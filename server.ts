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

  const isProd = process.env.NODE_ENV === 'production' || fs.existsSync(path.resolve('dist'));

  // API Routes
  app.post('/api/auth/otp-mock', (req, res) => {
    const { phone } = req.body;
    console.log(`[MOCK OTP] Sending 123456 to ${phone}`);
    res.json({ success: true, message: 'Code sent (123456)' });
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
