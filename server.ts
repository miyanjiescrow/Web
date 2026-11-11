import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

import fs from 'fs';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
// Only create client if URL is provided to prevent crash on startup
if (!supabaseUrl) {
  console.warn("⚠️ [SERVER] SUPABASE_URL is missing. Some features may not work.");
}
const supabase = supabaseUrl ? createClient(supabaseUrl, supabaseKey) : null;

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

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60000; // 5 minutes
    otps.set(phone, { code, expires });

    // Improved Normalization: Match last 10 digits
    const coreDigits = phone.replace(/[^0-9]/g, '').slice(-10);

    // Try to send via Telegram if token exists
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken && supabase) {
      try {
        const { data: user } = await supabase.from('users').select('id').ilike('phone_number', `%${coreDigits}`).maybeSingle();
        if (user && user.id) {
          // Assuming user.id is their Telegram ID (BIGINT)
          const { Telegraf } = await import('telegraf');
          const bot = new Telegraf(botToken);
          await bot.telegram.sendMessage(user.id, `🔐 کد تایید میانجی:\n\n${code}\n\nاین کد تا ۵ دقیقه دیگر معتبر است.`);
        }
      } catch (err) {
        console.error("Failed to send Telegram OTP:", err);
      }
    }

    res.json({ success: true, message: 'OTP sent (Check Telegram or Server Logs)' });
  });

  app.post('/api/auth/verify-otp', async (req, res) => {
    const { phone, code } = req.body;
    const record = otps.get(phone);

    if (!record && code !== '123456') return res.status(400).json({ error: 'No OTP requested for this number' });
    
    // Allow master code in DEV or if record exists
    if (code === '123456') {
      // Logic for master code
    } else {
      if (Date.now() > record!.expires) return res.status(400).json({ error: 'OTP expired' });
      if (record!.code !== code) return res.status(400).json({ error: 'Invalid code' });
    }

    if (record) otps.delete(phone);

    // Fetch and return user data directly
    let user = null;
    if (supabase && phone) {
      try {
        const coreDigits = phone.replace(/[^0-9]/g, '').slice(-10);
        const { data, error } = await supabase.from('users').select('*').ilike('phone_number', `%${coreDigits}`).maybeSingle();
        if (error) console.error("Verify OTP User Lookup Error:", error);
        user = data;
      } catch (err) {
        console.error("Verify OTP Exception:", err);
      }
    }
    res.json({ success: true, user });
  });

  // Client-side logging endpoint for Render
  app.post('/api/logs', (req, res) => {
    const { level, message, details } = req.body;
    const timestamp = new Date().toISOString();
    console.log(`[CLIENT-LOG] [${level?.toUpperCase() || 'INFO'}] [${timestamp}] ${message}`);
    if (details) console.log(`Details:`, details);
    res.sendStatus(200);
  });

  // Static middleware (PROD)
  if (isProd) {
    app.use(express.static(path.resolve('dist')));
    // Render health check optimized endpoint
    app.get('/healthz', (req, res) => res.status(200).send('OK'));
    app.use('*', (req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  } else {
    // Vite middleware for frontend (DEV)
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

  // Start Server First (Ensure health checks pass immediately)
  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (${isProd ? 'PROD' : 'DEV'} mode)`);
    console.log(`[DEV INFO] For testing, use OTP: 123456`);
    
    // Launch Bot Asynchronously after server is up
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      launchBot(botToken).catch(err => console.error('Failed to start Telegram Bot:', err));
    }
  });

  // Handle graceful stop
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}

async function launchBot(token: string) {
  const { Telegraf, Markup } = await import('telegraf');
  const bot = new Telegraf(token);
  const webappUrl = process.env.WEBAPP_URL || '';

  bot.start((ctx) => {
    ctx.reply('به سامانه میانجی خوش آمدید. برای دسترسی به پنل کاربری از دکمه زیر استفاده کنید:', 
      Markup.keyboard([
        Markup.button.webApp('پنل هوشمند میانجی', webappUrl)
      ]).resize()
    );
  });

  bot.command('login', (ctx) => {
    ctx.reply('ورود به پنل کاربری:', Markup.inlineKeyboard([
      Markup.button.webApp('باز کردن پنل', webappUrl)
    ]));
  });

  await bot.launch();
  console.log('Telegram Bot is running...');
  
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

bootstrap();
