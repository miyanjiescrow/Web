import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { initializeApp, getApps, cert, App as FirebaseAdminApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import * as webpush from 'web-push';
import { WebSocketServer, WebSocket } from 'ws';
import firebaseConfig from './firebase-applet-config.json';
import { validateIranianPayoutDestination, isValidIranianNationalId, isValidIranianCard, detectIranianBankName } from './src/lib/bankValidation';

dotenv.config();

const normalizeDigits = (val: string) =>
  val
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();

const extractCleanPhone = (val: string) => normalizeDigits(String(val || '')).replace(/[^0-9]/g, '');

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

const configuredFirestoreSet = new WeakSet<object>();

function getDb(useDefault = false) {
  if (!hasAdminCredentials || !adminApp) return null;
  try {
    const dbInstance = !useDefault && dbId ? getFirestore(adminApp, dbId) : getFirestore(adminApp);
    if (dbInstance && !configuredFirestoreSet.has(dbInstance)) {
      configuredFirestoreSet.add(dbInstance);
      try {
        dbInstance.settings({ ignoreUndefinedProperties: true });
      } catch {}
    }
    return dbInstance;
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
  app.use(express.json({ limit: '8mb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    next();
  });

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
    platform_fee_percent: number;
  }

  let globalLimits: GlobalLimits = {
    min_deal_amount: 10000,
    default_max_deal_amount: 100000000,
    default_daily_withdraw_limit: 50000000,
    default_max_active_deals: 10,
    max_admin_balance_adjust: 20000000,
    platform_fee_percent: 0,
  };

  let memoryTotalFeesCollected = 0;

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
            platform_fee_percent: Math.max(0, Math.min(15, Number(d.platform_fee_percent ?? globalLimits.platform_fee_percent) || 0)),
          };
        }
      } catch {}
    }
    return globalLimits;
  };

  const loadPlatformStats = async () => {
    const firestore = getDb();
    let firestoreTotal = 0;
    if (firestore) {
      try {
        const snap = await firestore.collection('system_settings').doc('platform_stats').get();
        if (snap.exists) {
          firestoreTotal = Number(snap.data()?.total_fees_collected || 0);
        }
      } catch {}
    }
    const total = Math.max(memoryTotalFeesCollected, firestoreTotal);
    memoryTotalFeesCollected = total;
    return { total_fees_collected: total };
  };

  const getAllUsersMerged = async () => {
    const merged = new Map<string, any>();

    // 1. Seed / in-memory users first (lower priority)
    for (const [id, u] of memoryUsers.entries()) {
      merged.set(String(id), { ...u, id: String(id) });
    }

    // 2. Firestore users (single source of truth)
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
        const isRootEmail =
          ['miyanjiescrow@gmail.com', 'mianjipay@gmail.com'].includes(String(decoded.email || '').toLowerCase()) &&
          decoded.email_verified;
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
    // 1. Query Firebase Firestore directly (sole database)
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

  // Auth: Non-production Preview Registration (only when Telegram Bot Token is not configured)
  app.post('/api/auth/register-preview', async (req, res) => {
    const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (isProd || botToken) {
      return res.status(403).json({
        success: false,
        error: 'ثبت‌نام سریع وب فقط در محیط پیش‌نمایش فعال است. لطفاً از طریق ربات تلگرام ثبت‌نام کنید.',
      });
    }
    try {
      const { phone, full_name } = req.body || {};
      const cleanPhone = extractCleanPhone(String(phone || ''));
      if (cleanPhone.length < 10) {
        return res.status(400).json({ success: false, error: 'شماره همراه وارد شده معتبر نیست.' });
      }
      const cleanName = String(full_name || '').trim().slice(0, 80);
      if (cleanName.length < 2) {
        return res.status(400).json({ success: false, error: 'لطفاً نام و نام خانوادگی (حداقل ۲ کاراکتر) را وارد کنید.' });
      }

      const coreDigits = cleanPhone.slice(-10);
      let existingUser = await findUserByPhone(cleanPhone, coreDigits);
      if (!existingUser) {
        const uid = `u_${coreDigits}`;
        const newUser: any = {
          id: uid,
          full_name: cleanName,
          phone_number: cleanPhone,
          username: `user_${coreDigits.slice(-4)}`,
          role: 'user',
          kyc_status: 'verified',
          wallet_balance: 0,
          escrow_locked_balance: 0,
          is_blocked: false,
          createdAt: new Date().toISOString(),
        };
        memoryUsers.set(uid, newUser);
        const usersCol = getUsersCol();
        if (usersCol) {
          await usersCol
            .doc(uid)
            .set(
              {
                id: uid,
                full_name: cleanName,
                phone_number: cleanPhone,
                username: newUser.username,
                role: 'user',
                kyc_status: 'verified',
                wallet_balance: 0,
                escrow_locked_balance: 0,
                is_blocked: false,
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            )
            .catch(() => {});
        }
        existingUser = newUser;
      }

      const code = crypto.randomInt(100000, 1000000).toString();
      const expires = Date.now() + 15 * 60000;
      otps.set(coreDigits, { code, expires, attempts: 0 });

      res.json({
        success: true,
        phone: existingUser.phone_number || cleanPhone,
        previewOtp: code,
        telegramDelivered: false,
        user: existingUser,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت‌نام پیش‌نمایش' });
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
            rating_avg: Number(found.rating_avg || 0),
            rating_count: Number(found.rating_count || 0),
            completed_deals_count: Number(found.completed_deals_count || 0),
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
      const [limits, platformStats] = await Promise.all([loadGlobalLimits(), loadPlatformStats()]);
      res.json({ success: true, limits, platformStats });
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
        platform_fee_percent: Math.max(0, Math.min(15, Number(body.platform_fee_percent ?? globalLimits.platform_fee_percent) || 0)),
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
      if (typeof body.national_id === 'string') {
        const cleanNid = normalizeDigits(body.national_id).replace(/[^0-9]/g, '');
        if (cleanNid) {
          const nidRes = isValidIranianNationalId(cleanNid);
          if (!nidRes.valid) {
            return res.status(400).json({ success: false, error: nidRes.error || 'کد ملی واردشده نامعتبر است.' });
          }
          updates.national_id = nidRes.normalized;
        } else {
          updates.national_id = '';
        }
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
    reactions?: Record<string, string[]>;
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
          reactions: { '👍': ['u_admin_owner'], '❤️': ['u_admin_owner'] },
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
          reactions: { '🔥': ['u_admin_owner'] },
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
          reactions: { '✅': ['u_admin_owner'] },
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

  // POST create a channel (authenticated)
  app.post('/api/channels', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const { title, handle, description, category } = req.body || {};
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
        owner_id: String(actor.id),
        owner_name: String(actor.full_name || 'مدیر کانال').slice(0, 100),
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
        reactions: {},
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
              reactions: d.reactions && typeof d.reactions === 'object' ? d.reactions : {},
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
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const channelId = String(req.params.channelId || '').trim();
      const ch = memoryChannels.get(channelId);
      if (ch && String(ch.owner_id) !== uid && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'فقط مالک کانال یا مدیر سیستم می‌تواند پست منتشر کند.' });
      }

      const { text, message_type, attachment_url, silent } = req.body || {};
      const cleanText = String(text || '').trim().slice(0, 2000);
      if (!cleanText) {
        return res.status(400).json({ success: false, error: 'متن پست نمی‌تواند خالی باشد' });
      }

      const nowIso = new Date().toISOString();
      const postId = `post_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const post: ChannelPostRecord = {
        id: postId,
        channel_id: channelId,
        author_id: uid,
        author_name: String(actor.full_name || ch?.title || 'مدیر کانال').slice(0, 100),
        text: cleanText,
        message_type: ['text', 'image', 'voice', 'file'].includes(message_type) ? message_type : 'text',
        ...(typeof attachment_url === 'string' && attachment_url.length <= 2048 ? { attachment_url } : {}),
        views: 1,
        silent: Boolean(silent),
        reactions: {},
        created_at: nowIso,
      };

      const existingPosts = memoryChannelPosts.get(channelId) || [];
      memoryChannelPosts.set(channelId, [...existingPosts, post]);

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
      wsBroadcastAll('channel:post', { channelId, post });

      if (!post.silent) {
        const subSet = memoryChannelSubscribers.get(channelId);
        if (subSet && subSet.size > 0) {
          for (const subUid of subSet) {
            if (subUid === uid) continue;
            void dispatchBrowserPushToUser(subUid, {
              title: `📢 ${ch?.title || 'کانال میانجی'}`,
              body: cleanText.slice(0, 140),
              kind: 'channel',
              tag: `mianji-channel-${postId}`,
              url: `/?view=messages&scope=channel&chat_id=${channelId}`,
              channel_id: channelId,
            });
          }
        }
      }
      res.json({ success: true, post });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در انتشار پست' });
    }
  });

  // POST toggle reaction on a channel post
  app.post('/api/channels/:channelId/posts/:postId/react', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const channelId = String(req.params.channelId || '').trim();
      const postId = String(req.params.postId || '').trim();
      const emoji = String(req.body?.emoji || '').trim().slice(0, 12);
      if (!emoji) {
        return res.status(400).json({ success: false, error: 'واکنش نامعتبر است' });
      }

      const posts = memoryChannelPosts.get(channelId) || [];
      let targetPost = posts.find((p) => p.id === postId);

      const firestore = getDb();
      if (!targetPost && firestore) {
        try {
          const snap = await firestore.collection('channel_posts').doc(postId).get();
          if (snap.exists) {
            const d = snap.data() as any;
            targetPost = {
              id: snap.id,
              channel_id: d.channel_id || channelId,
              author_id: String(d.author_id || ''),
              author_name: d.author_name || 'مدیر کانال',
              text: d.text || '',
              message_type: d.message_type || 'text',
              attachment_url: d.attachment_url,
              views: Number(d.views || 1),
              silent: Boolean(d.silent),
              reactions: d.reactions && typeof d.reactions === 'object' ? d.reactions : {},
              created_at: d.created_at?.toDate?.()?.toISOString?.() || String(d.created_at || new Date().toISOString()),
            };
          }
        } catch {}
      }

      if (!targetPost) {
        return res.status(404).json({ success: false, error: 'پست یافت نشد' });
      }

      const reactions: Record<string, string[]> = { ...(targetPost.reactions || {}) };
      const alreadyHadSame = Array.isArray(reactions[emoji]) && reactions[emoji].includes(uid);
      for (const key of Object.keys(reactions)) {
        reactions[key] = (reactions[key] || []).filter((u) => u !== uid);
        if (reactions[key].length === 0) delete reactions[key];
      }
      if (!alreadyHadSame) {
        reactions[emoji] = [...(reactions[emoji] || []), uid];
      }

      const updatedPost: ChannelPostRecord = { ...targetPost, reactions };
      const idx = posts.findIndex((p) => p.id === postId);
      if (idx >= 0) {
        const nextPosts = [...posts];
        nextPosts[idx] = updatedPost;
        memoryChannelPosts.set(channelId, nextPosts);
      } else {
        memoryChannelPosts.set(channelId, [...posts, updatedPost]);
      }

      if (firestore) {
        await firestore.collection('channel_posts').doc(postId).set({ reactions }, { merge: true }).catch(() => {});
      }

      wsBroadcastRoom(`channel:${channelId}`, 'channel:post_updated', { channelId, post: updatedPost });
      res.json({ success: true, post: updatedPost });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت واکنش' });
    }
  });

  // DELETE a channel post
  app.delete('/api/channels/:channelId/posts/:postId', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const channelId = String(req.params.channelId || '').trim();
      const postId = String(req.params.postId || '').trim();

      const ch = memoryChannels.get(channelId);
      const posts = memoryChannelPosts.get(channelId) || [];
      const target = posts.find((p) => p.id === postId);
      if (!isAdminActor && target && String(target.author_id) !== uid && String(ch?.owner_id || '') !== uid) {
        return res.status(403).json({ success: false, error: 'فقط نویسنده یا مدیر کانال می‌تواند پست را حذف کند.' });
      }

      memoryChannelPosts.set(channelId, posts.filter((p) => p.id !== postId));
      const firestore = getDb();
      if (firestore) {
        await firestore.collection('channel_posts').doc(postId).delete().catch(() => {});
      }

      wsBroadcastRoom(`channel:${channelId}`, 'channel:post_deleted', { channelId, postId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در حذف پست' });
    }
  });

  // POST toggle subscription count
  const memoryChannelSubscribers = new Map<string, Set<string>>();
  app.post('/api/channels/:channelId/subscribe', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const channelId = String(req.params.channelId || '').trim();
      const subscribed = Boolean(req.body?.subscribed);
      const subs = memoryChannelSubscribers.get(channelId) || new Set<string>();
      if (subscribed) subs.add(uid);
      else subs.delete(uid);
      memoryChannelSubscribers.set(channelId, subs);

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

  // --- Browser Web Push (VAPID) + Firebase Cloud Messaging (FCM) Engine ---
  interface NotificationPrefsRecord {
    user_id: string;
    deals_enabled: boolean;
    messages_enabled: boolean;
    channels_enabled: boolean;
    foreground_alerts: boolean;
    updatedAt: string;
  }

  interface PushSubscriptionRecord {
    id: string;
    user_id: string;
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    fcm_token?: string;
    platform?: string;
    user_agent?: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  }

  const memoryNotificationPrefs = new Map<string, NotificationPrefsRecord>();
  const memoryPushSubscriptions = new Map<string, PushSubscriptionRecord>();
  let cachedVapidKeys: { publicKey: string; privateKey: string } | null = null;

  const loadOrCreateVapidKeys = async (): Promise<{ publicKey: string; privateKey: string }> => {
    if (cachedVapidKeys) return cachedVapidKeys;

    const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim();
    const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
    if (envPub && envPriv) {
      cachedVapidKeys = { publicKey: envPub, privateKey: envPriv };
      webpush.setVapidDetails('mailto:mianjipay@gmail.com', envPub, envPriv);
      return cachedVapidKeys;
    }

    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('system_settings').doc('web_push').get();
        if (snap.exists) {
          const d = snap.data() || {};
          if (d.publicKey && d.privateKey) {
            cachedVapidKeys = { publicKey: String(d.publicKey), privateKey: String(d.privateKey) };
            webpush.setVapidDetails('mailto:mianjipay@gmail.com', cachedVapidKeys.publicKey, cachedVapidKeys.privateKey);
            return cachedVapidKeys;
          }
        }
      } catch {}
    }

    const generated = webpush.generateVAPIDKeys();
    cachedVapidKeys = generated;
    webpush.setVapidDetails('mailto:mianjipay@gmail.com', generated.publicKey, generated.privateKey);

    if (firestore) {
      try {
        await firestore.collection('system_settings').doc('web_push').set({
          publicKey: generated.publicKey,
          privateKey: generated.privateKey,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch {}
    }
    return generated;
  };

  void loadOrCreateVapidKeys().catch(() => {});

  const defaultNotifPrefs = (uid: string): NotificationPrefsRecord => ({
    user_id: uid,
    deals_enabled: true,
    messages_enabled: true,
    channels_enabled: true,
    foreground_alerts: true,
    updatedAt: new Date().toISOString(),
  });

  const getUserNotificationPrefs = async (uid: string): Promise<NotificationPrefsRecord> => {
    const cleanUid = String(uid);
    const mem = memoryNotificationPrefs.get(cleanUid);
    if (mem) return mem;

    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('notification_prefs').doc(cleanUid).get();
        if (snap.exists) {
          const d = snap.data() || {};
          const merged: NotificationPrefsRecord = {
            user_id: cleanUid,
            deals_enabled: d.deals_enabled !== false,
            messages_enabled: d.messages_enabled !== false,
            channels_enabled: d.channels_enabled !== false,
            foreground_alerts: d.foreground_alerts !== false,
            updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || String(d.updatedAt || new Date().toISOString()),
          };
          memoryNotificationPrefs.set(cleanUid, merged);
          return merged;
        }
      } catch {}
    }
    return defaultNotifPrefs(cleanUid);
  };

  const loadUserPushSubscriptions = async (uid: string): Promise<PushSubscriptionRecord[]> => {
    const cleanUid = String(uid);
    const merged = new Map<string, PushSubscriptionRecord>();
    for (const sub of memoryPushSubscriptions.values()) {
      if (sub.user_id === cleanUid && sub.enabled !== false) {
        merged.set(sub.id, sub);
      }
    }

    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('push_subscriptions').where('user_id', '==', cleanUid).get();
        snap.docs.forEach((doc) => {
          const d = doc.data() || {};
          if (d.enabled === false) return;
          const rec: PushSubscriptionRecord = {
            id: doc.id,
            user_id: cleanUid,
            endpoint: d.endpoint,
            keys: d.keys,
            fcm_token: d.fcm_token,
            platform: d.platform,
            user_agent: d.user_agent,
            enabled: true,
            createdAt: d.createdAt?.toDate?.()?.toISOString?.() || String(d.createdAt || new Date().toISOString()),
            updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || String(d.updatedAt || new Date().toISOString()),
          };
          merged.set(doc.id, rec);
          memoryPushSubscriptions.set(doc.id, rec);
        });
      } catch {}
    }
    return Array.from(merged.values());
  };

  const removePushSubscriptionById = async (subId: string) => {
    memoryPushSubscriptions.delete(subId);
    const firestore = getDb();
    if (firestore) {
      await firestore.collection('push_subscriptions').doc(subId).delete().catch(() => {});
    }
  };

  const dispatchBrowserPushToUser = async (
    userId: string,
    payload: {
      title: string;
      body: string;
      kind?: 'deal' | 'message' | 'channel' | 'wallet' | 'support' | 'system';
      url?: string;
      tag?: string;
      contract_id?: string;
      scope?: 'direct' | 'contract';
      chat_id?: string;
      channel_id?: string;
    }
  ): Promise<number> => {
    const uid = String(userId);
    const kind = payload.kind || 'system';
    const prefs = await getUserNotificationPrefs(uid);
    if (kind === 'deal' && !prefs.deals_enabled) return 0;
    if (kind === 'message' && !prefs.messages_enabled) return 0;
    if (kind === 'channel' && !prefs.channels_enabled) return 0;

    const subs = await loadUserPushSubscriptions(uid);
    if (subs.length === 0) return 0;

    let sentCount = 0;
    const vapid = await loadOrCreateVapidKeys().catch(() => null);

    // 1. Standard Web Push (VAPID)
    if (vapid) {
      const jsonPayload = JSON.stringify({
        title: payload.title,
        body: payload.body,
        kind,
        url: payload.url || '/',
        tag: payload.tag || `mianji-${kind}-${Date.now()}`,
        contract_id: payload.contract_id || null,
        scope: payload.scope || null,
        chat_id: payload.chat_id || null,
        channel_id: payload.channel_id || null,
      });

      await Promise.all(
        subs
          .filter((s) => Boolean(s.endpoint && s.keys?.p256dh && s.keys?.auth))
          .map(async (s) => {
            try {
              await webpush.sendNotification(
                {
                  endpoint: s.endpoint!,
                  keys: {
                    p256dh: s.keys!.p256dh!,
                    auth: s.keys!.auth!,
                  },
                },
                jsonPayload,
                { TTL: 86400 }
              );
              sentCount += 1;
            } catch (err: any) {
              const statusCode = Number(err?.statusCode || 0);
              if (statusCode === 404 || statusCode === 410) {
                await removePushSubscriptionById(s.id);
              }
            }
          })
      );
    }

    // 2. Firebase Cloud Messaging (FCM) for subscriptions with fcm_token
    const fcmSubs = subs.filter((s) => Boolean(s.fcm_token));
    if (fcmSubs.length > 0 && hasAdminCredentials && adminApp) {
      try {
        const tokens = fcmSubs.map((s) => String(s.fcm_token));
        const messaging = getMessaging(adminApp);
        const batchRes = await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: {
            kind,
            url: String(payload.url || '/'),
            tag: String(payload.tag || `mianji-${kind}-${Date.now()}`),
            ...(payload.contract_id ? { contract_id: String(payload.contract_id) } : {}),
            ...(payload.scope ? { scope: String(payload.scope) } : {}),
            ...(payload.chat_id ? { chat_id: String(payload.chat_id) } : {}),
            ...(payload.channel_id ? { channel_id: String(payload.channel_id) } : {}),
          },
          webpush: {
            fcmOptions: {
              link: payload.url || '/',
            },
          },
        });
        sentCount += batchRes.successCount;
        batchRes.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const code = String(resp.error?.code || '');
            if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
              void removePushSubscriptionById(fcmSubs[idx].id);
            }
          }
        });
      } catch (fcmErr: any) {
        console.warn('[PUSH-FCM] Multicast fallback:', fcmErr?.message || fcmErr);
      }
    }

    return sentCount;
  };

  const memoryNotifications = new Map<string, any[]>();
  const pushUserNotification = async (
    userId: string,
    title: string,
    message: string,
    tgText?: string,
    pushMeta?: {
      kind?: 'deal' | 'message' | 'channel' | 'wallet' | 'support' | 'system';
      url?: string;
      tag?: string;
      contract_id?: string;
      skipBrowserPush?: boolean;
    }
  ) => {
    const uid = String(userId);
    const noteId = `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const kind = pushMeta?.kind || 'system';
    const url = pushMeta?.url || '/';
    const record = {
      id: noteId,
      user_id: uid,
      title: String(title || '').slice(0, 200),
      message: String(message || '').slice(0, 1000),
      kind,
      url,
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
          kind,
          url,
          is_read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch {}
    }

    wsBroadcastUser(uid, 'notification:new', { userId: uid, notification: record });
    if (!pushMeta?.skipBrowserPush) {
      void dispatchBrowserPushToUser(uid, {
        title: record.title,
        body: record.message,
        kind,
        url,
        tag: pushMeta?.tag || `mianji-note-${noteId}`,
        contract_id: pushMeta?.contract_id,
      });
    }
    if (tgText) {
      void notifyTelegramUser(uid, tgText);
    }
  };

  // --- Scalable Media Assets Store (<= 5MB: Memory LRU + Firebase Storage / Chunked Firestore + ETag HTTP Cache) ---
  const memoryMedia = new Map<string, { buffer: Buffer; mimeType: string; filename: string; etag: string }>();
  const MEDIA_CHUNK_CHARS = 450000; // ~337KB raw per Firestore chunk doc (well under 1MiB cap)

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
      if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'حجم فایل باید بین ۱ بایت تا ۵ مگابایت باشد.' });
      }

      if (memoryMedia.size > 150) {
        const firstKey = memoryMedia.keys().next().value;
        if (firstKey) memoryMedia.delete(firstKey);
      }

      const mediaId = `med_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const cleanFilename = String(filename || 'attachment').replace(/[^\w.\-\u0600-\u06FF ]/g, '').slice(0, 120) || 'file';
      const etag = `"${crypto.createHash('sha1').update(buffer).digest('hex')}"`;
      memoryMedia.set(mediaId, { buffer, mimeType: resolvedMime, filename: cleanFilename, etag });

      let storagePath: string | undefined;
      const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || (firebaseConfig as any).storageBucket || '').trim();
      if (hasAdminCredentials && adminApp && bucketName) {
        try {
          const bucket = getStorage(adminApp).bucket(bucketName);
          const remotePath = `mianji_media/${mediaId}`;
          await bucket.file(remotePath).save(buffer, {
            contentType: resolvedMime,
            metadata: { metadata: { uploaderId: String(authResult.actor.id), filename: cleanFilename } },
          });
          storagePath = remotePath;
        } catch {}
      }

      const firestore = getDb();
      if (firestore) {
        try {
          if (storagePath) {
            await firestore.collection('media_assets').doc(mediaId).set({
              id: mediaId,
              uploader_id: String(authResult.actor.id),
              mime_type: resolvedMime,
              mimeType: resolvedMime,
              filename: cleanFilename,
              size_bytes: buffer.length,
              storage_path: storagePath,
              created_at: new Date().toISOString(),
              createdAt: FieldValue.serverTimestamp(),
            });
          } else if (match[2].length <= MEDIA_CHUNK_CHARS) {
            await firestore.collection('media_assets').doc(mediaId).set({
              id: mediaId,
              uploader_id: String(authResult.actor.id),
              mime_type: resolvedMime,
              mimeType: resolvedMime,
              filename: cleanFilename,
              size_bytes: buffer.length,
              chunk_count: 0,
              data_base64: match[2],
              created_at: new Date().toISOString(),
              createdAt: FieldValue.serverTimestamp(),
            });
          } else {
            const totalChunks = Math.ceil(match[2].length / MEDIA_CHUNK_CHARS);
            await firestore.collection('media_assets').doc(mediaId).set({
              id: mediaId,
              uploader_id: String(authResult.actor.id),
              mime_type: resolvedMime,
              mimeType: resolvedMime,
              filename: cleanFilename,
              size_bytes: buffer.length,
              chunk_count: totalChunks,
              created_at: new Date().toISOString(),
              createdAt: FieldValue.serverTimestamp(),
            });
            for (let idx = 0; idx < totalChunks; idx += 1) {
              const slice = match[2].slice(idx * MEDIA_CHUNK_CHARS, (idx + 1) * MEDIA_CHUNK_CHARS);
              const chunkId = `${mediaId}_${idx}`;
              await firestore.collection('media_chunks').doc(chunkId).set({
                id: chunkId,
                media_id: mediaId,
                index: idx,
                data_base64: slice,
              });
            }
          }
        } catch {}
      }

      res.json({ success: true, id: mediaId, url: `/api/media/${mediaId}`, sizeBytes: buffer.length });
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
            const mimeType = d.mime_type || d.mimeType || 'application/octet-stream';
            const filename = d.filename || 'file';
            let buffer: Buffer | null = null;

            if (d.storage_path && hasAdminCredentials && adminApp) {
              try {
                const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || (firebaseConfig as any).storageBucket || '').trim();
                const [downloaded] = await getStorage(adminApp).bucket(bucketName).file(String(d.storage_path)).download();
                buffer = downloaded;
              } catch {}
            }

            if (!buffer && Number(d.chunk_count || 0) > 0) {
              const count = Number(d.chunk_count);
              const chunkDocs = await Promise.all(
                Array.from({ length: count }, (_, idx) => firestore.collection('media_chunks').doc(`${mediaId}_${idx}`).get())
              );
              const combined = chunkDocs.map((c) => c.data()?.data_base64 || '').join('');
              if (combined) buffer = Buffer.from(combined, 'base64');
            }

            if (!buffer) {
              const b64 = d.data_base64 || d.base64;
              if (typeof b64 === 'string') buffer = Buffer.from(b64, 'base64');
            }

            if (buffer) {
              const etag = `"${crypto.createHash('sha1').update(buffer).digest('hex')}"`;
              item = { buffer, mimeType, filename, etag };
              memoryMedia.set(mediaId, item);
            }
          }
        } catch {}
      }
    }
    if (!item) return res.status(404).send('Not found');
    if (req.headers['if-none-match'] === item.etag) {
      return res.status(304).end();
    }
    res.setHeader('Content-Type', item.mimeType);
    res.setHeader('ETag', item.etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
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

  // --- Browser Push & FCM Subscriptions + Preferences API (Firestore-Synced) ---
  app.get('/api/push/config', async (_req, res) => {
    try {
      const vapid = await loadOrCreateVapidKeys();
      res.json({
        success: true,
        publicKey: vapid.publicKey,
        fcmVapidKey: (process.env.VITE_FIREBASE_VAPID_KEY || process.env.FIREBASE_FCM_VAPID_KEY || '').trim() || null,
        firebaseMessagingEnabled: Boolean(hasAdminCredentials && adminApp),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت کلید اعلان' });
    }
  });

  app.get('/api/push/preferences', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const [prefs, subs] = await Promise.all([getUserNotificationPrefs(uid), loadUserPushSubscriptions(uid)]);
      res.json({
        success: true,
        prefs,
        subscriptionsCount: subs.length,
        subscriptions: subs.map((s) => ({
          id: s.id,
          platform: s.platform || 'web',
          hasEndpoint: Boolean(s.endpoint),
          hasFcmToken: Boolean(s.fcm_token),
          updatedAt: s.updatedAt,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت تنظیمات اعلان' });
    }
  });

  app.put('/api/push/preferences', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const cur = await getUserNotificationPrefs(uid);
      const body = req.body || {};
      const next: NotificationPrefsRecord = {
        user_id: uid,
        deals_enabled: body.deals_enabled !== undefined ? Boolean(body.deals_enabled) : cur.deals_enabled,
        messages_enabled: body.messages_enabled !== undefined ? Boolean(body.messages_enabled) : cur.messages_enabled,
        channels_enabled: body.channels_enabled !== undefined ? Boolean(body.channels_enabled) : cur.channels_enabled,
        foreground_alerts: body.foreground_alerts !== undefined ? Boolean(body.foreground_alerts) : cur.foreground_alerts,
        updatedAt: new Date().toISOString(),
      };
      memoryNotificationPrefs.set(uid, next);

      const firestore = getDb();
      if (firestore) {
        await firestore
          .collection('notification_prefs')
          .doc(uid)
          .set(
            {
              user_id: uid,
              deals_enabled: next.deals_enabled,
              messages_enabled: next.messages_enabled,
              channels_enabled: next.channels_enabled,
              foreground_alerts: next.foreground_alerts,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {});
      }
      res.json({ success: true, prefs: next });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ذخیره تنظیمات اعلان' });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const { endpoint, keys, fcm_token, platform, user_agent } = req.body || {};
      const cleanEndpoint = typeof endpoint === 'string' ? endpoint.trim().slice(0, 1000) : '';
      const cleanFcm = typeof fcm_token === 'string' ? fcm_token.trim().slice(0, 512) : '';

      if (!cleanEndpoint && !cleanFcm) {
        return res.status(400).json({ success: false, error: 'اطلاعات اشتراک مرورگر نامعتبر است.' });
      }

      const rawKey = `${uid}:${cleanEndpoint || cleanFcm}`;
      const subId = `sub_${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 24)}`;
      const nowIso = new Date().toISOString();
      const existing = memoryPushSubscriptions.get(subId);

      const record: PushSubscriptionRecord = {
        id: subId,
        user_id: uid,
        ...(cleanEndpoint ? { endpoint: cleanEndpoint } : {}),
        ...(keys && typeof keys === 'object' && keys.p256dh && keys.auth
          ? { keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) } }
          : {}),
        ...(cleanFcm ? { fcm_token: cleanFcm } : {}),
        platform: String(platform || 'web').slice(0, 64),
        user_agent: String(user_agent || '').slice(0, 300),
        enabled: true,
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
      };
      memoryPushSubscriptions.set(subId, record);

      const firestore = getDb();
      if (firestore) {
        await firestore
          .collection('push_subscriptions')
          .doc(subId)
          .set(
            {
              id: subId,
              user_id: uid,
              ...(record.endpoint ? { endpoint: record.endpoint } : {}),
              ...(record.keys ? { keys: record.keys } : {}),
              ...(record.fcm_token ? { fcm_token: record.fcm_token } : {}),
              platform: record.platform,
              user_agent: record.user_agent,
              enabled: true,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {});
      }

      res.json({ success: true, subscriptionId: subId });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت اشتراک اعلان' });
    }
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const { endpoint, fcm_token } = req.body || {};
      const subs = await loadUserPushSubscriptions(uid);
      const targets = subs.filter(
        (s) => (endpoint && s.endpoint === endpoint) || (fcm_token && s.fcm_token === fcm_token) || (!endpoint && !fcm_token)
      );
      await Promise.all(targets.map((s) => removePushSubscriptionById(s.id)));
      res.json({ success: true, removedCount: targets.length });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در لغو اشتراک اعلان' });
    }
  });

  app.post('/api/push/test', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const deliveredCount = await dispatchBrowserPushToUser(uid, {
        title: '🛡️ تست اعلان فوری میانجی',
        body: 'اتصال پوش نوتیفیکیشن مرورگر با بک‌اند فایربیس با موفقیت برقرار است.',
        kind: 'system',
        url: '/?view=notifications',
        tag: `mianji-test-${Date.now()}`,
      });
      res.json({ success: true, deliveredCount });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ارسال اعلان آزمایشی' });
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
      type: 'escrow_lock' | 'escrow_release' | 'platform_fee' | 'deposit' | 'withdraw';
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

  // Track unread counts per roomKey ("direct:roomId" | "contract:cid") -> Map<userId, number>
  const memoryUnreadCounts = new Map<string, Map<string, number>>();
  const memoryDirectChats = new Map<string, DirectChatRoomRecord>();
  const memoryDirectMessages = new Map<string, any[]>();
  const memoryContractMessages = new Map<string, any[]>();
  const memoryPinnedMessages = new Map<string, { id: string; text: string } | null>();

  const bumpUnread = (roomKey: string, recipientId: string) => {
    let map = memoryUnreadCounts.get(roomKey);
    if (!map) {
      map = new Map<string, number>();
      memoryUnreadCounts.set(roomKey, map);
    }
    map.set(String(recipientId), (map.get(String(recipientId)) || 0) + 1);
  };

  const getUnreadCount = (roomKey: string, uid: string) => {
    return memoryUnreadCounts.get(roomKey)?.get(String(uid)) || 0;
  };

  const clearUnreadCount = (roomKey: string, uid: string) => {
    memoryUnreadCounts.get(roomKey)?.set(String(uid), 0);
  };

  const memoryDealReviews = new Map<string, any>();
  const processingDealIds = new Set<string>();

  const getReviewsForDeal = async (cid: string) => {
    const out = new Map<string, any>();
    for (const r of memoryDealReviews.values()) {
      if (String(r.contract_id) === cid) out.set(String(r.id), r);
    }
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('deal_reviews').where('contract_id', '==', cid).get();
        snap.docs.forEach((d) => {
          const item = { id: d.id, ...(d.data() || {}) };
          out.set(d.id, item);
          memoryDealReviews.set(d.id, item);
        });
      } catch {}
    }
    return Array.from(out.values());
  };

  const getReviewsForUser = async (targetUserId: string) => {
    const out = new Map<string, any>();
    for (const r of memoryDealReviews.values()) {
      if (String(r.target_user_id) === targetUserId) out.set(String(r.id), r);
    }
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('deal_reviews').where('target_user_id', '==', targetUserId).limit(100).get();
        snap.docs.forEach((d) => {
          const item = { id: d.id, ...(d.data() || {}) };
          out.set(d.id, item);
          memoryDealReviews.set(d.id, item);
        });
      } catch {}
    }
    return Array.from(out.values()).sort(
      (a, b) => Date.parse(String(b.created_at || 0)) - Date.parse(String(a.created_at || 0))
    );
  };

  const enrichDealWithParties = async (deal: any, usersById?: Map<string, any>, uid?: string) => {
    const buyerId = String(deal?.buyer_id || '');
    const sellerId = String(deal?.seller_id || '');
    const buyer = usersById?.get(buyerId) || (buyerId ? await getUserById(buyerId) : null);
    const seller = usersById?.get(sellerId) || (sellerId ? await getUserById(sellerId) : null);
    const cid = String(deal?.contract_id || deal?.id || '');
    const createdAt = deal?.createdAt || deal?.created_at || new Date().toISOString();
    const defaultTimeline = [
      {
        id: `tl_init_${cid}`,
        type: 'created',
        status: 'draft',
        actor_id: buyerId,
        actor_name: buyer?.full_name || 'کارفرما',
        note: 'قرارداد امن ایجاد شد',
        timestamp: createdAt,
      },
    ];
    const reviews = cid ? await getReviewsForDeal(cid) : [];
    const feePercent = Math.max(0, Math.min(15, Number(deal?.fee_percent ?? 0)));
    const amount = Number(deal?.amount || 0);
    const feeAmount = deal?.fee_amount !== undefined ? Number(deal.fee_amount) : Math.floor((amount * feePercent) / 100);
    const createdAtMs = Date.parse(String(createdAt)) || Date.now();
    const deadlineDays = Math.max(1, Math.min(365, Number(deal?.deadline || 7) || 7));
    const fallbackDeliveryDueAt =
      deal?.delivery_due_at ||
      (deal?.status === 'active' ? new Date(createdAtMs + deadlineDays * 86400000).toISOString() : undefined);
    const disputeMem = cid ? memoryDisputes.get(cid) : undefined;
    const appealObj = deal?.appeal || disputeMem?.appeal || undefined;
    return {
      ...deal,
      buyer_name: deal?.buyer_name || buyer?.full_name || 'کارفرما',
      buyer_phone: deal?.buyer_phone || buyer?.phone_number || '',
      buyer_kyc: deal?.buyer_kyc || buyer?.kyc_status || 'verified',
      buyer_rating_avg: Number(buyer?.rating_avg || 0),
      buyer_rating_count: Number(buyer?.rating_count || 0),
      seller_name: deal?.seller_name || seller?.full_name || 'مجری',
      seller_phone: deal?.seller_phone || seller?.phone_number || '',
      seller_kyc: deal?.seller_kyc || seller?.kyc_status || 'verified',
      seller_rating_avg: Number(seller?.rating_avg || 0),
      seller_rating_count: Number(seller?.rating_count || 0),
      fee_percent: feePercent,
      fee_amount: feeAmount,
      net_seller_amount: deal?.net_seller_amount !== undefined ? Number(deal.net_seller_amount) : Math.max(0, amount - feeAmount),
      is_milestone: Boolean(deal?.is_milestone && Array.isArray(deal?.milestones) && deal.milestones.length >= 2),
      milestones: Array.isArray(deal?.milestones) ? deal.milestones : [],
      inspection_hours: String(deal?.inspection_hours || '48'),
      ...(fallbackDeliveryDueAt ? { delivery_due_at: fallbackDeliveryDueAt } : {}),
      ...(appealObj ? { appeal: appealObj } : {}),
      reviews,
      timeline: Array.isArray(deal?.timeline) && deal.timeline.length > 0 ? deal.timeline : defaultTimeline,
      unread_count: uid ? getUnreadCount(`contract:${cid}`, uid) : 0,
    };
  };

  const executeEscrowPayout = async (params: {
    cid: string;
    deal: any;
    grossUnlockAmount: number;
    sellerGrossAmount: number;
    feePercent: number;
    buyerId: string;
    sellerId: string;
    nextDealFields: Record<string, any>;
    releaseDescription: string;
    incrementCompletedCount?: boolean;
  }): Promise<{
    balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }>;
    feeAmount: number;
    sellerNet: number;
  }> => {
    const {
      cid,
      deal,
      grossUnlockAmount,
      sellerGrossAmount,
      feePercent,
      buyerId,
      sellerId,
      nextDealFields,
      releaseDescription,
      incrementCompletedCount,
    } = params;
    const firestore = getDb();
    const balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};

    const cleanFeePct = Math.max(0, Math.min(15, Number(feePercent || 0)));
    const feeAmount =
      sellerGrossAmount > 0 ? Math.min(sellerGrossAmount, Math.floor((sellerGrossAmount * cleanFeePct) / 100)) : 0;
    const sellerNet = Math.max(0, sellerGrossAmount - feeAmount);

    const buyer = (await getUserById(buyerId)) || { wallet_balance: grossUnlockAmount, escrow_locked_balance: grossUnlockAmount };
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

          const nextBuyerLocked = Math.max(0, bLocked - grossUnlockAmount);
          const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - sellerGrossAmount);
          const nextSellerWallet = sWallet + sellerNet;

          const bUpdate: any = {
            wallet_balance: nextBuyerWallet,
            escrow_locked_balance: nextBuyerLocked,
            updatedAt: FieldValue.serverTimestamp(),
          };
          const sUpdate: any = {
            wallet_balance: nextSellerWallet,
            escrow_locked_balance: sLocked,
            updatedAt: FieldValue.serverTimestamp(),
          };
          if (incrementCompletedCount) {
            bUpdate.completed_deals_count = Number(bData.completed_deals_count || 0) + 1;
            sUpdate.completed_deals_count = Number(sData.completed_deals_count || 0) + 1;
          }

          tx.set(firestore.collection('users').doc(buyerId), bUpdate, { merge: true });
          tx.set(firestore.collection('users').doc(sellerId), sUpdate, { merge: true });
          tx.set(
            firestore.collection('deals').doc(cid),
            { ...nextDealFields, updatedAt: FieldValue.serverTimestamp() },
            { merge: true }
          );
          balancesPayload[buyerId] = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
          balancesPayload[sellerId] = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };
        });

        const bMem = memoryUsers.get(buyerId) || buyer;
        const sMem = memoryUsers.get(sellerId) || seller;
        memoryUsers.set(buyerId, {
          ...bMem,
          id: buyerId,
          ...balancesPayload[buyerId],
          ...(incrementCompletedCount ? { completed_deals_count: Number(bMem.completed_deals_count || 0) + 1 } : {}),
        });
        memoryUsers.set(sellerId, {
          ...sMem,
          id: sellerId,
          ...balancesPayload[sellerId],
          ...(incrementCompletedCount ? { completed_deals_count: Number(sMem.completed_deals_count || 0) + 1 } : {}),
        });
        releasedInTx = true;
      } catch (txErr: any) {
        console.warn('[ESCROW-PAYOUT] Firestore tx fallback:', txErr?.message || txErr);
      }
    }

    if (!releasedInTx) {
      const bWallet = Number(buyer.wallet_balance ?? 0);
      const bLocked = Number(buyer.escrow_locked_balance ?? 0);
      const sWallet = Number(seller.wallet_balance ?? 0);
      const sLocked = Number(seller.escrow_locked_balance ?? 0);

      const nextBuyerLocked = Math.max(0, bLocked - grossUnlockAmount);
      const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - sellerGrossAmount);
      const nextSellerWallet = sWallet + sellerNet;

      await saveUserBalances(buyerId, nextBuyerWallet, nextBuyerLocked);
      await saveUserBalances(sellerId, nextSellerWallet, sLocked);
      balancesPayload[buyerId] = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
      balancesPayload[sellerId] = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };

      if (firestore) {
        await firestore
          .collection('deals')
          .doc(cid)
          .set({ ...nextDealFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }
    }

    if (sellerNet > 0) {
      await recordTransaction(firestore, {
        user_id: sellerId,
        contract_id: cid,
        amount: sellerNet,
        type: 'escrow_release',
        status: 'completed',
        description:
          feeAmount > 0
            ? `${releaseDescription} (خالص پس از کسر ${feeAmount.toLocaleString()} تومان کارمزد)`
            : releaseDescription,
      });
    }

    if (feeAmount > 0) {
      memoryTotalFeesCollected += feeAmount;
      await recordTransaction(firestore, {
        user_id: sellerId,
        contract_id: cid,
        amount: feeAmount,
        type: 'platform_fee',
        status: 'completed',
        description: `کارمزد حفاظت امانت میانجی (${cleanFeePct}٪) برای ${deal.title}`,
      });
      if (firestore) {
        await firestore
          .collection('system_settings')
          .doc('platform_stats')
          .set({ total_fees_collected: FieldValue.increment(feeAmount), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }
    }

    return { balancesPayload, feeAmount, sellerNet };
  };

  const appendContractMilestoneMessage = async (
    cid: string,
    actor: any,
    text: string,
    attachmentUrl?: string,
    recipients: string[] = []
  ) => {
    const nowIso = new Date().toISOString();
    const msgId = `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const uid = String(actor?.id || '0');
    const msgRecord: any = {
      id: msgId,
      sender_id: uid,
      text,
      type: attachmentUrl ? 'file' : 'text',
      attachment_url: attachmentUrl,
      is_system: true,
      reactions: {},
      read_by: [uid],
      created_at: nowIso,
    };
    const prevList = memoryContractMessages.get(cid) || [];
    memoryContractMessages.set(cid, [...prevList, msgRecord]);

    const firestore = getDb();
    if (firestore) {
      try {
        const fsPayload: any = {
          contract_id: cid,
          sender_id: uid,
          message_text: text,
          message_type: attachmentUrl ? 'file' : 'text',
          is_system: true,
          created_at: FieldValue.serverTimestamp(),
        };
        if (attachmentUrl) fsPayload.attachment_url = attachmentUrl;
        await firestore.collection('contract_messages').doc(msgId).set(fsPayload);
      } catch {}
    }

    const roomKey = `contract:${cid}`;
    const eventPayload = { scope: 'contract', chatId: cid, room: roomKey, message: msgRecord };
    wsBroadcastRoom(roomKey, 'chat:message', eventPayload);
    for (const rid of recipients) {
      if (rid && rid !== uid) {
        bumpUnread(roomKey, rid);
        wsBroadcastUser(rid, 'chat:message', eventPayload);
      }
    }
    return msgRecord;
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
      const [all, allUsers] = await Promise.all([getAllDealsMerged(), getAllUsersMerged()]);
      const usersById = new Map<string, any>(allUsers.map((u) => [String(u.id), u]));

      const filtered = includeAll
        ? all
        : all.filter((d) => String(d.buyer_id) === uid || String(d.seller_id) === uid);
      filtered.sort(
        (a, b) =>
          Date.parse(String(b.createdAt || b.created_at || 0)) -
          Date.parse(String(a.createdAt || a.created_at || 0))
      );
      const enriched = await Promise.all(filtered.map((d) => enrichDealWithParties(d, usersById, uid)));
      res.json({ success: true, deals: enriched });
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

      const {
        title,
        amount,
        role,
        phone,
        category,
        description,
        deadline,
        revisions,
        inspection_hours,
        contract_id,
        is_milestone,
        milestones,
      } = req.body || {};
      const cleanTitle = String(title || '').trim().slice(0, 200);
      const numAmount = Math.floor(Number(amount || 0));
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

      let normalizedMilestones: any[] = [];
      const useMilestones = Boolean(is_milestone);
      if (useMilestones) {
        if (!Array.isArray(milestones) || milestones.length < 2 || milestones.length > 8) {
          return res.status(400).json({
            success: false,
            error: 'در معاملات مرحله‌ای باید بین ۲ تا ۸ مرحله تعریف شود.',
          });
        }
        let milestoneSum = 0;
        for (let idx = 0; idx < milestones.length; idx++) {
          const item = milestones[idx] || {};
          const mTitle = String(item.title || '').trim().slice(0, 120);
          const mAmt = Math.floor(Number(item.amount || 0));
          if (mTitle.length < 2) {
            return res.status(400).json({ success: false, error: `عنوان مرحله ${idx + 1} حداقل باید ۲ کاراکتر باشد.` });
          }
          if (!Number.isFinite(mAmt) || mAmt < 1000) {
            return res.status(400).json({ success: false, error: `مبلغ مرحله ${idx + 1} باید حداقل ۱,۰۰۰ تومان باشد.` });
          }
          milestoneSum += mAmt;
          normalizedMilestones.push({
            id: `ms_${idx + 1}_${crypto.randomBytes(3).toString('hex')}`,
            order: idx + 1,
            title: mTitle,
            amount: mAmt,
            status: 'pending',
          });
        }
        if (milestoneSum !== numAmount) {
          return res.status(400).json({
            success: false,
            error: `مجموع مبالغ مراحل (${milestoneSum.toLocaleString()} تومان) باید دقیقاً برابر مبلغ کل قرارداد (${numAmount.toLocaleString()} تومان) باشد.`,
          });
        }
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

      const feePercent = Math.max(0, Math.min(15, Number(limits.platform_fee_percent || 0)));
      const feeAmount = Math.floor((numAmount * feePercent) / 100);
      const netSellerAmount = Math.max(0, numAmount - feeAmount);

      const cid = String(contract_id || `M-${crypto.randomInt(100000, 999999)}`).replace(/[^a-zA-Z0-9_-]/g, '');
      const nowIso = new Date().toISOString();
      const buyerId = role === 'buyer' ? String(actor.id) : otherId;
      const sellerId = role === 'seller' ? String(actor.id) : otherId;
      const initialTimeline = [
        {
          id: `tl_${Date.now()}`,
          type: 'created',
          status: 'draft',
          actor_id: String(actor.id),
          actor_name: actor.full_name || 'کاربر میانجی',
          note: useMilestones
            ? `قرارداد مرحله‌ای «${cleanTitle}» (${normalizedMilestones.length} مرحله) به مبلغ ${numAmount.toLocaleString()} تومان ثبت شد.`
            : `قرارداد «${cleanTitle}» به مبلغ ${numAmount.toLocaleString()} تومان ثبت شد.`,
          timestamp: nowIso,
        },
      ];

      const rawDeal: any = {
        id: cid,
        contract_id: cid,
        title: cleanTitle,
        amount: numAmount,
        fee_percent: feePercent,
        fee_amount: feeAmount,
        net_seller_amount: netSellerAmount,
        is_milestone: useMilestones,
        milestones: normalizedMilestones,
        buyer_id: buyerId,
        seller_id: sellerId,
        status: 'draft',
        category: String(category || 'digital').slice(0, 50),
        description: String(description || '').slice(0, 2000),
        deadline: String(deadline || '7').slice(0, 20),
        revisions: String(revisions || '2').slice(0, 20),
        inspection_hours: String(inspection_hours || '48').slice(0, 10),
        timeline: initialTimeline,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const dealRecord = await enrichDealWithParties(rawDeal, undefined, String(actor.id));
      memoryDeals.set(cid, dealRecord);

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('deals').doc(cid).set({
            contract_id: cid,
            title: dealRecord.title,
            amount: dealRecord.amount,
            fee_percent: feePercent,
            fee_amount: feeAmount,
            net_seller_amount: netSellerAmount,
            is_milestone: useMilestones,
            milestones: normalizedMilestones,
            buyer_id: buyerId,
            seller_id: sellerId,
            status: 'draft',
            category: dealRecord.category,
            description: dealRecord.description,
            deadline: dealRecord.deadline,
            revisions: dealRecord.revisions,
            inspection_hours: dealRecord.inspection_hours,
            timeline: initialTimeline,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.warn('[DEALS] Firestore write fallback:', (err as Error)?.message);
        }
      }

      await appendContractMilestoneMessage(
        cid,
        actor,
        `🛡️ قرارداد امن «${cleanTitle}» به مبلغ ${numAmount.toLocaleString()} تومان توسط ${actor.full_name || 'کاربر'} ایجاد شد.`,
        undefined,
        [buyerId, sellerId]
      );

      await pushUserNotification(
        otherId,
        'قرارداد امن جدید ثبت شد',
        `${actor.full_name || 'طرف مقابل'} قرارداد «${cleanTitle}» به مبلغ ${numAmount.toLocaleString()} تومان را با شما ثبت کرد.`,
        `🤝 <b>قرارداد جدید میانجی</b>\n\nعنوان: <b>${cleanTitle}</b>\nشناسه: <code>${cid}</code>\nمبلغ: <b>${numAmount.toLocaleString()} تومان</b>\n\nلطفاً وارد وب‌اپ میانجی شوید و قرارداد را بررسی کنید.`,
        {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=detail&contract_id=${cid}`,
          tag: `mianji-deal-${cid}-draft`,
        }
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
    const cid = String(req.params.contractId || '').trim();
    if (processingDealIds.has(cid)) {
      return res.status(409).json({ success: false, error: 'درخواست تغییر وضعیت همزمان در حال پردازش است.' });
    }
    processingDealIds.add(cid);
    try {
      const actor = authResult.actor;
      const nextStatus = String(req.body?.status || '').trim();
      const transitionNote = String(req.body?.note || '').trim().slice(0, 1000);
      const transitionAttachment =
        typeof req.body?.attachment_url === 'string' && req.body.attachment_url.length <= 2048
          ? req.body.attachment_url
          : undefined;

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

      if (deal.is_milestone && ['work_submitted', 'completed'].includes(nextStatus) && !isAdminActor) {
        return res.status(400).json({
          success: false,
          error: 'این قرارداد مرحله‌ای است؛ لطفاً از کارت مراحل پروژه هر مرحله را تحویل یا آزادسازی کنید.',
        });
      }

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
      const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent || 0)));
      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      const firestore = getDb();
      let balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};

      const nowIso = new Date().toISOString();
      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const timelineEntry: any = {
        id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        type: 'status_change',
        status: nextStatus,
        actor_id: uid,
        actor_name: actor.full_name || 'کاربر میانجی',
        ...(transitionNote ? { note: transitionNote } : {}),
        ...(transitionAttachment ? { attachment_url: transitionAttachment } : {}),
        timestamp: nowIso,
      };
      const nextTimeline = [...prevTimeline, timelineEntry];

      const extraDealFields: Record<string, any> = {
        timeline: nextTimeline,
      };
      if (cur === 'awaiting_payment' && nextStatus === 'active') {
        const deadlineDays = Math.max(1, Math.min(365, Number(deal.deadline || 7) || 7));
        extraDealFields.delivery_due_at = new Date(Date.now() + deadlineDays * 86400000).toISOString();
        extraDealFields.deadline_warning_sent = null;
        extraDealFields.deadline_overdue_sent = null;
      }
      if (nextStatus === 'work_submitted') {
        const minHours = isProd ? 1 : 0.001;
        const hours = Math.max(minHours, Math.min(720, Number(deal.inspection_hours) || 48));
        extraDealFields.work_submitted_at = nowIso;
        extraDealFields.auto_release_at = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        extraDealFields.auto_release_warning_sent = null;
        if (transitionNote) extraDealFields.delivery_note = transitionNote;
        if (transitionAttachment) extraDealFields.delivery_attachment_url = transitionAttachment;
      } else if (cur === 'work_submitted' && nextStatus === 'active') {
        extraDealFields.auto_release_at = null;
        extraDealFields.auto_release_warning_sent = null;
        if (transitionNote) extraDealFields.revision_note = transitionNote;
      } else if (nextStatus === 'disputed') {
        extraDealFields.auto_release_at = null;
        extraDealFields.auto_release_warning_sent = null;
        if (Array.isArray(deal.milestones) && deal.milestones.length > 0) {
          extraDealFields.milestones = deal.milestones.map((m: any) => ({ ...m, auto_release_at: null, auto_release_warning_sent: null }));
        }
        if (transitionNote) extraDealFields.dispute_reason = transitionNote;
      } else if (nextStatus === 'completed') {
        extraDealFields.auto_release_at = null;
        extraDealFields.auto_release_warning_sent = null;
      }

      if (cur === 'awaiting_payment' && nextStatus === 'active' && deal.is_milestone && Array.isArray(deal.milestones) && deal.milestones.length > 0) {
        extraDealFields.milestones = deal.milestones.map((m: any, i: number) => ({
          ...m,
          status: i === 0 ? 'active' : 'pending',
        }));
      }

      // Atomic financial operations
      if (cur === 'awaiting_payment' && nextStatus === 'active') {
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
                { status: 'active', ...extraDealFields, updatedAt: FieldValue.serverTimestamp() },
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
        const payout = await executeEscrowPayout({
          cid,
          deal,
          grossUnlockAmount: amount,
          sellerGrossAmount: amount,
          feePercent,
          buyerId,
          sellerId,
          nextDealFields: { status: 'completed', ...extraDealFields },
          releaseDescription: `آزادسازی و تسویه معامله ${deal.title}`,
          incrementCompletedCount: true,
        });
        balancesPayload = payout.balancesPayload;
      } else if (firestore) {
        await firestore
          .collection('deals')
          .doc(cid)
          .set({ status: nextStatus, ...extraDealFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }

      const rawUpdated = { ...deal, ...extraDealFields, status: nextStatus, updatedAt: nowIso, updated_at: nowIso };
      const updatedDeal = await enrichDealWithParties(rawUpdated, undefined, uid);
      memoryDeals.set(cid, updatedDeal);

      const otherPartyId = uid === buyerId ? sellerId : buyerId;
      const statusMsgMap: Record<string, string> = {
        awaiting_payment: `قرارداد «${deal.title}» تایید شد و در انتظار قفل وجه است.`,
        active:
          cur === 'work_submitted'
            ? `کارفرما برای قرارداد «${deal.title}» درخواست اصلاحات ثبت کرد.`
            : `مبلغ ${amount.toLocaleString()} تومان در حساب امانی برای «${deal.title}» قفل شد. اجرا را آغاز کنید.`,
        work_submitted: `مجری کار پروژه «${deal.title}» را تحویل داد. مهلت بازرسی ${deal.inspection_hours || 48} ساعته آغاز شد.`,
        completed: `معامله «${deal.title}» با موفقیت تایید و مبلغ آزاد شد.`,
        cancelled: `قرارداد «${deal.title}» لغو شد.`,
        disputed: `برای قرارداد «${deal.title}» درخواست حل اختلاف ثبت شد.`,
      };
      const summaryText = statusMsgMap[nextStatus] || `وضعیت معامله «${deal.title}» تغییر کرد.`;
      const chatMilestoneText = transitionNote ? `${summaryText}\n📝 توضیح: ${transitionNote}` : summaryText;

      await appendContractMilestoneMessage(cid, actor, chatMilestoneText, transitionAttachment, [buyerId, sellerId]);

      await pushUserNotification(
        otherPartyId,
        `به‌روزرسانی قرارداد ${cid}`,
        summaryText,
        `📌 <b>به‌روزرسانی معامله ${cid}</b>\n\n${summaryText}`,
        {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=detail&contract_id=${cid}`,
          tag: `mianji-deal-${cid}-${nextStatus}`,
        }
      );
      if (nextStatus === 'completed') {
        await pushUserNotification(
          buyerId,
          `تسویه کامل قرارداد ${cid}`,
          summaryText,
          undefined,
          {
            kind: 'deal',
            contract_id: cid,
            url: `/?view=detail&contract_id=${cid}`,
            tag: `mianji-deal-${cid}-completed-buyer`,
          }
        );
      }

      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });

      res.json({ success: true, deal: updatedDeal, balances: balancesPayload });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || 'خطا در تغییر وضعیت قرارداد' });
    } finally {
      processingDealIds.delete(cid);
    }
  });

  // --- Milestone Deal Stage Transitions ---
  app.post('/api/deals/:contractId/milestones/:milestoneId/transition', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const cid = String(req.params.contractId || '').trim();
    const milestoneId = String(req.params.milestoneId || '').trim();
    if (processingDealIds.has(cid)) {
      return res.status(409).json({ success: false, error: 'عملیات همزمان در حال پردازش است.' });
    }
    processingDealIds.add(cid);
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const action = String(req.body?.action || '').trim(); // 'submit' | 'revision' | 'release'
      const note = String(req.body?.note || '').trim().slice(0, 1000);
      const attachmentUrl =
        typeof req.body?.attachment_url === 'string' && req.body.attachment_url.length <= 2048
          ? req.body.attachment_url
          : undefined;

      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });
      if (!deal.is_milestone || !Array.isArray(deal.milestones) || deal.milestones.length < 2) {
        return res.status(400).json({ success: false, error: 'این قرارداد از نوع مرحله‌ای نیست.' });
      }
      if (deal.status !== 'active') {
        return res.status(400).json({ success: false, error: 'فقط قراردادهای در حال اجرا قابل پیشبرد مرحله‌ای هستند.' });
      }

      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      const isBuyer = uid === buyerId;
      const isSeller = uid === sellerId;
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      if (!isBuyer && !isSeller && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'شما مجاز به تغییر وضعیت این مرحله نیستید.' });
      }

      const msIdx = deal.milestones.findIndex((m: any) => String(m.id) === milestoneId);
      if (msIdx === -1) return res.status(404).json({ success: false, error: 'مرحله مورد نظر یافت نشد.' });
      const targetMs = deal.milestones[msIdx];
      const nowIso = new Date().toISOString();
      const updatedMilestones = deal.milestones.map((m: any) => ({ ...m }));
      let balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};
      let nextDealStatus = 'active';
      let timelineNote = '';

      if (action === 'submit') {
        if (!isSeller && !isAdminActor) {
          return res.status(403).json({ success: false, error: 'فقط مجری می‌تواند مرحله را تحویل دهد.' });
        }
        if (targetMs.status !== 'active') {
          return res.status(400).json({ success: false, error: 'این مرحله در وضعیت فعال نیست.' });
        }
        const minHours = isProd ? 1 : 0.001;
        const hours = Math.max(minHours, Math.min(720, Number(deal.inspection_hours) || 48));
        updatedMilestones[msIdx] = {
          ...targetMs,
          status: 'work_submitted',
          submitted_at: nowIso,
          auto_release_at: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
          auto_release_warning_sent: null,
          ...(note ? { delivery_note: note } : {}),
          ...(attachmentUrl ? { delivery_attachment_url: attachmentUrl } : {}),
        };
        timelineNote = `مرحله ${msIdx + 1} («${targetMs.title}») توسط مجری تحویل داده شد.`;
      } else if (action === 'revision') {
        if (!isBuyer && !isAdminActor) {
          return res.status(403).json({ success: false, error: 'فقط کارفرما می‌تواند درخواست اصلاح مرحله بدهد.' });
        }
        if (targetMs.status !== 'work_submitted') {
          return res.status(400).json({ success: false, error: 'این مرحله در وضعیت تحویل‌شده نیست.' });
        }
        updatedMilestones[msIdx] = {
          ...targetMs,
          status: 'active',
          auto_release_at: null,
          ...(note ? { revision_note: note } : {}),
        };
        timelineNote = `درخواست اصلاحات برای مرحله ${msIdx + 1} («${targetMs.title}») ثبت شد.`;
      } else if (action === 'release') {
        if (!isBuyer && !isAdminActor) {
          return res.status(403).json({ success: false, error: 'فقط کارفرما می‌تواند مبلغ مرحله را آزاد کند.' });
        }
        if (!['work_submitted', 'active'].includes(targetMs.status)) {
          return res.status(400).json({ success: false, error: 'امکان آزادسازی این مرحله در وضعیت فعلی نیست.' });
        }
        updatedMilestones[msIdx] = {
          ...targetMs,
          status: 'completed',
          completed_at: nowIso,
          auto_release_at: null,
        };
        const nextPendingIdx = updatedMilestones.findIndex((m: any) => m.status === 'pending');
        if (nextPendingIdx !== -1) {
          updatedMilestones[nextPendingIdx] = { ...updatedMilestones[nextPendingIdx], status: 'active' };
        }
        const allDone = updatedMilestones.every((m: any) => m.status === 'completed');
        if (allDone) nextDealStatus = 'completed';

        const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
        const timelineEntry = {
          id: `tl_ms_${Date.now()}`,
          type: 'milestone_release',
          status: nextDealStatus,
          actor_id: uid,
          actor_name: actor.full_name || 'کارفرما',
          note: `مرحله ${msIdx + 1} («${targetMs.title}») تایید و مبلغ ${Number(targetMs.amount).toLocaleString()} تومان آزاد شد.`,
          timestamp: nowIso,
        };
        const nextTimeline = [...prevTimeline, timelineEntry];
        const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent || 0)));

        const payout = await executeEscrowPayout({
          cid,
          deal,
          grossUnlockAmount: Number(targetMs.amount),
          sellerGrossAmount: Number(targetMs.amount),
          feePercent,
          buyerId,
          sellerId,
          nextDealFields: {
            status: nextDealStatus,
            milestones: updatedMilestones,
            timeline: nextTimeline,
            auto_release_at: null,
          },
          releaseDescription: `آزادسازی مرحله ${msIdx + 1} (${targetMs.title}) در ${deal.title}`,
          incrementCompletedCount: allDone,
        });
        balancesPayload = payout.balancesPayload;
        timelineNote = timelineEntry.note;

        const updatedDeal = await enrichDealWithParties(
          {
            ...deal,
            status: nextDealStatus,
            milestones: updatedMilestones,
            timeline: nextTimeline,
            updatedAt: nowIso,
            updated_at: nowIso,
          },
          undefined,
          uid
        );
        memoryDeals.set(cid, updatedDeal);

        await appendContractMilestoneMessage(cid, actor, `✅ ${timelineNote}`, undefined, [buyerId, sellerId]);
        await pushUserNotification(
          sellerId,
          `آزادسازی وجه مرحله ${msIdx + 1}`,
          timelineNote,
          `💰 <b>آزادسازی مرحله‌ای (${cid})</b>\n\n${timelineNote}`,
          {
            kind: 'deal',
            contract_id: cid,
            url: `/?view=detail&contract_id=${cid}`,
            tag: `mianji-ms-${cid}-${milestoneId}-completed`,
          }
        );
        wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
        wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
        wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
        return res.json({ success: true, deal: updatedDeal, balances: balancesPayload });
      } else {
        return res.status(400).json({ success: false, error: 'عملیات مرحله نامعتبر است.' });
      }

      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const nextTimeline = [
        ...prevTimeline,
        {
          id: `tl_ms_${Date.now()}`,
          type: 'milestone_update',
          status: nextDealStatus,
          actor_id: uid,
          actor_name: actor.full_name || 'کاربر میانجی',
          note: note ? `${timelineNote}\n📝 ${note}` : timelineNote,
          ...(attachmentUrl ? { attachment_url: attachmentUrl } : {}),
          timestamp: nowIso,
        },
      ];

      const firestore = getDb();
      if (firestore) {
        await firestore
          .collection('deals')
          .doc(cid)
          .set({ milestones: updatedMilestones, timeline: nextTimeline, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }

      const updatedDeal = await enrichDealWithParties(
        {
          ...deal,
          milestones: updatedMilestones,
          timeline: nextTimeline,
          updatedAt: nowIso,
          updated_at: nowIso,
        },
        undefined,
        uid
      );
      memoryDeals.set(cid, updatedDeal);

      const notifyUserId = uid === buyerId ? sellerId : buyerId;
      await appendContractMilestoneMessage(
        cid,
        actor,
        note ? `${timelineNote}\n📝 توضیح: ${note}` : timelineNote,
        attachmentUrl,
        [buyerId, sellerId]
      );
      await pushUserNotification(
        notifyUserId,
        `به‌روزرسانی مرحله ${msIdx + 1} قرارداد ${cid}`,
        timelineNote,
        undefined,
        {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=detail&contract_id=${cid}`,
          tag: `mianji-ms-${cid}-${milestoneId}-${action}`,
        }
      );

      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });
      wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal });
      res.json({ success: true, deal: updatedDeal });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || 'خطا در به‌روزرسانی مرحله' });
    } finally {
      processingDealIds.delete(cid);
    }
  });

  // --- Counterparty Rating & Reviews (Post-Completion) ---
  app.post('/api/deals/:contractId/review', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const cid = String(req.params.contractId || '').trim();
      const score = Math.round(Number(req.body?.score || 0));
      const comment = String(req.body?.comment || '').trim().slice(0, 500);

      if (!Number.isFinite(score) || score < 1 || score > 5) {
        return res.status(400).json({ success: false, error: 'امتیاز باید عددی بین ۱ تا ۵ ستاره باشد.' });
      }

      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });
      if (deal.status !== 'completed') {
        return res.status(400).json({ success: false, error: 'ثبت امتیاز فقط پس از تکمیل و تسویه معامله امکان‌پذیر است.' });
      }

      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      if (uid !== buyerId && uid !== sellerId) {
        return res.status(403).json({ success: false, error: 'فقط طرفین معامله می‌توانند امتیاز ثبت کنند.' });
      }

      const targetUserId = uid === buyerId ? sellerId : buyerId;
      const reviewId = `${cid}_${uid}`;
      const existingReviews = await getReviewsForDeal(cid);
      if (existingReviews.some((r) => String(r.id) === reviewId || String(r.reviewer_id) === uid)) {
        return res.status(400).json({ success: false, error: 'شما پیش‌تر امتیاز خود را برای این معامله ثبت کرده‌اید.' });
      }

      const reviewRecord = {
        id: reviewId,
        contract_id: cid,
        reviewer_id: uid,
        reviewer_name: String(actor.full_name || 'کاربر میانجی').slice(0, 100),
        target_user_id: targetUserId,
        score,
        comment,
        created_at: new Date().toISOString(),
      };
      memoryDealReviews.set(reviewId, reviewRecord);

      const firestore = getDb();
      if (firestore) {
        await firestore.collection('deal_reviews').doc(reviewId).set(reviewRecord).catch(() => {});
      }

      // Recompute target user rating stats
      const allTargetReviews = await getReviewsForUser(targetUserId);
      const ratingCount = allTargetReviews.length;
      const sumScores = allTargetReviews.reduce((acc, r) => acc + Number(r.score || 0), 0);
      const ratingAvg = ratingCount > 0 ? Math.round((sumScores / ratingCount) * 10) / 10 : 0;
      const targetUser = (await getUserById(targetUserId)) || { id: targetUserId };
      const nextTrustScore = Math.min(100, Math.max(50, Math.round(75 + ratingAvg * 5)));

      const updatedTargetUser = {
        ...targetUser,
        id: targetUserId,
        rating_avg: ratingAvg,
        rating_count: ratingCount,
        trust_score: nextTrustScore,
      };
      memoryUsers.set(targetUserId, updatedTargetUser);

      if (firestore) {
        await firestore
          .collection('users')
          .doc(targetUserId)
          .set(
            {
              rating_avg: ratingAvg,
              rating_count: ratingCount,
              trust_score: nextTrustScore,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {});
      }

      const updatedDeal = await enrichDealWithParties(deal, undefined, uid);
      memoryDeals.set(cid, updatedDeal);

      await pushUserNotification(
        targetUserId,
        `امتیاز جدید (${score} ★) در معامله ${cid}`,
        `${reviewRecord.reviewer_name} امتیاز ${score} از ۵ ستاره برای شما ثبت کرد.${comment ? ` «${comment}»` : ''}`,
        undefined,
        {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=detail&contract_id=${cid}`,
          tag: `mianji-review-${reviewId}`,
        }
      );

      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });
      wsBroadcastUser(targetUserId, 'user:updated', { userId: targetUserId, user: updatedTargetUser });

      res.json({ success: true, review: reviewRecord, deal: updatedDeal, rating: { rating_avg: ratingAvg, rating_count: ratingCount } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت امتیاز' });
    }
  });

  app.get('/api/users/:userId/reviews', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const targetUserId = String(req.params.userId || '').trim();
      const [targetUser, reviews] = await Promise.all([getUserById(targetUserId), getReviewsForUser(targetUserId)]);
      const count = reviews.length || Number(targetUser?.rating_count || 0);
      const avg =
        reviews.length > 0
          ? Math.round((reviews.reduce((a, r) => a + Number(r.score || 0), 0) / reviews.length) * 10) / 10
          : Number(targetUser?.rating_avg || 0);
      res.json({
        success: true,
        rating_avg: avg,
        rating_count: count,
        completed_deals_count: Number(targetUser?.completed_deals_count || 0),
        reviews: reviews.slice(0, 30),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت امتیازها' });
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
          const otherId = room.participants.find((p) => p !== uid && !(isAdminActor && p === 'support')) || 'support';
          const isSupportRoom = Boolean(room.is_support || otherId === 'support');
          const title =
            room.title_map?.[uid] ||
            (isAdminActor && isSupportRoom ? room.title_map?.['support'] : undefined) ||
            (isSupportRoom ? 'پشتیبانی میانجی' : `کاربر ${otherId.slice(-4)}`);
          const phone =
            room.phone_map?.[uid] ||
            (isAdminActor && isSupportRoom ? room.phone_map?.['support'] : undefined) ||
            (isSupportRoom ? '0210000' : '');
          return {
            id: room.id,
            counterparty_id: otherId,
            full_name: title,
            phone_number: phone,
            last_msg: room.last_msg || 'گفتگوی مستقیم',
            time: room.time || room.createdAt,
            unread: getUnreadCount(`direct:${room.id}`, uid),
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
      const { targetId, target_user_id, phone, fullName } = req.body || {};
      const resolvedTargetParam = targetId || target_user_id;
      const cleanPhone = extractCleanPhone(String(phone || ''));

      let targetUser: any = null;
      if (resolvedTargetParam && String(resolvedTargetParam) !== '101' && String(resolvedTargetParam) !== 'support') {
        targetUser = await getUserById(String(resolvedTargetParam));
      }
      if (!targetUser && cleanPhone.length >= 10) {
        targetUser = await findUserByPhone(cleanPhone, cleanPhone.slice(-10));
      }

      const isSupport = String(resolvedTargetParam) === '101' || String(resolvedTargetParam) === 'support';
      const counterpartyId = isSupport
        ? 'support'
        : String(targetUser?.id || resolvedTargetParam || `u_${cleanPhone.slice(-10) || Date.now()}`);
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
          unread: getUnreadCount(`direct:${roomId}`, uid),
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
        const mapSnap = (snap: FirebaseFirestore.QuerySnapshot) => {
          snap.docs.forEach((doc) => {
            const d = doc.data() || {};
            const readBy = Array.isArray(d.read_by) ? d.read_by : [];
            merged.set(doc.id, {
              id: doc.id,
              sender_id: d.sender_id,
              text: d.message_text ?? d.text ?? '',
              type: d.message_type ?? d.type ?? 'text',
              attachment_url: d.attachment_url,
              reply_to: d.reply_to || null,
              reactions: d.reactions && typeof d.reactions === 'object' ? d.reactions : {},
              edited_at: d.edited_at || undefined,
              is_system: Boolean(d.is_system),
              deal_id: d.deal_id || undefined,
              deal_snapshot: d.deal_snapshot || undefined,
              read_by: readBy,
              read: readBy.some((r: string) => String(r) !== String(d.sender_id)),
              created_at: d.created_at?.toDate?.()?.toISOString?.() || d.created_at || new Date().toISOString(),
            });
          });
        };
        try {
          if (scope === 'contract') {
            const snap = await firestore.collection('contract_messages').where('contract_id', '==', chatId).limit(120).get();
            mapSnap(snap);
          } else {
            const [snapByChat, snapByRoom] = await Promise.all([
              firestore.collection('direct_messages').where('chat_id', '==', chatId).limit(120).get(),
              firestore.collection('direct_messages').where('room_id', '==', chatId).limit(120).get(),
            ]);
            mapSnap(snapByChat);
            mapSnap(snapByRoom);
          }
        } catch {}
      }

      let pinned = memoryPinnedMessages.get(`${scope}:${chatId}`) ?? null;
      if (!pinned && firestore) {
        try {
          const pSnap = await firestore.collection('chat_pins').doc(`${scope}_${chatId}`).get();
          if (pSnap.exists) {
            const pd = pSnap.data();
            const pid = pd?.message_id || pd?.id;
            if (pid) pinned = { id: pid, text: pd?.text || '' };
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
      const { text, type, attachment_url, reply_to, deal_id } = req.body || {};

      let cleanText = String(text || '').trim().slice(0, 1000);
      const msgType = ['text', 'image', 'voice', 'file', 'deal'].includes(type) ? type : 'text';
      const cleanAttachment =
        typeof attachment_url === 'string' && attachment_url.length <= 2048 ? attachment_url : undefined;

      let dealSnapshot: any = undefined;
      let cleanDealId: string | undefined = undefined;
      if (msgType === 'deal' && deal_id) {
        const targetDeal = await getDealByContractId(String(deal_id));
        if (!targetDeal) {
          return res.status(404).json({ success: false, error: 'قرارداد انتخاب‌شده یافت نشد.' });
        }
        if (!isAdminActor && uid !== String(targetDeal.buyer_id) && uid !== String(targetDeal.seller_id)) {
          return res.status(403).json({ success: false, error: 'دسترسی به ارسال این کارت معامله مجاز نیست.' });
        }
        const enrichedDeal = await enrichDealWithParties(targetDeal);
        cleanDealId = String(enrichedDeal.contract_id);
        dealSnapshot = {
          contract_id: cleanDealId,
          title: enrichedDeal.title,
          amount: Number(enrichedDeal.amount || 0),
          status: enrichedDeal.status,
          buyer_id: enrichedDeal.buyer_id,
          seller_id: enrichedDeal.seller_id,
          buyer_name: enrichedDeal.buyer_name,
          seller_name: enrichedDeal.seller_name,
        };
        if (!cleanText) {
          cleanText = `معامله امن: ${enrichedDeal.title} (${Number(enrichedDeal.amount || 0).toLocaleString()} تومان)`;
        }
      }

      if (!cleanText && !cleanAttachment && !dealSnapshot) {
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
        let room: any = memoryDirectChats.get(chatId);
        if (!room) {
          const fsDb = getDb();
          if (fsDb) {
            try {
              const rSnap = await fsDb.collection('direct_chats').doc(chatId).get();
              if (rSnap.exists) {
                room = { id: rSnap.id, ...(rSnap.data() || {}) };
                memoryDirectChats.set(chatId, room);
              }
            } catch {}
          }
        }
        if (room && Array.isArray(room.participants)) {
          recipientIds = room.participants.filter((id: string) => id !== uid && id !== 'support');
        }
      }

      const nowIso = new Date().toISOString();
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const msgRecord: any = {
        id: msgId,
        sender_id: uid,
        text: cleanText,
        type: msgType,
        ...(cleanAttachment ? { attachment_url: cleanAttachment } : {}),
        reply_to:
          reply_to && reply_to.id
            ? {
                id: String(reply_to.id),
                sender_name: String(reply_to.sender_name || ''),
                text: String(reply_to.text || '').slice(0, 120),
              }
            : null,
        reactions: {},
        read_by: [uid],
        read: false,
        ...(cleanDealId ? { deal_id: cleanDealId, deal_snapshot: dealSnapshot } : {}),
        created_at: nowIso,
      };

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      memMap.set(chatId, [...list, msgRecord]);

      const previewLabel =
        msgType === 'image'
          ? '📷 تصویر'
          : msgType === 'voice'
          ? '🎤 پیام صوتی'
          : msgType === 'file'
          ? `📎 ${cleanText}`
          : msgType === 'deal'
          ? `🛡️ کارت معامله: ${dealSnapshot?.title || cleanText}`
          : cleanText;

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
              read_by: [uid],
              reactions: {},
              created_at: FieldValue.serverTimestamp(),
            };
            if (cleanAttachment) fsPayload.attachment_url = cleanAttachment;
            if (msgRecord.reply_to) fsPayload.reply_to = msgRecord.reply_to;
            if (cleanDealId) {
              fsPayload.deal_id = cleanDealId;
              fsPayload.deal_snapshot = dealSnapshot;
            }
            await firestore.collection('contract_messages').doc(msgId).set(fsPayload);
          } else {
            const fsPayload: any = {
              chat_id: chatId,
              room_id: chatId,
              sender_id: uid,
              message_text: cleanText,
              message_type: msgType,
              read_by: [uid],
              reactions: {},
              created_at: nowIso,
            };
            if (cleanAttachment) fsPayload.attachment_url = cleanAttachment;
            if (msgRecord.reply_to) fsPayload.reply_to = msgRecord.reply_to;
            if (cleanDealId) {
              fsPayload.deal_id = cleanDealId;
              fsPayload.deal_snapshot = dealSnapshot;
            }
            await firestore.collection('direct_messages').doc(msgId).set(fsPayload);
            await firestore.collection('direct_chats').doc(chatId).set({ last_msg: previewLabel, time: nowIso }, { merge: true });
          }
        } catch {}
      }

      const roomKey = `${scope}:${chatId}`;
      const eventPayload = { scope, chatId, room: roomKey, message: msgRecord };
      wsBroadcastRoom(roomKey, 'chat:message', eventPayload);
      for (const rid of recipientIds) {
        bumpUnread(roomKey, rid);
        wsBroadcastUser(rid, 'chat:message', eventPayload);
        const contextHeader =
          scope === 'contract'
            ? `💬 پیام جدید در معامله «${dealTitle || chatId}»`
            : `💬 پیام جدید از ${actor.full_name || 'کاربر میانجی'}`;

        void dispatchBrowserPushToUser(rid, {
          title: contextHeader,
          body: previewLabel.slice(0, 160),
          kind: 'message',
          tag: `mianji-msg-${msgId}`,
          url: `/?view=messages&scope=${scope}&chat_id=${chatId}`,
          scope,
          chat_id: chatId,
          ...(scope === 'contract' ? { contract_id: chatId } : {}),
        });

        if (!getOnlineUserIds().includes(rid)) {
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

  // Edit a chat message text
  app.patch('/api/chats/:scope/:chatId/messages/:msgId', async (req, res) => {
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
      const nextText = String(req.body?.text || '').trim().slice(0, 1000);
      if (!nextText) {
        return res.status(400).json({ success: false, error: 'متن پیام نمی‌تواند خالی باشد.' });
      }

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      const idx = list.findIndex((m) => String(m.id) === msgId);
      if (idx >= 0 && String(list[idx].sender_id) !== uid && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'فقط فرستنده می‌تواند پیام را ویرایش کند.' });
      }

      const editedAt = new Date().toISOString();
      if (idx >= 0) {
        list[idx] = { ...list[idx], text: nextText, edited_at: editedAt };
        memMap.set(chatId, list);
      }

      const firestore = getDb();
      if (firestore) {
        const colName = scope === 'contract' ? 'contract_messages' : 'direct_messages';
        await firestore
          .collection(colName)
          .doc(msgId)
          .set({ message_text: nextText, edited_at: editedAt }, { merge: true })
          .catch(() => {});
      }

      const roomKey = `${scope}:${chatId}`;
      const payload = { scope, chatId, room: roomKey, messageId: msgId, text: nextText, edited_at: editedAt };
      wsBroadcastRoom(roomKey, 'chat:edited', payload);
      if (scope === 'contract') {
        const deal = await getDealByContractId(chatId);
        if (deal) {
          [String(deal.buyer_id), String(deal.seller_id)].forEach((pid) => wsBroadcastUser(pid, 'chat:edited', payload));
        }
      } else {
        const room = memoryDirectChats.get(chatId);
        room?.participants.forEach((pid) => pid !== 'support' && wsBroadcastUser(pid, 'chat:edited', payload));
      }

      res.json({ success: true, messageId: msgId, text: nextText, edited_at: editedAt });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ویرایش پیام' });
    }
  });

  // React to a chat message
  app.post('/api/chats/:scope/:chatId/messages/:msgId/react', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const scope = req.params.scope === 'contract' ? 'contract' : 'direct';
      const chatId = String(req.params.chatId || '').trim();
      const msgId = String(req.params.msgId || '').trim();
      const uid = String(authResult.actor.id);
      const emoji = String(req.body?.emoji || '').trim().slice(0, 12);
      if (!emoji) {
        return res.status(400).json({ success: false, error: 'واکنش نامعتبر است.' });
      }

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      const idx = list.findIndex((m) => String(m.id) === msgId);
      let curReactions: Record<string, string[]> = idx >= 0 ? { ...(list[idx].reactions || {}) } : {};

      const firestore = getDb();
      const colName = scope === 'contract' ? 'contract_messages' : 'direct_messages';
      if (idx < 0 && firestore) {
        try {
          const snap = await firestore.collection(colName).doc(msgId).get();
          if (snap.exists) {
            const d = snap.data() || {};
            if (d.reactions && typeof d.reactions === 'object') curReactions = { ...d.reactions };
          }
        } catch {}
      }

      const curUsers = Array.isArray(curReactions[emoji]) ? curReactions[emoji] : [];
      if (curUsers.includes(uid)) {
        const filtered = curUsers.filter((u) => u !== uid);
        if (filtered.length > 0) curReactions[emoji] = filtered;
        else delete curReactions[emoji];
      } else {
        curReactions[emoji] = [...curUsers, uid];
      }

      if (idx >= 0) {
        list[idx] = { ...list[idx], reactions: curReactions };
        memMap.set(chatId, list);
      }

      if (firestore) {
        await firestore.collection(colName).doc(msgId).set({ reactions: curReactions }, { merge: true }).catch(() => {});
      }

      const roomKey = `${scope}:${chatId}`;
      const payload = { scope, chatId, room: roomKey, messageId: msgId, reactions: curReactions };
      wsBroadcastRoom(roomKey, 'chat:reacted', payload);
      if (scope === 'contract') {
        const deal = await getDealByContractId(chatId);
        if (deal) {
          [String(deal.buyer_id), String(deal.seller_id)].forEach((pid) => wsBroadcastUser(pid, 'chat:reacted', payload));
        }
      } else {
        const room = memoryDirectChats.get(chatId);
        room?.participants.forEach((pid) => pid !== 'support' && wsBroadcastUser(pid, 'chat:reacted', payload));
      }

      res.json({ success: true, messageId: msgId, reactions: curReactions });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت واکنش' });
    }
  });

  // Mark room messages as read & reset unread count for actor
  app.post('/api/chats/:scope/:chatId/read', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const scope = req.params.scope === 'contract' ? 'contract' : 'direct';
      const chatId = String(req.params.chatId || '').trim();
      const uid = String(authResult.actor.id);
      const roomKey = `${scope}:${chatId}`;

      clearUnreadCount(roomKey, uid);

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      const updatedIds: string[] = [];
      const nextList = list.map((m) => {
        if (String(m.sender_id) === uid) return m;
        const readBy = Array.isArray(m.read_by) ? m.read_by : [];
        if (readBy.includes(uid) && m.read) return m;
        updatedIds.push(String(m.id));
        const mergedReadBy = readBy.includes(uid) ? readBy : [...readBy, uid];
        return { ...m, read_by: mergedReadBy, read: true };
      });
      memMap.set(chatId, nextList);

      const firestore = getDb();
      if (firestore && updatedIds.length > 0) {
        const colName = scope === 'contract' ? 'contract_messages' : 'direct_messages';
        await Promise.all(
          updatedIds.slice(-20).map((mid) =>
            firestore
              .collection(colName)
              .doc(mid)
              .set({ read_by: FieldValue.arrayUnion(uid) }, { merge: true })
              .catch(() => {})
          )
        );
      }

      const payload = { scope, chatId, room: roomKey, readerId: uid, messageIds: updatedIds };
      wsBroadcastRoom(roomKey, 'chat:read', payload);
      if (scope === 'contract') {
        const deal = await getDealByContractId(chatId);
        if (deal) {
          [String(deal.buyer_id), String(deal.seller_id)].forEach((pid) => wsBroadcastUser(pid, 'chat:read', payload));
        }
      } else {
        const room = memoryDirectChats.get(chatId);
        room?.participants.forEach((pid) => pid !== 'support' && wsBroadcastUser(pid, 'chat:read', payload));
      }

      res.json({ success: true, unread: 0, updatedCount: updatedIds.length });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در به‌روزرسانی وضعیت مطالعه' });
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
    const roomKey = `${scope}:${chatId}`;
    const pinned = req.body?.id ? { id: String(req.body.id), text: String(req.body.text || '').slice(0, 200) } : null;
    memoryPinnedMessages.set(roomKey, pinned);

    const firestore = getDb();
    if (firestore) {
      try {
        if (pinned) {
          await firestore.collection('chat_pins').doc(`${scope}_${chatId}`).set({
            room_key: roomKey,
            message_id: pinned.id,
            id: pinned.id,
            text: pinned.text,
            pinned_by: String(authResult.actor.id),
            updated_at: new Date().toISOString(),
          });
        } else {
          await firestore.collection('chat_pins').doc(`${scope}_${chatId}`).delete();
        }
      } catch {}
    }

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

  app.get('/api/wallet/transactions', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const merged = new Map<string, any>();
      (memoryTransactions.get(uid) || []).forEach((tx) => merged.set(String(tx.id), tx));

      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('transactions').where('user_id', '==', uid).limit(120).get();
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

      const transactions = Array.from(merged.values()).sort(
        (a, b) => Date.parse(String(b.createdAt || b.created_at || 0)) - Date.parse(String(a.createdAt || a.created_at || 0))
      );
      res.json({ success: true, transactions });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت تراکنش‌ها' });
    }
  });

  // --- Online Payment Gateway (Zarinpal / Zibal + Signed Sandbox) & Atomic Wallet Engine ---
  interface PaymentSessionRecord {
    id: string;
    user_id: string;
    amount: number;
    provider: 'zarinpal' | 'zibal' | 'sandbox';
    authority?: string;
    ref_id?: string;
    status: 'initiated' | 'verified' | 'failed';
    created_at: string;
    verified_at?: string;
  }

  const memoryPaymentSessions = new Map<string, PaymentSessionRecord>();
  const processingPaymentIds = new Set<string>();
  const processingWalletReqIds = new Set<string>();

  const getActiveGatewayProvider = (): 'zarinpal' | 'zibal' | 'sandbox' | null => {
    if ((process.env.ZARINPAL_MERCHANT_ID || '').trim()) return 'zarinpal';
    if ((process.env.ZIBAL_MERCHANT || '').trim()) return 'zibal';
    if (!isProd) return 'sandbox';
    return null;
  };

  const signPaymentSession = (sessionId: string, amount: number) =>
    crypto.createHmac('sha256', runtimeSecret).update(`${sessionId}:${amount}`).digest('hex').slice(0, 32);

  app.get('/api/wallet/gateway/info', (_req, res) => {
    const provider = getActiveGatewayProvider();
    res.json({
      success: true,
      onlineGatewayConfigured: Boolean(provider),
      provider: provider || 'manual_only',
      sandboxMode: provider === 'sandbox',
    });
  });

  app.post('/api/wallet/gateway/initiate', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const amt = Math.floor(Number(req.body?.amount || 0));
      if (!Number.isFinite(amt) || amt < 10000 || amt > 500000000) {
        return res.status(400).json({ success: false, error: 'مبلغ شارژ باید بین ۱۰,۰۰۰ تا ۵۰۰,۰۰۰,۰۰۰ تومان باشد.' });
      }

      const provider = getActiveGatewayProvider();
      if (!provider) {
        return res.status(503).json({
          success: false,
          error: 'درگاه پرداخت آنلاین هنوز پیکربندی نشده است. لطفاً از بخش ثبت فیش استفاده کنید.',
        });
      }

      const sessionId = `pay_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
      const origin = (process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const callbackUrl = `${origin}/api/wallet/gateway/callback?session=${sessionId}`;
      const nowIso = new Date().toISOString();

      let paymentUrl = '';
      let authority = '';

      if (provider === 'zarinpal') {
        const merchantId = (process.env.ZARINPAL_MERCHANT_ID || '').trim();
        const zpRes = await fetch('https://payment.zarinpal.com/pg/v4/payment/request.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merchant_id: merchantId,
            amount: amt * 10, // Zarinpal accepts Rials
            callback_url: callbackUrl,
            description: `شارژ کیف پول میانجی (${uid})`,
          }),
        });
        const zpJson: any = await zpRes.json().catch(() => ({}));
        if (!zpRes.ok || !zpJson?.data?.authority) {
          return res.status(502).json({ success: false, error: 'اتصال به درگاه زرین‌پال برقرار نشد.' });
        }
        authority = String(zpJson.data.authority);
        paymentUrl = `https://payment.zarinpal.com/pg/StartPay/${authority}`;
      } else if (provider === 'zibal') {
        const merchant = (process.env.ZIBAL_MERCHANT || '').trim();
        const zbRes = await fetch('https://gateway.zibal.ir/v1/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merchant,
            amount: amt * 10,
            callbackUrl,
            orderId: sessionId,
            description: `شارژ کیف پول میانجی (${uid})`,
          }),
        });
        const zbJson: any = await zbRes.json().catch(() => ({}));
        if (!zbRes.ok || zbJson?.result !== 100 || !zbJson?.trackId) {
          return res.status(502).json({ success: false, error: 'اتصال به درگاه زیبال برقرار نشد.' });
        }
        authority = String(zbJson.trackId);
        paymentUrl = `https://gateway.zibal.ir/start/${authority}`;
      } else {
        authority = `SBX-${crypto.randomInt(100000, 999999)}`;
        const sig = signPaymentSession(sessionId, amt);
        paymentUrl = `/api/wallet/gateway/sandbox-checkout?session=${encodeURIComponent(sessionId)}&sig=${encodeURIComponent(sig)}`;
      }

      const sessionRecord: PaymentSessionRecord = {
        id: sessionId,
        user_id: uid,
        amount: amt,
        provider,
        authority,
        status: 'initiated',
        created_at: nowIso,
      };
      memoryPaymentSessions.set(sessionId, sessionRecord);

      const firestore = getDb();
      if (firestore) {
        await firestore
          .collection('payment_sessions')
          .doc(sessionId)
          .set({
            ...sessionRecord,
            created_at: nowIso,
          })
          .catch(() => {});
      }

      res.json({ success: true, sessionId, provider, paymentUrl, authority });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ایجاد تراکنش درگاه' });
    }
  });

  app.get('/api/wallet/gateway/sandbox-checkout', async (req, res) => {
    if (isProd) return res.status(403).send('Disabled in production');
    const sessionId = String(req.query.session || '').trim();
    const sig = String(req.query.sig || '').trim();
    let session = memoryPaymentSessions.get(sessionId);
    if (!session) {
      const firestore = getDb();
      if (firestore) {
        const snap = await firestore.collection('payment_sessions').doc(sessionId).get().catch(() => null);
        if (snap?.exists) session = snap.data() as PaymentSessionRecord;
      }
    }
    if (!session || signPaymentSession(sessionId, session.amount) !== sig) {
      return res.status(403).send('نشست پرداخت نامعتبر است.');
    }
    const approveUrl = `/api/wallet/gateway/callback?session=${encodeURIComponent(sessionId)}&sig=${encodeURIComponent(sig)}&status=OK`;
    const cancelUrl = `/api/wallet/gateway/callback?session=${encodeURIComponent(sessionId)}&sig=${encodeURIComponent(sig)}&status=NOK`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>درگاه آزمایشی میانجی</title><style>body{font-family:tahoma,sans-serif;background:#05070b;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}.card{max-width:400px;width:100%;background:#141923;border:1px solid rgba(255,255,255,.2);border-radius:24px;padding:28px;text-align:center}.amt{font-size:28px;font-weight:900;color:#10b981;margin:16px 0}.btn{display:block;width:100%;padding:14px;border-radius:14px;text-decoration:none;font-weight:700;margin-top:10px;box-sizing:border-box}.ok{background:#2563eb;color:#fff}.cancel{background:rgba(255,255,255,.08);color:#cbd5e1}</style></head><body><div class="card"><h2>درگاه پرداخت آزمایشی میانجی</h2><p style="font-size:12px;color:#94a3b8">شماره پیگیری: ${session.authority || session.id}</p><div class="amt">${Number(session.amount).toLocaleString()} تومان</div><a class="btn ok" href="${approveUrl}">تایید پرداخت موفق</a><a class="btn cancel" href="${cancelUrl}">انصراف از پرداخت</a></div></body></html>`);
  });

  app.get('/api/wallet/gateway/callback', async (req, res) => {
    const sessionId = String(req.query.session || '').trim();
    if (!sessionId || processingPaymentIds.has(sessionId)) {
      return res.redirect('/?view=wallet&payment_status=failed');
    }
    processingPaymentIds.add(sessionId);
    try {
      const firestore = getDb();
      let session = memoryPaymentSessions.get(sessionId);
      if (!session && firestore) {
        const snap = await firestore.collection('payment_sessions').doc(sessionId).get().catch(() => null);
        if (snap?.exists) {
          session = snap.data() as PaymentSessionRecord;
          memoryPaymentSessions.set(sessionId, session);
        }
      }
      if (!session) {
        return res.redirect('/?view=wallet&payment_status=failed');
      }
      if (session.status === 'verified') {
        return res.redirect(`/?view=wallet&payment_status=success&amount=${session.amount}&ref=${encodeURIComponent(session.ref_id || session.authority || sessionId)}`);
      }
      if (session.status === 'failed') {
        return res.redirect('/?view=wallet&payment_status=failed');
      }

      let verified = false;
      let refId = session.authority || sessionId;

      if (session.provider === 'zarinpal') {
        const statusParam = String(req.query.Status || '');
        const authParam = String(req.query.Authority || session.authority || '');
        if (statusParam === 'OK' && authParam === session.authority) {
          const zpVerify = await fetch('https://payment.zarinpal.com/pg/v4/payment/verify.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              merchant_id: (process.env.ZARINPAL_MERCHANT_ID || '').trim(),
              amount: session.amount * 10,
              authority: authParam,
            }),
          });
          const zpJson: any = await zpVerify.json().catch(() => ({}));
          if ([100, 101].includes(Number(zpJson?.data?.code))) {
            verified = true;
            refId = String(zpJson.data.ref_id || authParam);
          }
        }
      } else if (session.provider === 'zibal') {
        const successParam = String(req.query.success || '');
        const trackId = String(req.query.trackId || session.authority || '');
        if (successParam === '1' && trackId === session.authority) {
          const zbVerify = await fetch('https://gateway.zibal.ir/v1/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              merchant: (process.env.ZIBAL_MERCHANT || '').trim(),
              trackId,
            }),
          });
          const zbJson: any = await zbVerify.json().catch(() => ({}));
          if (Number(zbJson?.result) === 100 && Number(zbJson?.amount) === session.amount * 10) {
            verified = true;
            refId = String(zbJson.refNumber || trackId);
          }
        }
      } else if (!isProd && session.provider === 'sandbox') {
        const statusParam = String(req.query.status || '');
        const sigParam = String(req.query.sig || '');
        if (statusParam === 'OK' && sigParam === signPaymentSession(sessionId, session.amount)) {
          verified = true;
          refId = `SBX-${crypto.randomInt(1000000, 9999999)}`;
        }
      }

      const nowIso = new Date().toISOString();
      if (!verified) {
        const failedSession: PaymentSessionRecord = { ...session, status: 'failed', verified_at: nowIso };
        memoryPaymentSessions.set(sessionId, failedSession);
        if (firestore) {
          await firestore.collection('payment_sessions').doc(sessionId).set(failedSession, { merge: true }).catch(() => {});
        }
        return res.redirect('/?view=wallet&payment_status=failed');
      }

      const targetUid = String(session.user_id);
      const amt = Number(session.amount);
      let nextBalances = { wallet_balance: amt, escrow_locked_balance: 0 };

      if (firestore) {
        let txDone = false;
        try {
          await firestore.runTransaction(async (tx) => {
            const payRef = firestore.collection('payment_sessions').doc(sessionId);
            const userRef = firestore.collection('users').doc(targetUid);
            const [paySnap, userSnap] = await Promise.all([tx.get(payRef), tx.get(userRef)]);
            const liveStatus = paySnap.exists ? paySnap.data()?.status : session!.status;
            if (liveStatus === 'verified') {
              throw new Error('ALREADY_VERIFIED');
            }
            const uData = userSnap.exists ? userSnap.data() || {} : (await getUserById(targetUid)) || {};
            const curWallet = Number(uData.wallet_balance || 0);
            const curLocked = Number(uData.escrow_locked_balance || 0);
            const nextWallet = curWallet + amt;
            nextBalances = { wallet_balance: nextWallet, escrow_locked_balance: curLocked };

            tx.set(
              userRef,
              { wallet_balance: nextWallet, escrow_locked_balance: curLocked, updatedAt: FieldValue.serverTimestamp() },
              { merge: true }
            );
            tx.set(
              payRef,
              { status: 'verified', ref_id: refId, verified_at: nowIso },
              { merge: true }
            );
          });
          const memUser = memoryUsers.get(targetUid) || { id: targetUid };
          memoryUsers.set(targetUid, { ...memUser, ...nextBalances });
          txDone = true;
        } catch (err: any) {
          if (err?.message === 'ALREADY_VERIFIED') {
            return res.redirect(`/?view=wallet&payment_status=success&amount=${amt}&ref=${encodeURIComponent(refId)}`);
          }
        }
        if (!txDone) {
          const curUser = (await getUserById(targetUid)) || { wallet_balance: 0, escrow_locked_balance: 0 };
          const nextWallet = Number(curUser.wallet_balance || 0) + amt;
          nextBalances = { wallet_balance: nextWallet, escrow_locked_balance: Number(curUser.escrow_locked_balance || 0) };
          await saveUserBalances(targetUid, nextBalances.wallet_balance, nextBalances.escrow_locked_balance);
        }
      } else {
        const curUser = (await getUserById(targetUid)) || { wallet_balance: 0, escrow_locked_balance: 0 };
        const nextWallet = Number(curUser.wallet_balance || 0) + amt;
        nextBalances = { wallet_balance: nextWallet, escrow_locked_balance: Number(curUser.escrow_locked_balance || 0) };
        await saveUserBalances(targetUid, nextBalances.wallet_balance, nextBalances.escrow_locked_balance);
      }

      const verifiedSession: PaymentSessionRecord = { ...session, status: 'verified', ref_id: refId, verified_at: nowIso };
      memoryPaymentSessions.set(sessionId, verifiedSession);

      await recordTransaction(firestore, {
        user_id: targetUid,
        contract_id: sessionId,
        amount: amt,
        type: 'deposit',
        status: 'completed',
        description: `شارژ آنلاین کیف پول (${session.provider.toUpperCase()} - ${refId})`,
      });

      await pushUserNotification(
        targetUid,
        'شارژ آنلاین کیف پول موفق',
        `مبلغ ${amt.toLocaleString()} تومان از طریق درگاه آنلاین به کیف پول شما اضافه شد. کد پیگیری: ${refId}`,
        `💳 <b>شارژ آنلاین موفق</b>\n\nمبلغ: <b>${amt.toLocaleString()} تومان</b>\nکد پیگیری: <code>${refId}</code>`,
        { kind: 'wallet', url: '/?view=wallet', tag: `mianji-gateway-${sessionId}` }
      );

      wsBroadcastUser(targetUid, 'wallet:updated', { userId: targetUid, balances: nextBalances });
      return res.redirect(`/?view=wallet&payment_status=success&amount=${amt}&ref=${encodeURIComponent(refId)}`);
    } finally {
      processingPaymentIds.delete(sessionId);
    }
  });

  app.post('/api/wallet/requests', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const { type, amount, ref_code, slip_image_url } = req.body || {};
      const reqType = type === 'withdraw' ? 'withdraw' : 'deposit';
      const amt = Math.floor(Number(amount || 0));
      if (!Number.isFinite(amt) || amt < 10000) {
        return res.status(400).json({ success: false, error: 'حداقل مبلغ تراکنش ۱۰,۰۰۰ تومان است.' });
      }

      const limits = await loadGlobalLimits();
      let cleanRefCode = String(ref_code || '').trim();
      const cleanSlipUrl =
        typeof slip_image_url === 'string' && slip_image_url.trim().length > 0 && slip_image_url.trim().length <= 2048
          ? slip_image_url.trim()
          : undefined;
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
        const destCheck = validateIranianPayoutDestination(cleanRefCode);
        if (!destCheck.valid) {
          return res.status(400).json({ success: false, error: destCheck.error });
        }
        cleanRefCode = destCheck.normalized || cleanRefCode;
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
        ref_code: cleanRefCode || `REQ-${crypto.randomInt(100000, 999999)}`,
        ...(cleanSlipUrl ? { slip_image_url: cleanSlipUrl } : {}),
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
    const reqId = String(req.params.reqId || '').trim();
    if (processingWalletReqIds.has(reqId)) {
      return res.status(409).json({ success: false, error: 'این درخواست در حال پردازش است.' });
    }
    processingWalletReqIds.add(reqId);
    try {
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
      const decidedAt = new Date().toISOString();
      const updatedSlip = {
        ...slip,
        status: decision,
        decided_by: String(authResult.actor.id),
        decided_at: decidedAt,
      };

      let txCommitted = false;
      if (firestore) {
        try {
          await firestore.runTransaction(async (tx) => {
            const slipRef = firestore.collection('wallet_requests').doc(reqId);
            const userRef = firestore.collection('users').doc(targetUid);
            const [slipSnap, userSnap] = await Promise.all([tx.get(slipRef), tx.get(userRef)]);
            const liveSlip = slipSnap.exists ? slipSnap.data() : slip;
            if (liveSlip?.status && liveSlip.status !== 'pending') {
              throw new Error('ALREADY_DECIDED');
            }
            const uData = userSnap.exists ? userSnap.data() || {} : targetUser;
            const liveWallet = Number(uData.wallet_balance ?? curWallet);
            const liveLocked = Number(uData.escrow_locked_balance ?? curLocked);

            if (decision === 'approved') {
              if (slip.type === 'deposit') {
                nextWallet = liveWallet + amt;
              } else {
                const available = Math.max(0, liveWallet - liveLocked);
                if (amt > available) {
                  throw new Error('INSUFFICIENT_AVAILABLE');
                }
                nextWallet = Math.max(liveLocked, liveWallet - amt);
              }
              tx.set(
                userRef,
                { wallet_balance: nextWallet, escrow_locked_balance: liveLocked, updatedAt: FieldValue.serverTimestamp() },
                { merge: true }
              );
            } else {
              nextWallet = liveWallet;
            }
            tx.set(slipRef, updatedSlip, { merge: true });
          });
          const memU = memoryUsers.get(targetUid) || targetUser;
          memoryUsers.set(targetUid, { ...memU, id: targetUid, wallet_balance: nextWallet, escrow_locked_balance: curLocked });
          txCommitted = true;
        } catch (txErr: any) {
          if (txErr?.message === 'ALREADY_DECIDED') {
            return res.status(400).json({ success: false, error: 'این درخواست پیش‌تر بررسی شده است.' });
          }
          if (txErr?.message === 'INSUFFICIENT_AVAILABLE') {
            return res.status(400).json({ success: false, error: 'موجودی قابل برداشت کاربر دیگر کافی نیست.' });
          }
        }
      }

      if (!txCommitted) {
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
        }
      }

      if (decision === 'approved') {
        await recordTransaction(firestore, {
          user_id: targetUid,
          contract_id: reqId,
          amount: amt,
          type: slip.type === 'deposit' ? 'deposit' : 'withdraw',
          status: 'completed',
          description: slip.type === 'deposit' ? `تایید واریز فیش ${slip.ref_code}` : `تسویه برداشت ${slip.ref_code}`,
        });
      }

      memoryWalletRequests.set(reqId, updatedSlip);

      const msgTitle = decision === 'approved' ? 'تراکنش مالی تایید شد' : 'درخواست مالی رد شد';
      const msgBody =
        decision === 'approved'
          ? `درخواست ${slip.type === 'deposit' ? 'افزایش موجودی' : 'برداشت'} به مبلغ ${amt.toLocaleString()} تومان تایید و در کیف پول اعمال شد.`
          : `درخواست ${slip.type === 'deposit' ? 'افزایش موجودی' : 'برداشت'} به مبلغ ${amt.toLocaleString()} تومان توسط بخش مالی رد شد.`;

      await pushUserNotification(
        targetUid,
        msgTitle,
        msgBody,
        `💳 <b>${msgTitle}</b>\n\n${msgBody}`,
        {
          kind: 'wallet',
          url: '/?view=wallet',
          tag: `mianji-wallet-${reqId}`,
        }
      );

      const balances = { wallet_balance: nextWallet, escrow_locked_balance: curLocked };
      wsBroadcastUser(targetUid, 'wallet:updated', { userId: targetUid, request: updatedSlip, balances });
      void wsBroadcastAdmins('wallet:updated', { userId: targetUid, request: updatedSlip, balances });

      res.json({ success: true, request: updatedSlip, balances });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در بررسی درخواست مالی' });
    } finally {
      processingWalletReqIds.delete(reqId);
    }
  });

  // --- Manual National ID + Selfie + Bank Card + Firebase Identity Inquiry (KYC) ---
  const verifyNationalIdPhoneMatch = async (params: {
    nationalId: string;
    phoneNumber: string;
    actorId: string;
  }): Promise<{
    status: 'matched' | 'mismatch' | 'pending_manual';
    matched: boolean;
    note: string;
    checked_at: string;
  }> => {
    const checked_at = new Date().toISOString();
    const nidCheck = isValidIranianNationalId(params.nationalId);
    if (!nidCheck.valid) {
      return {
        status: 'mismatch',
        matched: false,
        note: nidCheck.error || 'کد ملی نامعتبر است.',
        checked_at,
      };
    }

    const cleanPhone = extractCleanPhone(params.phoneNumber);
    const normalizedPhone = cleanPhone.startsWith('98') && cleanPhone.length === 12
      ? `0${cleanPhone.slice(2)}`
      : cleanPhone;

    if (!/^09\d{9}$/.test(normalizedPhone)) {
      return {
        status: 'mismatch',
        matched: false,
        note: 'شماره موبایل ثبت‌شده معتبر نیست (باید با 09 شروع شود و ۱۱ رقم باشد).',
        checked_at,
      };
    }

    // Inquiry exclusively against Firebase Firestore users collection
    const usersCol = getUsersCol();
    let duplicateUser: any = null;
    if (usersCol) {
      try {
        const dupSnap = await usersCol.where('national_id', '==', nidCheck.normalized).get();
        const foundDoc = dupSnap.docs.find((d) => {
          const data = d.data() || {};
          return String(d.id) !== String(params.actorId) && data.kyc_status === 'verified';
        });
        if (foundDoc) {
          duplicateUser = { id: foundDoc.id, ...foundDoc.data() };
        }
      } catch {
        const allUsers = await getAllUsersMerged();
        duplicateUser = allUsers.find(
          (u) =>
            String(u.id) !== String(params.actorId) &&
            String(u.national_id || '') === nidCheck.normalized &&
            u.kyc_status === 'verified'
        );
      }
    } else {
      const allUsers = await getAllUsersMerged();
      duplicateUser = allUsers.find(
        (u) =>
          String(u.id) !== String(params.actorId) &&
          String(u.national_id || '') === nidCheck.normalized &&
          u.kyc_status === 'verified'
      );
    }

    if (duplicateUser) {
      return {
        status: 'mismatch',
        matched: false,
        note: 'این کد ملی پیش‌تر به نام حساب دیگری در پایگاه داده فایربیس تایید شده است.',
        checked_at,
      };
    }

    return {
      status: 'matched',
      matched: true,
      note: `استعلام در پایگاه داده فایربیس تایید شد: کد ملی (${nidCheck.normalized}) یکتا بوده و با شماره موبایل ${normalizedPhone} انطباق دارد.`,
      checked_at,
    };
  };

  app.post('/api/kyc/check-match', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const nationalId = String(req.body?.national_id || actor.national_id || '').trim();
      const phone = String(actor.phone_number || req.body?.phone_number || '').trim();
      const result = await verifyNationalIdPhoneMatch({
        nationalId,
        phoneNumber: phone,
        actorId: uid,
      });

      const updatedUser = {
        ...actor,
        id: uid,
        kyc_match_status: result.status,
        kyc_match_note: result.note,
        kyc_match_checked_at: result.checked_at,
      };
      memoryUsers.set(uid, updatedUser);

      const usersCol = getUsersCol();
      if (usersCol) {
        await usersCol
          .doc(uid)
          .set(
            {
              kyc_match_status: result.status,
              kyc_match_note: result.note,
              kyc_match_checked_at: result.checked_at,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {});
      }

      res.json({ success: true, ...result, user: updatedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در استعلام انطباق کد ملی و موبایل' });
    }
  });

  app.post('/api/kyc/submit', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const { national_id, full_name, card_number, id_card_image_url, selfie_image_url } = req.body || {};

      const nidCheck = isValidIranianNationalId(String(national_id || ''));
      if (!nidCheck.valid) {
        return res.status(400).json({ success: false, error: nidCheck.error || 'کد ملی معتبر نیست.' });
      }

      const rawCard = String(card_number || actor.kyc_bank_card || '').trim();
      const cardCheck = isValidIranianCard(rawCard);
      if (!cardCheck.valid) {
        return res.status(400).json({ success: false, error: 'لطفاً شماره کارت بانکی ۱۶ رقمی معتبر به نام خودتان وارد کنید.' });
      }
      const bankName = detectIranianBankName(cardCheck.normalized) || 'بانک عضو شبکه شتاب';

      const cleanName = typeof full_name === 'string' && full_name.trim().length >= 2
        ? full_name.trim().slice(0, 100)
        : String(actor.full_name || 'کاربر میانجی').slice(0, 100);
      const cleanCardUrl =
        typeof id_card_image_url === 'string' && id_card_image_url.trim().length > 0 && id_card_image_url.trim().length <= 2048
          ? id_card_image_url.trim()
          : actor.kyc_id_card_url || undefined;
      const cleanSelfieUrl =
        typeof selfie_image_url === 'string' && selfie_image_url.trim().length > 0 && selfie_image_url.trim().length <= 2048
          ? selfie_image_url.trim()
          : actor.kyc_selfie_url || undefined;

      if (!cleanCardUrl) {
        return res.status(400).json({ success: false, error: 'بارگذاری تصویر کارت ملی الزامی است.' });
      }
      if (!cleanSelfieUrl) {
        return res.status(400).json({ success: false, error: 'بارگذاری تصویر سلفی همراه با کارت ملی الزامی است.' });
      }

      const matchResult = await verifyNationalIdPhoneMatch({
        nationalId: nidCheck.normalized,
        phoneNumber: String(actor.phone_number || ''),
        actorId: uid,
      });
      if (matchResult.status === 'mismatch') {
        return res.status(400).json({ success: false, error: matchResult.note });
      }

      const nowIso = new Date().toISOString();
      const updatedUser = {
        ...actor,
        id: uid,
        full_name: cleanName,
        national_id: nidCheck.normalized,
        kyc_bank_card: cardCheck.normalized,
        kyc_bank_name: bankName,
        kyc_id_card_url: cleanCardUrl,
        kyc_selfie_url: cleanSelfieUrl,
        kyc_match_status: matchResult.status,
        kyc_match_note: matchResult.note,
        kyc_match_checked_at: matchResult.checked_at,
        kyc_status: 'pending',
        kyc_submitted_at: nowIso,
        kyc_reject_reason: '',
      };
      memoryUsers.set(uid, updatedUser);

      const usersCol = getUsersCol();
      if (usersCol) {
        try {
          await usersCol.doc(uid).set(
            {
              full_name: cleanName,
              national_id: nidCheck.normalized,
              kyc_bank_card: cardCheck.normalized,
              kyc_bank_name: bankName,
              kyc_id_card_url: cleanCardUrl,
              kyc_selfie_url: cleanSelfieUrl,
              kyc_match_status: matchResult.status,
              kyc_match_note: matchResult.note,
              kyc_match_checked_at: matchResult.checked_at,
              kyc_status: 'pending',
              kyc_submitted_at: nowIso,
              kyc_reject_reason: '',
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch {}
      }

      void wsBroadcastAdmins('kyc:updated', { user: updatedUser });
      wsBroadcastUser(uid, 'user:updated', { userId: uid, user: updatedUser });
      res.json({ success: true, user: updatedUser, match: matchResult });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت اطلاعات احراز هویت' });
    }
  });

  app.get('/api/admin/finance/summary', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const [limits, platformStats] = await Promise.all([loadGlobalLimits(), loadPlatformStats()]);
      const feeTxs: any[] = [];
      for (const userTxList of memoryTransactions.values()) {
        for (const t of userTxList) {
          if (t?.type === 'platform_fee') {
            feeTxs.push({
              ...t,
              created_at: t.created_at || t.createdAt,
            });
          }
        }
      }
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('transactions').where('type', '==', 'platform_fee').limit(50).get();
          snap.docs.forEach((docSnap) => {
            const d = docSnap.data();
            if (!feeTxs.some((x) => x.id === docSnap.id)) {
              const iso = d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.created_at || d.createdAt;
              feeTxs.push({ id: docSnap.id, ...d, created_at: iso });
            }
          });
        } catch {}
      }
      feeTxs.sort((a, b) => Date.parse(String(b.created_at || b.createdAt || 0)) - Date.parse(String(a.created_at || a.createdAt || 0)));
      res.json({
        success: true,
        platform_fee_percent: limits.platform_fee_percent ?? 0,
        total_fees_collected: platformStats.total_fees_collected || 0,
        recent_fee_transactions: feeTxs.slice(0, 20),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت گزارش درآمد پلتفرم' });
    }
  });

  app.post('/api/admin/users/:targetId/kyc-decide', async (req, res) => {
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
      const decision = req.body?.decision === 'rejected' ? 'rejected' : 'verified';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
      const nowIso = new Date().toISOString();

      const updatedUser = {
        ...targetUser,
        id: targetId,
        kyc_status: decision,
        kyc_reviewed_at: nowIso,
        kyc_reviewed_by: String(authResult.actor.id),
        kyc_reject_reason: decision === 'rejected' ? reason || 'اطلاعات هویتی یا تصویر ارسالی نیاز به اصلاح دارد.' : '',
      };
      memoryUsers.set(targetId, updatedUser);

      const usersCol = getUsersCol();
      if (usersCol) {
        try {
          await usersCol.doc(targetId).set(
            {
              kyc_status: updatedUser.kyc_status,
              kyc_reviewed_at: nowIso,
              kyc_reviewed_by: updatedUser.kyc_reviewed_by,
              kyc_reject_reason: updatedUser.kyc_reject_reason,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch {}
      }

      const noteTitle = decision === 'verified' ? 'احراز هویت (کد ملی) تایید شد' : 'درخواست احراز هویت رد شد';
      const noteBody =
        decision === 'verified'
          ? 'کد ملی و مشخصات هویتی شما توسط مدیریت میانجی تایید شد.'
          : `درخواست احراز هویت شما رد شد: ${updatedUser.kyc_reject_reason}`;

      await pushUserNotification(
        targetId,
        noteTitle,
        noteBody,
        `🪪 <b>${noteTitle}</b>\n\n${noteBody}`,
        {
          kind: 'system',
          url: '/?view=profile',
          tag: `mianji-kyc-${targetId}`,
        }
      );

      wsBroadcastUser(targetId, 'user:updated', { userId: targetId, user: updatedUser });
      void wsBroadcastAdmins('kyc:updated', { user: updatedUser });
      res.json({ success: true, user: updatedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در بررسی احراز هویت' });
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
        `🛟 <b>پاسخ پشتیبانی میانجی (${ticketId})</b>\n\nموضوع: ${ticket.subject}\nپاسخ: ${replyText}`,
        {
          kind: 'support',
          url: '/?view=support',
          tag: `mianji-ticket-${ticketId}`,
        }
      );
      wsBroadcastUser(String(ticket.user_id), 'ticket:updated', { userId: String(ticket.user_id), ticket: updated });
      void wsBroadcastAdmins('ticket:updated', { userId: String(ticket.user_id), ticket: updated });

      res.json({ success: true, ticket: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت پاسخ تیکت' });
    }
  });

  // --- Dispute Evidence & Atomic Arbitration Verdict ---
  const memoryDisputes = new Map<string, { evidence: any[]; resolution?: any; appeal?: any }>();

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

      let record: any = memoryDisputes.get(cid) || { evidence: [] };
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('dispute_records').doc(cid).get();
          if (snap.exists) {
            const d = snap.data() || {};
            record = {
              evidence: Array.isArray(d.evidence) ? d.evidence : record.evidence,
              resolution: d.resolution || record.resolution,
              appeal: d.appeal || record.appeal,
            };
            memoryDisputes.set(cid, record);
          }
        } catch {}
      }

      res.json({
        success: true,
        contract: deal,
        evidence: record.evidence,
        resolution: record.resolution || null,
        appeal: record.appeal || deal.appeal || null,
      });
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
      const otherDisputeParty = uid === String(deal.buyer_id) ? String(deal.seller_id) : String(deal.buyer_id);
      if (otherDisputeParty && otherDisputeParty !== uid) {
        void pushUserNotification(
          otherDisputeParty,
          `مدرک جدید در داوری ${cid}`,
          `${item.sender_name}: ${text || 'فایل مدرک جدید ثبت شد.'}`,
          `⚖️ <b>مدرک جدید در پرونده داوری ${cid}</b>\n\n${item.sender_name}: ${text || 'فایل پیوست'}`,
          {
            kind: 'deal',
            contract_id: cid,
            url: `/?view=dispute&contract_id=${cid}`,
            tag: `mianji-dispute-ev-${item.id}`,
          }
        );
      }
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
    const cid = String(req.params.contractId || '').trim();
    if (processingDealIds.has(cid)) {
      return res.status(409).json({ success: false, error: 'پرونده همزمان در حال پردازش است.' });
    }
    processingDealIds.add(cid);
    try {
      const verdict = ['refund', 'release', 'split'].includes(req.body?.verdict) ? req.body.verdict : 'release';
      const customNote = String(req.body?.note || '').trim().slice(0, 600);
      const rawSellerPercent = req.body?.seller_percent;
      const sellerPercent =
        verdict === 'refund'
          ? 0
          : verdict === 'release'
          ? 100
          : Math.max(0, Math.min(100, Math.round(Number(rawSellerPercent ?? 50))));

      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });
      if (['completed', 'cancelled'].includes(String(deal.status))) {
        return res.status(400).json({ success: false, error: 'این پرونده پیش‌تر مختومه شده است.' });
      }

      const amount = Number(deal.amount || 0);
      const remainingEscrow =
        deal.is_milestone && Array.isArray(deal.milestones) && deal.milestones.length > 0
          ? deal.milestones
              .filter((m: any) => m.status !== 'completed')
              .reduce((sum: number, m: any) => sum + Number(m.amount || 0), 0)
          : amount;

      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      const buyer = (await getUserById(buyerId)) || { wallet_balance: 0, escrow_locked_balance: 0 };
      const hasLockedFunds = Number(buyer.escrow_locked_balance || 0) >= remainingEscrow && remainingEscrow > 0;

      const sellerGross = hasLockedFunds ? Math.round((remainingEscrow * sellerPercent) / 100) : 0;
      const buyerRefund = hasLockedFunds ? Math.max(0, remainingEscrow - sellerGross) : 0;
      const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent || 0)));

      const nextStatus = sellerPercent === 0 ? 'cancelled' : 'completed';
      const nowIso = new Date().toISOString();
      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const verdictSummaryText =
        sellerPercent === 0
          ? 'استرداد کامل وجه به کارفرما'
          : sellerPercent === 100
          ? 'آزادسازی کامل وجه برای مجری'
          : `تقسیم سفارشی وجه (${sellerPercent}٪ مجری / ${100 - sellerPercent}٪ کارفرما)`;

      const verdictTimelineEntry = {
        id: `tl_verdict_${Date.now()}`,
        type: 'verdict',
        status: nextStatus,
        actor_id: String(authResult.actor.id),
        actor_name: authResult.actor.full_name || 'داور میانجی',
        note: customNote ? `رأی داوری: ${verdictSummaryText} — ${customNote}` : `رأی داوری: ${verdictSummaryText}`,
        timestamp: nowIso,
      };
      const nextTimeline = [...prevTimeline, verdictTimelineEntry];
      const resolvedMilestones =
        Array.isArray(deal.milestones) && deal.milestones.length > 0
          ? deal.milestones.map((m: any) =>
              m.status === 'completed' ? m : { ...m, status: sellerPercent === 0 ? 'cancelled' : 'completed', auto_release_at: null }
            )
          : [];

      let balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};
      let feeAmount = 0;
      let sellerNet = 0;

      if (hasLockedFunds) {
        const payout = await executeEscrowPayout({
          cid,
          deal,
          grossUnlockAmount: remainingEscrow,
          sellerGrossAmount: sellerGross,
          feePercent,
          buyerId,
          sellerId,
          nextDealFields: {
            status: nextStatus,
            auto_release_at: null,
            ...(resolvedMilestones.length > 0 ? { milestones: resolvedMilestones } : {}),
            timeline: nextTimeline,
          },
          releaseDescription: `رأی داوری (${verdictSummaryText}) در ${deal.title}`,
          incrementCompletedCount: nextStatus === 'completed',
        });
        balancesPayload = payout.balancesPayload;
        feeAmount = payout.feeAmount;
        sellerNet = payout.sellerNet;
      } else {
        const firestore = getDb();
        if (firestore) {
          await firestore
            .collection('deals')
            .doc(cid)
            .set(
              {
                status: nextStatus,
                auto_release_at: null,
                ...(resolvedMilestones.length > 0 ? { milestones: resolvedMilestones } : {}),
                timeline: nextTimeline,
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            )
            .catch(() => {});
        }
      }

      const updatedDeal = await enrichDealWithParties({
        ...deal,
        status: nextStatus,
        auto_release_at: null,
        ...(resolvedMilestones.length > 0 ? { milestones: resolvedMilestones } : {}),
        timeline: nextTimeline,
        updatedAt: nowIso,
        updated_at: nowIso,
      });
      memoryDeals.set(cid, updatedDeal);

      const disputeCur = memoryDisputes.get(cid) || { evidence: [] };
      const resolution = {
        verdict,
        seller_percent: sellerPercent,
        buyer_percent: 100 - sellerPercent,
        seller_amount: sellerGross,
        seller_net_amount: sellerNet,
        buyer_refund_amount: buyerRefund,
        fee_amount: feeAmount,
        note: customNote,
        decided_by: String(authResult.actor.id),
        arbitrator_name: authResult.actor.full_name || 'داور میانجی',
        decided_at: nowIso,
      };
      memoryDisputes.set(cid, { ...disputeCur, resolution });

      const firestore = getDb();
      if (firestore) {
        await firestore.collection('dispute_records').doc(cid).set({ resolution, updated_at: nowIso }, { merge: true }).catch(() => {});
      }

      const msgBody = customNote ? `⚖️ رأی نهایی داوری: ${verdictSummaryText}\n📝 توضیح داور: ${customNote}` : `⚖️ رأی نهایی داوری: ${verdictSummaryText}`;
      await appendContractMilestoneMessage(cid, authResult.actor, msgBody, undefined, [buyerId, sellerId]);
      await pushUserNotification(
        buyerId,
        `صدور رأی داوری ${cid}`,
        verdictSummaryText,
        `⚖️ <b>رأی نهایی داوری (${cid})</b>\n\n${verdictSummaryText}`,
        {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=dispute&contract_id=${cid}`,
          tag: `mianji-deal-${cid}-${nextStatus}`,
        }
      );
      await pushUserNotification(
        sellerId,
        `صدور رأی داوری ${cid}`,
        verdictSummaryText,
        `⚖️ <b>رأی نهایی داوری (${cid})</b>\n\n${verdictSummaryText}`,
        {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=dispute&contract_id=${cid}`,
          tag: `mianji-deal-${cid}-${nextStatus}`,
        }
      );

      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      wsBroadcastUser(buyerId, 'dispute:updated', { contractId: cid, verdict, resolution, contract: updatedDeal });
      wsBroadcastUser(sellerId, 'dispute:updated', { contractId: cid, verdict, resolution, contract: updatedDeal });

      res.json({ success: true, deal: updatedDeal, resolution, balances: balancesPayload });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت رأی داور' });
    } finally {
      processingDealIds.delete(cid);
    }
  });

  app.post('/api/disputes/:contractId/appeal', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const cid = String(req.params.contractId || '').trim();
      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });

      const uid = String(authResult.actor.id);
      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      if (uid !== buyerId && uid !== sellerId) {
        return res.status(403).json({ success: false, error: 'فقط طرفین معامله می‌توانند درخواست تجدیدنظر ثبت کنند.' });
      }

      let record: any = memoryDisputes.get(cid) || { evidence: [] };
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('dispute_records').doc(cid).get();
          if (snap.exists) {
            const d = snap.data() || {};
            record = {
              evidence: Array.isArray(d.evidence) ? d.evidence : record.evidence,
              resolution: d.resolution || record.resolution,
              appeal: d.appeal || record.appeal,
            };
          }
        } catch {}
      }

      if (!record.resolution) {
        return res.status(400).json({ success: false, error: 'درخواست تجدیدنظر تنها پس از صدور رأی داور امکان‌پذیر است.' });
      }
      if (record.appeal) {
        return res.status(400).json({ success: false, error: 'برای این پرونده پیش‌تر درخواست تجدیدنظر ثبت شده است.' });
      }

      const reason = String(req.body?.reason || '').trim().slice(0, 1500);
      if (reason.length < 10) {
        return res.status(400).json({ success: false, error: 'لطفاً دلیل درخواست تجدیدنظر را حداقل در ۱۰ کاراکتر بنویسید.' });
      }
      const attachment_url =
        typeof req.body?.attachment_url === 'string' && req.body.attachment_url.trim().length > 0 && req.body.attachment_url.trim().length <= 2048
          ? req.body.attachment_url.trim()
          : undefined;

      const nowIso = new Date().toISOString();
      const appeal = {
        id: `apl_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        requester_id: uid,
        requester_name: authResult.actor.full_name || 'کاربر میانجی',
        requester_role: uid === buyerId ? 'buyer' : 'seller',
        reason,
        ...(attachment_url ? { attachment_url } : {}),
        status: 'pending',
        created_at: nowIso,
      };

      const nextRecord = { ...record, appeal };
      memoryDisputes.set(cid, nextRecord);

      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const tlEntry = {
        id: `tl_appeal_${Date.now()}`,
        type: 'appeal_submitted',
        status: deal.status,
        actor_id: uid,
        actor_name: appeal.requester_name,
        note: `درخواست تجدیدنظر ثبت شد: ${reason.slice(0, 180)}`,
        timestamp: nowIso,
      };
      const nextTimeline = [...prevTimeline, tlEntry];

      if (firestore) {
        await firestore.collection('dispute_records').doc(cid).set({ appeal, updated_at: nowIso }, { merge: true }).catch(() => {});
        await firestore.collection('deals').doc(cid).set({ appeal, timeline: nextTimeline, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
      }

      const updatedDeal = await enrichDealWithParties({
        ...deal,
        appeal,
        timeline: nextTimeline,
        updatedAt: nowIso,
        updated_at: nowIso,
      });
      memoryDeals.set(cid, updatedDeal);

      await appendContractMilestoneMessage(
        cid,
        authResult.actor,
        `⚖️ درخواست تجدیدنظر توسط ${appeal.requester_name} ثبت شد:\n📝 ${reason}`,
        attachment_url,
        [buyerId, sellerId]
      );

      const otherPartyId = uid === buyerId ? sellerId : buyerId;
      await pushUserNotification(
        otherPartyId,
        `ثبت درخواست تجدیدنظر در پرونده ${cid}`,
        `${appeal.requester_name} درخواست تجدیدنظر روی رأی داور ثبت کرد.`,
        `⚖️ <b>درخواست تجدیدنظر (${cid})</b>\n\n${appeal.requester_name}: ${reason}`,
        {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=dispute&contract_id=${cid}`,
          tag: `mianji-appeal-${cid}`,
        }
      );

      wsBroadcastUser(buyerId, 'dispute:updated', { contractId: cid, appeal, contract: updatedDeal });
      wsBroadcastUser(sellerId, 'dispute:updated', { contractId: cid, appeal, contract: updatedDeal });
      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });
      void wsBroadcastAdmins('dispute:updated', { contractId: cid, appeal, contract: updatedDeal });

      res.json({ success: true, appeal, contract: updatedDeal });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت درخواست تجدیدنظر' });
    }
  });

  app.post('/api/disputes/:contractId/appeal-decision', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const cid = String(req.params.contractId || '').trim();
      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });

      let record: any = memoryDisputes.get(cid) || { evidence: [] };
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('dispute_records').doc(cid).get();
          if (snap.exists) {
            const d = snap.data() || {};
            record = {
              evidence: Array.isArray(d.evidence) ? d.evidence : record.evidence,
              resolution: d.resolution || record.resolution,
              appeal: d.appeal || record.appeal,
            };
          }
        } catch {}
      }

      if (!record.appeal || record.appeal.status !== 'pending') {
        return res.status(400).json({ success: false, error: 'درخواست تجدیدنظر باز برای این پرونده وجود ندارد.' });
      }

      const decision = req.body?.decision === 'accepted' ? 'accepted' : 'rejected';
      const reviewNote = String(req.body?.note || '').trim().slice(0, 800);
      if (reviewNote.length < 3) {
        return res.status(400).json({ success: false, error: 'لطفاً متن دلیل تصمیم هیئت داوری را وارد کنید.' });
      }

      const nowIso = new Date().toISOString();
      const updatedAppeal = {
        ...record.appeal,
        status: decision,
        review_note: reviewNote,
        reviewed_by: String(authResult.actor.id),
        reviewed_by_name: authResult.actor.full_name || 'هیئت داوری میانجی',
        reviewed_at: nowIso,
      };
      memoryDisputes.set(cid, { ...record, appeal: updatedAppeal });

      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const tlEntry = {
        id: `tl_appeal_dec_${Date.now()}`,
        type: 'appeal_decision',
        status: deal.status,
        actor_id: String(authResult.actor.id),
        actor_name: updatedAppeal.reviewed_by_name,
        note:
          decision === 'accepted'
            ? `تجدیدنظر پذیرفته شد: ${reviewNote}`
            : `درخواست تجدیدنظر رد شد و رأی پیشین ابقا گردید: ${reviewNote}`,
        timestamp: nowIso,
      };
      const nextTimeline = [...prevTimeline, tlEntry];

      if (firestore) {
        await firestore.collection('dispute_records').doc(cid).set({ appeal: updatedAppeal, updated_at: nowIso }, { merge: true }).catch(() => {});
        await firestore.collection('deals').doc(cid).set({ appeal: updatedAppeal, timeline: nextTimeline, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
      }

      const updatedDeal = await enrichDealWithParties({
        ...deal,
        appeal: updatedAppeal,
        timeline: nextTimeline,
        updatedAt: nowIso,
        updated_at: nowIso,
      });
      memoryDeals.set(cid, updatedDeal);

      const buyerId = String(deal.buyer_id);
      const sellerId = String(deal.seller_id);
      const msgText =
        decision === 'accepted'
          ? `⚖️ نتیجه تجدیدنظر پرونده ${cid}: پذیرفته شد\n📝 ${reviewNote}`
          : `⚖️ نتیجه تجدیدنظر پرونده ${cid}: رد شد (تایید رأی قبلی)\n📝 ${reviewNote}`;

      await appendContractMilestoneMessage(cid, authResult.actor, msgText, undefined, [buyerId, sellerId]);
      await Promise.all([
        pushUserNotification(buyerId, `نتیجه تجدیدنظر ${cid}`, msgText, undefined, {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=dispute&contract_id=${cid}`,
          tag: `mianji-appeal-dec-${cid}`,
        }),
        pushUserNotification(sellerId, `نتیجه تجدیدنظر ${cid}`, msgText, undefined, {
          kind: 'deal',
          contract_id: cid,
          url: `/?view=dispute&contract_id=${cid}`,
          tag: `mianji-appeal-dec-${cid}`,
        }),
      ]);

      wsBroadcastUser(buyerId, 'dispute:updated', { contractId: cid, appeal: updatedAppeal, contract: updatedDeal });
      wsBroadcastUser(sellerId, 'dispute:updated', { contractId: cid, appeal: updatedAppeal, contract: updatedDeal });
      wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
      wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });

      res.json({ success: true, appeal: updatedAppeal, contract: updatedDeal });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت نتیجه تجدیدنظر' });
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
          category: c.category || 'طرف معامله',
          note: c.note || '',
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
      const category = String(req.body?.category || 'طرف معامله').trim().slice(0, 40) || 'طرف معامله';
      const note = String(req.body?.note || '').trim().slice(0, 300);
      if (!name || cleanPhone.length < 8) {
        return res.status(400).json({ success: false, error: 'نام و شماره معتبر الزامی است.' });
      }
      const matched = cleanPhone.length >= 10 ? await findUserByPhone(cleanPhone, cleanPhone.slice(-10)) : null;
      const cid = `cnt_${cleanPhone.slice(-10)}_${Date.now().toString(36)}`;
      const item = {
        id: cid,
        owner_id: uid,
        full_name: name,
        phone_number: cleanPhone,
        category,
        note,
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

  app.get('/sw.js', (_req, res, next) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    const swPath = useStaticDist ? path.resolve('dist', 'sw.js') : path.resolve('public', 'sw.js');
    if (fs.existsSync(swPath)) {
      return res.sendFile(swPath);
    }
    return next();
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

  // --- Auto-Inspection Timer Scheduler (Background Sweep) ---
  let autoReleaseSweepBusy = false;
  const processExpiredAutoReleases = async () => {
    if (autoReleaseSweepBusy) return;
    autoReleaseSweepBusy = true;
    try {
      const nowMs = Date.now();
      const deals = await getAllDealsMerged();
      for (const deal of deals) {
        const cid = String(deal.contract_id || deal.id || '');
        if (!cid || processingDealIds.has(cid)) continue;

        const buyerId = String(deal.buyer_id);
        const sellerId = String(deal.seller_id);
        const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent || 0)));

        // Case 0: Active deal delivery deadline reminders & overdue alerts
        if (deal.status === 'active') {
          const deadlineDays = Math.max(1, Math.min(365, Number(deal.deadline || 7) || 7));
          const createdMs = Date.parse(String(deal.createdAt || deal.created_at || '')) || nowMs;
          const dueIso = deal.delivery_due_at || new Date(createdMs + deadlineDays * 86400000).toISOString();
          const dueMs = Date.parse(String(dueIso));
          const firestore = getDb();

          if (!Number.isNaN(dueMs)) {
            const remainingMs = dueMs - nowMs;
            // Send 24-hour approaching deadline warning once
            if (remainingMs > 0 && remainingMs <= 24 * 3600 * 1000 && !deal.deadline_warning_sent) {
              const nowIso = new Date().toISOString();
              const hoursLeft = Math.max(1, Math.ceil(remainingMs / 3600000));
              const warnText = `⏳ یادآوری سررسید تحویل: کمتر از ${hoursLeft} ساعت تا پایان مهلت تحویل قرارداد «${deal.title}» باقی مانده است.`;
              const patch = { delivery_due_at: dueIso, deadline_warning_sent: nowIso };
              if (firestore) {
                await firestore.collection('deals').doc(cid).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
              }
              const updatedDeal = await enrichDealWithParties({ ...deal, ...patch, updatedAt: nowIso, updated_at: nowIso });
              memoryDeals.set(cid, updatedDeal);
              await appendContractMilestoneMessage(cid, { id: '0', full_name: 'سیستم زمان‌بندی میانجی' }, warnText, undefined, [buyerId, sellerId]);
              await Promise.all([
                pushUserNotification(sellerId, `نزدیک شدن به سررسید ${cid}`, warnText, undefined, {
                  kind: 'deal',
                  contract_id: cid,
                  url: `/?view=detail&contract_id=${cid}`,
                  tag: `mianji-due-warn-${cid}-seller`,
                }),
                pushUserNotification(buyerId, `یادآوری زمان‌بندی ${cid}`, warnText, undefined, {
                  kind: 'deal',
                  contract_id: cid,
                  url: `/?view=detail&contract_id=${cid}`,
                  tag: `mianji-due-warn-${cid}-buyer`,
                }),
              ]);
              wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
              wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });
            } else if (remainingMs <= 0 && !deal.deadline_overdue_sent) {
              const nowIso = new Date().toISOString();
              const overText = `⚠️ مهلت تحویل قرارداد «${deal.title}» به پایان رسید. طرفین می‌توانند زمان تحویل را در چت هماهنگ یا در صورت نیاز درخواست داوری ثبت کنند.`;
              const patch = { delivery_due_at: dueIso, deadline_overdue_sent: nowIso };
              if (firestore) {
                await firestore.collection('deals').doc(cid).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
              }
              const updatedDeal = await enrichDealWithParties({ ...deal, ...patch, updatedAt: nowIso, updated_at: nowIso });
              memoryDeals.set(cid, updatedDeal);
              await appendContractMilestoneMessage(cid, { id: '0', full_name: 'سیستم زمان‌بندی میانجی' }, overText, undefined, [buyerId, sellerId]);
              await Promise.all([
                pushUserNotification(sellerId, `پایان مهلت تحویل ${cid}`, overText, undefined, {
                  kind: 'deal',
                  contract_id: cid,
                  url: `/?view=detail&contract_id=${cid}`,
                  tag: `mianji-due-over-${cid}-seller`,
                }),
                pushUserNotification(buyerId, `پایان مهلت تحویل ${cid}`, overText, undefined, {
                  kind: 'deal',
                  contract_id: cid,
                  url: `/?view=detail&contract_id=${cid}`,
                  tag: `mianji-due-over-${cid}-buyer`,
                }),
              ]);
              wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
              wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });
            }
          }
        }

        // Case 1: Single-stage work_submitted approaching auto-release warning OR expired
        if (deal.status === 'work_submitted' && !deal.is_milestone && deal.auto_release_at) {
          const expMs = Date.parse(String(deal.auto_release_at));
          if (!Number.isNaN(expMs) && expMs > nowMs && expMs - nowMs <= 6 * 3600 * 1000 && !deal.auto_release_warning_sent) {
            const nowIso = new Date().toISOString();
            const hoursLeft = Math.max(1, Math.ceil((expMs - nowMs) / 3600000));
            const warnText = `⏰ هشدار اتمام مهلت بازرسی: حدود ${hoursLeft} ساعت تا آزادسازی خودکار وجه قرارداد «${deal.title}» باقی مانده است. در صورت نیاز به اصلاح، پیش از اتمام زمان اقدام کنید.`;
            const firestore = getDb();
            if (firestore) {
              await firestore.collection('deals').doc(cid).set({ auto_release_warning_sent: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
            }
            const updatedDeal = await enrichDealWithParties({ ...deal, auto_release_warning_sent: nowIso, updatedAt: nowIso, updated_at: nowIso });
            memoryDeals.set(cid, updatedDeal);
            await appendContractMilestoneMessage(cid, { id: '0', full_name: 'سیستم بازرسی هوشمند میانجی' }, warnText, undefined, [buyerId, sellerId]);
            await pushUserNotification(buyerId, `هشدار مهلت بازرسی ${cid}`, warnText, undefined, {
              kind: 'deal',
              contract_id: cid,
              url: `/?view=detail&contract_id=${cid}`,
              tag: `mianji-inspect-warn-${cid}`,
            });
            wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
            wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });
          } else if (!Number.isNaN(expMs) && expMs <= nowMs) {
            processingDealIds.add(cid);
            try {
              const liveDeal = (await getDealByContractId(cid)) || deal;
              if (liveDeal.status === 'work_submitted' && liveDeal.auto_release_at && Date.parse(String(liveDeal.auto_release_at)) <= nowMs) {
                const nowIso = new Date().toISOString();
                const amount = Number(liveDeal.amount || 0);
                const prevTimeline = Array.isArray(liveDeal.timeline) ? liveDeal.timeline : [];
                const tlEntry = {
                  id: `tl_auto_${Date.now()}`,
                  type: 'auto_release',
                  status: 'completed',
                  actor_id: 'system',
                  actor_name: 'سیستم بازرسی هوشمند میانجی',
                  note: 'مهلت بازرسی بدون اعتراض یا درخواست اصلاح به پایان رسید و وجه به‌صورت خودکار آزاد شد.',
                  timestamp: nowIso,
                };
                const nextTimeline = [...prevTimeline, tlEntry];
                const payout = await executeEscrowPayout({
                  cid,
                  deal: liveDeal,
                  grossUnlockAmount: amount,
                  sellerGrossAmount: amount,
                  feePercent,
                  buyerId,
                  sellerId,
                  nextDealFields: {
                    status: 'completed',
                    auto_release_at: null,
                    auto_released: true,
                    timeline: nextTimeline,
                  },
                  releaseDescription: `آزادسازی خودکار پس از پایان مهلت بازرسی برای ${liveDeal.title}`,
                  incrementCompletedCount: true,
                });
                const updatedDeal = await enrichDealWithParties({
                  ...liveDeal,
                  status: 'completed',
                  auto_release_at: null,
                  auto_released: true,
                  timeline: nextTimeline,
                  updatedAt: nowIso,
                  updated_at: nowIso,
                });
                memoryDeals.set(cid, updatedDeal);

                const sysMsg = `⏱️ مهلت بازرسی قرارداد «${liveDeal.title}» به پایان رسید و وجه به‌صورت خودکار برای مجری آزاد شد.`;
                await appendContractMilestoneMessage(cid, { id: '0', full_name: 'سیستم میانجی' }, sysMsg, undefined, [buyerId, sellerId]);
                await Promise.all([
                  pushUserNotification(sellerId, `آزادسازی خودکار ${cid}`, sysMsg, undefined, {
                    kind: 'deal',
                    contract_id: cid,
                    url: `/?view=detail&contract_id=${cid}`,
                    tag: `mianji-autorelease-${cid}`,
                  }),
                  pushUserNotification(buyerId, `تکمیل خودکار ${cid}`, sysMsg, undefined, {
                    kind: 'deal',
                    contract_id: cid,
                    url: `/?view=detail&contract_id=${cid}`,
                    tag: `mianji-autorelease-${cid}-buyer`,
                  }),
                ]);
                wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
                wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
                wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
              }
            } finally {
              processingDealIds.delete(cid);
            }
          }
        }

        // Case 2: Milestone work_submitted warning OR expired
        if (deal.status === 'active' && deal.is_milestone && Array.isArray(deal.milestones)) {
          const warnMsIdx = deal.milestones.findIndex((m: any) => {
            if (m.status !== 'work_submitted' || !m.auto_release_at || m.auto_release_warning_sent) return false;
            const t = Date.parse(String(m.auto_release_at));
            return !Number.isNaN(t) && t > nowMs && t - nowMs <= 6 * 3600 * 1000;
          });
          if (warnMsIdx !== -1) {
            const nowIso = new Date().toISOString();
            const targetMs = deal.milestones[warnMsIdx];
            const hoursLeft = Math.max(1, Math.ceil((Date.parse(String(targetMs.auto_release_at)) - nowMs) / 3600000));
            const nextMilestones = deal.milestones.map((m: any, idx: number) =>
              idx === warnMsIdx ? { ...m, auto_release_warning_sent: nowIso } : m
            );
            const firestore = getDb();
            if (firestore) {
              await firestore.collection('deals').doc(cid).set({ milestones: nextMilestones, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
            }
            const updatedDeal = await enrichDealWithParties({ ...deal, milestones: nextMilestones, updatedAt: nowIso, updated_at: nowIso });
            memoryDeals.set(cid, updatedDeal);
            const warnText = `⏰ هشدار بازرسی مرحله ${warnMsIdx + 1} («${targetMs.title}»): حدود ${hoursLeft} ساعت تا آزادسازی خودکار مبلغ این مرحله باقی مانده است.`;
            await appendContractMilestoneMessage(cid, { id: '0', full_name: 'سیستم بازرسی هوشمند میانجی' }, warnText, undefined, [buyerId, sellerId]);
            await pushUserNotification(buyerId, `هشدار بازرسی مرحله ${warnMsIdx + 1}`, warnText, undefined, {
              kind: 'deal',
              contract_id: cid,
              url: `/?view=detail&contract_id=${cid}`,
              tag: `mianji-inspect-warn-ms-${cid}-${targetMs.id}`,
            });
            wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal });
            wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal });
          }

          const expiredMsIdx = deal.milestones.findIndex(
            (m: any) => m.status === 'work_submitted' && m.auto_release_at && Date.parse(String(m.auto_release_at)) <= nowMs
          );
          if (expiredMsIdx !== -1) {
            processingDealIds.add(cid);
            try {
              const liveDeal = (await getDealByContractId(cid)) || deal;
              if (liveDeal.status === 'active' && Array.isArray(liveDeal.milestones)) {
                const targetMs = liveDeal.milestones[expiredMsIdx];
                if (targetMs && targetMs.status === 'work_submitted' && targetMs.auto_release_at && Date.parse(String(targetMs.auto_release_at)) <= nowMs) {
                  const nowIso = new Date().toISOString();
                  const nextMilestones = liveDeal.milestones.map((m: any) => ({ ...m }));
                  nextMilestones[expiredMsIdx] = {
                    ...targetMs,
                    status: 'completed',
                    completed_at: nowIso,
                    auto_release_at: null,
                  };
                  const nextPendingIdx = nextMilestones.findIndex((m: any) => m.status === 'pending');
                  if (nextPendingIdx !== -1) {
                    nextMilestones[nextPendingIdx] = { ...nextMilestones[nextPendingIdx], status: 'active' };
                  }
                  const allDone = nextMilestones.every((m: any) => m.status === 'completed');
                  const nextStatus = allDone ? 'completed' : 'active';
                  const prevTimeline = Array.isArray(liveDeal.timeline) ? liveDeal.timeline : [];
                  const tlEntry = {
                    id: `tl_auto_ms_${Date.now()}`,
                    type: 'auto_release',
                    status: nextStatus,
                    actor_id: 'system',
                    actor_name: 'سیستم بازرسی هوشمند میانجی',
                    note: `مهلت بازرسی مرحله ${expiredMsIdx + 1} («${targetMs.title}») به پایان رسید و مبلغ ${Number(targetMs.amount).toLocaleString()} تومان خودکار آزاد شد.`,
                    timestamp: nowIso,
                  };
                  const nextTimeline = [...prevTimeline, tlEntry];
                  const payout = await executeEscrowPayout({
                    cid,
                    deal: liveDeal,
                    grossUnlockAmount: Number(targetMs.amount),
                    sellerGrossAmount: Number(targetMs.amount),
                    feePercent,
                    buyerId,
                    sellerId,
                    nextDealFields: {
                      status: nextStatus,
                      milestones: nextMilestones,
                      timeline: nextTimeline,
                      ...(allDone ? { auto_released: true } : {}),
                    },
                    releaseDescription: `آزادسازی خودکار مرحله ${expiredMsIdx + 1} (${targetMs.title}) در ${liveDeal.title}`,
                    incrementCompletedCount: allDone,
                  });
                  const updatedDeal = await enrichDealWithParties({
                    ...liveDeal,
                    status: nextStatus,
                    milestones: nextMilestones,
                    timeline: nextTimeline,
                    ...(allDone ? { auto_released: true } : {}),
                    updatedAt: nowIso,
                    updated_at: nowIso,
                  });
                  memoryDeals.set(cid, updatedDeal);

                  await appendContractMilestoneMessage(cid, { id: '0', full_name: 'سیستم میانجی' }, `⏱️ ${tlEntry.note}`, undefined, [buyerId, sellerId]);
                  await pushUserNotification(sellerId, `آزادسازی خودکار مرحله ${expiredMsIdx + 1}`, tlEntry.note, undefined, {
                    kind: 'deal',
                    contract_id: cid,
                    url: `/?view=detail&contract_id=${cid}`,
                    tag: `mianji-autorelease-ms-${cid}-${targetMs.id}`,
                  });
                  wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
                  wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
                  wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
                }
              }
            } finally {
              processingDealIds.delete(cid);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[AUTO-RELEASE] Sweep error:', (err as Error)?.message || err);
    } finally {
      autoReleaseSweepBusy = false;
    }
  };

  setTimeout(() => {
    void processExpiredAutoReleases();
  }, 4000);
  const autoReleaseTimer = setInterval(() => {
    void processExpiredAutoReleases();
  }, 30000);

  process.once('SIGINT', () => {
    clearInterval(autoReleaseTimer);
    server.close();
  });
  process.once('SIGTERM', () => {
    clearInterval(autoReleaseTimer);
    server.close();
  });
}

bootstrap();
