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

  // API Routes
  app.post('/api/auth/otp-mock', (req, res) => {
    const { phone } = req.body;
    console.log(`[MOCK OTP] Sending 123456 to ${phone}`);
    res.json({ success: true, message: 'Code sent (123456)' });
  });

  // Verify National ID Mock
  app.post('/api/verify/national-id', async (req, res) => {
    const { nationalId } = req.body;
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
      // Read index.html from root
      let template = fs.readFileSync(path.resolve('index.html'), 'utf-8');
      template = await vite.transformIndexHtml(url, template);
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
