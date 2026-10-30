import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import path from 'path';
import { adminAuth, adminDb } from './src/lib/firebase-admin.ts';

dotenv.config();

const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function bootstrap() {
  const app = express();
  app.use(express.json());

  // Telegram Bot Setup (Telegraf)
  if (TG_TOKEN) {
    const bot = new Telegraf(TG_TOKEN);
    
    bot.start((ctx) => {
      ctx.reply('به میانجی خوش آمدید. برای شروع معامله از دکمه زیر استفاده کنید.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: "ورود به پلتفرم", web_app: { url: process.env.APP_URL || '' } }]
          ]
        }
      });
    });

    bot.launch().catch(err => console.error('Bot launch error:', err));
    console.log('Telegram Bot is running...');
  } else {
    console.warn('TELEGRAM_BOT_TOKEN not found in environment variables.');
  }

  // API Routes
  app.post('/api/auth/otp-mock', (req, res) => {
    const { phone } = req.body;
    console.log(`[MOCK OTP] Sending 123456 to ${phone}`);
    res.json({ success: true, message: 'Code sent (123456)' });
  });

  // Verify National ID Mock
  app.post('/api/verify/national-id', async (req, res) => {
    const { nationalId, fullName } = req.body;
    // Simple logic-only mock
    if (nationalId.length === 10) {
      res.json({ success: true, verified: true });
    } else {
      res.status(400).json({ success: false, message: 'Invalid National ID format' });
    }
  });

  // Vite middleware for frontend
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom',
  });
  app.use(vite.middlewares);

  app.use('*', async (req, res, next) => {
    const url = req.originalUrl;
    try {
      let template = await vite.transformIndexHtml(url, `<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>`);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

bootstrap();
