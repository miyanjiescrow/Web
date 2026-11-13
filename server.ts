import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { initializeApp, getApps, cert, App as FirebaseAdminApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from './firebase-applet-config.json';

dotenv.config();

const normalizeDigits = (val: string) =>
  val
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();

const extractCleanPhone = (val: string) => normalizeDigits(String(val || '')).replace(/[^0-9]/g, '');

// Initialize Supabase if configured (optional secondary/legacy DB sync)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase: SupabaseClient | null = null;
if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log(`[SUPABASE] Connected to ${supabaseUrl}`);
  } catch (err) {
    console.error('[SUPABASE] Connection error:', err);
  }
}

// Initialize Firebase Admin (supports FIREBASE_SERVICE_ACCOUNT JSON on Render/external hosts)
let adminApp: FirebaseAdminApp;
if (getApps().length === 0) {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountRaw) {
    try {
      const serviceAccount = JSON.parse(serviceAccountRaw);
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || firebaseConfig.projectId,
      });
    } catch (e) {
      console.error('[FIREBASE] Failed to parse FIREBASE_SERVICE_ACCOUNT, falling back to default credentials');
      adminApp = initializeApp({ projectId: firebaseConfig.projectId });
    }
  } else {
    adminApp = initializeApp({
      projectId: firebaseConfig.projectId,
    });
  }
} else {
  adminApp = getApps()[0];
}
console.log(`[FIREBASE] Admin SDK initialized for project: ${adminApp.options.projectId}`);

// In AI Studio, the database ID is crucial for non-default databases
const dbId = (firebaseConfig as any).firestoreDatabaseId;

function getDb(useDefault = false) {
  try {
    if (!useDefault && dbId) {
      return getFirestore(adminApp, dbId);
    }
    return getFirestore(adminApp);
  } catch (err) {
    console.error('Critical error getting Firestore instance:', err);
    return getFirestore(adminApp);
  }
}

