import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { initializeApp, getApps, App as FirebaseAdminApp } from 'firebase-admin/app';
import { getFirestore, Firestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from './firebase-applet-config.json';

dotenv.config();

// Initialize Firebase Admin
let adminApp: FirebaseAdminApp;
if (getApps().length === 0) {
  adminApp = initializeApp({
    projectId: firebaseConfig.projectId,
  });
} else {
  adminApp = getApps()[0];
}
console.log(`[FIREBASE] Admin SDK initialized for project: ${adminApp.options.projectId}`);

// In AI Studio, the database ID is crucial for non-default databases
const dbId = (firebaseConfig as any).firestoreDatabaseId;

function getDb(useAlternative = false) {
  try {
    // If we have a specific dbId, try it first. 
    // In AI Studio, sometimes the Admin SDK needs the explicit ID, 
    // but sometimes it defaults correctly.
    if (!useAlternative && dbId) {
      return getFirestore(adminApp, dbId);
    }
    return getFirestore(adminApp);
  } catch (err) {
    console.error("Critical error getting Firestore instance:", err);
    return getFirestore(adminApp);
  }
}

function getUsersCol(useAlternative = false) {
  return getDb(useAlternative).collection('users');
}

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  const app = express();
  app.use(express.json());

  const isProd = process.env.NODE_ENV === 'production' || fs.existsSync(path.resolve('dist'));

  // Simple In-Memory Rate Limiter
  const rateLimitMap = new Map<string, { count: number, lastReset: number }>();
  app.use((req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const limit = 100; // 100 requests per minute
    const window = 60000;

    const data = rateLimitMap.get(ip) || { count: 0, lastReset: now };
    if (now - data.lastReset > window) {
      data.count = 0;
      data.lastReset = now;
    }
    data.count++;
    rateLimitMap.set(ip, data);

    if (data.count > limit) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  });

  // In-Memory store for OTPs (Temporary solution)
  const otps = new Map<string, { code: string, expires: number }>();

  // API Routes
  app.post('/api/auth/send-otp', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const coreDigits = cleanPhone.slice(-10);

    let targetUserId = null;
    let actualPhone = null;

    try {
      // Robust lookup using the admin SDK
      let usersSnapshot;
      try {
        console.log(`[DB] Attempting lookup in configured database: ${dbId || '(default)'}`);
        usersSnapshot = await getUsersCol().get();
      } catch (err: any) {
        console.warn(`[DB] Primary lookup failed (Code ${err.code}): ${err.message}`);
        // If Primary (configured) fails, try the absolute default
        if (err.message?.includes('PERMISSION_DENIED') || err.message?.includes('NOT_FOUND') || err.code === 5 || err.code === 7) {
          console.warn("[DB] Falling back to default database instance...");
          usersSnapshot = await getUsersCol(true).get();
        } else {
          throw err;
        }
      }
      
      const match = usersSnapshot.docs.find((doc: any) => (doc.data().phone_number as string)?.endsWith(coreDigits));
      
      if (match) {
        targetUserId = match.id;
        actualPhone = match.data().phone_number;
      }
    } catch (err) {
      console.error("Firestore lookup error in send-otp:", err);
    }

    if (!targetUserId) {
      return res.status(404).json({ success: false, error: 'User not found. Please register via Telegram bot first.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60000; // 5 minutes
    otps.set(cleanPhone, { code, expires });

    console.log(`[AUTH] Generated OTP ${code} for ${cleanPhone}`);

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken && targetUserId) {
      try {
        const { Telegraf } = await import('telegraf');
        const bot = new Telegraf(botToken);
        await bot.telegram.sendMessage(targetUserId, 
          `🔐 *کد تایید میانجی*\n\n` +
          `کد ورود شما: \`${code}\`\n\n` +
          `⚠️ این کد تا ۵ دقیقه دیگر معتبر است. لطفا آن را در اختیار دیگران قرار ندهید.`,
          { parse_mode: 'MarkdownV2' }
        );
      } catch (err) {
        console.error("Failed to send Telegram OTP:", err);
      }
    }

    res.json({ success: true, message: 'OTP sent', phone: actualPhone || cleanPhone });
  });

  app.post('/api/auth/verify-otp', async (req, res) => {
    const { phone, code } = req.body;
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const record = otps.get(cleanPhone);

    if (!record) return res.status(400).json({ success: false, error: 'کد تایید منقضی شده یا درخواستی ثبت نشده است' });
    
    if (Date.now() > record.expires) return res.status(400).json({ success: false, error: 'کد تایید منقضی شده است' });
    if (record.code !== code) return res.status(400).json({ success: false, error: 'کد تایید اشتباه است' });

    otps.delete(cleanPhone);

    let user = null;
    let customToken = null;
    try {
      const coreDigits = cleanPhone.slice(-10);
      let usersSnapshot;
      try {
        usersSnapshot = await getUsersCol().get();
      } catch (err: any) {
        if (err.message?.includes('PERMISSION_DENIED') || err.message?.includes('NOT_FOUND') || err.code === 5 || err.code === 7) {
          usersSnapshot = await getUsersCol(true).get();
        } else {
          throw err;
        }
      }

      let match = usersSnapshot.docs.find((doc: any) => (doc.data().phone_number as string)?.endsWith(coreDigits));

      if (match) {
        user = { id: match.id, ...match.data() };
        customToken = await getAuth(adminApp).createCustomToken(match.id.toString());
      }
    } catch (err) {
      console.error("Verify OTP Exception:", err);
    }
    
    res.json({ success: true, user, customToken });
  });

  app.get('/api/users/lookup', async (req, res) => {
    const { phone } = req.query;
    if (!phone || typeof phone !== 'string') return res.status(400).json({ error: 'Phone required' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const coreDigits = cleanPhone.slice(-10);

    try {
      let usersSnapshot;
      try {
        usersSnapshot = await getUsersCol().get();
      } catch (err: any) {
        if (err.message?.includes('PERMISSION_DENIED') || err.message?.includes('NOT_FOUND') || err.code === 5 || err.code === 7) {
          usersSnapshot = await getUsersCol(true).get();
        } else {
          throw err;
        }
      }
      
      const match = usersSnapshot.docs.find((doc: any) => (doc.data().phone_number as string)?.endsWith(coreDigits));
      if (match) {
        return res.json({ success: true, user: { id: match.id, ...match.data() } });
      }
      res.status(404).json({ success: false, error: 'User not found' });
    } catch (err) {
      console.error("Lookup error:", err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  app.post('/api/logs', (req, res) => {
    const { level, message, details } = req.body;
    console.log(`[CLIENT-LOG] [${level?.toUpperCase() || 'INFO'}] ${message}`, details || '');
    res.sendStatus(200);
  });

  if (isProd) {
    app.use(express.static(path.resolve('dist')));
    app.get('/healthz', (req, res) => res.status(200).send('OK'));
    app.use('*', (req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve('index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  }

  const server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} at 0.0.0.0`);
  });

  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}


bootstrap();
