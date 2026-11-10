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

    console.log(`[OTP] Code for ${phone}: ${code}`);

    // Try to send via Telegram if token exists
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken && supabase) {
      try {
        const { data: user } = await supabase.from('users').select('id').eq('phone_number', phone).maybeSingle();
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

    if (!record) return res.status(400).json({ error: 'No OTP requested for this number' });
    if (Date.now() > record.expires) return res.status(400).json({ error: 'OTP expired' });
    if (record.code !== code) return res.status(400).json({ error: 'Invalid code' });

    otps.delete(phone);
    res.json({ success: true });
  });

  if (!isProd) {
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
  } else {
    // Static middleware (PROD)
    app.use(express.static(path.resolve('dist')));
    app.use('*', (req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (${isProd ? 'PROD' : 'DEV'} mode)`);
  });
}

bootstrap();