function getUsersCol(useDefault = false) {
  return getDb(useDefault).collection('users');
}

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const isProd = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  const useStaticDist = isProd && fs.existsSync(path.resolve('dist'));

  // In-Memory Rate Limiter with bounded pruning
  const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
  app.use((req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const limit = 120;
    const windowMs = 60000;

    if (rateLimitMap.size > 1000) {
      for (const [k, v] of rateLimitMap.entries()) {
        if (now - v.lastReset > windowMs) rateLimitMap.delete(k);
      }
    }

    const data = rateLimitMap.get(ip) || { count: 0, lastReset: now };
    if (now - data.lastReset > windowMs) {
      data.count = 0;
      data.lastReset = now;
    }
    data.count++;
    rateLimitMap.set(ip, data);

    if (data.count > limit) {
      return res.status(429).json({ success: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً کمی بعد تلاش کنید.' });
    }
    next();
  });

  const otps = new Map<string, { code: string; expires: number; attempts: number }>();
  const memoryUsers = new Map<string, any>();

  // Pre-seed owner account for Preview/fallback convenience (real DB records always take priority)
  memoryUsers.set('u_admin_owner', {
    id: 'u_admin_owner',
    phone_number: '09057586655',
    full_name: 'مدیر میانجی',
    kyc_status: 'verified',
    wallet_balance: 50000000,
    escrow_locked_balance: 0,
    role: 'owner',
  });

  const findUserByPhone = async (targetCleanPhone: string, targetCoreDigits: string) => {
    // 1. Check Supabase (if configured)
    if (supabase) {
      try {
        const { data } = await supabase.from('users').select('*');
        if (data && data.length > 0) {
          const match = data.find((u: any) =>
            extractCleanPhone(u.phone_number).endsWith(targetCoreDigits)
          );
          if (match) {
            console.log(`[SUPABASE] User found: ${match.id} (${match.full_name || ''}) for phone ${targetCleanPhone}`);
            return { id: match.id.toString(), ...match };
          }
        }
      } catch (err) {
        console.error('[SUPABASE] Lookup error:', err);
      }
    }

    // 2. Check Firestore (named dbId first, fallback to default db)
    try {
      let usersSnapshot: any = null;
      try {
        usersSnapshot = await getUsersCol().get();
      } catch {
        try {
          usersSnapshot = await getUsersCol(true).get();
        } catch (e) {
          console.warn('[FIRESTORE] Admin read unavailable:', (e as Error)?.message || e);
        }
      }
      if (usersSnapshot && usersSnapshot.docs) {
        const match = usersSnapshot.docs.find((doc: any) =>
          extractCleanPhone(doc.data().phone_number).endsWith(targetCoreDigits)
        );
        if (match) {
          console.log(`[FIRESTORE] User found: ${match.id} for phone ${targetCleanPhone}`);
          return { id: match.id, ...match.data() };
        }
      }
    } catch {}

    // 3. Check In-Memory users (Preview fallback & bot-synced runtime users)
    const memMatch = Array.from(memoryUsers.values()).find((u: any) =>
      extractCleanPhone(u.phone_number).endsWith(targetCoreDigits)
    );
    if (memMatch) {
      console.log(`[MEMORY] User found: ${memMatch.id} for phone ${targetCleanPhone}`);
      return memMatch;
    }

    return null;
  };

  // Health Checks (Dev & Production)
  app.get('/healthz', (_req, res) => res.status(200).send('OK'));
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      env: isProd ? 'production' : 'development',
      telegramConfigured: Boolean(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN),
      supabaseConfigured: Boolean(supabase),
      firebaseProjectId: adminApp.options.projectId,
    });
  });

  // Auth: Send OTP
  app.post('/api/auth/send-otp', async (req, res) => {
    try {
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ success: false, error: 'لطفاً شماره همراه را وارد کنید' });

      const cleanPhone = extractCleanPhone(phone);
      if (cleanPhone.length < 10) {
        return res.status(400).json({ success: false, error: 'شماره همراه وارد شده معتبر نیست' });
      }
      const coreDigits = cleanPhone.slice(-10);

      // Prune expired OTPs periodically
      const now = Date.now();
      if (otps.size > 500) {
        for (const [k, v] of otps.entries()) {
          if (now > v.expires) otps.delete(k);
        }
      }

      const foundUser = await findUserByPhone(cleanPhone, coreDigits);

      // STRICT VALIDATION: User must exist in bot/database before OTP is issued
      if (!foundUser) {
        return res.json({
          success: false,
          needRegistration: true,
          error: 'شماره همراه شما در سیستم میانجی و ربات ثبت نشده است. لطفا ابتدا ربات تلگرام را استارت کنید.',
        });
      }

      const targetUserId = foundUser.id.toString();
      const actualPhone = foundUser.phone_number || cleanPhone;
      const code = crypto.randomInt(100000, 1000000).toString();
      const expires = Date.now() + 15 * 60000; // 15 minutes
      otps.set(coreDigits, { code, expires, attempts: 0 });

      console.log(`[AUTH] Generated OTP for ${coreDigits}`);

      const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
      let telegramDelivered = false;
      if (botToken && targetUserId && !targetUserId.startsWith('u_')) {
        try {
          const { Telegraf } = await import('telegraf');
          const bot = new Telegraf(botToken);
          await Promise.race([
            bot.telegram.sendMessage(
              targetUserId,
              `🔐 *کد تایید میانجی*\n\n` +
                `کد ورود شما: \`${code}\`\n\n` +
                `⚠️ این کد تا ۱۵ دقیقه دیگر معتبر است. لطفا آن را در اختیار دیگران قرار ندهید.`,
              { parse_mode: 'Markdown' }
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram send timeout')), 5000)),
          ]);
          telegramDelivered = true;
          console.log(`[AUTH] Sent Telegram OTP to ${targetUserId}`);
        } catch (err) {
          console.error('Failed to send Telegram OTP via bot:', err);
        }
      }

      // Never expose OTP in production or when Telegram delivered it
      const responsePayload: any = {
        success: true,
        message: 'OTP sent',
        phone: actualPhone || cleanPhone,
        telegramDelivered,
      };
      if (!isProd && !telegramDelivered) {
        responsePayload.previewOtp = code;
      }

      res.json(responsePayload);
    } catch (err: any) {
      console.error('send-otp critical error:', err);
      res.status(500).json({ success: false, error: err.message || 'خطای داخلی سرور' });
    }
  });

  // Auth: Verify OTP
  app.post('/api/auth/verify-otp', async (req, res) => {
    try {
      const { phone, code } = req.body || {};
      if (!phone || !code) {
        return res.status(400).json({ success: false, error: 'شماره همراه و کد تایید الزامی است' });
      }

      const cleanPhone = extractCleanPhone(phone);
      const coreDigits = cleanPhone.slice(-10);
      const cleanCode = extractCleanPhone(code);
      const record = otps.get(coreDigits);

      if (!record) {
        return res.status(400).json({ success: false, error: 'کد تایید منقضی شده یا درخواستی ثبت نشده است' });
      }

      if (Date.now() > record.expires) {
        otps.delete(coreDigits);
        return res.status(400).json({ success: false, error: 'کد تایید منقضی شده است' });
      }

      if (record.code !== cleanCode) {
        record.attempts += 1;
        if (record.attempts >= 5) {
          otps.delete(coreDigits);
          return res.status(400).json({ success: false, error: 'تعداد تلاش‌های ناموفق بیش از حد مجاز بود. لطفاً کد جدید دریافت کنید.' });
        }
        return res.status(400).json({ success: false, error: 'کد تایید اشتباه است' });
      }

      // Successful verification: invalidate OTP to prevent replay attacks
      otps.delete(coreDigits);

      const user = await findUserByPhone(cleanPhone, coreDigits);
      if (!user) {
        return res.status(404).json({ success: false, error: 'حساب کاربری یافت نشد. لطفاً ابتدا ربات را استارت کنید.' });
      }

      let customToken: string | null = null;
      try {
        customToken = await getAuth(adminApp).createCustomToken(user.id.toString());
      } catch (e) {
        console.warn('[AUTH] createCustomToken unavailable in current environment; returning session fallback');
      }

      res.json({ success: true, user, customToken });
    } catch (err: any) {
      console.error('verify-otp error:', err);
      res.status(500).json({ success: false, error: err.message || 'خطای داخلی سرور' });
    }
  });

  // Auth: Telegram WebApp InitData login
  app.post('/api/auth/telegram-webapp', async (req, res) => {
    const { initData } = req.body || {};
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

      let isValid = false;
      if (botToken && hash) {
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        isValid = calculatedHash === hash;
      }

      if (botToken && (!hash || !isValid)) {
        return res.status(401).json({ success: false, error: 'امضای تلگرام نامعتبر است' });
      }

      const userStr = urlParams.get('user');
      if (!userStr) {
        return res.status(400).json({ success: false, error: 'اطلاعات کاربر در initData یافت نشد' });
      }

      const tgUser = JSON.parse(userStr);
      const userId = tgUser.id.toString();
      const fullName = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() || 'کاربر تلگرام';
      const username = tgUser.username || '';

      let userData: any = null;

      try {
        const userRef = getUsersCol().doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
          const newDocData = {
            id: userId,
            full_name: fullName,
            username,
            phone_number: '',
            kyc_status: 'pending',
            wallet_balance: 0,
            escrow_locked_balance: 0,
            role: 'user',
            updatedAt: FieldValue.serverTimestamp(),
          };
          await userRef.set(newDocData);
          userData = { ...newDocData, updatedAt: new Date().toISOString() };
        } else {
          userData = { id: userDoc.id, ...userDoc.data() };
        }
      } catch (dbErr) {
        console.warn('[TWA] Firestore Admin unavailable, using in-memory profile:', (dbErr as Error)?.message);
        const existingMem = memoryUsers.get(userId);
        userData = existingMem || {
          id: userId,
          full_name: fullName,
          username,
          phone_number: '',
          kyc_status: 'pending',
          wallet_balance: 0,
          escrow_locked_balance: 0,
          role: 'user',
        };
        memoryUsers.set(userId, userData);
      }

      let customToken: string | null = null;
      try {
        customToken = await getAuth(adminApp).createCustomToken(userId);
      } catch {
        console.warn('[TWA] createCustomToken unavailable; returning session fallback');
      }

      res.json({ success: true, user: userData, customToken });
    } catch (err: any) {
      console.error('Telegram WebApp Auth Error:', err);
      res.status(500).json({ success: false, error: err.message || 'خطای داخلی سرور' });
    }
  });

  // Bot Sync Endpoint: Telegram Bot registers or updates a user phone + telegramId
  app.post('/api/bot/register-user', async (req, res) => {
    try {
      const { telegramId, phone, fullName } = req.body || {};
      if (!telegramId || !phone) {
        return res.status(400).json({ success: false, error: 'telegramId and phone are required' });
      }

      const cleanPhone = extractCleanPhone(phone);
      if (cleanPhone.length < 10) {
        return res.status(400).json({ success: false, error: 'Invalid phone number' });
      }

      const userId = String(telegramId).trim();
      const existingMem = memoryUsers.get(userId);
      const userData = {
        id: userId,
        phone_number: cleanPhone,
        full_name: fullName || existingMem?.full_name || 'کاربر میانجی',
        kyc_status: existingMem?.kyc_status || 'verified',
        wallet_balance: existingMem?.wallet_balance ?? 0,
        escrow_locked_balance: existingMem?.escrow_locked_balance ?? 0,
        role: existingMem?.role || 'user',
      };

      memoryUsers.set(userId, userData);

      try {
        const docRef = getUsersCol().doc(userId);
        const snap = await docRef.get();
        if (snap.exists) {
          await docRef.set(
            {
              phone_number: cleanPhone,
              full_name: fullName || snap.data()?.full_name || 'کاربر میانجی',
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } else {
          await docRef.set({
            ...userData,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      } catch (e) {
        console.warn('[BOT-SYNC] Firestore sync skipped/unavailable:', (e as Error)?.message);
      }

      if (supabase) {
        try {
          await supabase.from('users').upsert({
            id: Number(userId),
            phone_number: cleanPhone,
            full_name: userData.full_name,
            wallet_balance: userData.wallet_balance,
            kyc_status: userData.kyc_status,
          });
        } catch {}
      }

      console.log(`[BOT-SYNC] Registered user ${userId} for phone ${cleanPhone}`);
      res.json({ success: true, user: userData });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Safe User Lookup by Phone (for creating deals without leaking balances/sensitive data)
  app.get('/api/users/lookup', async (req, res) => {
    const { phone } = req.query;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, error: 'شماره همراه الزامی است' });
    }

    const cleanPhone = extractCleanPhone(phone);
    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, error: 'شماره همراه معتبر نیست' });
    }
    const coreDigits = cleanPhone.slice(-10);

    try {
      const found = await findUserByPhone(cleanPhone, coreDigits);
      if (found) {
        return res.json({
          success: true,
          user: {
            id: String(found.id),
            full_name: found.full_name || 'کاربر میانجی',
            phone_number: found.phone_number || cleanPhone,
            kyc_status: found.kyc_status || 'pending',
          },
        });
      }

      res.status(404).json({ success: false, error: 'کاربری با این شماره یافت نشد' });
    } catch (err) {
      console.error('Lookup error:', err);
      res.status(500).json({ success: false, error: 'خطای داخلی سرور' });
    }
  });

  // --- Channels Store (Firestore Admin + In-Memory Preview Cache) ---
  interface ChannelRecord {
    channel_id: string;
    handle: string;
    title: string;
    description: string;
    owner_id: string;
    owner_name: string;
    category: string;
    is_verified: boolean;
    subscribers_count: number;
    createdAt: string;
    updatedAt: string;
  }

  interface ChannelPostRecord {
    id: string;
    channel_id: string;
    author_id: string;
    author_name: string;
    text: string;
    message_type: 'text' | 'image' | 'voice' | 'file';
    attachment_url?: string;
    views: number;
    silent?: boolean;
    created_at: string;
  }

  const memoryChannels = new Map<string, ChannelRecord>([
    [
      'ch_mianji_official',
      {
        channel_id: 'ch_mianji_official',
        handle: 'mianji_official',
        title: 'کانال رسمی میانجی',
        description: 'اطلاعیه‌های رسمی، آپدیت‌های امنیتی و اخبار پلتفرم معاملات امانی میانجی',
        owner_id: 'u_admin_owner',
        owner_name: 'تیم میانجی',
        category: 'رسمی',
        is_verified: true,
        subscribers_count: 12450,
        createdAt: new Date(Date.now() - 86400000 * 14).toISOString(),
        updatedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
      },
    ],
    [
      'ch_mianji_academy',
      {
        channel_id: 'ch_mianji_academy',
        handle: 'mianji_academy',
        title: 'آکادمی معاملات امن',
        description: 'راهنمای قراردادنویسی حرفه‌ای، نکات جلوگیری از کلاهبرداری و چک‌لیست‌های تحویل کار',
        owner_id: 'u_admin_owner',
        owner_name: 'آکادمی میانجی',
        category: 'آموزش',
        is_verified: true,
        subscribers_count: 5820,
        createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
        updatedAt: new Date(Date.now() - 3600000 * 5).toISOString(),
      },
    ],
  ]);

  const memoryChannelPosts = new Map<string, ChannelPostRecord[]>([
    [
      'ch_mianji_official',
      [
        {
          id: 'post_official_1',
          channel_id: 'ch_mianji_official',
          author_id: 'u_admin_owner',
          author_name: 'تیم میانجی',
          text: '🔐 به کانال رسمی میانجی خوش آمدید!\n\nتمام اطلاعیه‌های مهم سیستم Escrow، به‌روزرسانی‌های کیف پول، و هشدارهای امنیتی معاملات آنلاین در این کانال منتشر می‌شود.',
          message_type: 'text',
          views: 11840,
          created_at: new Date(Date.now() - 86400000 * 3).toISOString(),
        },
        {
          id: 'post_official_2',
          channel_id: 'ch_mianji_official',
          author_id: 'u_admin_owner',
          author_name: 'تیم میانجی',
          text: '⚡ قابلیت جدید پیام‌رسان میانجی فعال شد:\nاز امروز می‌توانید علاوه بر گفتگوی شخصی و چت قرارداد، در بخش «کانال‌ها» کانال اختصاصی بسازید یا اخبار رسمی را لحظه‌ای دنبال کنید.',
          message_type: 'text',
          views: 9420,
          created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
        },
      ],
    ],
    [
      'ch_mianji_academy',
      [
        {
          id: 'post_academy_1',
          channel_id: 'ch_mianji_academy',
          author_id: 'u_admin_owner',
          author_name: 'آکادمی میانجی',
          text: '✅ چک‌لیست طلایی قبل از قفل وجه:\n۱. تمام جزئیات تحویل و تعداد اصلاحات را شفاف در توضیحات معامله ثبت کنید.\n۲. فایل‌ها و تاییدیه‌ها را فقط در چت داخل قرارداد ارسال نمایید تا در صورت بروز اختلاف، مستندات رسمی داوری در دسترس باشد.',
          message_type: 'text',
          views: 4910,
          created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
        },
      ],
    ],
  ]);

  // GET all channels
  app.get('/api/channels', async (_req, res) => {
    try {
      const merged = new Map<string, ChannelRecord>(memoryChannels);
      try {
        const snap = await getDb().collection('channels').limit(50).get();
        snap.docs.forEach((doc) => {
          const data = doc.data() as any;
          merged.set(doc.id, {
            channel_id: data.channel_id || doc.id,
            handle: data.handle || '',
            title: data.title || 'کانال',
            description: data.description || '',
            owner_id: String(data.owner_id || ''),
            owner_name: data.owner_name || 'مدیر کانال',
            category: data.category || 'عمومی',
            is_verified: Boolean(data.is_verified),
            subscribers_count: Number(data.subscribers_count || 1),
            createdAt: data.createdAt?.toDate?.()?.toISOString?.() || String(data.createdAt || new Date().toISOString()),
            updatedAt: data.updatedAt?.toDate?.()?.toISOString?.() || String(data.updatedAt || new Date().toISOString()),
          });
        });
      } catch {}

      const list = Array.from(merged.values()).sort((a, b) => {
        if (a.is_verified !== b.is_verified) return a.is_verified ? -1 : 1;
        return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      });
      res.json({ success: true, channels: list });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت کانال‌ها' });
    }
  });

  // POST create a channel
  app.post('/api/channels', async (req, res) => {
    try {
      const { title, handle, description, category, owner_id, owner_name } = req.body || {};
      const cleanTitle = String(title || '').trim();
      if (cleanTitle.length < 2 || cleanTitle.length > 100) {
        return res.status(400).json({ success: false, error: 'نام کانال باید بین ۲ تا ۱۰۰ کاراکتر باشد' });
      }
      const channelId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const cleanHandle = String(handle || '')
        .replace(/[^a-zA-Z0-9_]/g, '')
        .slice(0, 40)
        .toLowerCase();
      const nowIso = new Date().toISOString();
      const record: ChannelRecord = {
        channel_id: channelId,
        handle: cleanHandle || `channel_${channelId.slice(-4)}`,
        title: cleanTitle,
        description: String(description || '').trim().slice(0, 500) || 'کانال اطلاع‌رسانی در پیام‌رسان میانجی',
        owner_id: String(owner_id || 'u_guest'),
        owner_name: String(owner_name || 'مدیر کانال').slice(0, 100),
        category: String(category || 'عمومی').slice(0, 40),
        is_verified: false,
        subscribers_count: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      memoryChannels.set(channelId, record);
      const initialPost: ChannelPostRecord = {
        id: `post_${Date.now()}`,
        channel_id: channelId,
        author_id: record.owner_id,
        author_name: record.owner_name,
        text: `📢 کانال «${record.title}» راه‌اندازی شد.`,
        message_type: 'text',
        views: 1,
        created_at: nowIso,
      };
      memoryChannelPosts.set(channelId, [initialPost]);

      try {
        await getDb().collection('channels').doc(channelId).set({
          ...record,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        await getDb().collection('channel_posts').doc(initialPost.id).set({
          ...initialPost,
          created_at: FieldValue.serverTimestamp(),
        });
      } catch {}

      res.json({ success: true, channel: record, initialPost });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ایجاد کانال' });
    }
  });

  // GET posts of a channel
  app.get('/api/channels/:channelId/posts', async (req, res) => {
    try {
      const channelId = String(req.params.channelId || '').trim();
      const memPosts = memoryChannelPosts.get(channelId) || [];
      const merged = new Map<string, ChannelPostRecord>();
      memPosts.forEach((p) => merged.set(p.id, p));

      try {
        const snap = await getDb()
          .collection('channel_posts')
          .where('channel_id', '==', channelId)
          .limit(80)
          .get();
        snap.docs.forEach((doc) => {
          const d = doc.data() as any;
          merged.set(doc.id, {
            id: doc.id,
            channel_id: d.channel_id || channelId,
            author_id: String(d.author_id || ''),
            author_name: d.author_name || 'مدیر کانال',
            text: d.text || '',
            message_type: d.message_type || 'text',
            attachment_url: d.attachment_url,
            views: Number(d.views || 1),
            silent: Boolean(d.silent),
            created_at: d.created_at?.toDate?.()?.toISOString?.() || String(d.created_at || new Date().toISOString()),
          });
        });
      } catch {}

      const posts = Array.from(merged.values()).sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
      );
      res.json({ success: true, posts });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت پست‌ها' });
    }
  });

  // POST publish a new post to a channel
  app.post('/api/channels/:channelId/posts', async (req, res) => {
    try {
      const channelId = String(req.params.channelId || '').trim();
      const { author_id, author_name, text, message_type, attachment_url, silent } = req.body || {};
      const cleanText = String(text || '').trim().slice(0, 2000);
      if (!cleanText) {
        return res.status(400).json({ success: false, error: 'متن پست نمی‌تواند خالی باشد' });
      }

      const nowIso = new Date().toISOString();
      const postId = `post_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const post: ChannelPostRecord = {
        id: postId,
        channel_id: channelId,
        author_id: String(author_id || 'u_guest'),
        author_name: String(author_name || 'مدیر کانال').slice(0, 100),
        text: cleanText,
        message_type: ['text', 'image', 'voice', 'file'].includes(message_type) ? message_type : 'text',
        attachment_url: typeof attachment_url === 'string' && attachment_url.length <= 2048 ? attachment_url : undefined,
        views: 1,
        silent: Boolean(silent),
        created_at: nowIso,
      };

      const existingPosts = memoryChannelPosts.get(channelId) || [];
      memoryChannelPosts.set(channelId, [...existingPosts, post]);

      const ch = memoryChannels.get(channelId);
      if (ch) {
        memoryChannels.set(channelId, { ...ch, updatedAt: nowIso });
      }

      try {
        await getDb().collection('channel_posts').doc(postId).set({
          ...post,
          created_at: FieldValue.serverTimestamp(),
        });
        await getDb().collection('channels').doc(channelId).set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      } catch {}

      res.json({ success: true, post });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در انتشار پست' });
    }
  });

  // POST toggle subscription count
  app.post('/api/channels/:channelId/subscribe', async (req, res) => {
    try {
      const channelId = String(req.params.channelId || '').trim();
      const subscribed = Boolean(req.body?.subscribed);
      const ch = memoryChannels.get(channelId);
      if (ch) {
        const nextCount = Math.max(1, ch.subscribers_count + (subscribed ? 1 : -1));
        memoryChannels.set(channelId, { ...ch, subscribers_count: nextCount });
      }
      try {
        await getDb()
          .collection('channels')
          .doc(channelId)
          .update({
            subscribers_count: FieldValue.increment(subscribed ? 1 : -1),
            updatedAt: FieldValue.serverTimestamp(),
          });
      } catch {}
      res.json({ success: true, subscribers_count: memoryChannels.get(channelId)?.subscribers_count });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا' });
    }
  });

  app.post('/api/logs', (req, res) => {
    const { level, message, details } = req.body || {};
    console.log(`[CLIENT-LOG] [${level?.toUpperCase() || 'INFO'}] ${message}`, details || '');
    res.sendStatus(200);
  });

  // Guarantee unmatched /api/* endpoints return JSON 404 (never HTML)
  app.use('/api/*', (_req, res) => {
    res.status(404).json({ success: false, error: 'API route not found' });
  });

  if (useStaticDist) {
    app.use(express.static(path.resolve('dist')));
    app.use('*', (_req, res) => {
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
