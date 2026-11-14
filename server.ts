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
import { WebSocketServer, WebSocket } from 'ws';
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
  app.use(express.json({ limit: '3mb' }));

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

  const authenticateActor = async (req: express.Request): Promise<{ actor: any } | { error: string; status: number }> => {
    const ownerId = (process.env.OWNER_ID || '').trim();
    const adminId = (process.env.ADMIN_ID || '').trim();

    // 1. Check HMAC session token header
    const sessionHeader = req.headers['x-session-token'];
    const sessionToken = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const sessionClaims = verifySessionToken(sessionToken);

    if (sessionClaims) {
      const liveUser = await getUserById(sessionClaims.uid);
      const role = liveUser?.role || sessionClaims.role || 'user';
      if (liveUser?.is_blocked) {
        return { status: 403, error: 'حساب کاربری شما مسدود شده است.' };
      }
      return { actor: liveUser || { id: sessionClaims.uid, role } };
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
        return { actor: liveUser || { id: uid, role: resolvedRole, full_name: decoded.name || 'کاربر میانجی' } };
      } catch {
        // fall through to preview check if applicable
      }
    }

    // 3. Preview fallback ONLY when not in production and Admin credentials are missing
    if (!isProd && !hasAdminCredentials) {
      const previewId = String(req.headers['x-preview-user-id'] || req.headers['x-preview-admin-id'] || '').trim();
      if (previewId) {
        const memUser = memoryUsers.get(previewId) || (await getUserById(previewId));
        if (memUser) {
          if (memUser.is_blocked) {
            return { status: 403, error: 'حساب کاربری مسدود است.' };
          }
          return { actor: memUser };
        }
        if (previewId.startsWith('u_')) {
          return { actor: { id: previewId, role: 'user', full_name: 'کاربر آزمایشی' } };
        }
      }
    }

    return { status: 401, error: 'نشست کاربری منقضی شده یا نامعتبر است. لطفاً دوباره وارد شوید.' };
  };

  const authenticateAdmin = async (req: express.Request): Promise<{ actor: any } | { error: string; status: number }> => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) return authResult;
    const role = authResult.actor?.role;
    if (role === 'owner' || role === 'admin') {
      return authResult;
    }
    return { status: 403, error: 'فقط مالک و ادمین‌ها به این بخش دسترسی دارند.' };
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

      wsBroadcastRoom(`channel:${channelId}`, 'channel:post', { channelId, post });
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

  // ============================================================================
  // REAL-TIME WEBSOCKET HUB + TELEGRAM BOT DISPATCHER + DOMAIN APIS
  // ============================================================================

  interface WsClientMeta {
    ws: WebSocket;
    userId: string;
    role: string;
    rooms: Set<string>;
  }

  const wsClientsByUser = new Map<string, Set<WsClientMeta>>();
  const wsClientsByRoom = new Map<string, Set<WsClientMeta>>();

  const wsSend = (ws: WebSocket, type: string, payload: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type, payload }));
      } catch {}
    }
  };

  const wsBroadcastUser = (userId: string | number, type: string, payload: any) => {
    const sockets = wsClientsByUser.get(String(userId));
    if (!sockets) return;
    for (const meta of sockets) wsSend(meta.ws, type, payload);
  };

  const wsBroadcastAdmins = async (type: string, payload: any) => {
    for (const sockets of wsClientsByUser.values()) {
      for (const meta of sockets) {
        if (meta.role === 'owner' || meta.role === 'admin') {
          wsSend(meta.ws, type, payload);
        }
      }
    }
  };

  const wsBroadcastRoom = (room: string, type: string, payload: any, excludeUserId?: string) => {
    const sockets = wsClientsByRoom.get(room);
    if (!sockets) return;
    for (const meta of sockets) {
      if (excludeUserId && meta.userId === excludeUserId) continue;
      wsSend(meta.ws, type, payload);
    }
  };

  const wsBroadcastAll = (type: string, payload: any) => {
    for (const sockets of wsClientsByUser.values()) {
      for (const meta of sockets) wsSend(meta.ws, type, payload);
    }
  };

  const getOnlineUserIds = () => Array.from(wsClientsByUser.keys());

  const resolveTgChatId = (userObj: any): string | null => {
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
      const m = s.match(/^u_(-?\d+)$/);
      if (m) return m[1];
    }
    return null;
  };

  const notifyTelegramUser = async (userOrId: any, text: string) => {
    const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!botToken || !text) return;
    try {
      const targetUser =
        typeof userOrId === 'object' && userOrId !== null ? userOrId : await getUserById(String(userOrId));
      const chatId = resolveTgChatId(targetUser || { id: String(userOrId) });
      if (!chatId) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
        }),
      }).catch(() => {});
      clearTimeout(timer);
    } catch {}
  };

  const memoryNotifications = new Map<string, any[]>();
  const pushUserNotification = async (userId: string, title: string, message: string, tgText?: string) => {
    const uid = String(userId);
    const noteId = `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record = {
      id: noteId,
      user_id: uid,
      title: String(title || '').slice(0, 200),
      message: String(message || '').slice(0, 1000),
      is_read: false,
      createdAt: new Date().toISOString(),
    };
    const prev = memoryNotifications.get(uid) || [];
    memoryNotifications.set(uid, [record, ...prev].slice(0, 50));

    const firestore = getDb();
    if (firestore) {
      try {
        await firestore.collection('notifications').doc(noteId).set({
          user_id: uid,
          title: record.title,
          message: record.message,
          is_read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch {}
    }

    wsBroadcastUser(uid, 'notification:new', { userId: uid, notification: record });
    if (tgText) {
      void notifyTelegramUser(uid, tgText);
    }
  };

  // --- Media Assets Store (for small images/voice/files <= 2MB) ---
  const memoryMedia = new Map<string, { buffer: Buffer; mimeType: string; filename: string }>();

  app.post('/api/media', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const { dataUrl, filename, mimeType } = req.body || {};
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        return res.status(400).json({ success: false, error: 'فرمت فایل نامعتبر است.' });
      }
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ success: false, error: 'داده base64 نامعتبر است.' });
      }
      const resolvedMime = String(mimeType || match[1] || 'application/octet-stream').slice(0, 100);
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'حجم فایل نباید بیشتر از ۲ مگابایت باشد.' });
      }

      if (memoryMedia.size > 150) {
        const firstKey = memoryMedia.keys().next().value;
        if (firstKey) memoryMedia.delete(firstKey);
      }

      const mediaId = `med_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const cleanFilename = String(filename || 'attachment').replace(/[^\w.\-\u0600-\u06FF ]/g, '').slice(0, 120) || 'file';
      memoryMedia.set(mediaId, { buffer, mimeType: resolvedMime, filename: cleanFilename });

      // Persist small assets (< 700KB decoded) in Firestore so reloads preserve media across restarts
      const firestore = getDb();
      if (firestore && buffer.length <= 650 * 1024) {
        try {
          await firestore.collection('media_assets').doc(mediaId).set({
            id: mediaId,
            uploader_id: String(authResult.actor.id),
            mimeType: resolvedMime,
            filename: cleanFilename,
            base64: match[2],
            createdAt: FieldValue.serverTimestamp(),
          });
        } catch {}
      }

      res.json({ success: true, id: mediaId, url: `/api/media/${mediaId}` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در آپلود فایل' });
    }
  });

  app.get('/api/media/:mediaId', async (req, res) => {
    const mediaId = String(req.params.mediaId || '').trim();
    let item = memoryMedia.get(mediaId);
    if (!item) {
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('media_assets').doc(mediaId).get();
          if (snap.exists) {
            const d = snap.data() || {};
            if (typeof d.base64 === 'string') {
              item = {
                buffer: Buffer.from(d.base64, 'base64'),
                mimeType: d.mimeType || 'application/octet-stream',
                filename: d.filename || 'file',
              };
              memoryMedia.set(mediaId, item);
            }
          }
        } catch {}
      }
    }
    if (!item) return res.status(404).send('Not found');
    res.setHeader('Content-Type', item.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(item.buffer);
  });

  // --- Notifications API ---
  app.get('/api/notifications', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const uid = String(authResult.actor.id);
    const merged = new Map<string, any>();
    (memoryNotifications.get(uid) || []).forEach((n) => merged.set(n.id, n));
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('notifications').where('user_id', '==', uid).limit(30).get();
        snap.docs.forEach((doc) => {
          const d = doc.data() || {};
          merged.set(doc.id, {
            id: doc.id,
            ...d,
            createdAt: d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt || new Date().toISOString(),
          });
        });
      } catch {}
    }
    const list = Array.from(merged.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    res.json({ success: true, notifications: list });
  });

  app.post('/api/notifications/read', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const targetId = req.body?.id ? String(req.body.id).trim() : null;
      const list = memoryNotifications.get(uid) || [];
      const updated = list.map((n) => (!targetId || String(n.id) === targetId ? { ...n, is_read: true } : n));
      memoryNotifications.set(uid, updated);

      const firestore = getDb();
      if (firestore) {
        try {
          if (targetId) {
            await firestore.collection('notifications').doc(targetId).set({ is_read: true }, { merge: true });
          } else {
            const snap = await firestore.collection('notifications').where('user_id', '==', uid).where('is_read', '==', false).get();
            await Promise.all(snap.docs.map((d) => d.ref.set({ is_read: true }, { merge: true })));
          }
        } catch {}
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در بروزرسانی اعلان‌ها' });
    }
  });

  // --- Atomic Deals Store & Escrow Financial Engine ---
  const memoryDeals = new Map<string, any>();
  const memoryTransactions = new Map<string, any[]>();
  const recordTransaction = async (
    firestore: FirebaseFirestore.Firestore | null,
    txData: {
      user_id: string;
      contract_id: string;
      amount: number;
      type: 'escrow_lock' | 'escrow_release' | 'deposit' | 'withdraw';
      status: 'pending' | 'completed' | 'rejected';
      description: string;
    }
  ) => {
    const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const record = { id: txId, ...txData, createdAt: new Date().toISOString() };
    const list = memoryTransactions.get(txData.user_id) || [];
    memoryTransactions.set(txData.user_id, [record, ...list]);
    if (firestore) {
      try {
        await firestore.collection('transactions').doc(txId).set({
          ...txData,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch {}
    }
    return record;
  };

  const saveUserBalances = async (
    uid: string,
    nextWallet: number,
    nextLocked: number,
    tx?: FirebaseFirestore.Transaction
  ) => {
    const existing = (await getUserById(uid)) || memoryUsers.get(uid);
    const updated = {
      ...(existing || { id: uid, full_name: 'کاربر میانجی', phone_number: '', kyc_status: 'verified', role: 'user' }),
      id: uid,
      wallet_balance: Math.max(0, Math.round(nextWallet)),
      escrow_locked_balance: Math.max(0, Math.round(nextLocked)),
    };
    memoryUsers.set(uid, updated);
    const usersCol = getUsersCol();
    if (usersCol) {
      if (tx) {
        tx.set(
          usersCol.doc(uid),
          {
            wallet_balance: updated.wallet_balance,
            escrow_locked_balance: updated.escrow_locked_balance,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else {
        await usersCol
          .doc(uid)
          .set(
            {
              wallet_balance: updated.wallet_balance,
              escrow_locked_balance: updated.escrow_locked_balance,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {});
      }
    }
    return updated;
  };

  const getAllDealsMerged = async () => {
    const merged = new Map<string, any>(memoryDeals);
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('deals').limit(200).get();
        snap.docs.forEach((doc) => {
          const d = doc.data() || {};
          merged.set(doc.id, {
            ...d,
            id: doc.id,
            contract_id: d.contract_id || doc.id,
            createdAt: d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt,
            updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt,
          });
        });
      } catch {}
    }
    return Array.from(merged.values());
  };

  const getDealByContractId = async (contractId: string) => {
    const cid = String(contractId || '').trim();
    const mem = memoryDeals.get(cid);
    const firestore = getDb();
    if (firestore) {
      try {
        const docSnap = await firestore.collection('deals').doc(cid).get();
        if (docSnap.exists) {
          const d = docSnap.data() || {};
          return {
            ...d,
            id: docSnap.id,
            contract_id: d.contract_id || docSnap.id,
            createdAt: d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt,
            updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt,
          };
        }
      } catch {}
    }
    return mem || null;
  };

  app.get('/api/deals', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const isAdminActor = authResult.actor.role === 'owner' || authResult.actor.role === 'admin';
      const includeAll = isAdminActor && req.query.scope === 'all';
      const all = await getAllDealsMerged();
      const filtered = includeAll
        ? all
        : all.filter((d) => String(d.buyer_id) === uid || String(d.seller_id) === uid);
      filtered.sort(
        (a, b) =>
          Date.parse(String(b.createdAt || b.created_at || 0)) -
          Date.parse(String(a.createdAt || a.created_at || 0))
      );
      res.json({ success: true, deals: filtered });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت معاملات' });
    }
  });

  app.post('/api/deals', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      if (actor.is_deal_locked) {
        return res.status(403).json({ success: false, error: 'امکان ثبت معامله جدید برای حساب شما محدود شده است.' });
      }

      const { title, amount, role, phone, category, description, deadline, revisions, contract_id } = req.body || {};
      const cleanTitle = String(title || '').trim().slice(0, 200);
      const numAmount = Number(amount || 0);
      const cleanPhone = extractCleanPhone(String(phone || ''));
      const limits = await loadGlobalLimits();

      if (cleanTitle.length < 3) {
        return res.status(400).json({ success: false, error: 'عنوان معامله باید حداقل ۳ کاراکتر باشد.' });
      }
      if (!numAmount || numAmount < limits.min_deal_amount) {
        return res.status(400).json({
          success: false,
          error: `مبلغ معامله باید حداقل ${limits.min_deal_amount.toLocaleString()} تومان باشد.`,
        });
      }
      const userMax = Number(actor.max_deal_amount || limits.default_max_deal_amount || 0);
      if (userMax > 0 && numAmount > userMax) {
        return res.status(400).json({
          success: false,
          error: `سقف مجاز مبلغ هر معامله برای شما ${userMax.toLocaleString()} تومان است.`,
        });
      }

      const allDeals = await getAllDealsMerged();
      const myActiveDeals = allDeals.filter(
        (d) =>
          (String(d.buyer_id) === String(actor.id) || String(d.seller_id) === String(actor.id)) &&
          !['completed', 'cancelled'].includes(String(d.status || ''))
      ).length;
      const maxActive = Number(actor.max_active_deals || limits.default_max_active_deals || 0);
      if (maxActive > 0 && myActiveDeals >= maxActive) {
        return res.status(400).json({
          success: false,
          error: `شما به سقف مجاز معاملات فعال همزمان (${maxActive} معامله) رسیده‌اید.`,
        });
      }

      if (cleanPhone.length < 10) {
        return res.status(400).json({ success: false, error: 'شماره همراه طرف مقابل معتبر نیست.' });
      }
      const counterparty = await findUserByPhone(cleanPhone, cleanPhone.slice(-10));
      let otherId = counterparty ? String(counterparty.id) : '';
      if (!otherId) {
        if (isProd || hasAdminCredentials) {
          return res.status(404).json({
            success: false,
            error: 'شماره همراه طرف مقابل در سیستم میانجی یافت نشد. او باید ابتدا ربات تلگرام را استارت کند.',
          });
        }
        otherId = `u_${cleanPhone.slice(-10)}`;
      }
      if (otherId === String(actor.id)) {
        return res.status(400).json({ success: false, error: 'امکان ایجاد معامله با حساب خودتان وجود ندارد.' });
      }

      const cid = String(contract_id || `M-${crypto.randomInt(100000, 999999)}`).replace(/[^a-zA-Z0-9_-]/g, '');
      const nowIso = new Date().toISOString();
      const buyerId = role === 'buyer' ? String(actor.id) : otherId;
      const sellerId = role === 'seller' ? String(actor.id) : otherId;

      const dealRecord: any = {
        id: cid,
        contract_id: cid,
        title: cleanTitle,
        amount: numAmount,
        buyer_id: buyerId,
        seller_id: sellerId,
        status: 'draft',
        category: String(category || 'digital').slice(0, 50),
        description: String(description || '').slice(0, 2000),
        deadline: String(deadline || '7').slice(0, 20),
        revisions: String(revisions || '2').slice(0, 20),
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      memoryDeals.set(cid, dealRecord);

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('deals').doc(cid).set({
            contract_id: cid,
            title: dealRecord.title,
            amount: dealRecord.amount,
            buyer_id: buyerId,
            seller_id: sellerId,
            status: 'draft',
            category: dealRecord.category,
            description: dealRecord.description,
            deadline: dealRecord.deadline,
            revisions: dealRecord.revisions,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.warn('[DEALS] Firestore write fallback:', (err as Error)?.message);
        }
      }

      await pushUserNotification(
        otherId,
        'قرارداد امن جدید ثبت شد',
        `${actor.full_name || 'طرف مقابل'} قرارداد «${cleanTitle}» به مبلغ ${numAmount.toLocaleString()} تومان را با شما ثبت کرد.`,
        `🤝 <b>قرارداد جدید میانجی</b>\n\nعنوان: <b>${cleanTitle}</b>\nشناسه: <code>${cid}</code>\nمبلغ: <b>${numAmount.toLocaleString()} تومان</b>\n\nلطفاً وارد وب‌اپ میانجی شوید و قرارداد را بررسی کنید.`
      );

      wsBroadcastUser(buyerId, 'deal:updated', { contract: dealRecord });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: dealRecord });
      res.json({ success: true, deal: dealRecord });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ایجاد معامله' });
    }
  });

  app.post('/api/deals/:contractId/transition', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const cid = String(req.params.contractId || '').trim();
      const nextStatus = String(req.body?.status || '').trim();
      const deal = await getDealByContractId(cid);
      if (!deal) {
        return res.status(404).json({ success: false, error: 'قرارداد مورد نظر یافت نشد.' });
      }

      const uid = String(actor.id);
      const isBuyer = uid === String(deal.buyer_id);
      const isSeller = uid === String(deal.seller_id);
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      if (!isBuyer && !isSeller && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'شما مجاز به تغییر وضعیت این معامله نیستید.' });
      }

      const cur = String(deal.status);
      if (['completed', 'cancelled'].includes(cur)) {
        return res.status(400).json({ success: false, error: 'این قرارداد پیش‌تر مختومه شده است.' });
      }

      // Transition validation
      const allowed =
        (cur === 'draft' && nextStatus === 'awaiting_payment' && (isBuyer || isAdminActor)) ||
        (cur === 'awaiting_payment' && nextStatus === 'active' && (isBuyer || isAdminActor)) ||
        (cur === 'active' && nextStatus === 'work_submitted' && (isSeller || isAdminActor)) ||
        (cur === 'work_submitted' && ['completed', 'active'].includes(nextStatus) && (isBuyer || isAdminActor)) ||
        (['draft', 'awaiting_payment'].includes(cur) && nextStatus === 'cancelled') ||
        (['awaiting_payment', 'active', 'work_submitted'].includes(cur) && nextStatus === 'disputed');

      if (!allowed) {
        return res.status(400).json({ success: false, error: 'تغییر وضعیت درخواستی در این مرحله مجاز نیست.' });
      }

      const amount = Number(deal.amount || 0);
      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      const firestore = getDb();
      const balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};

      // Atomic financial operations
      if (cur === 'awaiting_payment' && nextStatus === 'active') {
        // Buyer locks funds into escrow
        const buyer = (await getUserById(buyerId)) || { wallet_balance: 0, escrow_locked_balance: 0 };
        const wallet = Number(buyer.wallet_balance || 0);
        const locked = Number(buyer.escrow_locked_balance || 0);
        const available = Math.max(0, wallet - locked);
        if (available < amount) {
          return res.status(400).json({
            success: false,
            error: `موجودی قابل برداشت کارفرما کافی نیست. موجودی فعلی: ${available.toLocaleString()} تومان | مبلغ معامله: ${amount.toLocaleString()} تومان`,
          });
        }

        let lockedInTx = false;
        if (firestore) {
          try {
            await firestore.runTransaction(async (tx) => {
              const bSnap = await tx.get(firestore.collection('users').doc(buyerId));
              const bData = bSnap.exists ? bSnap.data() || {} : buyer;
              const liveWallet = Number(bData.wallet_balance ?? wallet);
              const liveLocked = Number(bData.escrow_locked_balance ?? locked);
              if (liveWallet - liveLocked < amount) {
                throw new Error('INSUFFICIENT_BALANCE_ESCROW');
              }
              const nextLocked = liveLocked + amount;
              tx.set(
                firestore.collection('users').doc(buyerId),
                {
                  wallet_balance: liveWallet,
                  escrow_locked_balance: nextLocked,
                  updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
              tx.set(
                firestore.collection('deals').doc(cid),
                { status: 'active', updatedAt: FieldValue.serverTimestamp() },
                { merge: true }
              );
              balancesPayload[buyerId] = { wallet_balance: liveWallet, escrow_locked_balance: nextLocked };
            });
            const bMem = memoryUsers.get(buyerId) || buyer;
            memoryUsers.set(buyerId, { ...bMem, id: buyerId, ...balancesPayload[buyerId] });
            lockedInTx = true;
          } catch (txErr: any) {
            if (txErr?.message === 'INSUFFICIENT_BALANCE_ESCROW') {
              throw new Error('موجودی قابل برداشت کافی نیست.');
            }
            console.warn('[ESCROW-LOCK] Firestore tx fallback:', txErr?.message || txErr);
          }
        }
        if (!lockedInTx) {
          await saveUserBalances(buyerId, wallet, locked + amount);
          balancesPayload[buyerId] = { wallet_balance: wallet, escrow_locked_balance: locked + amount };
        }

        await recordTransaction(firestore, {
          user_id: buyerId,
          contract_id: cid,
          amount,
          type: 'escrow_lock',
          status: 'completed',
          description: `قفل امن وجه برای معامله ${deal.title}`,
        });
      } else if (cur === 'work_submitted' && nextStatus === 'completed') {
        // Buyer releases escrow to seller
        const buyer = (await getUserById(buyerId)) || { wallet_balance: amount, escrow_locked_balance: amount };
        const seller = (await getUserById(sellerId)) || { wallet_balance: 0, escrow_locked_balance: 0 };

        let releasedInTx = false;
        if (firestore) {
          try {
            await firestore.runTransaction(async (tx) => {
              const bSnap = await tx.get(firestore.collection('users').doc(buyerId));
              const sSnap = await tx.get(firestore.collection('users').doc(sellerId));
              const bData = bSnap.exists ? bSnap.data() || {} : buyer;
              const sData = sSnap.exists ? sSnap.data() || {} : seller;

              const bWallet = Number(bData.wallet_balance ?? 0);
              const bLocked = Number(bData.escrow_locked_balance ?? 0);
              const sWallet = Number(sData.wallet_balance ?? 0);
              const sLocked = Number(sData.escrow_locked_balance ?? 0);

              const nextBuyerLocked = Math.max(0, bLocked - amount);
              const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - amount);
              const nextSellerWallet = sWallet + amount;

              tx.set(
                firestore.collection('users').doc(buyerId),
                {
                  wallet_balance: nextBuyerWallet,
                  escrow_locked_balance: nextBuyerLocked,
                  updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
              tx.set(
                firestore.collection('users').doc(sellerId),
                {
                  wallet_balance: nextSellerWallet,
                  escrow_locked_balance: sLocked,
                  updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
              tx.set(
                firestore.collection('deals').doc(cid),
                { status: 'completed', updatedAt: FieldValue.serverTimestamp() },
                { merge: true }
              );
              balancesPayload[buyerId] = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
              balancesPayload[sellerId] = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };
            });
            const bMem = memoryUsers.get(buyerId) || buyer;
            const sMem = memoryUsers.get(sellerId) || seller;
            memoryUsers.set(buyerId, { ...bMem, id: buyerId, ...balancesPayload[buyerId] });
            memoryUsers.set(sellerId, { ...sMem, id: sellerId, ...balancesPayload[sellerId] });
            releasedInTx = true;
          } catch (txErr: any) {
            console.warn('[ESCROW-RELEASE] Firestore tx fallback:', txErr?.message || txErr);
          }
        }
        if (!releasedInTx) {
          const bWallet = Number(buyer.wallet_balance ?? 0);
          const bLocked = Number(buyer.escrow_locked_balance ?? 0);
          const sWallet = Number(seller.wallet_balance ?? 0);
          const sLocked = Number(seller.escrow_locked_balance ?? 0);

          const nextBuyerLocked = Math.max(0, bLocked - amount);
          const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - amount);
          const nextSellerWallet = sWallet + amount;

          await saveUserBalances(buyerId, nextBuyerWallet, nextBuyerLocked);
          await saveUserBalances(sellerId, nextSellerWallet, sLocked);
          balancesPayload[buyerId] = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
          balancesPayload[sellerId] = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };
        }

        await recordTransaction(firestore, {
          user_id: sellerId,
          contract_id: cid,
          amount,
          type: 'escrow_release',
          status: 'completed',
          description: `آزادسازی و تسویه معامله ${deal.title}`,
        });
      } else if (firestore) {
        await firestore
          .collection('deals')
          .doc(cid)
          .set({ status: nextStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }

      const nowIso = new Date().toISOString();
      const updatedDeal = { ...deal, status: nextStatus, updatedAt: nowIso, updated_at: nowIso };
      memoryDeals.set(cid, updatedDeal);

      // Push notifications & Telegram message to counterparty
      const otherPartyId = uid === buyerId ? sellerId : buyerId;
      const statusMsgMap: Record<string, string> = {
        awaiting_payment: `قرارداد «${deal.title}» تایید شد و در انتظار قفل وجه است.`,
        active: `مبلغ ${amount.toLocaleString()} تومان در حساب امانی برای «${deal.title}» قفل شد. اجرا را آغاز کنید.`,
        work_submitted: `مجری کار پروژه «${deal.title}» را تحویل داد. لطفاً بررسی و تایید نهایی کنید.`,
        completed: `معامله «${deal.title}» با موفقیت تایید و مبلغ ${amount.toLocaleString()} تومان آزاد شد.`,
        cancelled: `قرارداد «${deal.title}» لغو شد.`,
        disputed: `برای قرارداد «${deal.title}» درخواست حل اختلاف ثبت شد.`,
      };
      const summaryText = statusMsgMap[nextStatus] || `وضعیت معامله «${deal.title}» تغییر کرد.`;

      await pushUserNotification(
        otherPartyId,
        `به‌روزرسانی قرارداد ${cid}`,
        summaryText,
        `📌 <b>به‌روزرسانی معامله ${cid}</b>\n\n${summaryText}`
      );
      if (nextStatus === 'completed') {
        await pushUserNotification(buyerId, `تسویه کامل قرارداد ${cid}`, summaryText);
      }

      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });

      res.json({ success: true, deal: updatedDeal, balances: balancesPayload });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || 'خطا در تغییر وضعیت قرارداد' });
    }
  });

  // --- Real-Time Direct & Contract Chat Persistence ---
  interface DirectChatRoomRecord {
    id: string;
    participants: string[];
    is_support?: boolean;
    title_map?: Record<string, string>;
    phone_map?: Record<string, string>;
    last_msg: string;
    time: string;
    createdAt: string;
  }

  const memoryDirectChats = new Map<string, DirectChatRoomRecord>();
  const memoryDirectMessages = new Map<string, any[]>();
  const memoryContractMessages = new Map<string, any[]>();
  const memoryPinnedMessages = new Map<string, { id: string; text: string } | null>();

  const buildDirectRoomId = (uidA: string, uidB: string, isSupport?: boolean) => {
    if (isSupport || uidB === '101' || uidB === 'support') {
      return `support_${uidA}`;
    }
    return `dm_${[uidA, uidB].sort().join('__')}`;
  };

  app.get('/api/chats/direct', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const merged = new Map<string, DirectChatRoomRecord>(memoryDirectChats);

      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore
            .collection('direct_chats')
            .where('participants', 'array-contains', uid)
            .limit(80)
            .get();
          snap.docs.forEach((d) => {
            const data = d.data() as any;
            merged.set(d.id, { id: d.id, ...data });
          });
          if (isAdminActor) {
            const supSnap = await firestore.collection('direct_chats').where('is_support', '==', true).limit(40).get();
            supSnap.docs.forEach((d) => {
              const data = d.data() as any;
              merged.set(d.id, { id: d.id, ...data });
            });
          }
        } catch {}
      }

      // Ensure user's official support chat exists
      const supportRoomId = `support_${uid}`;
      if (!merged.has(supportRoomId) && !isAdminActor) {
        const nowIso = new Date().toISOString();
        const supChat: DirectChatRoomRecord = {
          id: supportRoomId,
          participants: [uid, 'support'],
          is_support: true,
          title_map: { [uid]: 'پشتیبانی میانجی', support: actor.full_name || 'کاربر میانجی' },
          phone_map: { [uid]: '0210000', support: actor.phone_number || '' },
          last_msg: 'چطور می‌تونم کمکتون کنم؟',
          time: nowIso,
          createdAt: nowIso,
        };
        merged.set(supportRoomId, supChat);
        memoryDirectChats.set(supportRoomId, supChat);
      }

      const onlineSet = new Set(getOnlineUserIds());
      const chats = Array.from(merged.values())
        .filter((room) => room.participants?.includes(uid) || (isAdminActor && room.is_support))
        .map((room) => {
          const otherId = room.participants.find((p) => p !== uid) || 'support';
          const isSupportRoom = Boolean(room.is_support || otherId === 'support');
          const title =
            room.title_map?.[uid] || (isSupportRoom ? 'پشتیبانی میانجی' : `کاربر ${otherId.slice(-4)}`);
          const phone = room.phone_map?.[uid] || (isSupportRoom ? '0210000' : '');
          return {
            id: room.id,
            counterparty_id: otherId,
            full_name: title,
            phone_number: phone,
            last_msg: room.last_msg || 'گفتگوی مستقیم',
            time: room.time || room.createdAt,
            unread: 0,
            online: isSupportRoom || onlineSet.has(otherId),
            is_support: isSupportRoom,
          };
        })
        .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

      res.json({ success: true, chats });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت لیست چت‌ها' });
    }
  });

  app.post('/api/chats/direct/open', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const { targetId, phone, fullName } = req.body || {};
      const cleanPhone = extractCleanPhone(String(phone || ''));

      let targetUser: any = null;
      if (targetId && String(targetId) !== '101' && String(targetId) !== 'support') {
        targetUser = await getUserById(String(targetId));
      }
      if (!targetUser && cleanPhone.length >= 10) {
        targetUser = await findUserByPhone(cleanPhone, cleanPhone.slice(-10));
      }

      const isSupport = String(targetId) === '101' || String(targetId) === 'support';
      const counterpartyId = isSupport
        ? 'support'
        : String(targetUser?.id || targetId || `u_${cleanPhone.slice(-10) || Date.now()}`);
      if (!isSupport && counterpartyId === uid) {
        return res.status(400).json({ success: false, error: 'نمی‌توانید با خودتان گفتگوی مستقیم باز کنید.' });
      }

      const roomId = buildDirectRoomId(uid, counterpartyId, isSupport);
      const targetDisplayName = isSupport
        ? 'پشتیبانی میانجی'
        : String(targetUser?.full_name || fullName || `کاربر ${(cleanPhone || counterpartyId).slice(-4)}`);
      const targetPhone = isSupport ? '0210000' : String(targetUser?.phone_number || cleanPhone || '');

      const nowIso = new Date().toISOString();
      const existing = memoryDirectChats.get(roomId);
      const roomRecord: DirectChatRoomRecord = existing || {
        id: roomId,
        participants: [uid, counterpartyId],
        is_support: isSupport,
        title_map: {
          [uid]: targetDisplayName,
          [counterpartyId]: actor.full_name || 'کاربر میانجی',
        },
        phone_map: {
          [uid]: targetPhone,
          [counterpartyId]: actor.phone_number || '',
        },
        last_msg: 'گفتگو شروع شد',
        time: nowIso,
        createdAt: nowIso,
      };
      memoryDirectChats.set(roomId, roomRecord);

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('direct_chats').doc(roomId).set(roomRecord, { merge: true });
        } catch {}
      }

      res.json({
        success: true,
        chat: {
          id: roomId,
          counterparty_id: counterpartyId,
          full_name: targetDisplayName,
          phone_number: targetPhone,
          last_msg: roomRecord.last_msg,
          time: roomRecord.time,
          unread: 0,
          online: isSupport || getOnlineUserIds().includes(counterpartyId),
          is_support: isSupport,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ایجاد گفتگو' });
    }
  });

  app.get('/api/chats/:scope/:chatId/messages', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const scope = req.params.scope === 'contract' ? 'contract' : 'direct';
      const chatId = String(req.params.chatId || '').trim();
      const uid = String(authResult.actor.id);
      const isAdminActor = authResult.actor.role === 'owner' || authResult.actor.role === 'admin';

      if (scope === 'contract') {
        const deal = await getDealByContractId(chatId);
        if (deal && !isAdminActor && uid !== String(deal.buyer_id) && uid !== String(deal.seller_id)) {
          return res.status(403).json({ success: false, error: 'دسترسی به این چت مجاز نیست.' });
        }
      }

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const merged = new Map<string, any>();
      (memMap.get(chatId) || []).forEach((m) => merged.set(String(m.id), m));

      const firestore = getDb();
      if (firestore) {
        try {
          const colName = scope === 'contract' ? 'contract_messages' : 'direct_messages';
          const filterField = scope === 'contract' ? 'contract_id' : 'room_id';
          const snap = await firestore.collection(colName).where(filterField, '==', chatId).limit(120).get();
          snap.docs.forEach((doc) => {
            const d = doc.data() || {};
            merged.set(doc.id, {
              id: doc.id,
              sender_id: d.sender_id,
              text: d.message_text ?? d.text ?? '',
              type: d.message_type ?? d.type ?? 'text',
              attachment_url: d.attachment_url,
              reply_to: d.reply_to || null,
              created_at: d.created_at?.toDate?.()?.toISOString?.() || d.created_at || new Date().toISOString(),
            });
          });
        } catch {}
      }

      let pinned = memoryPinnedMessages.get(`${scope}:${chatId}`) ?? null;
      if (!pinned && firestore) {
        try {
          const pSnap = await firestore.collection('chat_pins').doc(`${scope}_${chatId}`).get();
          if (pSnap.exists) {
            const pd = pSnap.data();
            if (pd?.id) pinned = { id: pd.id, text: pd.text };
          }
        } catch {}
      }

      const messages = Array.from(merged.values()).sort(
        (a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at))
      );
      res.json({ success: true, messages, pinned });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت پیام‌ها' });
    }
  });

  app.post('/api/chats/:scope/:chatId/messages', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const scope = req.params.scope === 'contract' ? 'contract' : 'direct';
      const chatId = String(req.params.chatId || '').trim();
      const { text, type, attachment_url, reply_to } = req.body || {};

      const cleanText = String(text || '').trim().slice(0, 1000);
      const msgType = ['text', 'image', 'voice', 'file'].includes(type) ? type : 'text';
      const cleanAttachment =
        typeof attachment_url === 'string' && attachment_url.length <= 2048 ? attachment_url : undefined;
      if (!cleanText && !cleanAttachment) {
        return res.status(400).json({ success: false, error: 'متن پیام نمی‌تواند خالی باشد.' });
      }

      let recipientIds: string[] = [];
      let dealTitle = '';
      if (scope === 'contract') {
        const deal = await getDealByContractId(chatId);
        if (deal && !isAdminActor && uid !== String(deal.buyer_id) && uid !== String(deal.seller_id)) {
          return res.status(403).json({ success: false, error: 'دسترسی به این معامله مجاز نیست.' });
        }
        if (deal) {
          dealTitle = deal.title;
          recipientIds = [String(deal.buyer_id), String(deal.seller_id)].filter((id) => id !== uid);
        }
      } else {
        const room = memoryDirectChats.get(chatId);
        if (room) {
          recipientIds = room.participants.filter((id) => id !== uid && id !== 'support');
        }
      }

      const nowIso = new Date().toISOString();
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const msgRecord = {
        id: msgId,
        sender_id: uid,
        text: cleanText,
        type: msgType,
        attachment_url: cleanAttachment,
        reply_to: reply_to && reply_to.id ? { id: String(reply_to.id), sender_name: String(reply_to.sender_name || ''), text: String(reply_to.text || '').slice(0, 120) } : null,
        created_at: nowIso,
      };

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      memMap.set(chatId, [...list, msgRecord]);

      const previewLabel =
        msgType === 'image' ? '📷 تصویر' : msgType === 'voice' ? '🎤 پیام صوتی' : msgType === 'file' ? `📎 ${cleanText}` : cleanText;

      if (scope === 'direct') {
        const existingRoom = memoryDirectChats.get(chatId);
        if (existingRoom) {
          existingRoom.last_msg = previewLabel;
          existingRoom.time = nowIso;
          memoryDirectChats.set(chatId, existingRoom);
        }
      }

      const firestore = getDb();
      if (firestore) {
        try {
          if (scope === 'contract') {
            const fsPayload: any = {
              contract_id: chatId,
              sender_id: uid,
              message_text: cleanText,
              message_type: msgType,
              created_at: FieldValue.serverTimestamp(),
            };
            if (cleanAttachment) fsPayload.attachment_url = cleanAttachment;
            await firestore.collection('contract_messages').doc(msgId).set(fsPayload);
          } else {
            const fsPayload: any = {
              room_id: chatId,
              sender_id: uid,
              message_text: cleanText,
              message_type: msgType,
              created_at: FieldValue.serverTimestamp(),
            };
            if (cleanAttachment) fsPayload.attachment_url = cleanAttachment;
            if (msgRecord.reply_to) fsPayload.reply_to = msgRecord.reply_to;
            await firestore.collection('direct_messages').doc(msgId).set(fsPayload);
            await firestore.collection('direct_chats').doc(chatId).set({ last_msg: previewLabel, time: nowIso }, { merge: true });
          }
        } catch {}
      }

      const roomKey = `${scope}:${chatId}`;
      const eventPayload = { scope, chatId, room: roomKey, message: msgRecord };
      wsBroadcastRoom(roomKey, 'chat:message', eventPayload);
      for (const rid of recipientIds) {
        wsBroadcastUser(rid, 'chat:message', eventPayload);
        if (!getOnlineUserIds().includes(rid)) {
          const contextHeader = scope === 'contract' ? `💬 پیام جدید در معامله «${dealTitle || chatId}»` : `💬 پیام جدید از ${actor.full_name || 'کاربر میانجی'}`;
          void notifyTelegramUser(rid, `${contextHeader}\n\n${previewLabel}`);
        }
      }
      if (scope === 'direct' && chatId.startsWith('support_')) {
        void wsBroadcastAdmins('chat:message', eventPayload);
      }

      res.json({ success: true, message: msgRecord });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ارسال پیام' });
    }
  });

  app.delete('/api/chats/:scope/:chatId/messages/:msgId', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const scope = req.params.scope === 'contract' ? 'contract' : 'direct';
      const chatId = String(req.params.chatId || '').trim();
      const msgId = String(req.params.msgId || '').trim();
      const uid = String(authResult.actor.id);
      const isAdminActor = authResult.actor.role === 'owner' || authResult.actor.role === 'admin';

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      const target = list.find((m) => String(m.id) === msgId);
      if (target && String(target.sender_id) !== uid && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'فقط فرستنده پیام می‌تواند آن را حذف کند.' });
      }
      memMap.set(chatId, list.filter((m) => String(m.id) !== msgId));

      const firestore = getDb();
      if (firestore) {
        const colName = scope === 'contract' ? 'contract_messages' : 'direct_messages';
        await firestore.collection(colName).doc(msgId).delete().catch(() => {});
      }

      const roomKey = `${scope}:${chatId}`;
      wsBroadcastRoom(roomKey, 'chat:deleted', { scope, chatId, room: roomKey, messageId: msgId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در حذف پیام' });
    }
  });

  app.post('/api/chats/:scope/:chatId/pin', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const scope = req.params.scope === 'contract' ? 'contract' : 'direct';
    const chatId = String(req.params.chatId || '').trim();
    const pinned = req.body?.id ? { id: String(req.body.id), text: String(req.body.text || '').slice(0, 200) } : null;
    memoryPinnedMessages.set(`${scope}:${chatId}`, pinned);

    const firestore = getDb();
    if (firestore) {
      try {
        if (pinned) {
          await firestore.collection('chat_pins').doc(`${scope}_${chatId}`).set(pinned);
        } else {
          await firestore.collection('chat_pins').doc(`${scope}_${chatId}`).delete();
        }
      } catch {}
    }

    const roomKey = `${scope}:${chatId}`;
    wsBroadcastRoom(roomKey, 'chat:pinned', { scope, chatId, room: roomKey, pinned });
    res.json({ success: true, pinned });
  });

  // --- Wallet Deposit Slips & Withdraw Requests ---
  const memoryWalletRequests = new Map<string, any>();

  const loadWalletRequests = async () => {
    const merged = new Map<string, any>(memoryWalletRequests);
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('wallet_requests').limit(200).get();
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          merged.set(d.id, {
            id: d.id,
            ...data,
            created_at: data.created_at?.toDate?.()?.toISOString?.() || data.created_at || new Date().toISOString(),
          });
        });
      } catch {}
    }
    return Array.from(merged.values()).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  };

  app.get('/api/wallet/requests', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const wantAll = isAdminActor && req.query.scope === 'admin';
      const all = await loadWalletRequests();
      const filtered = wantAll ? all : all.filter((r) => String(r.user_id) === String(actor.id));
      res.json({
        success: true,
        requests: filtered,
        balances: {
          wallet_balance: Number(actor.wallet_balance || 0),
          escrow_locked_balance: Number(actor.escrow_locked_balance || 0),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت سوابق کیف پول' });
    }
  });

  app.post('/api/wallet/requests', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const { type, amount, ref_code } = req.body || {};
      const reqType = type === 'withdraw' ? 'withdraw' : 'deposit';
      const amt = Number(amount || 0);
      if (!amt || amt < 10000) {
        return res.status(400).json({ success: false, error: 'حداقل مبلغ تراکنش ۱۰,۰۰۰ تومان است.' });
      }

      const limits = await loadGlobalLimits();
      if (reqType === 'withdraw') {
        if (actor.is_withdraw_locked) {
          return res.status(403).json({ success: false, error: 'برداشت وجه برای حساب شما قفل شده است.' });
        }
        const available = Math.max(0, Number(actor.wallet_balance || 0) - Number(actor.escrow_locked_balance || 0));
        if (amt > available) {
          return res.status(400).json({ success: false, error: 'موجودی قابل برداشت شما کافی نیست.' });
        }
        const allReqs = await loadWalletRequests();
        const todayStr = new Date().toDateString();
        const todayTotal = allReqs
          .filter(
            (r) =>
              String(r.user_id) === String(actor.id) &&
              r.type === 'withdraw' &&
              r.status !== 'rejected' &&
              new Date(r.created_at).toDateString() === todayStr
          )
          .reduce((s, r) => s + Number(r.amount || 0), 0);
        const dailyLimit = Number(actor.daily_withdraw_limit || limits.default_daily_withdraw_limit || 0);
        if (dailyLimit > 0 && todayTotal + amt > dailyLimit) {
          return res.status(400).json({
            success: false,
            error: `سقف برداشت روزانه شما ${dailyLimit.toLocaleString()} تومان است.`,
          });
        }
        if (String(ref_code || '').trim().length < 8) {
          return res.status(400).json({ success: false, error: 'شماره شبا یا کارت مقصد را کامل وارد کنید.' });
        }
      }

      const reqId = `slip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const nowIso = new Date().toISOString();
      const record = {
        id: reqId,
        user_id: String(actor.id),
        user_name: actor.full_name || 'کاربر میانجی',
        phone: actor.phone_number || '',
        type: reqType,
        amount: amt,
        ref_code: String(ref_code || '').trim() || `REQ-${crypto.randomInt(100000, 999999)}`,
        status: 'pending',
        created_at: nowIso,
      };
      memoryWalletRequests.set(reqId, record);

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('wallet_requests').doc(reqId).set({
            ...record,
            created_at: FieldValue.serverTimestamp(),
          });
        } catch {}
      }

      void wsBroadcastAdmins('wallet:updated', { userId: String(actor.id), request: record });
      res.json({ success: true, request: record });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت درخواست مالی' });
    }
  });

  app.post('/api/admin/wallet-requests/:reqId/decide', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const reqId = String(req.params.reqId || '').trim();
      const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
      const all = await loadWalletRequests();
      const slip = all.find((r) => r.id === reqId);
      if (!slip) {
        return res.status(404).json({ success: false, error: 'درخواست مالی یافت نشد.' });
      }
      if (slip.status !== 'pending') {
        return res.status(400).json({ success: false, error: 'این درخواست پیش‌تر بررسی شده است.' });
      }

      const targetUid = String(slip.user_id);
      const targetUser = (await getUserById(targetUid)) || { wallet_balance: 0, escrow_locked_balance: 0 };
      const curWallet = Number(targetUser.wallet_balance || 0);
      const curLocked = Number(targetUser.escrow_locked_balance || 0);
      const amt = Number(slip.amount || 0);
      const firestore = getDb();

      let nextWallet = curWallet;
      if (decision === 'approved') {
        if (slip.type === 'deposit') {
          nextWallet = curWallet + amt;
        } else {
          const available = Math.max(0, curWallet - curLocked);
          if (amt > available) {
            return res.status(400).json({ success: false, error: 'موجودی قابل برداشت کاربر دیگر کافی نیست.' });
          }
          nextWallet = Math.max(curLocked, curWallet - amt);
        }
        await saveUserBalances(targetUid, nextWallet, curLocked);
        await recordTransaction(firestore, {
          user_id: targetUid,
          contract_id: reqId,
          amount: amt,
          type: slip.type === 'deposit' ? 'deposit' : 'withdraw',
          status: 'completed',
          description: slip.type === 'deposit' ? `تایید واریز فیش ${slip.ref_code}` : `تسویه برداشت ${slip.ref_code}`,
        });
      }

      const updatedSlip = {
        ...slip,
        status: decision,
        decided_by: String(authResult.actor.id),
        decided_at: new Date().toISOString(),
      };
      memoryWalletRequests.set(reqId, updatedSlip);
      if (firestore) {
        await firestore.collection('wallet_requests').doc(reqId).set(updatedSlip, { merge: true }).catch(() => {});
      }

      const msgTitle = decision === 'approved' ? 'تراکنش مالی تایید شد' : 'درخواست مالی رد شد';
      const msgBody =
        decision === 'approved'
          ? `درخواست ${slip.type === 'deposit' ? 'افزایش موجودی' : 'برداشت'} به مبلغ ${amt.toLocaleString()} تومان تایید و در کیف پول اعمال شد.`
          : `درخواست ${slip.type === 'deposit' ? 'افزایش موجودی' : 'برداشت'} به مبلغ ${amt.toLocaleString()} تومان توسط بخش مالی رد شد.`;

      await pushUserNotification(targetUid, msgTitle, msgBody, `💳 <b>${msgTitle}</b>\n\n${msgBody}`);

      const balances = { wallet_balance: nextWallet, escrow_locked_balance: curLocked };
      wsBroadcastUser(targetUid, 'wallet:updated', { userId: targetUid, request: updatedSlip, balances });
      void wsBroadcastAdmins('wallet:updated', { userId: targetUid, request: updatedSlip, balances });

      res.json({ success: true, request: updatedSlip, balances });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در بررسی درخواست مالی' });
    }
  });

  // --- Support Tickets End-to-End ---
  const memoryTickets = new Map<string, any>();

  const loadAllTickets = async () => {
    const merged = new Map<string, any>(memoryTickets);
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('support_tickets').limit(200).get();
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          merged.set(d.id, {
            id: d.id,
            ...data,
            created_at: data.created_at?.toDate?.()?.toISOString?.() || data.created_at || new Date().toISOString(),
          });
        });
      } catch {}
    }
    return Array.from(merged.values()).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  };

  app.get('/api/support/tickets', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const wantAll = isAdminActor && req.query.scope === 'admin';
      const all = await loadAllTickets();
      const filtered = wantAll ? all : all.filter((t) => String(t.user_id) === String(actor.id));
      res.json({ success: true, tickets: filtered });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت تیکت‌ها' });
    }
  });

  app.post('/api/support/tickets', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const subject = String(req.body?.subject || '').trim().slice(0, 160);
      const message = String(req.body?.message || '').trim().slice(0, 2000);
      if (!subject || !message) {
        return res.status(400).json({ success: false, error: 'لطفاً موضوع و متن پیام را وارد کنید.' });
      }
      const ticketId = `T-${crypto.randomInt(10000, 99999)}`;
      const ticket = {
        id: ticketId,
        user_id: String(actor.id),
        user_name: actor.full_name || 'کاربر میانجی',
        phone: actor.phone_number || '',
        subject,
        message,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      memoryTickets.set(ticketId, ticket);

      const firestore = getDb();
      if (firestore) {
        await firestore
          .collection('support_tickets')
          .doc(ticketId)
          .set({ ...ticket, created_at: FieldValue.serverTimestamp() })
          .catch(() => {});
      }

      void wsBroadcastAdmins('ticket:updated', { userId: String(actor.id), ticket });
      res.json({ success: true, ticket });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت تیکت' });
    }
  });

  app.post('/api/admin/support/tickets/:ticketId/reply', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const ticketId = String(req.params.ticketId || '').trim();
      const replyText = String(req.body?.reply || '').trim().slice(0, 2000);
      if (!replyText) {
        return res.status(400).json({ success: false, error: 'متن پاسخ نمی‌تواند خالی باشد.' });
      }
      const all = await loadAllTickets();
      const ticket = all.find((t) => t.id === ticketId);
      if (!ticket) {
        return res.status(404).json({ success: false, error: 'تیکت یافت نشد.' });
      }

      const updated = {
        ...ticket,
        reply: replyText,
        status: 'resolved',
        replied_by: authResult.actor.full_name || 'پشتیبانی میانجی',
        replied_at: new Date().toISOString(),
      };
      memoryTickets.set(ticketId, updated);
      const firestore = getDb();
      if (firestore) {
        await firestore.collection('support_tickets').doc(ticketId).set(updated, { merge: true }).catch(() => {});
      }

      await pushUserNotification(
        String(ticket.user_id),
        `پاسخ تیکت ${ticketId}`,
        replyText,
        `🛟 <b>پاسخ پشتیبانی میانجی (${ticketId})</b>\n\nموضوع: ${ticket.subject}\nپاسخ: ${replyText}`
      );
      wsBroadcastUser(String(ticket.user_id), 'ticket:updated', { userId: String(ticket.user_id), ticket: updated });
      void wsBroadcastAdmins('ticket:updated', { userId: String(ticket.user_id), ticket: updated });

      res.json({ success: true, ticket: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت پاسخ تیکت' });
    }
  });

  // --- Dispute Evidence & Atomic Arbitration Verdict ---
  const memoryDisputes = new Map<string, { evidence: any[]; resolution?: any }>();

  app.get('/api/disputes/:contractId', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const cid = String(req.params.contractId || '').trim();
      const deal = await getDealByContractId(cid);
      if (!deal) {
        return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });
      }
      const uid = String(authResult.actor.id);
      const isAdminActor = authResult.actor.role === 'owner' || authResult.actor.role === 'admin';
      if (!isAdminActor && uid !== String(deal.buyer_id) && uid !== String(deal.seller_id)) {
        return res.status(403).json({ success: false, error: 'دسترسی به این پرونده داوری مجاز نیست.' });
      }

      let record = memoryDisputes.get(cid) || { evidence: [] };
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('dispute_records').doc(cid).get();
          if (snap.exists) {
            const d = snap.data() || {};
            record = {
              evidence: Array.isArray(d.evidence) ? d.evidence : record.evidence,
              resolution: d.resolution || record.resolution,
            };
            memoryDisputes.set(cid, record);
          }
        } catch {}
      }

      res.json({ success: true, contract: deal, evidence: record.evidence, resolution: record.resolution || null });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت پرونده داوری' });
    }
  });

  app.post('/api/disputes/:contractId/evidence', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const cid = String(req.params.contractId || '').trim();
      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });

      const uid = String(authResult.actor.id);
      const isAdminActor = authResult.actor.role === 'owner' || authResult.actor.role === 'admin';
      if (!isAdminActor && uid !== String(deal.buyer_id) && uid !== String(deal.seller_id)) {
        return res.status(403).json({ success: false, error: 'شما طرف این معامله نیستید.' });
      }

      const text = String(req.body?.text || '').trim().slice(0, 1500);
      const attachment_url = typeof req.body?.attachment_url === 'string' && req.body.attachment_url.length <= 2048 ? req.body.attachment_url : undefined;
      if (!text && !attachment_url) {
        return res.status(400).json({ success: false, error: 'متن یا فایل مدرک الزامی است.' });
      }

      const cur = memoryDisputes.get(cid) || { evidence: [] };
      const item = {
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        sender_id: uid,
        sender_name: authResult.actor.full_name || 'کاربر',
        text,
        attachment_url,
        created_at: new Date().toISOString(),
      };
      const updated = { ...cur, evidence: [...cur.evidence, item] };
      memoryDisputes.set(cid, updated);

      const firestore = getDb();
      if (firestore) {
        await firestore.collection('dispute_records').doc(cid).set(updated, { merge: true }).catch(() => {});
      }

      wsBroadcastUser(String(deal.buyer_id), 'dispute:updated', { contractId: cid, evidence: item });
      wsBroadcastUser(String(deal.seller_id), 'dispute:updated', { contractId: cid, evidence: item });
      res.json({ success: true, item, evidence: updated.evidence });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت مدرک' });
    }
  });

  app.post('/api/disputes/:contractId/verdict', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const cid = String(req.params.contractId || '').trim();
      const verdict = ['refund', 'release', 'split'].includes(req.body?.verdict) ? req.body.verdict : 'release';
      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });
      if (['completed', 'cancelled'].includes(String(deal.status))) {
        return res.status(400).json({ success: false, error: 'این پرونده پیش‌تر مختومه شده است.' });
      }

      const amount = Number(deal.amount || 0);
      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      const buyer = (await getUserById(buyerId)) || { wallet_balance: 0, escrow_locked_balance: 0 };
      const seller = (await getUserById(sellerId)) || { wallet_balance: 0, escrow_locked_balance: 0 };

      const bWallet = Number(buyer.wallet_balance || 0);
      const bLocked = Number(buyer.escrow_locked_balance || 0);
      const sWallet = Number(seller.wallet_balance || 0);
      const sLocked = Number(seller.escrow_locked_balance || 0);
      const hasLockedFunds = bLocked >= amount && amount > 0;
      const balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};
      const firestore = getDb();

      if (hasLockedFunds) {
        if (verdict === 'refund') {
          const nextBuyerLocked = Math.max(0, bLocked - amount);
          await saveUserBalances(buyerId, bWallet, nextBuyerLocked);
          balancesPayload[buyerId] = { wallet_balance: bWallet, escrow_locked_balance: nextBuyerLocked };
        } else if (verdict === 'release') {
          const nextBuyerLocked = Math.max(0, bLocked - amount);
          const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - amount);
          const nextSellerWallet = sWallet + amount;
          await saveUserBalances(buyerId, nextBuyerWallet, nextBuyerLocked);
          await saveUserBalances(sellerId, nextSellerWallet, sLocked);
          balancesPayload[buyerId] = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
          balancesPayload[sellerId] = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };
          await recordTransaction(firestore, {
            user_id: sellerId,
            contract_id: cid,
            amount,
            type: 'escrow_release',
            status: 'completed',
            description: `رأی داوری تسویه کامل معامله ${deal.title}`,
          });
        } else {
          // 50/50 split
          const sellerShare = Math.floor(amount / 2);
          const nextBuyerLocked = Math.max(0, bLocked - amount);
          const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - sellerShare);
          const nextSellerWallet = sWallet + sellerShare;
          await saveUserBalances(buyerId, nextBuyerWallet, nextBuyerLocked);
          await saveUserBalances(sellerId, nextSellerWallet, sLocked);
          balancesPayload[buyerId] = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
          balancesPayload[sellerId] = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };
          await recordTransaction(firestore, {
            user_id: sellerId,
            contract_id: cid,
            amount: sellerShare,
            type: 'escrow_release',
            status: 'completed',
            description: `رأی داوری تقسیم ۵۰/۵۰ معامله ${deal.title}`,
          });
        }
      }

      const nextStatus = verdict === 'refund' ? 'cancelled' : 'completed';
      const nowIso = new Date().toISOString();
      const updatedDeal = { ...deal, status: nextStatus, updatedAt: nowIso, updated_at: nowIso };
      memoryDeals.set(cid, updatedDeal);

      const disputeCur = memoryDisputes.get(cid) || { evidence: [] };
      const resolution = { verdict, decided_by: String(authResult.actor.id), decided_at: nowIso };
      memoryDisputes.set(cid, { ...disputeCur, resolution });

      if (firestore) {
        await firestore
          .collection('deals')
          .doc(cid)
          .set({ status: nextStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
        await firestore.collection('dispute_records').doc(cid).set({ resolution }, { merge: true }).catch(() => {});
      }

      const verdictLabel =
        verdict === 'refund' ? 'استرداد کامل وجه به کارفرما' : verdict === 'release' ? 'آزادسازی کامل وجه برای مجری' : 'تقسیم ۵۰/۵۰ وجه';
      await pushUserNotification(buyerId, `صدور رأی داوری ${cid}`, verdictLabel, `⚖️ <b>رأی نهایی داوری (${cid})</b>\n\n${verdictLabel}`);
      await pushUserNotification(sellerId, `صدور رأی داوری ${cid}`, verdictLabel, `⚖️ <b>رأی نهایی داوری (${cid})</b>\n\n${verdictLabel}`);

      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastUser(buyerId, 'dispute:updated', { contractId: cid, verdict, contract: updatedDeal });
      wsBroadcastUser(sellerId, 'dispute:updated', { contractId: cid, verdict, contract: updatedDeal });

      res.json({ success: true, deal: updatedDeal, resolution, balances: balancesPayload });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت رأی داور' });
    }
  });

  // --- Server-Synced Contacts ---
  const memoryContacts = new Map<string, any[]>();

  app.get('/api/contacts', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const merged = new Map<string, any>();
      (memoryContacts.get(uid) || []).forEach((c) => merged.set(String(c.id), c));

      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('users').doc(uid).collection('contacts').limit(150).get();
          snap.docs.forEach((d) => merged.set(d.id, { id: d.id, ...d.data() }));
        } catch {}
      }

      const allUsers = await getAllUsersMerged();
      const byPhone = new Map<string, any>();
      allUsers.forEach((u) => {
        const clean = extractCleanPhone(u.phone_number || '');
        if (clean.length >= 10) byPhone.set(clean.slice(-10), u);
      });
      const onlineIds = new Set(getOnlineUserIds());

      const enriched = Array.from(merged.values()).map((c) => {
        const clean = extractCleanPhone(c.phone_number || '');
        const matched = clean.length >= 10 ? byPhone.get(clean.slice(-10)) : null;
        return {
          ...c,
          target_user_id: matched ? String(matched.id) : c.target_user_id || undefined,
          status: matched ? 'verified' : c.status || 'pending',
          trust_score: matched ? Number(matched.trust_score || 96) : Number(c.trust_score || 0),
          online: matched ? onlineIds.has(String(matched.id)) : false,
        };
      });

      res.json({ success: true, contacts: enriched });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت مخاطبین' });
    }
  });

  app.post('/api/contacts', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const name = String(req.body?.full_name || '').trim().slice(0, 100);
      const cleanPhone = extractCleanPhone(String(req.body?.phone_number || ''));
      if (!name || cleanPhone.length < 8) {
        return res.status(400).json({ success: false, error: 'نام و شماره معتبر الزامی است.' });
      }
      const matched = cleanPhone.length >= 10 ? await findUserByPhone(cleanPhone, cleanPhone.slice(-10)) : null;
      const cid = `cnt_${cleanPhone.slice(-10)}_${Date.now().toString(36)}`;
      const item = {
        id: cid,
        full_name: name,
        phone_number: cleanPhone,
        target_user_id: matched ? String(matched.id) : undefined,
        status: matched ? 'verified' : 'pending',
        trust_score: matched ? Number(matched.trust_score || 96) : 0,
        createdAt: new Date().toISOString(),
      };
      const prev = memoryContacts.get(uid) || [];
      const deduped = prev.filter((c) => extractCleanPhone(c.phone_number) !== cleanPhone);
      memoryContacts.set(uid, [item, ...deduped]);

      const firestore = getDb();
      if (firestore) {
        await firestore.collection('users').doc(uid).collection('contacts').doc(cid).set(item).catch(() => {});
      }

      res.json({ success: true, contact: item });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ذخیره مخاطب' });
    }
  });

  app.delete('/api/contacts/:contactId', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const uid = String(authResult.actor.id);
    const contactId = String(req.params.contactId || '').trim();
    const prev = memoryContacts.get(uid) || [];
    memoryContacts.set(uid, prev.filter((c) => String(c.id) !== contactId));
    const firestore = getDb();
    if (firestore) {
      await firestore.collection('users').doc(uid).collection('contacts').doc(contactId).delete().catch(() => {});
    }
    res.json({ success: true });
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

  // Attach Real-Time WebSocket Server on /ws (strictly isolated from Vite HMR WebSocket)
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const urlStr = req.url || '';
    if (urlStr.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  wss.on('connection', async (ws, req) => {
    let resolvedUserId = '';
    let resolvedRole = 'user';

    try {
      const urlObj = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
      const token = urlObj.searchParams.get('token') || undefined;
      const fallbackUid = urlObj.searchParams.get('uid') || '';
      const claims = verifySessionToken(token);
      if (claims) {
        resolvedUserId = claims.uid;
        resolvedRole = claims.role;
      } else if (!isProd && !hasAdminCredentials && fallbackUid) {
        resolvedUserId = fallbackUid;
      }
    } catch {}

    if (!resolvedUserId) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    const liveUser = await getUserById(resolvedUserId);
    if (liveUser?.is_blocked) {
      ws.close(1008, 'Blocked');
      return;
    }
    if (liveUser?.role) resolvedRole = liveUser.role;

    const meta: WsClientMeta = { ws, userId: resolvedUserId, role: resolvedRole, rooms: new Set() };
    const existingSet = wsClientsByUser.get(resolvedUserId) || new Set<WsClientMeta>();
    const wasOffline = existingSet.size === 0;
    existingSet.add(meta);
    wsClientsByUser.set(resolvedUserId, existingSet);

    wsSend(ws, 'presence:snapshot', { onlineIds: getOnlineUserIds() });
    if (wasOffline) {
      wsBroadcastAll('presence:update', { userId: resolvedUserId, online: true });
    }

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(String(raw || '{}'));
        if (parsed.type === 'ping') {
          wsSend(ws, 'pong', { t: Date.now() });
          return;
        }
        if (parsed.type === 'room:join' && typeof parsed.room === 'string') {
          const room = parsed.room.slice(0, 120);
          meta.rooms.add(room);
          const rSet = wsClientsByRoom.get(room) || new Set<WsClientMeta>();
          rSet.add(meta);
          wsClientsByRoom.set(room, rSet);
          return;
        }
        if (parsed.type === 'room:leave' && typeof parsed.room === 'string') {
          const room = parsed.room.slice(0, 120);
          meta.rooms.delete(room);
          wsClientsByRoom.get(room)?.delete(meta);
          return;
        }
        if (parsed.type === 'typing' && typeof parsed.room === 'string') {
          const room = parsed.room.slice(0, 120);
          wsBroadcastRoom(
            room,
            'typing:update',
            {
              room,
              userId: resolvedUserId,
              fullName: String(parsed.fullName || liveUser?.full_name || 'کاربر').slice(0, 80),
              isTyping: Boolean(parsed.isTyping),
            },
            resolvedUserId
          );
        }
      } catch {}
    });

    ws.on('close', () => {
      for (const room of meta.rooms) {
        const rSet = wsClientsByRoom.get(room);
        if (rSet) {
          rSet.delete(meta);
          if (rSet.size === 0) wsClientsByRoom.delete(room);
        }
      }
      const uSet = wsClientsByUser.get(resolvedUserId);
      if (uSet) {
        uSet.delete(meta);
        if (uSet.size === 0) {
          wsClientsByUser.delete(resolvedUserId);
          wsBroadcastAll('presence:update', { userId: resolvedUserId, online: false });
        }
      }
    });
  });

  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}

bootstrap();
