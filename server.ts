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

// Initialize Firebase Admin only when valid credentials or GCP runtime ADC exist
let adminApp: FirebaseAdminApp | null = null;
let hasAdminCredentials = false;

const isGcpRuntime =
  process.env.RENDER !== 'true' &&
  Boolean(
    process.env.K_SERVICE ||
      process.env.CLOUD_RUN_JOB ||
      process.env.GAE_APPLICATION ||
      process.env.FUNCTION_TARGET ||
      process.env.GOOGLE_CLOUD_WORKSTATIONS
  );

const configuredProjectId = (process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId || '').trim();

if (getApps().length === 0) {
  const serviceAccountRaw = (
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    ''
  ).trim();
  if (serviceAccountRaw) {
    try {
      let normalizedJson = serviceAccountRaw;
      if (
        (normalizedJson.startsWith("'") && normalizedJson.endsWith("'")) ||
        (normalizedJson.startsWith('"') && normalizedJson.endsWith('"') && !normalizedJson.startsWith('"{'))
      ) {
        normalizedJson = normalizedJson.slice(1, -1).trim();
      }
      const parsed = JSON.parse(normalizedJson);
      const serviceAccount = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
      if (typeof serviceAccount.private_key === 'string') {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
        throw new Error('Missing client_email or private_key in Firebase service account JSON');
      }
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || configuredProjectId,
      });
      hasAdminCredentials = true;
      console.log(`[FIREBASE] Admin SDK initialized with service account for project: ${adminApp.options.projectId}`);
    } catch (e) {
      console.error('[FIREBASE] Invalid FIREBASE_SERVICE_ACCOUNT_JSON; disabling Admin SDK fallback:', (e as Error)?.message);
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    adminApp = initializeApp({ projectId: configuredProjectId });
    hasAdminCredentials = true;
    console.log(`[FIREBASE] Admin SDK initialized with GOOGLE_APPLICATION_CREDENTIALS for project: ${adminApp.options.projectId}`);
  } else if (isGcpRuntime) {
    adminApp = initializeApp({ projectId: configuredProjectId });
    hasAdminCredentials = true;
    console.log(`[FIREBASE] Admin SDK initialized with GCP ADC for project: ${adminApp.options.projectId}`);
  } else {
    console.warn('[FIREBASE] Admin SDK credentials not configured (set FIREBASE_SERVICE_ACCOUNT_JSON env var on Render). Running with in-memory/client fallback.');
  }
} else {
  adminApp = getApps()[0];
  hasAdminCredentials = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
      (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) ||
      isGcpRuntime
  );
}

// Guard against background gRPC/google-gax ADC lookup crashes on non-GCP hosts (e.g. Render)
const isAdcCredentialError = (err: any) => {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('NO_ADC_FOUND') ||
    msg.includes('MetadataLookup')
  );
};

