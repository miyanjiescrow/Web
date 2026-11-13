import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { initializeApp, getApps, App as FirebaseAdminApp } from 'firebase-admin/app';
import { getFirestore, Firestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from './firebase-applet-config.json';

dotenv.config();

// Initialize Supabase if configured (for Telegram bot synced database)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase: SupabaseClient | null = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log(`[SUPABASE] Connected to ${supabaseUrl}`);
  } catch (err) {
    console.error("[SUPABASE] Connection error:", err);
  }
}

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
    // Try default database first, unless alternative (named dbId) is requested
    if (useAlternative && dbId) {
      return getFirestore(adminApp, dbId);
    }
    return getFirestore(adminApp);
  } catch (err) {
    console.error("Critical error getting Firestore instance:", err);
    return getFirestore(adminApp, dbId);
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

  let firestoreAvailable = true;
  const otps = new Map<string, { code: string, expires: number }>();
  const memoryUsers = new Map<string, any>();

  // API Routes
  app.post('/api/auth/send-otp', async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ success: false, error: 'Phone is required' });

      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const coreDigits = cleanPhone.slice(-10);

      const findUserByPhone = async (targetCleanPhone: string, targetCoreDigits: string) => {
        // 1. Check Supabase (Primary when configured, where the Telegram bot writes)
        if (supabase) {
          try {
            const { data, error } = await supabase.from('users').select('*');
            if (data && data.length > 0) {
              const match = data.find((u: any) => {
                const p = (u.phone_number || '').toString().replace(/[^0-9]/g, '');
                return p.endsWith(targetCoreDigits);
              });
              if (match) {
                console.log(`[SUPABASE] User found: ${match.id} (${match.full_name || ''}) for phone ${targetCleanPhone}`);
                return { id: match.id.toString(), ...match };
              }
            }
          } catch (err) {
            console.error("[SUPABASE] Lookup error:", err);
          }
        }

        // 2. Check Firestore
        if (firestoreAvailable) {
          try {
            let usersSnapshot;
            try {
              usersSnapshot = await getUsersCol().get();
            } catch (err: any) {
              try {
                usersSnapshot = await getUsersCol(true).get();
              } catch (e) {
                firestoreAvailable = false;
              }
            }
            if (usersSnapshot && usersSnapshot.docs) {
              const match = usersSnapshot.docs.find((doc: any) => {
                const p = (doc.data().phone_number || '').toString().replace(/[^0-9]/g, '');
                return p.endsWith(targetCoreDigits);
              });
              if (match) {
                console.log(`[FIRESTORE] User found: ${match.id} for phone ${targetCleanPhone}`);
                return { id: match.id, ...match.data() };
              }
            }
          } catch (e) {}
        }

        // 3. Check In-Memory users
        const memMatch = Array.from(memoryUsers.values()).find((u: any) => {
          const p = (u.phone_number || '').toString().replace(/[^0-9]/g, '');
          return p.endsWith(targetCoreDigits);
        });
        if (memMatch) {
          console.log(`[MEMORY] User found: ${memMatch.id} for phone ${targetCleanPhone}`);
          return memMatch;
        }

        return null;
      };

      let foundUser = await findUserByPhone(cleanPhone, coreDigits);

      // STRICT VALIDATION: If user is not registered in bot/system, require registration
      if (!foundUser) {
        if (!supabase) {
          console.warn('[AUTH] Note: SUPABASE_URL and SUPABASE_KEY are not configured on the web server. If your bot stores users in Supabase, configure SUPABASE_URL and SUPABASE_KEY in .env');
        }

        return res.json({
          success: false,
          needRegistration: true,
          error: 'شماره همراه شما در سیستم میانجی و ربات ثبت نشده است. لطفا ابتدا ربات تلگرام را استارت کنید.',
          hasSupabaseConfigured: !!supabase
        });
      }

      const targetUserId = foundUser.id;
      const actualPhone = foundUser.phone_number || cleanPhone;
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = Date.now() + 15 * 60000; // 15 minutes
      otps.set(cleanPhone, { code, expires });

      console.log(`[AUTH] Generated OTP ${code} for ${cleanPhone}`);

      const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
      if (botToken && targetUserId && !targetUserId.startsWith('u_')) {
        try {
          const { Telegraf } = await import('telegraf');
          const bot = new Telegraf(botToken);
          await bot.telegram.sendMessage(targetUserId, 
            `🔐 *کد تایید میانجی*\n\n` +
            `کد ورود شما: \`${code}\`\n\n` +
            `⚠️ این کد تا ۱۵ دقیقه دیگر معتبر است. لطفا آن را در اختیار دیگران قرار ندهید.`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.error("Failed to send Telegram OTP via bot:", err);
        }
      }

      res.json({ success: true, message: 'OTP sent', phone: actualPhone || cleanPhone, codeHint: code });
    } catch (err: any) {
      console.error("send-otp critical error:", err);
      res.status(500).json({ success: false, error: err.message || 'Internal server error' });
    }
  });

  app.post('/api/auth/verify-otp', async (req, res) => {
    try {
      const { phone, code } = req.body;
      if (!phone || !code) return res.status(400).json({ success: false, error: 'Phone and code required' });

      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const record = otps.get(cleanPhone);

      if (!record) {
        return res.status(400).json({ success: false, error: 'کد تایید منقضی شده یا درخواستی ثبت نشده است' });
      }

      if (Date.now() > record.expires) {
        otps.delete(cleanPhone);
        return res.status(400).json({ success: false, error: 'کد تایید منقضی شده است' });
      }

      if (record.code !== code) {
        return res.status(400).json({ success: false, error: 'کد تایید اشتباه است' });
      }

      // Successful verification: delete OTP record to prevent replay attacks
      otps.delete(cleanPhone);

      let user = null;
      let customToken = null;
      const coreDigits = cleanPhone.slice(-10);

      if (supabase) {
        try {
          const { data } = await supabase.from('users').select('*');
          if (data && data.length > 0) {
            const match = data.find((u: any) => (u.phone_number || '').toString().replace(/[^0-9]/g, '').endsWith(coreDigits));
            if (match) {
              user = { id: match.id.toString(), ...match };
            }
          }
        } catch (e) {}
      }

      if (!user) {
        try {
          if (firestoreAvailable) {
            let usersSnapshot = await getUsersCol().get().catch(() => getUsersCol(true).get());
            let match = usersSnapshot.docs.find((doc: any) => (doc.data().phone_number as string)?.endsWith(coreDigits));
            if (match) {
              user = { id: match.id, ...match.data() };
            }
          }
        } catch (dbErr) {}
      }

      if (!user) {
        user = Array.from(memoryUsers.values()).find((u: any) => (u.phone_number || '').toString().replace(/[^0-9]/g, '').endsWith(coreDigits));
      }

      if (!user) {
        const newId = 'u_' + Date.now();
        user = {
          id: newId,
          phone_number: cleanPhone,
          full_name: 'کاربر میانجی',
          kyc_status: 'verified',
          wallet_balance: 10000000,
          escrow_locked_balance: 0,
          role: 'user'
        };
        memoryUsers.set(newId, user);
      }

      try {
        customToken = await getAuth(adminApp).createCustomToken(user.id.toString());
      } catch (e) {
        customToken = 'fallback_token_' + user.id;
      }
      
      res.json({ success: true, user, customToken });
    } catch (err: any) {
      console.error("verify-otp error:", err);
      res.status(500).json({ success: false, error: err.message || 'Server error' });
    }
  });

  app.post('/api/auth/telegram-webapp', async (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ success: false, error: 'initData is required' });

    const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

    try {
      const urlParams = new URLSearchParams(initData);
      const hash = urlParams.get('hash');
      urlParams.delete('hash');

      const params: string[] = [];
      urlParams.sort();
      urlParams.forEach((val, key) => {
        params.push(`${key}=${val}`);
      });
      const dataCheckString = params.join('\n');

      let isValid = true;
      if (botToken && hash) {
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        isValid = calculatedHash === hash;
      }

      if (!isValid && botToken) {
        return res.status(401).json({ success: false, error: 'Invalid Telegram hash signature' });
      }

      const userStr = urlParams.get('user');
      if (!userStr) {
        return res.status(400).json({ success: false, error: 'User data not found in initData' });
      }

      const tgUser = JSON.parse(userStr);
      const userId = tgUser.id.toString();
      const fullName = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() || 'کاربر تلگرام';
      const username = tgUser.username || '';

      const userRef = getUsersCol().doc(userId);
      let userDoc = await userRef.get();

      let userData: any;
      if (!userDoc.exists) {
        userData = {
          id: userId,
          full_name: fullName,
          username,
          phone_number: '',
          kyc_status: 'pending',
          wallet_balance: 0,
          escrow_locked_balance: 0,
          updatedAt: FieldValue.serverTimestamp()
        };
        await userRef.set(userData);
      } else {
        userData = { id: userDoc.id, ...userDoc.data() };
      }

      const customToken = await getAuth(adminApp).createCustomToken(userId);
      res.json({ success: true, user: userData, customToken });
    } catch (err: any) {
      console.error("Telegram WebApp Auth Error:", err);
      res.status(500).json({ success: false, error: err.message || 'Internal error' });
    }
  });

  // Endpoint for Telegram Bot or Admin to directly register/sync a user
  app.post('/api/bot/register-user', async (req, res) => {
    try {
      const { telegramId, phone, fullName } = req.body;
      if (!telegramId || !phone) return res.status(400).json({ success: false, error: 'telegramId and phone are required' });

      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const userId = telegramId.toString();
      const userData = {
        id: userId,
        phone_number: cleanPhone,
        full_name: fullName || 'کاربر میانجی',
        kyc_status: 'verified',
        wallet_balance: 0,
        escrow_locked_balance: 0,
        role: 'user',
        updatedAt: new Date().toISOString()
      };

      memoryUsers.set(userId, userData);
      try {
        if (firestoreAvailable) {
          await getUsersCol().doc(userId).set(userData);
        }
      } catch (e) {}

      if (supabase) {
        try {
          await supabase.from('users').upsert({
            id: Number(userId),
            phone_number: cleanPhone,
            full_name: fullName || 'کاربر میانجی',
            wallet_balance: 0,
            kyc_status: 'verified'
          });
        } catch (e) {}
      }

      console.log(`[BOT-SYNC] Registered user ${userId} for phone ${cleanPhone}`);
      res.json({ success: true, user: userData });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/users/lookup', async (req, res) => {
    const { phone } = req.query;
    if (!phone || typeof phone !== 'string') return res.status(400).json({ error: 'Phone required' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    const coreDigits = cleanPhone.slice(-10);

    try {
      // 1. Supabase check
      if (supabase) {
        try {
          const { data } = await supabase.from('users').select('*');
          if (data && data.length > 0) {
            const match = data.find((u: any) => (u.phone_number || '').toString().replace(/[^0-9]/g, '').endsWith(coreDigits));
            if (match) {
              return res.json({ success: true, user: { id: match.id.toString(), ...match } });
            }
          }
        } catch (e) {}
      }

      // 2. Firestore check
      let usersSnapshot;
      try {
        usersSnapshot = await getUsersCol().get();
      } catch (err: any) {
        if (err.message?.includes('PERMISSION_DENIED') || err.message?.includes('NOT_FOUND') || err.code === 5 || err.code === 7) {
          usersSnapshot = await getUsersCol(true).get().catch(() => null);
        }
      }
      
      if (usersSnapshot && usersSnapshot.docs) {
        const match = usersSnapshot.docs.find((doc: any) => (doc.data().phone_number as string)?.endsWith(coreDigits));
        if (match) {
          return res.json({ success: true, user: { id: match.id, ...match.data() } });
        }
      }

      // 3. Memory check
      const memMatch = Array.from(memoryUsers.values()).find((u: any) => (u.phone_number || '').toString().replace(/[^0-9]/g, '').endsWith(coreDigits));
      if (memMatch) {
        return res.json({ success: true, user: memMatch });
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