process.on('unhandledRejection', (reason: any) => {
  if (isAdcCredentialError(reason)) {
    hasAdminCredentials = false;
    console.warn('[FIREBASE] Disabled Admin SDK after ADC lookup error:', String(reason?.message || reason));
    return;
  }
  console.error('[SERVER] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err: any) => {
  if (isAdcCredentialError(err)) {
    hasAdminCredentials = false;
    console.warn('[FIREBASE] Caught async ADC exception; Admin SDK disabled safely:', String(err?.message || err));
    return;
  }
  console.error('[SERVER] Uncaught Exception:', err);
  process.exit(1);
});

// In AI Studio / Render, the database ID is crucial for non-default databases
const dbId = (process.env.FIREBASE_DATABASE_ID || (firebaseConfig as any).firestoreDatabaseId || '').trim();

function getDb(useDefault = false) {
  if (!hasAdminCredentials || !adminApp) return null;
  try {
    if (!useDefault && dbId) {
      return getFirestore(adminApp, dbId);
    }
    return getFirestore(adminApp);
  } catch (err) {
    console.error('Critical error getting Firestore instance:', err);
    return null;
  }
}

function getUsersCol(useDefault = false) {
  const firestore = getDb(useDefault);
  return firestore ? firestore.collection('users') : null;
}

const PORT =
  process.env.NODE_ENV !== 'production' || (process.env.PORT === '8080' && process.env.RENDER !== 'true')
    ? 3000
    : Number(process.env.PORT) || 3000;

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
    telegram_id: (process.env.OWNER_ID || '').trim() || undefined,
    phone_number: '09057586655',
    full_name: 'مدیر میانجی',
    kyc_status: 'verified',
    wallet_balance: 50000000,
    escrow_locked_balance: 0,
    role: 'owner',
    is_blocked: false,
  });

  // Server-side HMAC session tokens (for resilient Admin/Impersonation auth across Render & Preview)
  const runtimeSecret =
    process.env.ADMIN_SESSION_SECRET ||
    crypto
      .createHash('sha256')
      .update(
        process.env.BOT_TOKEN ||
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
          `mianji-ephemeral-${process.pid}-${Date.now()}`
      )
      .digest('hex');

  const signSessionToken = (uid: string, role: string) => {
    const payload = Buffer.from(
      JSON.stringify({ uid: String(uid), role: String(role || 'user'), exp: Date.now() + 86400000 })
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', runtimeSecret).update(payload).digest('hex');
    return `${payload}.${sig}`;
  };

  const verifySessionToken = (token: string | undefined): { uid: string; role: string } | null => {
    if (!token || typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = crypto.createHmac('sha256', runtimeSecret).update(payload).digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!parsed?.uid || !parsed?.exp || Date.now() > Number(parsed.exp)) return null;
      return { uid: String(parsed.uid), role: String(parsed.role || 'user') };
    } catch {
      return null;
    }
  };

  interface GlobalLimits {
    min_deal_amount: number;
    default_max_deal_amount: number;
    default_daily_withdraw_limit: number;
    default_max_active_deals: number;
    max_admin_balance_adjust: number;
  }

  let globalLimits: GlobalLimits = {
    min_deal_amount: 10000,
    default_max_deal_amount: 100000000,
    default_daily_withdraw_limit: 50000000,
    default_max_active_deals: 10,
    max_admin_balance_adjust: 20000000,
  };

  const loadGlobalLimits = async (): Promise<GlobalLimits> => {
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('system_settings').doc('limits').get();
        if (snap.exists) {
          const d = snap.data() || {};
          globalLimits = {
            min_deal_amount: Number(d.min_deal_amount ?? globalLimits.min_deal_amount),
            default_max_deal_amount: Number(d.default_max_deal_amount ?? globalLimits.default_max_deal_amount),
            default_daily_withdraw_limit: Number(d.default_daily_withdraw_limit ?? globalLimits.default_daily_withdraw_limit),
            default_max_active_deals: Number(d.default_max_active_deals ?? globalLimits.default_max_active_deals),
            max_admin_balance_adjust: Number(d.max_admin_balance_adjust ?? globalLimits.max_admin_balance_adjust),
          };
        }
      } catch {}
    }
    return globalLimits;
  };

  const getAllUsersMerged = async () => {
    const merged = new Map<string, any>();

    // 1. Seed / in-memory users first (lower priority)
    for (const [id, u] of memoryUsers.entries()) {
      merged.set(String(id), { ...u, id: String(id) });
    }

    // 2. Supabase users
    if (supabase) {
      try {
        const { data } = await supabase.from('users').select('*');
        if (Array.isArray(data)) {
          for (const u of data) {
            const uid = String(u.id);
            const prev = merged.get(uid) || {};
            merged.set(uid, { ...prev, ...u, id: uid });
          }
        }
      } catch {}
    }

    // 3. Firestore users (highest priority)
    if (hasAdminCredentials) {
      try {
        let usersSnapshot: any = null;
        const primaryUsers = getUsersCol();
        if (primaryUsers) {
          try {
            usersSnapshot = await primaryUsers.limit(300).get();
          } catch {
            const fallbackUsers = getUsersCol(true);
            if (fallbackUsers) {
              try {
                usersSnapshot = await fallbackUsers.limit(300).get();
              } catch {}
            }
          }
        }
        if (usersSnapshot && usersSnapshot.docs) {
          for (const doc of usersSnapshot.docs) {
            const d = doc.data() || {};
            const uid = String(doc.id);
            const prev = merged.get(uid) || {};
            merged.set(uid, {
              ...prev,
              ...d,
              id: uid,
              updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt || prev.updatedAt,
            });
          }
        }
      } catch {}
    }

    const ownerId = (process.env.OWNER_ID || '').trim();
    const adminId = (process.env.ADMIN_ID || '').trim();
    return Array.from(merged.values()).map((u) => {
      const uid = String(u.id);
      let role = u.role || 'user';
      if (ownerId && (uid === ownerId || String(u.telegram_id || '') === ownerId)) role = 'owner';
      else if (adminId && (uid === adminId || String(u.telegram_id || '') === adminId) && role !== 'owner') role = 'admin';
      return { ...u, role, is_blocked: Boolean(u.is_blocked) };
    });
  };

  const getUserById = async (targetId: string) => {
    const all = await getAllUsersMerged();
    return all.find((u) => String(u.id) === String(targetId)) || null;
  };

  const authenticateAdmin = async (req: express.Request): Promise<{ actor: any } | { error: string; status: number }> => {
    const ownerId = (process.env.OWNER_ID || '').trim();
    const adminId = (process.env.ADMIN_ID || '').trim();

    // 1. Check HMAC session token header
    const sessionHeader = req.headers['x-session-token'];
    const sessionToken = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const sessionClaims = verifySessionToken(sessionToken);

    if (sessionClaims) {
      const liveUser = await getUserById(sessionClaims.uid);
      const role = liveUser?.role || sessionClaims.role;
      if (liveUser?.is_blocked) {
        return { status: 403, error: 'حساب مدیریت شما مسدود است.' };
      }
      if (role === 'owner' || role === 'admin') {
        return { actor: liveUser || { id: sessionClaims.uid, role } };
      }
      return { status: 403, error: 'شما دسترسی مدیریت ندارید.' };
    }

    // 2. Check Firebase Bearer ID token
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ') && hasAdminCredentials && adminApp) {
      const idToken = authHeader.slice(7).trim();
      try {
        const decoded = await getAuth(adminApp).verifyIdToken(idToken);
        const uid = String(decoded.uid);
        const liveUser = await getUserById(uid);
        const isRootEmail = decoded.email === 'miyanjiescrow@gmail.com' && decoded.email_verified;
        const resolvedRole =
          liveUser?.role ||
          (isRootEmail || (ownerId && uid === ownerId) ? 'owner' : adminId && uid === adminId ? 'admin' : 'user');
        if (liveUser?.is_blocked) {
          return { status: 403, error: 'حساب کاربری مسدود است.' };
        }
        if (resolvedRole === 'owner' || resolvedRole === 'admin') {
          return { actor: liveUser || { id: uid, role: resolvedRole, full_name: decoded.name || 'مدیر' } };
        }
        return { status: 403, error: 'فقط مالک و ادمین‌ها به این بخش دسترسی دارند.' };
      } catch {
        // fall through to preview check if applicable
      }
    }

    // 3. Preview fallback ONLY when not in production and Admin credentials are missing
    if (!isProd && !hasAdminCredentials) {
      const previewId = String(req.headers['x-preview-admin-id'] || '').trim();
      if (previewId) {
        const memUser = memoryUsers.get(previewId);
        if (memUser && (memUser.role === 'owner' || memUser.role === 'admin') && !memUser.is_blocked) {
          return { actor: memUser };
        }
      }
    }

    return { status: 401, error: 'نشست مدیریتی منقضی شده یا نامعتبر است. لطفاً دوباره وارد شوید.' };
  };

  const findUserByPhone = async (targetCleanPhone: string, targetCoreDigits: string) => {
    // 1. Check Supabase (if configured)
    if (supabase) {
      try {
        const { data } = await supabase.from('users').select('*');
        if (data && data.length > 0) {
          const match = data.find((u: any) =>
            extractCleanPhone(u.phone_number || u.phone || u.phoneNumber || u.mobile).endsWith(targetCoreDigits)
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

    // 2. Check Firestore (named dbId first, fallback to default db) when Admin credentials exist
    if (hasAdminCredentials) {
      try {
        let usersSnapshot: any = null;
        const primaryUsers = getUsersCol();
        if (primaryUsers) {
          try {
            usersSnapshot = await primaryUsers.get();
          } catch {
            const fallbackUsers = getUsersCol(true);
            if (fallbackUsers) {
              try {
                usersSnapshot = await fallbackUsers.get();
              } catch (e) {
                console.warn('[FIRESTORE] Admin read unavailable:', (e as Error)?.message || e);
              }
            }
          }
        }
        if (usersSnapshot && usersSnapshot.docs) {
          const match = usersSnapshot.docs.find((doc: any) => {
            const d = doc.data() || {};
            return extractCleanPhone(d.phone_number || d.phone || d.phoneNumber || d.mobile).endsWith(targetCoreDigits);
          });
          if (match) {
            console.log(`[FIRESTORE] User found: ${match.id} for phone ${targetCleanPhone}`);
            return { id: match.id, ...match.data() };
          }
        }
      } catch {}
    }

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
      firebaseAdminReady: hasAdminCredentials,
      firebaseProjectId: adminApp?.options.projectId || configuredProjectId,
      firebaseDatabaseConfigured: Boolean(dbId),
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

      if (foundUser.is_blocked) {
        return res.status(403).json({
          success: false,
          blocked: true,
          error: foundUser.blocked_reason
            ? `حساب کاربری شما مسدود شده است: ${foundUser.blocked_reason}`
            : 'حساب کاربری شما توسط مدیریت مسدود شده است.',
        });
      }

      const resolveTelegramChatId = (userObj: any): string | null => {
        const candidates = [
          userObj?.telegram_id,
          userObj?.telegramId,
          userObj?.tg_id,
          userObj?.chat_id,
          userObj?.chatId,
          userObj?.id,
          userObj?.role === 'owner' || userObj?.id === 'u_admin_owner' ? process.env.OWNER_ID : null,
          userObj?.role === 'admin' ? process.env.ADMIN_ID : null,
        ];
        for (const c of candidates) {
          const s = String(c ?? '').trim();
          if (/^-?\d+$/.test(s)) return s;
          const uMatch = s.match(/^u_(-?\d+)$/);
          if (uMatch) return uMatch[1];
        }
        return null;
      };

      const targetTelegramId = resolveTelegramChatId(foundUser);
      const actualPhone = foundUser.phone_number || foundUser.phone || cleanPhone;
      const code = crypto.randomInt(100000, 1000000).toString();
      const expires = Date.now() + 15 * 60000; // 15 minutes
      otps.set(coreDigits, { code, expires, attempts: 0 });

      console.log(`[AUTH] Generated OTP for ${coreDigits} (targetTelegramId=${targetTelegramId || 'none'})`);

      const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
      let telegramDelivered = false;
      let deliveryFailureReason = '';
      let needBotStart = false;

      if (!botToken) {
        deliveryFailureReason = 'توکن ربات تلگرام (BOT_TOKEN) روی سرور تنظیم نشده است.';
        console.warn('[AUTH] BOT_TOKEN is not configured; cannot send Telegram OTP');
      } else if (!targetTelegramId) {
        deliveryFailureReason =
          'شناسه تلگرام برای این شماره ثبت نشده است. لطفاً ابتدا وارد ربات تلگرام شوید، دکمه Start را بزنید و شماره خود را تایید کنید.';
        needBotStart = true;
        console.warn(`[AUTH] No numeric Telegram ID resolved for user ${foundUser.id}`);
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              chat_id: targetTelegramId,
              text:
                `🔐 *کد تایید میانجی*\n\n` +
                `کد ورود شما: \`${code}\`\n\n` +
                `⚠️ این کد تا ۱۵ دقیقه دیگر معتبر است. لطفا آن را در اختیار دیگران قرار ندهید.`,
              parse_mode: 'Markdown',
            }),
          });
          const tgJson: any = await tgRes.json().catch(() => ({}));
          if (tgRes.ok && tgJson?.ok) {
            telegramDelivered = true;
            console.log(`[AUTH] Sent Telegram OTP to chat ${targetTelegramId}`);
          } else {
            const errCode = tgJson?.error_code || tgRes.status;
            const desc = String(tgJson?.description || tgRes.statusText || 'Unknown Telegram error');
            console.error(`[AUTH] Telegram API rejected sendMessage (${errCode}): ${desc}`);
            if (errCode === 403 || desc.toLowerCase().includes('chat not found') || desc.toLowerCase().includes('blocked')) {
              deliveryFailureReason =
                'ربات امکان ارسال پیام به حساب تلگرام شما را ندارد. لطفاً وارد ربات شوید، دکمه Start را بزنید (یا ربات را از بلاک خارج کنید) و دوباره تلاش کنید.';
              needBotStart = true;
            } else if (errCode === 401) {
              deliveryFailureReason = 'توکن ربات تلگرام (BOT_TOKEN) نامعتبر است.';
            } else {
              deliveryFailureReason = `ارسال پیام توسط تلگرام ناموفق بود (${errCode}). لطفاً لحظاتی بعد دوباره تلاش کنید.`;
            }
          }
        } catch (err: any) {
          console.error('[AUTH] Failed to send Telegram OTP via Bot API:', err?.message || err);
          deliveryFailureReason = 'ارتباط سرور با تلگرام برقرار نشد. لطفاً چند لحظه بعد دوباره تلاش کنید.';
        } finally {
          clearTimeout(timer);
        }
      }

      // In production, never pretend OTP was sent to Telegram if delivery failed
      if (isProd && !telegramDelivered) {
        otps.delete(coreDigits);
        return res.status(502).json({
          success: false,
          telegramDelivered: false,
          needRegistration: needBotStart,
          error: deliveryFailureReason || 'ارسال کد به تلگرام انجام نشد. لطفاً ابتدا ربات را استارت کنید.',
        });
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
      if (user.is_blocked) {
        return res.status(403).json({
          success: false,
          blocked: true,
          error: user.blocked_reason
            ? `حساب کاربری شما مسدود شده است: ${user.blocked_reason}`
            : 'حساب کاربری شما توسط مدیریت مسدود شده است.',
        });
      }

      let customToken: string | null = null;
      if (hasAdminCredentials && adminApp) {
        try {
          customToken = await getAuth(adminApp).createCustomToken(user.id.toString());
        } catch {
          console.warn('[AUTH] createCustomToken unavailable in current environment; returning session fallback');
        }
      }

      const sessionToken = signSessionToken(user.id.toString(), user.role || 'user');
      res.json({ success: true, user, customToken, sessionToken });
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

      const ownerId = (process.env.OWNER_ID || '').trim();
      const adminId = (process.env.ADMIN_ID || '').trim();
      const resolvedRole = ownerId && userId === ownerId ? 'owner' : adminId && userId === adminId ? 'admin' : 'user';

      const usersCol = getUsersCol();
      if (usersCol) {
        try {
          const userRef = usersCol.doc(userId);
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
              role: resolvedRole,
              updatedAt: FieldValue.serverTimestamp(),
            };
            await userRef.set(newDocData);
            userData = { ...newDocData, updatedAt: new Date().toISOString() };
          } else {
            userData = { id: userDoc.id, ...userDoc.data() };
          }
        } catch (dbErr) {
          console.warn('[TWA] Firestore Admin unavailable, using in-memory profile:', (dbErr as Error)?.message);
        }
      }

      if (!userData) {
        const existingMem = memoryUsers.get(userId);
        userData = existingMem || {
          id: userId,
          telegram_id: userId,
          full_name: fullName,
          username,
          phone_number: '',
          kyc_status: 'pending',
          wallet_balance: 0,
          escrow_locked_balance: 0,
          role: resolvedRole,
        };
        memoryUsers.set(userId, userData);
      }

      if (userData?.is_blocked) {
        return res.status(403).json({
          success: false,
          blocked: true,
          error: userData.blocked_reason
            ? `حساب کاربری شما مسدود شده است: ${userData.blocked_reason}`
            : 'حساب کاربری شما توسط مدیریت مسدود شده است.',
        });
      }

      let customToken: string | null = null;
      if (hasAdminCredentials && adminApp) {
        try {
          customToken = await getAuth(adminApp).createCustomToken(userId);
        } catch {
          console.warn('[TWA] createCustomToken unavailable; returning session fallback');
        }
      }

      const sessionToken = signSessionToken(userId, userData?.role || resolvedRole);
      res.json({ success: true, user: userData, customToken, sessionToken });
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
      const ownerId = (process.env.OWNER_ID || '').trim();
      const adminId = (process.env.ADMIN_ID || '').trim();
      const existingMem = memoryUsers.get(userId);
      const userData = {
        id: userId,
        phone_number: cleanPhone,
        full_name: fullName || existingMem?.full_name || 'کاربر میانجی',
        kyc_status: existingMem?.kyc_status || 'verified',
        wallet_balance: existingMem?.wallet_balance ?? 0,
        escrow_locked_balance: existingMem?.escrow_locked_balance ?? 0,
        role:
          existingMem?.role ||
          (ownerId && userId === ownerId ? 'owner' : adminId && userId === adminId ? 'admin' : 'user'),
      };

      memoryUsers.set(userId, { ...userData, telegram_id: userId });

      const usersCol = getUsersCol();
      if (usersCol) {
        try {
          const docRef = usersCol.doc(userId);
          const snap = await docRef.get();
          if (snap.exists) {
            await docRef.set(
              {
                id: userId,
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

  // --- Effective Platform Limits & Admin User Management ---
  app.get('/api/limits/effective', async (_req, res) => {
    try {
      const limits = await loadGlobalLimits();
      res.json({ success: true, limits });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت محدودیت‌ها' });
    }
  });

  app.put('/api/admin/limits', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    if (authResult.actor.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'فقط مالک کل (Owner) می‌تواند محدودیت‌های پایه سیستم را تغییر دهد.' });
    }

    try {
      const body = req.body || {};
      const nextLimits: GlobalLimits = {
        min_deal_amount: Math.max(1000, Number(body.min_deal_amount ?? globalLimits.min_deal_amount) || 10000),
        default_max_deal_amount: Math.max(10000, Number(body.default_max_deal_amount ?? globalLimits.default_max_deal_amount) || 100000000),
        default_daily_withdraw_limit: Math.max(10000, Number(body.default_daily_withdraw_limit ?? globalLimits.default_daily_withdraw_limit) || 50000000),
        default_max_active_deals: Math.max(1, Math.min(200, Number(body.default_max_active_deals ?? globalLimits.default_max_active_deals) || 10)),
        max_admin_balance_adjust: Math.max(0, Number(body.max_admin_balance_adjust ?? globalLimits.max_admin_balance_adjust) || 20000000),
      };
      globalLimits = nextLimits;

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('system_settings').doc('limits').set(
            { ...nextLimits, updatedAt: FieldValue.serverTimestamp(), updated_by: String(authResult.actor.id) },
            { merge: true }
          );
        } catch (e) {
          console.warn('[ADMIN] Failed to persist global limits to Firestore:', (e as Error)?.message);
        }
      }

      console.log(`[ADMIN-AUDIT] Owner ${authResult.actor.id} updated global limits`);
      res.json({ success: true, limits: nextLimits });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ذخیره محدودیت‌ها' });
    }
  });

  app.get('/api/admin/users', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }

    try {
      const limits = await loadGlobalLimits();
      const allUsers = await getAllUsersMerged();
      const q = normalizeDigits(String(req.query.q || '')).toLowerCase();

      const filtered = q
        ? allUsers.filter((u) => {
            const name = String(u.full_name || '').toLowerCase();
            const phone = extractCleanPhone(u.phone_number || u.phone || '');
            const username = String(u.username || '').toLowerCase();
            const id = String(u.id || '').toLowerCase();
            const tgId = String(u.telegram_id || '').toLowerCase();
            return (
              name.includes(q) ||
              phone.includes(extractCleanPhone(q) || q) ||
              username.includes(q) ||
              id.includes(q) ||
              tgId.includes(q)
            );
          })
        : allUsers;

      // Sort: owner/admin first, then verified/recent
      filtered.sort((a, b) => {
        const rank = (r: string) => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
        return rank(a.role) - rank(b.role);
      });

      res.json({ success: true, users: filtered, globalLimits: limits });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت لیست کاربران' });
    }
  });

  app.post('/api/admin/users', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }

    try {
      const { full_name, phone_number, username, wallet_balance, role, kyc_status, max_deal_amount, daily_withdraw_limit, max_active_deals } =
        req.body || {};
      const cleanPhone = extractCleanPhone(phone_number || '');
      const cleanName = String(full_name || '').trim();
      if (!cleanName || cleanPhone.length < 10) {
        return res.status(400).json({ success: false, error: 'نام کامل و شماره همراه معتبر الزامی است.' });
      }
      if (role && role !== 'user' && authResult.actor.role !== 'owner') {
        return res.status(403).json({ success: false, error: 'فقط مالک کل می‌تواند نقش مدیر تعیین کند.' });
      }

      const userId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const newUser: any = {
        id: userId,
        full_name: cleanName.slice(0, 100),
        phone_number: cleanPhone.slice(0, 20),
        username: String(username || '').trim().slice(0, 64),
        role: ['user', 'admin', 'owner'].includes(role) ? role : 'user',
        kyc_status: ['pending', 'verified', 'rejected'].includes(kyc_status) ? kyc_status : 'verified',
        wallet_balance: Math.max(0, Number(wallet_balance || 0)),
        escrow_locked_balance: 0,
        is_blocked: false,
      };
      if (Number(max_deal_amount) > 0) newUser.max_deal_amount = Number(max_deal_amount);
      if (Number(daily_withdraw_limit) > 0) newUser.daily_withdraw_limit = Number(daily_withdraw_limit);
      if (Number(max_active_deals) > 0) newUser.max_active_deals = Number(max_active_deals);

      memoryUsers.set(userId, newUser);

      const usersCol = getUsersCol();
      if (usersCol) {
        try {
          await usersCol.doc(userId).set({
            ...newUser,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.warn('[ADMIN] Firestore create user fallback:', (e as Error)?.message);
        }
      }

      console.log(`[ADMIN-AUDIT] ${authResult.actor.id} created user ${userId}`);
      res.json({ success: true, user: newUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ایجاد کاربر' });
    }
  });

  app.patch('/api/admin/users/:targetId', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }

    try {
      const targetId = String(req.params.targetId || '').trim();
      const targetUser = await getUserById(targetId);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: 'کاربر مورد نظر یافت نشد.' });
      }

      const actorIsOwner = authResult.actor.role === 'owner';
      if (targetUser.role === 'owner' && !actorIsOwner) {
        return res.status(403).json({ success: false, error: 'ادمین عادی مجاز به تغییر حساب مالک کل نیست.' });
      }

      const body = req.body || {};
      const limits = await loadGlobalLimits();
      const updates: Record<string, any> = {};

      if (typeof body.full_name === 'string' && body.full_name.trim()) {
        updates.full_name = body.full_name.trim().slice(0, 100);
      }
      if (typeof body.phone_number === 'string' && body.phone_number.trim()) {
        const clean = extractCleanPhone(body.phone_number);
        if (clean.length < 10) {
          return res.status(400).json({ success: false, error: 'شماره همراه وارد شده معتبر نیست.' });
        }
        updates.phone_number = clean.slice(0, 20);
      }
      if (typeof body.username === 'string') {
        updates.username = body.username.trim().slice(0, 64);
      }
      if (typeof body.kyc_status === 'string' && ['pending', 'verified', 'rejected'].includes(body.kyc_status)) {
        updates.kyc_status = body.kyc_status;
      }

      if (typeof body.role === 'string' && ['user', 'admin', 'owner'].includes(body.role) && body.role !== targetUser.role) {
        if (!actorIsOwner) {
          return res.status(403).json({ success: false, error: 'فقط مالک کل می‌تواند نقش کاربران را تغییر دهد.' });
        }
        if (String(authResult.actor.id) === targetId && body.role !== 'owner') {
          return res.status(400).json({ success: false, error: 'امکان تنزل نقش مالک فعلی وجود ندارد.' });
        }
        updates.role = body.role;
      }

      if (body.wallet_balance !== undefined) {
        const nextBal = Number(body.wallet_balance);
        if (Number.isNaN(nextBal) || nextBal < 0) {
          return res.status(400).json({ success: false, error: 'موجودی کیف پول نمی‌تواند منفی باشد.' });
        }
        const delta = Math.abs(nextBal - Number(targetUser.wallet_balance || 0));
        if (!actorIsOwner && limits.max_admin_balance_adjust > 0 && delta > limits.max_admin_balance_adjust) {
          return res.status(403).json({
            success: false,
            error: `سقف تغییر موجودی توسط ادمین در هر مرحله ${limits.max_admin_balance_adjust.toLocaleString()} تومان است.`,
          });
        }
        updates.wallet_balance = nextBal;
      }

      if (body.escrow_locked_balance !== undefined) {
        const nextLocked = Number(body.escrow_locked_balance);
        if (Number.isNaN(nextLocked) || nextLocked < 0) {
          return res.status(400).json({ success: false, error: 'موجودی قفل امانی نمی‌تواند منفی باشد.' });
        }
        const deltaLocked = Math.abs(nextLocked - Number(targetUser.escrow_locked_balance || 0));
        if (!actorIsOwner && limits.max_admin_balance_adjust > 0 && deltaLocked > limits.max_admin_balance_adjust) {
          return res.status(403).json({
            success: false,
            error: `سقف تغییر موجودی امانی توسط ادمین ${limits.max_admin_balance_adjust.toLocaleString()} تومان است.`,
          });
        }
        updates.escrow_locked_balance = nextLocked;
      }

      if (typeof body.is_blocked === 'boolean') {
        if (targetUser.role === 'owner' && body.is_blocked) {
          return res.status(400).json({ success: false, error: 'حساب مالک کل را نمی‌توان مسدود کرد.' });
        }
        if (String(authResult.actor.id) === targetId && body.is_blocked) {
          return res.status(400).json({ success: false, error: 'نمی‌توانید حساب خودتان را مسدود کنید.' });
        }
        updates.is_blocked = body.is_blocked;
      }
      if (typeof body.blocked_reason === 'string') {
        updates.blocked_reason = body.blocked_reason.trim().slice(0, 300);
      }

      if (body.max_deal_amount !== undefined) {
        const val = Math.max(0, Number(body.max_deal_amount) || 0);
        updates.max_deal_amount = val;
      }
      if (body.daily_withdraw_limit !== undefined) {
        const val = Math.max(0, Number(body.daily_withdraw_limit) || 0);
        updates.daily_withdraw_limit = val;
      }
      if (body.max_active_deals !== undefined) {
        const val = Math.max(0, Math.min(500, Number(body.max_active_deals) || 0));
        updates.max_active_deals = val;
      }
      if (typeof body.is_withdraw_locked === 'boolean') {
        updates.is_withdraw_locked = body.is_withdraw_locked;
      }
      if (typeof body.is_deal_locked === 'boolean') {
        updates.is_deal_locked = body.is_deal_locked;
      }
      if (typeof body.admin_note === 'string') {
        updates.admin_note = body.admin_note.trim().slice(0, 500);
      }

      const mergedUser = { ...targetUser, ...updates, id: targetId };
      memoryUsers.set(targetId, mergedUser);

      const usersCol = getUsersCol();
      if (usersCol) {
        try {
          await usersCol.doc(targetId).set(
            {
              ...mergedUser,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch (e) {
          console.warn('[ADMIN] Firestore update user fallback:', (e as Error)?.message);
        }
      }

      if (supabase && /^\d+$/.test(targetId)) {
        try {
          await supabase
            .from('users')
            .update({
              full_name: mergedUser.full_name,
              phone_number: mergedUser.phone_number,
              wallet_balance: mergedUser.wallet_balance,
              kyc_status: mergedUser.kyc_status,
            })
            .eq('id', Number(targetId));
        } catch {}
      }

      console.log(`[ADMIN-AUDIT] ${authResult.actor.id} updated user ${targetId} fields=[${Object.keys(updates).join(',')}]`);
      res.json({ success: true, user: mergedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ویرایش اطلاعات کاربر' });
    }
  });

  app.post('/api/admin/users/:targetId/impersonate', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }

    try {
      const targetId = String(req.params.targetId || '').trim();
      const targetUser = await getUserById(targetId);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: 'کاربر مورد نظر یافت نشد.' });
      }

      const actorIsOwner = authResult.actor.role === 'owner';
      if (!actorIsOwner && (targetUser.role === 'owner' || targetUser.role === 'admin')) {
        return res.status(403).json({ success: false, error: 'فقط مالک کل می‌تواند وارد حساب مدیران دیگر شود.' });
      }

      let customToken: string | null = null;
      if (hasAdminCredentials && adminApp) {
        try {
          customToken = await getAuth(adminApp).createCustomToken(targetId);
        } catch {
          console.warn('[ADMIN] createCustomToken unavailable for impersonation; using session fallback');
        }
      }

      const sessionToken = signSessionToken(targetId, targetUser.role || 'user');
      console.log(`[ADMIN-AUDIT] ${authResult.actor.id} impersonated user ${targetId}`);
      res.json({ success: true, user: targetUser, customToken, sessionToken });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ورود به حساب کاربر' });
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
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('channels').limit(50).get();
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
      }

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

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('channels').doc(channelId).set({
            ...record,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          await firestore.collection('channel_posts').doc(initialPost.id).set({
            ...initialPost,
            created_at: FieldValue.serverTimestamp(),
          });
        } catch {}
      }

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

      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore
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
      }

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

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('channel_posts').doc(postId).set({
            ...post,
            created_at: FieldValue.serverTimestamp(),
          });
          await firestore.collection('channels').doc(channelId).set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        } catch {}
      }

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
      const firestore = getDb();
      if (firestore) {
        try {
          await firestore
            .collection('channels')
            .doc(channelId)
            .update({
              subscribers_count: FieldValue.increment(subscribed ? 1 : -1),
              updatedAt: FieldValue.serverTimestamp(),
            });
        } catch {}
      }
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
