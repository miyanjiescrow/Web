import express from 'express';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import https from 'node:https';
import crypto from 'crypto';
import { initializeApp, getApps, cert, App as FirebaseAdminApp } from 'firebase-admin/app';
import { getFirestore, FieldValue as FirebaseFieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import * as webpush from 'web-push';
import { WebSocketServer, WebSocket } from 'ws';
import firebaseConfig from './firebase-applet-config.json';
import {
  initializeAndVerifySupabase,
  DbSentinel,
  SupabaseInitResult,
  adjustWalletAtomicRpc,
  extractPhoneCore10Digits,
  normalizeAmbassadorCommissionRate,
  probeSupabaseWriteHealth,
  resolveTableTarget,
  rowToDocData,
} from './src/lib/supabaseDb';
import { validateIranianPayoutDestination, isValidIranianNationalId, isValidIranianCard, detectIranianBankName, formatIranianCard } from './src/lib/bankValidation';
import {
  DEFAULT_PLATFORM_FEE_PERCENT,
  normalizeCategoryCode,
  getCategoryPrefix,
  generateContractId,
  normalizeDigits,
  extractCleanPhone,
  parseIranMobile,
  getPhoneCore10,
  normalizeIranPhone,
  isPendingPartyId,
  getUserIdentityTokens,
  isUserDealBuyer,
  isUserDealSeller,
  isUserDealCreator,
  normalizeCommissionPayer,
  computeCommissionBreakdown,
  normalizeDealStatus,
  isDisputedStatus,
  isTerminalStatus,
  buildTelegramBotDealLink,
} from './src/lib/dealSync';
import { buildContractPdfBuffer } from './src/lib/contractPdf';
import {
  AdminPermissionKey,
  DEFAULT_ADMIN_PERMISSIONS,
  getEffectiveActorPermissions,
  hasAdminPermission,
  hasAnyAdminPermission,
  normalizeAdminPermissions,
  sanitizeAdminPermissionsPatch,
} from './src/lib/adminPermissions';

dotenv.config();

// Initialize Firebase Admin only when valid credentials or GCP runtime ADC exist
let adminApp: FirebaseAdminApp | null = null;
let hasAdminCredentials = false;
let hasExplicitAdminCredentials = false;
let credentialSource: 'service_account_json' | 'secret_file' | 'gac_file' | 'gcp_adc' | 'none' = 'none';
let credentialDetail = '';
let lastFirestoreError: string | null = null;
let firebaseInitError: string | null = null;
let firestoreVerifiedAt: string | null = null;
let supabaseState: SupabaseInitResult = {
  configured: false,
  ready: false,
  urlHost: null,
  keyRole: null,
  keyRef: null,
  client: null,
  adapter: null,
  lastError: null,
  verifiedAt: null,
};

const FieldValue = {
  serverTimestamp: () => (supabaseState.ready ? DbSentinel.serverTimestamp() : FirebaseFieldValue.serverTimestamp()),
  increment: (n: number) => (supabaseState.ready ? DbSentinel.increment(n) : FirebaseFieldValue.increment(n)),
  arrayUnion: (...items: any[]) => (supabaseState.ready ? DbSentinel.arrayUnion(...items) : FirebaseFieldValue.arrayUnion(...items)),
  arrayRemove: (...items: any[]) => (supabaseState.ready ? DbSentinel.arrayRemove(...items) : FirebaseFieldValue.arrayRemove(...items)),
  delete: () => (supabaseState.ready ? DbSentinel.delete() : FirebaseFieldValue.delete()),
};

const hasDbReady = () => Boolean(supabaseState.ready || hasAdminCredentials);
const hasExplicitDb = () => Boolean((supabaseState.configured && supabaseState.ready) || hasExplicitAdminCredentials);

// Dedicated IPv4 keep-alive HTTPS agent for Telegram Bot API (prevents 15-30s Node/undici IPv6 connect hangs on containers)
const telegramIpv4Agent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const telegramBotRequest = (
  botToken: string,
  method: string,
  payload?: Record<string, any>,
  timeoutMs = 4500
): Promise<{ ok: boolean; status: number; json: any; error?: string }> =>
  new Promise((resolve) => {
    const cleanToken = String(botToken || '').trim();
    if (!cleanToken) {
      resolve({ ok: false, status: 0, json: {}, error: 'missing_token' });
      return;
    }
    const bodyStr = payload ? JSON.stringify(payload) : '';
    const isPost = Boolean(payload);
    let settled = false;
    const finish = (result: { ok: boolean; status: number; json: any; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${cleanToken}/${method}`,
        method: isPost ? 'POST' : 'GET',
        family: 4,
        agent: telegramIpv4Agent,
        headers: isPost
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: any = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {}
          const status = Number(res.statusCode || 0);
          finish({
            ok: status >= 200 && status < 300 && Boolean(json?.ok),
            status,
            json,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Telegram API timeout'));
      finish({ ok: false, status: 0, json: {}, error: 'timeout' });
    });
    req.on('error', (err: any) => {
      finish({ ok: false, status: 0, json: {}, error: String(err?.message || err || 'network_error') });
    });

    if (isPost && bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });

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

function parseServiceAccountRaw(rawInput: string): Record<string, any> | null {
  let normalizedJson = String(rawInput || '').trim();
  if (!normalizedJson) return null;
  if (
    (normalizedJson.startsWith("'") && normalizedJson.endsWith("'")) ||
    (normalizedJson.startsWith('"') && normalizedJson.endsWith('"') && !normalizedJson.startsWith('"{\\"'))
  ) {
    normalizedJson = normalizedJson.slice(1, -1).trim();
  }
  if (!normalizedJson.startsWith('{') && !normalizedJson.startsWith('"') && /^[A-Za-z0-9+/=\s]+$/.test(normalizedJson)) {
    try {
      const decoded = Buffer.from(normalizedJson.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) normalizedJson = decoded;
    } catch {}
  }
  if (!normalizedJson.startsWith('{') && !normalizedJson.startsWith('"')) return null;
  const parsed = JSON.parse(normalizedJson);
  const serviceAccount = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  if (!serviceAccount || typeof serviceAccount !== 'object') return null;
  if (typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) return null;
  return serviceAccount;
}

function tryReadServiceAccountFile(filePath: string): Record<string, any> | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 65536) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const sa = parseServiceAccountRaw(raw);
    if (!sa) return null;
    if (sa.type && sa.type !== 'service_account') return null;
    return sa;
  } catch {
    return null;
  }
}

function discoverSecretServiceAccountFile(): { path: string; serviceAccount: Record<string, any> } | null {
  const candidates: string[] = [];
  const envFileHints = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    process.env.FIREBASE_KEY_FILE,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  for (const hint of envFileHints) {
    candidates.push(hint);
    candidates.push(path.resolve(hint));
    candidates.push(path.join('/etc/secrets', path.basename(hint)));
  }

  for (const fixed of [
    '/etc/secrets/firebase.json',
    '/etc/secrets/FIREBASE_SERVICE_ACCOUNT_JSON',
    '/etc/secrets/firebase-adminsdk.json',
    '/etc/secrets/service-account.json',
    '/etc/secrets/serviceAccountKey.json',
    path.resolve('secrets/firebase.json'),
    path.resolve('firebase-service-account.json'),
    path.resolve('serviceAccountKey.json'),
  ]) {
    candidates.push(fixed);
  }

  const scanDirForServiceAccount = (dir: string, requireAdminPattern: boolean) => {
    try {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        if (entry === 'firebase-applet-config.json' || entry === 'firebase-blueprint.json' || entry === 'package.json' || entry === 'metadata.json' || entry === 'tsconfig.json') {
          continue;
        }
        if (requireAdminPattern) {
          const lower = entry.toLowerCase();
          if (
            !lower.endsWith('.json') ||
            (!lower.includes('firebase-adminsdk') && !lower.includes('service-account') && !lower.includes('serviceaccount') && !lower.includes('firebase-key') && !lower.includes('firebase_key'))
          ) {
            continue;
          }
        }
        candidates.push(path.join(dir, entry));
      }
    } catch {}
  };

  scanDirForServiceAccount('/etc/secrets', false);
  scanDirForServiceAccount(path.resolve('secrets'), false);
  scanDirForServiceAccount(process.cwd(), true);

  const seen = new Set<string>();
  let fallbackHit: { path: string; serviceAccount: Record<string, any> } | null = null;
  for (const candidatePath of candidates) {
    const resolved = path.resolve(candidatePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const sa = tryReadServiceAccountFile(candidatePath);
    if (!sa) continue;
    if (configuredProjectId && sa.project_id === configuredProjectId) {
      return { path: candidatePath, serviceAccount: sa };
    }
    if (!fallbackHit) fallbackHit = { path: candidatePath, serviceAccount: sa };
  }
  return fallbackHit;
}

if (getApps().length === 0) {
  const serviceAccountRaw = (
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    ''
  ).trim();

  if (serviceAccountRaw) {
    try {
      let serviceAccount: Record<string, any> | null = null;
      if (!serviceAccountRaw.startsWith('{') && !serviceAccountRaw.startsWith('"') && (serviceAccountRaw.includes('/') || serviceAccountRaw.endsWith('.json'))) {
        serviceAccount =
          tryReadServiceAccountFile(serviceAccountRaw) ||
          tryReadServiceAccountFile(path.join('/etc/secrets', path.basename(serviceAccountRaw))) ||
          tryReadServiceAccountFile(path.resolve(serviceAccountRaw));
      }
      if (!serviceAccount) {
        serviceAccount = parseServiceAccountRaw(serviceAccountRaw);
      }
      if (!serviceAccount) {
        throw new Error('Missing client_email or private_key in Firebase service account JSON');
      }
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.project_id || configuredProjectId,
      });
      hasAdminCredentials = true;
      hasExplicitAdminCredentials = true;
      credentialSource = 'service_account_json';
      credentialDetail = 'env:FIREBASE_SERVICE_ACCOUNT_JSON';
      console.log(`[FIREBASE] Admin SDK initialized with service account env for project: ${adminApp.options.projectId}`);
    } catch (e) {
      firebaseInitError = `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${(e as Error)?.message}`;
      console.error('[FIREBASE] Invalid FIREBASE_SERVICE_ACCOUNT_JSON; checking Secret Files fallback:', (e as Error)?.message);
    }
  }

  if (!hasAdminCredentials) {
    const discoveredFile = discoverSecretServiceAccountFile();
    if (discoveredFile) {
      adminApp = initializeApp({
        credential: cert(discoveredFile.serviceAccount),
        projectId: discoveredFile.serviceAccount.project_id || configuredProjectId,
      });
      hasAdminCredentials = true;
      hasExplicitAdminCredentials = true;
      credentialSource = process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'gac_file' : 'secret_file';
      credentialDetail = path.basename(discoveredFile.path);
      console.log(
        `[FIREBASE] Admin SDK initialized with Secret File (${discoveredFile.path}) for project: ${adminApp.options.projectId}`
      );
    } else if (isGcpRuntime) {
      adminApp = initializeApp({ projectId: configuredProjectId });
      hasAdminCredentials = true;
      credentialSource = 'gcp_adc';
      credentialDetail = 'gcp_adc';
      console.log(`[FIREBASE] Admin SDK initialized with GCP ADC for project: ${adminApp.options.projectId}`);
    } else {
      firebaseInitError = 'FIREBASE_SERVICE_ACCOUNT_JSON or /etc/secrets/*.json service account file not found';
      if (!process.env.SUPABASE_URL) {
        console.warn('[FIREBASE] Admin SDK credentials not configured; checking local disk snapshot fallback.');
      }
    }
  }
} else {
  adminApp = getApps()[0];
  const discoveredFile = discoverSecretServiceAccountFile();
  hasExplicitAdminCredentials = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
      discoveredFile
  );
  hasAdminCredentials = Boolean(hasExplicitAdminCredentials || isGcpRuntime);
  credentialSource = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? 'service_account_json'
    : discoveredFile
    ? 'secret_file'
    : isGcpRuntime
    ? 'gcp_adc'
    : 'none';
  credentialDetail = discoveredFile ? path.basename(discoveredFile.path) : credentialSource;
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
    firebaseInitError = String(reason?.message || reason);
    console.warn('[FIREBASE] Disabled Admin SDK after ADC lookup error:', firebaseInitError);
    return;
  }
  console.error('[SERVER] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err: any) => {
  if (isAdcCredentialError(err)) {
    hasAdminCredentials = false;
    firebaseInitError = String(err?.message || err);
    console.warn('[FIREBASE] Caught async ADC exception; Admin SDK disabled safely:', firebaseInitError);
    return;
  }
  console.error('[SERVER] Uncaught Exception:', err);
  process.exit(1);
});

// In AI Studio / Render, the database ID is crucial for non-default databases
const dbId = (process.env.FIREBASE_DATABASE_ID || (firebaseConfig as any).firestoreDatabaseId || '').trim();

const configuredFirestoreSet = new WeakSet<object>();

function getDb(useDefault = false): FirebaseFirestore.Firestore | null {
  if (supabaseState.ready && supabaseState.adapter) {
    return useDefault ? null : (supabaseState.adapter as unknown as FirebaseFirestore.Firestore);
  }
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

const isPermissionOrAuthError = (err: any) => {
  const code = err?.code;
  const msg = String(err?.message || err || '');
  return (
    code === 7 ||
    code === 16 ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('UNAUTHENTICATED') ||
    isAdcCredentialError(err)
  );
};

async function verifyFirestoreConnection() {
  if (!hasAdminCredentials || !adminApp) return;
  try {
    const testDb = dbId ? getFirestore(adminApp, dbId) : getFirestore(adminApp);
    await Promise.race([
      testDb.collection('users').limit(1).get(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore probe timeout (12s)')), 12000)),
    ]);
    lastFirestoreError = null;
    firestoreVerifiedAt = new Date().toISOString();
    console.log(
      `[FIREBASE] Verified Firestore connection (${adminApp.options.projectId || configuredProjectId} / ${dbId || '(default)'}) via ${credentialSource}${credentialDetail ? ` (${credentialDetail})` : ''}`
    );
  } catch (err: any) {
    const msg = String(err?.message || err || 'Unknown Firestore connection error');
    lastFirestoreError = msg;
    const isTransientTimeout = msg.includes('timeout') || msg.includes('DEADLINE_EXCEEDED') || msg.includes('UNAVAILABLE');
    if (hasExplicitAdminCredentials && isTransientTimeout) {
      // Never disable valid explicit Secret File / Service Account credentials due to cold-start latency
      console.warn(`[FIREBASE] Startup probe timed out (${msg}), keeping Admin SDK active for runtime operations.`);
      return;
    }
    if (isPermissionOrAuthError(err) || (!hasExplicitAdminCredentials && isTransientTimeout) || msg.includes('NOT_FOUND')) {
      hasAdminCredentials = false;
      console.warn(
        `[FIREBASE] Cannot access Firestore (${adminApp?.options.projectId || configuredProjectId} / ${dbId || '(default)'}): ${msg}. Falling back to local disk snapshot.`
      );
    } else {
      console.warn(`[FIREBASE] Startup probe warning: ${msg}`);
    }
  }
}

interface RuntimeLogEntry {
  id: string;
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'success';
  source: 'supabase' | 'bot_sync' | 'auth' | 'telegram' | 'wallet' | 'system';
  message: string;
  detail?: string;
}

const runtimeEventLogs: RuntimeLogEntry[] = [];
const pushRuntimeLog = (
  level: RuntimeLogEntry['level'],
  source: RuntimeLogEntry['source'],
  message: string,
  detail?: string
) => {
  runtimeEventLogs.unshift({
    id: `rlog_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    timestamp: new Date().toISOString(),
    level,
    source,
    message: String(message || '').slice(0, 240),
    ...(detail ? { detail: String(detail).slice(0, 800) } : {}),
  });
  if (runtimeEventLogs.length > 250) {
    runtimeEventLogs.length = 250;
  }
};

async function bootstrap() {
  supabaseState = await initializeAndVerifySupabase();
  if (supabaseState.ready) {
    lastFirestoreError = null;
    console.log(`[SUPABASE] Connected & verified (${supabaseState.urlHost})`);
    pushRuntimeLog('success', 'supabase', `اتصال به Supabase تایید شد (${supabaseState.urlHost})`);
  } else {
    if (supabaseState.configured && supabaseState.lastError) {
      console.warn(`[SUPABASE] Configured (${supabaseState.urlHost || 'unknown'}) but unavailable: ${supabaseState.lastError}`);
      pushRuntimeLog('error', 'supabase', `عدم اتصال به Supabase (${supabaseState.urlHost || 'unknown'})`, supabaseState.lastError);
    } else {
      pushRuntimeLog('warn', 'supabase', 'متغیرهای SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY تنظیم نشده‌اند');
    }
    await verifyFirestoreConnection();
  }
  const DATA_DIR = path.resolve('.data');
  const SNAPSHOT_FILE = path.join(DATA_DIR, 'mianji-db.json');
  let diskWritable = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    diskWritable = true;
  } catch {
    diskWritable = false;
  }

  let initialDiskSnapshot: Record<string, any> | null = null;
  if (diskWritable && fs.existsSync(SNAPSHOT_FILE)) {
    try {
      const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
      if (raw.trim()) {
        initialDiskSnapshot = JSON.parse(raw);
      }
    } catch (snapErr: any) {
      console.warn('[PERSISTENCE] Failed to parse local snapshot file:', snapErr?.message || snapErr);
    }
  }

  const getPersistenceStatus = () => ({
    mode: supabaseState.ready
      ? ('supabase' as const)
      : hasAdminCredentials
      ? ('firestore' as const)
      : diskWritable
      ? ('local_disk' as const)
      : ('memory_ephemeral' as const),
    supabaseReady: supabaseState.ready,
    supabaseConfigured: supabaseState.configured,
    supabaseHost: supabaseState.urlHost,
    supabaseKeyRole: supabaseState.keyRole || null,
    supabaseKeyRef: supabaseState.keyRef || null,
    firebaseAdminReady: hasAdminCredentials,
    projectId: supabaseState.ready
      ? supabaseState.urlHost || 'supabase-postgres'
      : adminApp?.options.projectId || configuredProjectId,
    databaseId: supabaseState.ready ? 'postgresql (RLS)' : dbId || '(default)',
    credentialSource: supabaseState.ready ? 'supabase_service_role' : credentialSource,
    credentialDetail: supabaseState.ready ? supabaseState.urlHost || 'Supabase PostgreSQL' : credentialDetail,
    lastError: supabaseState.ready
      ? lastFirestoreError
      : lastFirestoreError ||
        (supabaseState.configured ? supabaseState.lastError : hasExplicitAdminCredentials ? firebaseInitError : null),
    lastWriteError: lastFirestoreError,
    verifiedAt: supabaseState.verifiedAt || firestoreVerifiedAt,
  });

  const strictFirestoreWrite = async (
    label: string,
    op: (firestore: FirebaseFirestore.Firestore) => Promise<any>
  ): Promise<boolean> => {
    const firestore = getDb();
    if (!firestore) return false;
    try {
      await op(firestore);
      lastFirestoreError = null;
      return true;
    } catch (err: any) {
      const msg = String(err?.message || err || 'Unknown write error');
      lastFirestoreError = `${label}: ${msg}`;
      pushRuntimeLog('error', supabaseState.ready ? 'supabase' : 'system', `خطا در نوشتن دیتابیس (${label})`, msg);
      console.error(`[${supabaseState.ready ? 'SUPABASE' : 'FIRESTORE'}-WRITE-ERROR] ${label}:`, msg);
      if (hasExplicitDb()) {
        throw new Error(
          supabaseState.ready
            ? `خطا در ذخیره دائمی اطلاعات در دیتابیس Supabase (${label}): ${msg.slice(0, 180)}`
            : `خطا در ذخیره دائمی اطلاعات در دیتابیس (${label}): ${msg.slice(0, 180)}`
        );
      }
      return false;
    }
  };

  let snapshotFlushRequested = () => {};
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use((req, res, next) => {
    if (!hasDbReady() && req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      res.on('finish', () => {
        if (res.statusCode < 500) {
          snapshotFlushRequested();
        }
      });
    }
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
  const usedOtpChallenges = new Set<string>();
  const otpChallengeAttempts = new Map<string, number>();

  const otpSecret = crypto
    .createHash('sha256')
    .update(
      process.env.ADMIN_SESSION_SECRET ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.BOT_TOKEN ||
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
        `mianji-otp-${configuredProjectId || 'local'}-${(firebaseConfig as any)?.apiKey || 'fallback'}`
    )
    .digest('hex');

  const hashOtpCode = (coreDigits: string, code: string) =>
    crypto.createHmac('sha256', otpSecret).update(`${coreDigits}:${code}`).digest('hex');

  const safeEqualHex = (a: string, b: string) => {
    if (!a || !b || a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  };

  const signOtpChallenge = (coreDigits: string, code: string, expires: number) => {
    const jti = crypto.randomBytes(8).toString('hex');
    const payload = Buffer.from(
      JSON.stringify({
        p: coreDigits,
        h: hashOtpCode(coreDigits, code),
        exp: expires,
        jti,
      })
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', otpSecret).update(payload).digest('hex');
    return `${payload}.${sig}`;
  };

  const verifyOtpChallengeToken = (
    token: unknown
  ): { p: string; h: string; exp: number; jti: string } | null => {
    if (!token || typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = crypto.createHmac('sha256', otpSecret).update(payload).digest('hex');
    if (!safeEqualHex(sig, expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!parsed?.p || !parsed?.h || !parsed?.exp || !parsed?.jti) return null;
      return {
        p: String(parsed.p),
        h: String(parsed.h),
        exp: Number(parsed.exp),
        jti: String(parsed.jti),
      };
    } catch {
      return null;
    }
  };

  const parseOtpExpiresMs = (rawExp: any): number => {
    if (rawExp === undefined || rawExp === null || rawExp === '') return 0;
    if (typeof rawExp === 'number') {
      if (!Number.isFinite(rawExp) || rawExp <= 0) return 0;
      return rawExp < 1e12 ? Math.trunc(rawExp * 1000) : Math.trunc(rawExp);
    }
    if (typeof rawExp?.toMillis === 'function') {
      try {
        return Math.trunc(rawExp.toMillis());
      } catch {
        return 0;
      }
    }
    if (typeof rawExp?.toDate === 'function') {
      try {
        return Math.trunc(rawExp.toDate().getTime());
      } catch {
        return 0;
      }
    }
    const s = String(rawExp).trim();
    if (!s) return 0;
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
      return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
    }
    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? 0 : parsed;
  };

  const otpPhoneVariants = (coreDigits: string): string[] => {
    const clean = extractCleanPhone(coreDigits);
    const c10 = clean.length >= 10 ? clean.slice(-10) : clean;
    if (!c10) return [];
    return Array.from(new Set([c10, `0${c10}`, `98${c10}`, `+98${c10}`, `0098${c10}`, `u_${c10}`]));
  };

  const getOtpFirestoreTargets = () => {
    const dbs: any[] = [];
    const primary = getDb();
    if (primary) dbs.push(primary);
    const fallback = !supabaseState.ready && dbId ? getDb(true) : null;
    if (fallback && fallback !== primary) dbs.push(fallback);
    return dbs;
  };

  const saveOtpRecord = async (
    coreDigits: string,
    code: string,
    expires: number,
    options?: { purpose?: string; telegramId?: string | null; phone?: string }
  ): Promise<string> => {
    otps.set(coreDigits, { code, expires, attempts: 0 });
    const canonicalPhone = options?.phone ? normalizeIranPhone(options.phone) || String(options.phone) : `0${coreDigits}`;
    const purpose = String(options?.purpose || 'login').slice(0, 48);
    const telegramId = options?.telegramId ? String(options.telegramId) : null;

    // Fast path: single atomic upsert in Supabase (onConflict: 'id'), cleanup legacy variant rows non-blocking
    if (supabaseState.ready && supabaseState.client && /^\d{10}$/.test(coreDigits)) {
      const legacyVariants = otpPhoneVariants(coreDigits).filter((v) => v !== coreDigits);
      if (legacyVariants.length > 0) {
        void (async () => {
          try {
            await supabaseState.client!
              .from('otp_codes')
              .delete()
              .in('id', legacyVariants);
          } catch {}
        })();
      }
      const nowIso = new Date().toISOString();
      const row = {
        id: coreDigits,
        phone: canonicalPhone,
        code: null,
        code_hash: hashOtpCode(coreDigits, code),
        expires,
        attempts: 0,
        purpose,
        telegram_id: telegramId,
        data: {
          id: coreDigits,
          phone: canonicalPhone,
          code_hash: hashOtpCode(coreDigits, code),
          expires,
          attempts: 0,
          purpose,
          ...(telegramId ? { telegram_id: telegramId } : {}),
          updatedAt: nowIso,
        },
        updated_at: nowIso,
      };
      try {
        const { error } = await Promise.race([
          supabaseState.client.from('otp_codes').upsert(row, { onConflict: 'id' }),
          new Promise<{ error: any }>((resolve) =>
            setTimeout(() => resolve({ error: { message: 'OTP write timeout' } }), 2500)
          ),
        ]);
        if (error) {
          pushRuntimeLog('warn', 'auth', `خطا در ذخیره موقت OTP در دیتابیس (${coreDigits})`, error.message || String(error));
        }
      } catch (err: any) {
        pushRuntimeLog('warn', 'auth', `خطا در ذخیره موقت OTP در دیتابیس (${coreDigits})`, err?.message || String(err));
      }
      return signOtpChallenge(coreDigits, code, expires);
    }

    const dbs = getOtpFirestoreTargets();
    if (dbs.length > 0) {
      const payload: Record<string, any> = {
        id: coreDigits,
        phone: canonicalPhone,
        code_hash: hashOtpCode(coreDigits, code),
        expires,
        attempts: 0,
        purpose,
        ...(telegramId ? { telegram_id: telegramId } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      };
      for (const targetDb of dbs) {
        try {
          await Promise.race([
            targetDb.collection('otp_codes').doc(coreDigits).set(payload),
            new Promise((_, reject) => setTimeout(() => reject(new Error('OTP write timeout')), 2500)),
          ]);
          break;
        } catch (err: any) {
          pushRuntimeLog('warn', 'auth', `خطا در ذخیره موقت OTP در دیتابیس (${coreDigits})`, err?.message || String(err));
          if (!supabaseState.ready && !hasExplicitAdminCredentials && isPermissionOrAuthError(err)) {
            hasAdminCredentials = false;
            break;
          }
        }
      }
    }
    return signOtpChallenge(coreDigits, code, expires);
  };

  interface LoadedOtpRecord {
    sourceDb: any;
    docId: string;
    code?: string;
    code_hash?: string;
    expires: number;
    attempts: number;
    telegram_id?: string;
    phone?: string;
  }

  const loadOtpRecords = async (coreDigits: string): Promise<LoadedOtpRecord[]> => {
    const results: LoadedOtpRecord[] = [];
    const seenKeys = new Set<string>();
    const variants = otpPhoneVariants(coreDigits);

    const pushRow = (sourceDb: any, docId: string, data: any) => {
      if (!data) return;
      const key = `${docId}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      const rawCode = data.code ?? data.otp ?? data.otp_code ?? data.pin ?? data.data?.code ?? data.data?.otp;
      const normalizedCode = rawCode !== undefined && rawCode !== null ? extractCleanPhone(rawCode) : undefined;
      const rawExp = data.expires ?? data.expires_at ?? data.expiresAt ?? data.data?.expires ?? data.data?.expires_at;
      const rawHash = data.code_hash ?? data.hash ?? data.data?.code_hash;
      const rawTg = data.telegram_id ?? data.tg_id ?? data.data?.telegram_id;
      const rawPhone = data.phone ?? data.phone_number ?? data.data?.phone;
      results.push({
        sourceDb,
        docId: String(docId),
        code: normalizedCode || undefined,
        code_hash: rawHash ? String(rawHash).trim() : undefined,
        expires: parseOtpExpiresMs(rawExp),
        attempts: Math.max(0, Number(data.attempts ?? data.data?.attempts ?? 0)),
        ...(rawTg ? { telegram_id: String(rawTg).trim() } : {}),
        ...(rawPhone ? { phone: String(rawPhone).trim() } : {}),
      });
    };

    const primaryDb = getDb();

    // 1. Direct Supabase query across all phone & ID formats (catches bot-inserted rows too)
    if (supabaseState.ready && supabaseState.client && primaryDb && /^\d{10}$/.test(coreDigits)) {
      try {
        const orExpr = [
          `id.eq.${coreDigits}`,
          `id.eq.0${coreDigits}`,
          `id.eq.98${coreDigits}`,
          `id.eq.+98${coreDigits}`,
          `id.eq.0098${coreDigits}`,
          `id.eq.u_${coreDigits}`,
          `phone.eq.${coreDigits}`,
          `phone.eq.0${coreDigits}`,
          `phone.eq.98${coreDigits}`,
          `phone.eq.+98${coreDigits}`,
          `phone.eq.0098${coreDigits}`,
          `phone.ilike.%${coreDigits}%`,
        ].join(',');
        const { data: rows, error } = await Promise.race([
          supabaseState.client
            .from('otp_codes')
            .select('*')
            .or(orExpr)
            .order('updated_at', { ascending: false })
            .limit(10),
          new Promise<{ data: null; error: any }>((resolve) =>
            setTimeout(() => resolve({ data: null, error: { message: 'OTP read timeout' } }), 5000)
          ),
        ]);
        if (!error && Array.isArray(rows)) {
          for (const r of rows) {
            pushRow(primaryDb, String(r.id), { ...(r.data || {}), ...r });
          }
        }
      } catch {}
    }

    // 2. Adapter / Firestore lookup by doc IDs & phone query fallback
    const dbs = getOtpFirestoreTargets();
    for (const targetDb of dbs) {
      for (const docId of variants) {
        if (seenKeys.has(docId)) continue;
        try {
          const snap: any = await Promise.race([
            targetDb.collection('otp_codes').doc(docId).get(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('OTP read timeout')), 4000)),
          ]);
          if (snap?.exists) {
            pushRow(targetDb, docId, snap.data() || {});
          }
        } catch (err: any) {
          if (!supabaseState.ready && !hasExplicitAdminCredentials && isPermissionOrAuthError(err)) {
            hasAdminCredentials = false;
            return results;
          }
        }
      }

      if (results.length === 0) {
        try {
          const allSnap: any = await Promise.race([
            targetDb.collection('otp_codes').get(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('OTP scan timeout')), 4000)),
          ]);
          if (allSnap?.docs) {
            for (const docItem of allSnap.docs) {
              const d = docItem.data() || {};
              const rowCore = getPhoneCore10(d.phone || d.phone_number || docItem.id);
              if (rowCore && rowCore === coreDigits) {
                pushRow(targetDb, docItem.id, d);
              }
            }
          }
        } catch {}
      }
    }

    return results;
  };

  const clearOtpRecord = async (coreDigits: string) => {
    otps.delete(coreDigits);
    const variants = otpPhoneVariants(coreDigits);
    if (supabaseState.ready && supabaseState.client && /^\d{10}$/.test(coreDigits)) {
      try {
        await Promise.race([
          supabaseState.client
            .from('otp_codes')
            .delete()
            .or(`id.in.(${variants.join(',')}),phone.in.(${variants.join(',')})`),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch {}
      return;
    }
    const dbs = getOtpFirestoreTargets();
    await Promise.race([
      Promise.all(
        dbs.flatMap((targetDb) =>
          variants.map((id) => targetDb.collection('otp_codes').doc(id).delete().catch(() => {}))
        )
      ),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  };

  const memoryUsers = new Map<string, any>();

  // Server-side HMAC session tokens (for resilient Admin/Impersonation auth across Render & Preview)
  const ephemeralFallbackSecret = crypto.randomBytes(32).toString('hex');
  const runtimeSecret =
    process.env.ADMIN_SESSION_SECRET ||
    crypto
      .createHash('sha256')
      .update(
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
          process.env.BOT_TOKEN ||
          process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
          ephemeralFallbackSecret
      )
      .digest('hex');

  const signSessionToken = (uid: string, role: string, opts?: { jti?: string; iat?: number }) => {
    const iat = opts?.iat || Date.now();
    const jti = opts?.jti || `sess_${crypto.randomBytes(10).toString('hex')}`;
    const payload = Buffer.from(
      JSON.stringify({ uid: String(uid), role: String(role || 'user'), jti, iat, exp: Date.now() + 86400000 })
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', runtimeSecret).update(payload).digest('hex');
    return `${payload}.${sig}`;
  };

  const verifySessionToken = (token: string | undefined): { uid: string; role: string; jti?: string; iat?: number } | null => {
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
      return {
        uid: String(parsed.uid),
        role: String(parsed.role || 'user'),
        ...(parsed.jti ? { jti: String(parsed.jti) } : {}),
        ...(parsed.iat ? { iat: Number(parsed.iat) } : {}),
      };
    } catch {
      return null;
    }
  };

  interface UserSessionRecord {
    id: string;
    user_id: string;
    device_label: string;
    platform: string;
    ip_masked: string;
    user_agent: string;
    issued_at: number;
    last_seen_at: number;
    revoked_at?: number;
  }

  const memorySessions = new Map<string, UserSessionRecord>();
  const memoryRevokedBefore = new Map<string, number>();

  const maskIpAddress = (rawIp?: string) => {
    const clean = String(rawIp || '').replace(/^::ffff:/, '').trim();
    if (!clean || clean === '::1' || clean === '127.0.0.1') return 'لوکال / پیش‌نمایش';
    const v4 = clean.split('.');
    if (v4.length === 4) return `${v4[0]}.${v4[1]}.*.*`;
    return clean.slice(0, 12) + '...';
  };

  const parseDeviceInfo = (req: express.Request) => {
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const lower = ua.toLowerCase();
    let os = 'دستگاه ناشناس';
    let platform = 'Web';
    if (lower.includes('telegram')) {
      os = 'تلگرام وب‌اپ';
      platform = 'Telegram';
    } else if (lower.includes('iphone') || lower.includes('ipad')) {
      os = 'iPhone / iOS';
      platform = 'Mobile';
    } else if (lower.includes('android')) {
      os = 'Android';
      platform = 'Mobile';
    } else if (lower.includes('windows')) {
      os = 'Windows';
      platform = 'Desktop';
    } else if (lower.includes('macintosh') || lower.includes('mac os')) {
      os = 'macOS';
      platform = 'Desktop';
    } else if (lower.includes('linux')) {
      os = 'Linux';
      platform = 'Desktop';
    }

    let browser = '';
    if (lower.includes('samsungbrowser')) browser = 'Samsung Browser';
    else if (lower.includes('edg/')) browser = 'Edge';
    else if (lower.includes('chrome/') || lower.includes('crios/')) browser = 'Chrome';
    else if (lower.includes('firefox/') || lower.includes('fxios/')) browser = 'Firefox';
    else if (lower.includes('safari/')) browser = 'Safari';

    const deviceLabel = browser && os !== 'تلگرام وب‌اپ' ? `${os} • ${browser}` : os;
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ipMasked = maskIpAddress(forwardedFor || req.ip);
    return { ua, deviceLabel, platform, ipMasked };
  };

  const isSessionRevoked = async (
    uid: string,
    claims: { jti?: string; iat?: number },
    liveUser?: any
  ): Promise<boolean> => {
    const revokedCutoff = Math.max(
      Number(memoryRevokedBefore.get(uid) || 0),
      Number(liveUser?.sessions_revoked_before || 0)
    );
    if (revokedCutoff > 0 && claims.iat && claims.iat < revokedCutoff) {
      return true;
    }
    if (claims.jti) {
      const mem = memorySessions.get(claims.jti);
      if (mem?.revoked_at) return true;
      if (!mem) {
        const fsDb = getDb();
        if (fsDb) {
          try {
            const snap = await fsDb.collection('user_sessions').doc(claims.jti).get();
            if (snap.exists) {
              const d = snap.data() as UserSessionRecord;
              memorySessions.set(claims.jti, { ...d, id: snap.id });
              if (d?.revoked_at) return true;
            }
          } catch {}
        }
      }
    }
    return false;
  };

  const issueTrackedSession = async (req: express.Request, res: express.Response, user: any): Promise<string> => {
    const uid = String(user.id);
    const role = String(user.role || 'user');
    const jti = `sess_${crypto.randomBytes(10).toString('hex')}`;
    const now = Date.now();
    const { ua, deviceLabel, platform, ipMasked } = parseDeviceInfo(req);

    const record: UserSessionRecord = {
      id: jti,
      user_id: uid,
      device_label: deviceLabel,
      platform,
      ip_masked: ipMasked,
      user_agent: ua,
      issued_at: now,
      last_seen_at: now,
    };
    memorySessions.set(jti, record);

    const fsDb = getDb();
    if (fsDb) {
      fsDb.collection('user_sessions').doc(jti).set(record).catch(() => {});
    }

    const token = signSessionToken(uid, role, { jti, iat: now });
    setSessionCookie(req, res, token);
    return token;
  };

  const timingSafeEqualStr = (a: string, b: string) => {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  };

  const extractSessionCookie = (req: express.Request): string | undefined => {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') return undefined;
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      if (k === 'mianji_sid') {
        try {
          return decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
          return part.slice(idx + 1).trim();
        }
      }
    }
    return undefined;
  };

  const setSessionCookie = (req: express.Request, res: express.Response, sessionToken: string) => {
    const isHttps =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https' ||
      process.env.NODE_ENV === 'production' ||
      process.env.RENDER === 'true';
    const attrs = [
      `mianji_sid=${encodeURIComponent(sessionToken)}`,
      'Path=/',
      'HttpOnly',
      'Max-Age=86400',
      isHttps ? 'SameSite=None' : 'SameSite=Lax',
    ];
    if (isHttps) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  };

  const otpSendRateMap = new Map<string, { count: number; resetAt: number }>();
  const otpVerifyRateMap = new Map<string, { count: number; resetAt: number }>();
  const authTelegramRateMap = new Map<string, { count: number; resetAt: number }>();
  const walletReqRateMap = new Map<string, { count: number; resetAt: number }>();
  const supportTicketRateMap = new Map<string, { count: number; resetAt: number }>();
  const disputeActionRateMap = new Map<string, { count: number; resetAt: number }>();
  const lookupRateMap = new Map<string, { count: number; resetAt: number }>();
  const logsRateMap = new Map<string, { count: number; resetAt: number }>();

  const checkBucketLimit = (
    bucket: Map<string, { count: number; resetAt: number }>,
    key: string,
    maxCount: number,
    windowMs: number
  ): boolean => {
    const now = Date.now();
    if (bucket.size > 1000) {
      for (const [k, v] of bucket.entries()) {
        if (now > v.resetAt) bucket.delete(k);
      }
    }
    const cur = bucket.get(key);
    if (!cur || now > cur.resetAt) {
      bucket.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (cur.count >= maxCount) return false;
    cur.count += 1;
    return true;
  };

  interface AuditLogRecord {
    id: string;
    actor_id: string;
    actor_name: string;
    actor_role: string;
    action: string;
    target_type?: string;
    target_id?: string;
    summary: string;
    created_at: string;
  }

  const memoryAuditLogs: AuditLogRecord[] = [];

  const recordAuditLog = async (
    actor: any,
    action: string,
    summary: string,
    target?: { type?: string; id?: string }
  ) => {
    try {
      const id = `aud_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const nowIso = new Date().toISOString();
      const entry: AuditLogRecord = {
        id,
        actor_id: String(actor?.id || 'system'),
        actor_name: String(actor?.full_name || 'سیستم'),
        actor_role: String(actor?.role || 'system'),
        action: String(action).slice(0, 80),
        ...(target?.type ? { target_type: String(target.type).slice(0, 40) } : {}),
        ...(target?.id ? { target_id: String(target.id).slice(0, 128) } : {}),
        summary: String(summary).slice(0, 500),
        created_at: nowIso,
      };
      memoryAuditLogs.unshift(entry);
      if (memoryAuditLogs.length > 250) memoryAuditLogs.length = 250;
      const firestore = getDb();
      if (firestore) {
        await firestore.collection('audit_logs').doc(id).set(entry).catch(() => {});
      }
    } catch {}
  };

  const isSecretSettingKey = (rawKey: string): boolean => {
    const k = String(rawKey || '').trim().toLowerCase();
    return /(service_role|bot_sync_secret|bot_token|admin_session_secret|session_secret|otp_api_secret|otp_secret|private_key|api_key|merchant_id|zibal_merchant|vapid|password|jwt_secret)/i.test(k);
  };

  const memorySecurityLogs: Array<Record<string, any>> = [];
  const recordSecurityAuditLog = async (params: {
    userId?: string | null;
    phoneNumber?: string | null;
    event: string;
    category?: string;
    status?: string;
    details?: string;
    data?: Record<string, any>;
  }) => {
    try {
      const id = `sec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const nowIso = new Date().toISOString();
      const entry = {
        id,
        user_id: params.userId ? String(params.userId) : null,
        phone_number: params.phoneNumber ? String(params.phoneNumber) : null,
        event: String(params.event || 'security_event').slice(0, 80),
        category: String(params.category || 'auth').slice(0, 40),
        status: String(params.status || 'info').slice(0, 32),
        details: params.details ? String(params.details).slice(0, 500) : '',
        ...(params.data || {}),
        created_at: nowIso,
      };
      memorySecurityLogs.unshift(entry);
      if (memorySecurityLogs.length > 200) memorySecurityLogs.length = 200;
      const firestore = getDb();
      if (firestore) {
        await firestore.collection('security_audit_logs').doc(id).set(entry).catch((err: any) => {
          pushRuntimeLog('warn', 'supabase', 'خطا در ثبت لاگ امنیتی', err?.message || String(err));
        });
      }
    } catch {}
  };

  const loadSecurityAuditLogs = async (limitCount = 100): Promise<any[]> => {
    const merged = new Map<string, any>();
    for (const item of memorySecurityLogs) merged.set(item.id, item);
    if (supabaseState.ready && supabaseState.client) {
      const { data, error } = await supabaseState.client
        .from('security_audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limitCount);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          merged.set(String(row.id), {
            ...(row.data && typeof row.data === 'object' ? row.data : {}),
            ...row,
            id: String(row.id),
          });
        }
      }
    } else {
      const firestore = getDb();
      if (firestore) {
        const snap = await firestore.collection('security_audit_logs').orderBy('created_at', 'desc').limit(limitCount).get().catch(() => null);
        if (snap) {
          snap.docs.forEach((d) => merged.set(d.id, { id: d.id, ...(d.data() || {}) }));
        }
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))
      .slice(0, limitCount);
  };

  const recordContractSignatureRecord = async (params: {
    contractId: string;
    user: any;
    role: 'buyer' | 'seller';
    signatureHash: string;
    signedAt: string;
    otpVerified?: boolean;
    clientIp?: string;
    verificationMethod?: string;
  }) => {
    try {
      const uid = String(params.user?.id || '');
      if (!params.contractId || !uid) return;
      const sigId = `sig_${params.contractId}_${params.role}_${uid}`;
      const entry = {
        id: sigId,
        contract_id: params.contractId,
        user_id: uid,
        telegram_id: params.user?.telegram_id ? String(params.user.telegram_id) : null,
        telegram_username: params.user?.username ? String(params.user.username) : null,
        full_name: params.user?.full_name ? String(params.user.full_name) : 'کاربر میانجی',
        national_id: params.user?.national_id ? String(params.user.national_id) : null,
        phone_number: params.user?.phone_number ? String(params.user.phone_number) : null,
        role: params.role,
        signed_at: params.signedAt,
        otp_verified: Boolean(params.otpVerified ?? true),
        client_ip: params.clientIp ? String(params.clientIp).slice(0, 64) : null,
        verification_method: params.verificationMethod || 'web_session',
        signature_hash: params.signatureHash,
        status: 'signed',
      };
      const firestore = getDb();
      if (firestore) {
        await firestore.collection('contract_signatures').doc(sigId).set(entry, { merge: true }).catch(() => {});
      }
    } catch {}
  };

  const loadAuditLogs = async (limitCount = 80): Promise<AuditLogRecord[]> => {
    const merged = new Map<string, AuditLogRecord>();
    for (const item of memoryAuditLogs) merged.set(item.id, item);
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore
          .collection('audit_logs')
          .orderBy('created_at', 'desc')
          .limit(limitCount)
          .get();
        snap.docs.forEach((d) => {
          const data = d.data() as AuditLogRecord;
          merged.set(d.id, { ...data, id: d.id });
        });
      } catch {
        try {
          const snap = await firestore.collection('audit_logs').limit(limitCount).get();
          snap.docs.forEach((d) => {
            const data = d.data() as AuditLogRecord;
            merged.set(d.id, { ...data, id: d.id });
          });
        } catch {}
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limitCount);
  };

  const PERMISSION_DENIED_MESSAGES: Record<AdminPermissionKey, string> = {
    manage_users: 'شما مجوز «مدیریت کاربران و لیمیت‌ها» را ندارید.',
    manage_kyc: 'شما مجوز «بررسی و تایید احراز هویت (KYC)» را ندارید.',
    manage_support: 'شما مجوز «پشتیبانی و پاسخ به تیکت‌ها» را ندارید.',
    manage_finance: 'شما مجوز «بخش مالی و فیش‌ها» را ندارید.',
    manage_disputes: 'شما مجوز «نظارت معاملات و داوری» را ندارید.',
  };

  const ensureAdminPermission = (
    actor: any,
    permission: AdminPermissionKey
  ): { ok: true } | { ok: false; status: number; error: string } => {
    if (hasAdminPermission(actor, permission)) return { ok: true };
    return {
      ok: false,
      status: 403,
      error: PERMISSION_DENIED_MESSAGES[permission] || 'دسترسی شما به این بخش توسط مالک محدود شده است.',
    };
  };

  interface GlobalLimits {
    min_deal_amount: number;
    default_max_deal_amount: number;
    default_daily_withdraw_limit: number;
    default_max_active_deals: number;
    max_admin_balance_adjust: number;
    platform_fee_percent: number;
    deposit_card_number?: string;
    deposit_card_holder?: string;
    deposit_sheba?: string;
    deposit_note?: string;
  }

  let globalLimits: GlobalLimits = {
    min_deal_amount: 10000,
    default_max_deal_amount: 100000000,
    default_daily_withdraw_limit: 50000000,
    default_max_active_deals: 10,
    max_admin_balance_adjust: 20000000,
    platform_fee_percent: DEFAULT_PLATFORM_FEE_PERCENT,
    deposit_card_number: '',
    deposit_card_holder: '',
    deposit_sheba: '',
    deposit_note: '',
  };

  let memoryTotalFeesCollected = 0;

  let cachedBotUsername: string | null = null;
  const resolveBotUsername = async (): Promise<string> => {
    const envName = (process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || '')
      .trim()
      .replace(/^@+/, '');
    if (envName) return envName;
    if (cachedBotUsername) return cachedBotUsername;
    const token = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (token) {
      try {
        const res = await telegramBotRequest(token, 'getMe', undefined, 3000);
        if (res.ok && res.json?.result?.username) {
          cachedBotUsername = String(res.json.result.username).replace(/^@+/, '');
          return cachedBotUsername;
        }
      } catch {}
    }
    return 'mianji_ir_bot';
  };

  const memoryWalletRequests = new Map<string, any>();

  const loadWalletRequests = async () => {
    const merged = new Map<string, any>(memoryWalletRequests);
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('wallet_requests').get();
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          merged.set(d.id, {
            id: d.id,
            ...data,
            created_at: data.created_at?.toDate?.()?.toISOString?.() || data.created_at || new Date().toISOString(),
          });
        });
      } catch (err: any) {
        console.warn('[WALLET] Firestore read failed:', err?.message || err);
      }
    }
    return Array.from(merged.values()).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  };

  const loadWalletRequestsForUser = async (uid: string) => {
    const targetId = String(uid);
    const merged = new Map<string, any>();
    for (const [id, r] of memoryWalletRequests.entries()) {
      if (String(r?.user_id || '') === targetId) merged.set(id, r);
    }
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('wallet_requests').where('user_id', '==', targetId).get();
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          merged.set(d.id, {
            id: d.id,
            ...data,
            created_at: data.created_at?.toDate?.()?.toISOString?.() || data.created_at || new Date().toISOString(),
          });
        });
      } catch (err: any) {
        console.warn('[WALLET] User requests read failed:', err?.message || err);
      }
    }
    return Array.from(merged.values()).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  };

  const getPendingWithdrawTotal = async (uid: string): Promise<number> => {
    const targetId = String(uid);
    const userReqs = await loadWalletRequestsForUser(targetId);
    return userReqs
      .filter((r) => r.type === 'withdraw' && r.status === 'pending')
      .reduce((sum, r) => sum + Math.max(0, Number(r.amount || 0)), 0);
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
            platform_fee_percent: (() => {
              const parsed = Number(d.platform_fee_percent);
              return Number.isFinite(parsed) ? Math.max(0, Math.min(15, parsed)) : globalLimits.platform_fee_percent;
            })(),
            deposit_card_number: typeof d.deposit_card_number === 'string' ? d.deposit_card_number : (globalLimits.deposit_card_number || ''),
            deposit_card_holder: typeof d.deposit_card_holder === 'string' ? d.deposit_card_holder : (globalLimits.deposit_card_holder || ''),
            deposit_sheba: typeof d.deposit_sheba === 'string' ? d.deposit_sheba : (globalLimits.deposit_sheba || ''),
            deposit_note: typeof d.deposit_note === 'string' ? d.deposit_note : (globalLimits.deposit_note || ''),
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

    // 1. In-memory users ONLY when no persistent DB (Supabase/Firestore) is active
    if (!hasDbReady()) {
      for (const [id, u] of memoryUsers.entries()) {
        if (String(id) === 'u_admin_owner') continue;
        merged.set(String(id), { ...u, id: String(id) });
      }
    }

    // 2. Database users (Supabase PostgreSQL or Firestore)
    if (hasDbReady()) {
      try {
        let usersSnapshot: any = null;
        const primaryUsers = getUsersCol();
        if (primaryUsers) {
          try {
            usersSnapshot = await primaryUsers.get();
          } catch (primaryErr: any) {
            if (!supabaseState.ready && !hasExplicitAdminCredentials && isPermissionOrAuthError(primaryErr)) {
              hasAdminCredentials = false;
              lastFirestoreError = String(primaryErr?.message || primaryErr);
            } else {
              console.warn('[USERS] Primary DB read failed:', primaryErr?.message || primaryErr);
              const fallbackUsers = getUsersCol(true);
              if (fallbackUsers) {
                try {
                  usersSnapshot = await fallbackUsers.get();
                } catch {}
              }
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
      } catch (err: any) {
        console.warn('[USERS] DB merge failed:', err?.message || err);
      }
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

  const applyEnvRoleOverride = (u: any) => {
    if (!u) return u;
    const ownerId = (process.env.OWNER_ID || '').trim();
    const adminId = (process.env.ADMIN_ID || '').trim();
    const uid = String(u.id);
    let role = u.role || 'user';
    if (ownerId && (uid === ownerId || String(u.telegram_id || '') === ownerId)) role = 'owner';
    else if (adminId && (uid === adminId || String(u.telegram_id || '') === adminId) && role !== 'owner') role = 'admin';
    return { ...u, role, is_blocked: Boolean(u.is_blocked) };
  };

  const getUserById = async (targetId: string) => {
    const clean = String(targetId || '').trim();
    if (!clean || clean === 'u_admin_owner') return null;
    const stripped = clean.replace(/^u_/, '');

    // Fast path 1: O(1) indexed Supabase lookup
    if (supabaseState.ready && supabaseState.client) {
      try {
        const usersCol = getUsersCol();
        const candidateTokens = Array.from(new Set([clean, stripped, stripped ? `u_${stripped}` : ''].filter((t) => /^[a-zA-Z0-9_+-]+$/.test(t))));
        if (candidateTokens.length > 0) {
          const orExpr = candidateTokens.flatMap((t) => [`id.eq.${t}`, `telegram_id.eq.${t}`]).join(',');
          const { data: rows, error } = await Promise.race([
            supabaseState.client.from('users').select('*').or(orExpr).limit(4),
            new Promise<{ data: null; error: any }>((resolve) => setTimeout(() => resolve({ data: null, error: null }), 3000)),
          ]);
          if (!error && Array.isArray(rows) && rows.length > 0) {
            const target = resolveTableTarget('users');
            const mapped = rows
              .map((r: any) => rowToDocData(target, r))
              .filter(Boolean)
              .map((u: any) => applyEnvRoleOverride({ ...u, _col: usersCol }));
            const exact =
              mapped.find((u) => getUserIdentityTokens(u).includes(clean)) ||
              mapped.find((u) => stripped && getUserIdentityTokens(u).includes(stripped)) ||
              mapped[0];
            if (exact) return exact;
          }
        }
      } catch {}
    }

    // Fast path 2: Direct doc lookup in Firestore / local adapter
    if (hasDbReady()) {
      const usersCol = getUsersCol();
      if (usersCol) {
        const candidateIds = Array.from(new Set([clean, stripped, stripped ? `u_${stripped}` : ''].filter(Boolean)));
        for (const docId of candidateIds) {
          try {
            const snap = await usersCol.doc(docId).get().catch(() => null);
            if (snap?.exists) {
              const d = snap.data() || {};
              return applyEnvRoleOverride({
                ...d,
                id: String(snap.id),
                updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt,
                _col: usersCol,
              });
            }
          } catch {}
        }
      }
    } else {
      const mem = memoryUsers.get(clean) || (stripped ? memoryUsers.get(stripped) || memoryUsers.get(`u_${stripped}`) : undefined);
      if (mem && String(mem.id) !== 'u_admin_owner') {
        return applyEnvRoleOverride({ ...mem, id: String(mem.id) });
      }
    }

    // Fallback scan only if direct identity lookup didn't hit
    const all = await getAllUsersMerged();
    return (
      all.find((u) => getUserIdentityTokens(u).includes(clean)) ||
      all.find((u) => stripped && getUserIdentityTokens(u).includes(stripped)) ||
      null
    );
  };

  const authenticateActor = async (req: express.Request): Promise<{ actor: any; sessionJti?: string } | { error: string; status: number; revoked?: boolean }> => {
    const ownerId = (process.env.OWNER_ID || '').trim();
    const adminId = (process.env.ADMIN_ID || '').trim();

    // 1. Check HMAC session token header or HttpOnly session cookie
    const sessionHeader = req.headers['x-session-token'];
    const sessionToken =
      typeof sessionHeader === 'string' && sessionHeader.trim()
        ? sessionHeader.trim()
        : extractSessionCookie(req);
    const sessionClaims = verifySessionToken(sessionToken);

    if (sessionClaims) {
      if (sessionClaims.uid === 'u_admin_owner') {
        return {
          status: 401,
          revoked: true,
          error: 'حساب پیش‌فرض آزمایشی غیرفعال شده است. لطفاً با حساب واقعی خود وارد شوید.',
        };
      }
      const liveUser = await getUserById(sessionClaims.uid);
      if (hasDbReady() && !liveUser) {
        return {
          status: 401,
          revoked: true,
          error: 'اطلاعات کاربری این نشست در دیتابیس یافت نشد. لطفاً دوباره وارد شوید.',
        };
      }
      if (await isSessionRevoked(sessionClaims.uid, sessionClaims, liveUser)) {
        return {
          status: 401,
          revoked: true,
          error: 'این نشست از دستگاه دیگری لغو شده است. لطفاً دوباره وارد شوید.',
        };
      }
      if (sessionClaims.jti) {
        const curSess = memorySessions.get(sessionClaims.jti);
        const now = Date.now();
        if (curSess && now - curSess.last_seen_at > 60000) {
          curSess.last_seen_at = now;
          const fsDb = getDb();
          if (fsDb) {
            fsDb.collection('user_sessions').doc(sessionClaims.jti).set({ last_seen_at: now }, { merge: true }).catch(() => {});
          }
        }
      }
      const role = liveUser?.role || sessionClaims.role || 'user';
      if (liveUser?.is_blocked) {
        return { status: 403, error: 'حساب کاربری شما مسدود شده است.' };
      }
      return { actor: liveUser || { id: sessionClaims.uid, role }, sessionJti: sessionClaims.jti };
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

    // 3. Preview fallback ONLY when not in production and no persistent DB is active
    if (!isProd && !hasDbReady()) {
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

  const tryAuthenticate = async (req: express.Request): Promise<any | null> => {
    const res = await authenticateActor(req);
    return 'actor' in res ? res.actor : null;
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

  const findUserByPhone = async (targetCleanPhone: string, targetCoreDigits?: string) => {
    const parsedInput = parseIranMobile(targetCleanPhone || targetCoreDigits || '');
    const core10 = parsedInput.valid
      ? parsedInput.core10
      : /^\d{10}$/.test(String(targetCoreDigits || ''))
      ? String(targetCoreDigits)
      : getPhoneCore10(targetCleanPhone);
    if (!/^\d{10}$/.test(core10)) {
      return null;
    }

    const scoreUserRow = (u: any) =>
      (u?.telegram_id ? 1000 : 0) +
      (String(u?.kyc_status || '').toLowerCase() === 'verified' ? 100 : 0) +
      (Number(u?.wallet_balance || 0) + Number(u?.escrow_locked_balance || 0) > 0 ? 50 : 0) +
      (u?.phone_core_digits ? 10 : 0);

    // 1. Direct indexed Supabase lookup first (covers 9xx, 09xx, 989xx, +989xx, 00989xx, u_<core10>)
    if (supabaseState.ready && supabaseState.client) {
      try {
        const usersCol = getUsersCol();
        const userTarget = resolveTableTarget('users');
        const mapPickedUser = (rows: any[]) => {
          const sorted = [...rows].sort((a, b) => scoreUserRow(b) - scoreUserRow(a));
          const mapped = rowToDocData(userTarget, sorted[0]);
          if (!mapped) return null;
          return applyEnvRoleOverride({ ...mapped, id: String(sorted[0].id), _col: usersCol });
        };

        const exactOrClauses = [
          `phone_core_digits.eq.${core10}`,
          `phone_number.eq.0${core10}`,
          `phone_number.eq.${core10}`,
          `phone_number.eq.98${core10}`,
          `phone_number.eq.+98${core10}`,
          `phone_number.eq.0098${core10}`,
          `id.eq.u_${core10}`,
        ].join(',');
        const { data: exactRows, error: exactErr } = await Promise.race([
          supabaseState.client.from('users').select('*').or(exactOrClauses).limit(6),
          new Promise<{ data: null; error: any }>((resolve) =>
            setTimeout(() => resolve({ data: null, error: { message: 'Supabase phone lookup timeout' } }), 3500)
          ),
        ]);
        if (exactErr) {
          pushRuntimeLog('warn', 'supabase', 'هشدار جستجوی شماره در Supabase', exactErr.message);
        } else if (Array.isArray(exactRows) && exactRows.length > 0) {
          const user = mapPickedUser(exactRows);
          if (user) {
            console.log(`[SUPABASE] User found by phone index: ${user.id}`);
            return user;
          }
        }

        // Secondary bounded pattern lookup for formatted phone numbers (spaces/dashes)
        const { data: patternRows } = await Promise.race([
          supabaseState.client.from('users').select('*').ilike('phone_number', `%${core10}%`).limit(5),
          new Promise<{ data: null }>((resolve) => setTimeout(() => resolve({ data: null }), 2500)),
        ]);
        if (Array.isArray(patternRows) && patternRows.length > 0) {
          const user = mapPickedUser(patternRows);
          if (user) {
            console.log(`[SUPABASE] User found by phone pattern: ${user.id}`);
            return user;
          }
        }
        return null;
      } catch (err: any) {
        pushRuntimeLog('error', 'supabase', 'خطای جستجوی شماره در Supabase', err?.message || String(err));
      }
    }

    // 2. Firestore DB scan fallback (only when Supabase is not the active primary DB)
    if (hasDbReady() && !supabaseState.ready) {
      try {
        let usersSnapshot: any = null;
        const primaryUsers = getUsersCol();
        if (primaryUsers) {
          try {
            const byCore = await primaryUsers.where('phone_core_digits', '==', core10).limit(5).get().catch(() => null);
            if (byCore && !byCore.empty) {
              usersSnapshot = byCore;
            } else {
              usersSnapshot = await primaryUsers.get();
            }
          } catch (primaryErr: any) {
            pushRuntimeLog('warn', 'supabase', 'خطا در خواندن جدول users', primaryErr?.message || String(primaryErr));
            if (!supabaseState.ready && !hasExplicitAdminCredentials && isPermissionOrAuthError(primaryErr)) {
              hasAdminCredentials = false;
            } else {
              const fallbackUsers = getUsersCol(true);
              if (fallbackUsers) {
                try {
                  usersSnapshot = await fallbackUsers.get();
                } catch (e: any) {
                  console.warn('[DB] Admin read unavailable:', e?.message || e);
                }
              }
            }
          }
        }
        if (usersSnapshot && usersSnapshot.docs) {
          const matches = usersSnapshot.docs.filter((doc: any) => {
            const d = doc.data() || {};
            const rowCore = getPhoneCore10(d.phone_number || d.phone || d.phoneNumber || d.mobile || d.phone_core_digits);
            return rowCore === core10 || String(doc.id) === `u_${core10}`;
          });
          if (matches.length > 0) {
            matches.sort((a: any, b: any) => scoreUserRow(b.data()) - scoreUserRow(a.data()));
            const match = matches[0];
            console.log(`[DB] User found: ${match.id} for phone 0${core10}`);
            return applyEnvRoleOverride({ id: match.id, ...match.data(), _col: primaryUsers });
          }
        }
      } catch (err: any) {
        pushRuntimeLog('error', 'supabase', 'خطای غیرمنتظره در جستجوی شماره', err?.message || String(err));
      }
    }

    // 3. Check In-Memory users ONLY when persistent DB is not active
    if (!hasDbReady()) {
      const memMatch = Array.from(memoryUsers.values()).find(
        (u: any) =>
          String(u.id) !== 'u_admin_owner' &&
          getPhoneCore10(u.phone_number || u.phone || u.phone_core_digits) === core10
      );
      if (memMatch) {
        console.log(`[MEMORY] User found: ${memMatch.id} for phone 0${core10}`);
        return applyEnvRoleOverride(memMatch);
      }
    }

    return null;
  };

  const findUserByTelegramId = async (rawTgId: string) => {
    const cleanTgId = String(rawTgId || '').trim();
    if (!cleanTgId) return null;

    if (supabaseState.ready && supabaseState.client) {
      try {
        const usersCol = getUsersCol();
        const isNumeric = /^-?\d+$/.test(cleanTgId);
        const orClauses = [
          `telegram_id.eq.${cleanTgId}`,
          `id.eq.${cleanTgId}`,
          `id.eq.u_${cleanTgId}`,
          ...(isNumeric ? [`chat_id.eq.${cleanTgId}`] : []),
        ].join(',');
        const { data: rows, error } = await Promise.race([
          supabaseState.client.from('users').select('*').or(orClauses).limit(3),
          new Promise<{ data: null; error: any }>((resolve) =>
            setTimeout(() => resolve({ data: null, error: { message: 'Supabase tg lookup timeout' } }), 3500)
          ),
        ]);
        if (error) {
          pushRuntimeLog('warn', 'supabase', 'هشدار جستجوی telegram_id در Supabase', error.message);
        } else if (Array.isArray(rows) && rows.length > 0) {
          const picked = rows.find((r: any) => String(r.telegram_id || '') === cleanTgId) || rows[0];
          const mapped = rowToDocData(resolveTableTarget('users'), picked);
          if (mapped) {
            return applyEnvRoleOverride({ ...mapped, id: String(picked.id), _col: usersCol });
          }
        }
        return null;
      } catch (err: any) {
        pushRuntimeLog('error', 'supabase', 'خطای جستجوی telegram_id در Supabase', err?.message || String(err));
      }
    }

    if (hasDbReady()) {
      const candidateCols = [getUsersCol(), !supabaseState.ready && dbId ? getUsersCol(true) : null].filter(Boolean);
      for (const usersCol of candidateCols as any[]) {
        try {
          for (const docId of [cleanTgId, `u_${cleanTgId}`]) {
            const snap = await usersCol.doc(docId).get().catch(() => null);
            if (snap?.exists) {
              return { id: snap.id, ...snap.data(), _col: usersCol };
            }
          }
          const numTgId = /^-?\d+$/.test(cleanTgId) ? Number(cleanTgId) : null;
          const byStr = await usersCol.where('telegram_id', '==', cleanTgId).limit(1).get().catch(() => null);
          if (byStr && !byStr.empty) {
            const m = byStr.docs[0];
            return { id: m.id, ...m.data(), _col: usersCol };
          }
          if (numTgId !== null) {
            const byNum = await usersCol.where('telegram_id', '==', numTgId).limit(1).get().catch(() => null);
            if (byNum && !byNum.empty) {
              const m = byNum.docs[0];
              return { id: m.id, ...m.data(), _col: usersCol };
            }
          }
          const allSnap = await usersCol.get().catch(() => null);
          if (allSnap?.docs) {
            const found = allSnap.docs.find((doc: any) => {
              const d = doc.data() || {};
              return [d.telegram_id, d.telegramId, d.tg_id, d.chat_id, d.chatId, doc.id].some(
                (v) => v !== undefined && v !== null && (String(v).trim() === cleanTgId || String(v).trim() === `u_${cleanTgId}`)
              );
            });
            if (found) {
              return { id: found.id, ...found.data(), _col: usersCol };
            }
          }
        } catch (err: any) {
          pushRuntimeLog('warn', 'supabase', 'خطا در جستجوی کاربر تلگرام', err?.message || String(err));
          if (!supabaseState.ready && !hasExplicitAdminCredentials && isPermissionOrAuthError(err)) {
            hasAdminCredentials = false;
            break;
          }
        }
      }
    }

    if (!hasDbReady()) {
      const memDirect = memoryUsers.get(cleanTgId) || memoryUsers.get(`u_${cleanTgId}`);
      if (memDirect && String(memDirect.id) !== 'u_admin_owner') return memDirect;
      const memMatch = Array.from(memoryUsers.values()).find(
        (u: any) =>
          String(u.id) !== 'u_admin_owner' &&
          [u.telegram_id, u.telegramId, u.tg_id, u.chat_id, u.id].some(
            (v) => v !== undefined && v !== null && String(v).trim() === cleanTgId
          )
      );
      return memMatch || null;
    }

    return null;
  };

  // Health Checks (Dev & Production)
  app.get('/healthz', (_req, res) => res.status(200).send('OK'));
  app.get('/api/health', (_req, res) => {
    const persistence = getPersistenceStatus();
    res.json({
      ok: true,
      env: isProd ? 'production' : 'development',
      telegramConfigured: Boolean(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN),
      supabaseReady: supabaseState.ready,
      supabaseConfigured: supabaseState.configured,
      supabaseHost: supabaseState.urlHost,
      firebaseAdminReady: hasAdminCredentials,
      firebaseProjectId: adminApp?.options.projectId || configuredProjectId,
      firebaseDatabaseConfigured: Boolean(dbId),
      persistence,
    });
  });

  // Auth: Send OTP
  app.post('/api/auth/send-otp', async (req, res) => {
    try {
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ success: false, error: 'لطفاً شماره همراه را وارد کنید' });

      const parsedPhone = parseIranMobile(phone);
      if (!parsedPhone.valid) {
        return res.status(400).json({
          success: false,
          error: 'شماره همراه وارد شده معتبر نیست (نمونه مجاز: 09123456789 یا 9123456789 یا +989123456789)',
        });
      }
      const coreDigits = parsedPhone.core10;
      const canonicalPhone = parsedPhone.local;

      if (!checkBucketLimit(otpSendRateMap, `${req.ip || 'ip'}:${coreDigits}`, 5, 15 * 60 * 1000)) {
        return res.status(429).json({
          success: false,
          error: 'درخواست کد تایید برای این شماره بیش از حد مجاز بوده است. لطفاً ۱۵ دقیقه بعد تلاش کنید.',
        });
      }

      // Prune expired OTPs periodically
      const now = Date.now();
      if (otps.size > 500) {
        for (const [k, v] of otps.entries()) {
          if (now > v.expires) otps.delete(k);
        }
      }

      const foundUser = await findUserByPhone(canonicalPhone, coreDigits);
      const configuredBotToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();

      // STRICT VALIDATION in production / when bot is configured: User must exist before OTP is issued
      if (!foundUser) {
        pushRuntimeLog('warn', 'auth', `درخواست OTP برای شماره ثبت‌نشده (${coreDigits})`, `حالت دیتابیس: ${getPersistenceStatus().mode}`);
        if (!isProd && !configuredBotToken) {
          return res.json({
            success: false,
            needRegistration: true,
            previewMode: true,
            normalizedPhone: canonicalPhone,
            error: '',
          });
        }
        return res.json({
          success: false,
          needRegistration: true,
          normalizedPhone: canonicalPhone,
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
          userObj?.role === 'owner' ? process.env.OWNER_ID : null,
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
      const code = crypto.randomInt(100000, 1000000).toString();
      const expires = Date.now() + 15 * 60000; // 15 minutes
      const purpose = String(req.body?.purpose || 'login').slice(0, 48);

      void recordSecurityAuditLog({
        userId: String(foundUser.id),
        phoneNumber: canonicalPhone,
        event: 'otp_sent',
        category: 'auth',
        status: 'success',
        details: `OTP (${purpose}) صادر شد`,
      });

      console.log(`[AUTH] Generated OTP for ${coreDigits} (targetTelegramId=${targetTelegramId || 'none'})`);

      const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
      let telegramDelivered = false;
      let deliveryFailureReason = '';
      let needBotStart = false;

      const sendTelegramOtpPromise = (async () => {
        if (!botToken) {
          deliveryFailureReason = 'توکن ربات تلگرام (BOT_TOKEN) روی سرور تنظیم نشده است.';
          console.warn('[AUTH] BOT_TOKEN is not configured; cannot send Telegram OTP');
          return;
        }
        if (!targetTelegramId) {
          deliveryFailureReason =
            'شناسه تلگرام برای این شماره ثبت نشده است. لطفاً ابتدا وارد ربات تلگرام شوید، دکمه Start را بزنید و شماره خود را تایید کنید.';
          needBotStart = true;
          console.warn(`[AUTH] No numeric Telegram ID resolved for user ${foundUser.id}`);
          return;
        }
        const tgRes = await telegramBotRequest(
          botToken,
          'sendMessage',
          {
            chat_id: targetTelegramId,
            text:
              `🔐 *کد تایید میانجی*\n\n` +
              `کد ورود شما: \`${code}\`\n\n` +
              `⚠️ این کد تا ۱۵ دقیقه دیگر معتبر است. لطفا آن را در اختیار دیگران قرار ندهید.`,
            parse_mode: 'Markdown',
          },
          4500
        );
        if (tgRes.ok) {
          telegramDelivered = true;
          console.log(`[AUTH] Sent Telegram OTP to chat ${targetTelegramId}`);
        } else if (tgRes.error) {
          console.error('[AUTH] Failed to send Telegram OTP via Bot API:', tgRes.error);
          deliveryFailureReason = 'ارتباط سرور با تلگرام برقرار نشد. لطفاً چند لحظه بعد دوباره تلاش کنید.';
        } else {
          const errCode = tgRes.json?.error_code || tgRes.status;
          const desc = String(tgRes.json?.description || 'Unknown Telegram error');
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
      })();

      // Save OTP in memory/DB and send via Telegram concurrently so transition to OTP screen is immediate
      const [otpChallenge] = await Promise.all([
        saveOtpRecord(coreDigits, code, expires, {
          purpose,
          telegramId: targetTelegramId,
          phone: canonicalPhone,
        }),
        sendTelegramOtpPromise,
      ]);

      // In production, never pretend OTP was sent to Telegram if delivery failed
      if (isProd && !telegramDelivered) {
        pushRuntimeLog('error', 'telegram', `عدم ارسال کد OTP برای شماره ${coreDigits}`, deliveryFailureReason);
        void clearOtpRecord(coreDigits);
        return res.status(502).json({
          success: false,
          telegramDelivered: false,
          needRegistration: needBotStart,
          error: deliveryFailureReason || 'ارسال کد به تلگرام انجام نشد. لطفاً ابتدا ربات را استارت کنید.',
        });
      }
      if (telegramDelivered) {
        pushRuntimeLog('success', 'telegram', `کد OTP برای ${coreDigits} ارسال شد`, `chat_id=${targetTelegramId}`);
      }

      // Never expose OTP in production or when Telegram delivered it
      const responsePayload: any = {
        success: true,
        message: 'OTP sent',
        phone: canonicalPhone,
        telegramDelivered,
        otpChallenge,
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
      const { phone, code, otpChallenge } = req.body || {};
      if (!phone || !code) {
        return res.status(400).json({ success: false, error: 'شماره همراه و کد تایید الزامی است' });
      }

      const parsedPhone = parseIranMobile(phone);
      if (!parsedPhone.valid) {
        return res.status(400).json({ success: false, error: 'شماره همراه نامعتبر است' });
      }
      const coreDigits = parsedPhone.core10;
      const canonicalPhone = parsedPhone.local;

      if (!checkBucketLimit(otpVerifyRateMap, `${req.ip || 'ip'}:${coreDigits}`, 12, 15 * 60 * 1000)) {
        return res.status(429).json({
          success: false,
          error: 'تعداد تلاش‌های ورود بیش از حد مجاز بوده است. لطفاً ۱۵ دقیقه بعد تلاش کنید.',
        });
      }
      const cleanCode = extractCleanPhone(code);
      if (cleanCode.length < 4 || cleanCode.length > 8) {
        return res.status(400).json({ success: false, error: 'کد تایید نامعتبر است' });
      }

      const expectedHmac = hashOtpCode(coreDigits, cleanCode);
      const expectedPlainSha = crypto.createHash('sha256').update(cleanCode).digest('hex');
      const expectedScopedSha = crypto.createHash('sha256').update(`${coreDigits}:${cleanCode}`).digest('hex');

      let verified = false;
      let usedChallengeJti: string | null = null;
      let matchedFsRecord: LoadedOtpRecord | null = null;

      // Track whether any active or expired factor exists for accurate error & brute-force lockout
      let hadExpiredOnly = false;

      // 1) In-memory OTP record
      const memRecord = otps.get(coreDigits);
      if (memRecord) {
        if (Date.now() > memRecord.expires) {
          otps.delete(coreDigits);
          hadExpiredOnly = true;
        } else if (memRecord.code === cleanCode) {
          verified = true;
        }
      }

      // 2) Signed HMAC challenge token (stateless backup if memRecord missing/restarted or DB lagged)
      const parsedChallenge = verifyOtpChallengeToken(otpChallenge);
      const challengeActive = Boolean(
        parsedChallenge &&
          parsedChallenge.p === coreDigits &&
          !usedOtpChallenges.has(parsedChallenge.jti) &&
          Date.now() <= parsedChallenge.exp
      );
      if (parsedChallenge && parsedChallenge.p === coreDigits && Date.now() > parsedChallenge.exp) {
        hadExpiredOnly = true;
      }
      if (!verified && challengeActive && parsedChallenge) {
        if (safeEqualHex(parsedChallenge.h, expectedHmac)) {
          verified = true;
          usedChallengeJti = parsedChallenge.jti;
        }
      }

      // 3) Database OTP records (handles multi-worker, cold starts, or bot-created OTPs in Supabase)
      let fsRecords: LoadedOtpRecord[] = [];
      if (!verified) {
        fsRecords = await loadOtpRecords(coreDigits);
        for (const rec of fsRecords) {
          if (rec.expires > 0 && Date.now() > rec.expires) {
            hadExpiredOnly = true;
            await rec.sourceDb.collection('otp_codes').doc(rec.docId).delete().catch(() => {});
            continue;
          }
          const recHashLower = rec.code_hash ? rec.code_hash.toLowerCase() : '';
          const hashMatches = Boolean(
            recHashLower &&
              (safeEqualHex(recHashLower, expectedHmac) ||
                safeEqualHex(recHashLower, expectedPlainSha) ||
                safeEqualHex(recHashLower, expectedScopedSha))
          );
          const plainMatches = Boolean(rec.code && rec.code === cleanCode);
          if (hashMatches || plainMatches) {
            verified = true;
            matchedFsRecord = rec;
            break;
          }
        }
      }

      if (!verified) {
        const activeMem = otps.get(coreDigits);
        const activeFs = fsRecords.filter((r) => !(r.expires > 0 && Date.now() > r.expires));

        if (activeMem || challengeActive || activeFs.length > 0) {
          let maxAttemptsReached = false;
          if (activeMem) {
            activeMem.attempts += 1;
            if (activeMem.attempts >= 5) maxAttemptsReached = true;
          }
          if (challengeActive && parsedChallenge) {
            const nextChallengeAttempts = (otpChallengeAttempts.get(parsedChallenge.jti) || 0) + 1;
            otpChallengeAttempts.set(parsedChallenge.jti, nextChallengeAttempts);
            if (nextChallengeAttempts >= 5) {
              usedOtpChallenges.add(parsedChallenge.jti);
              maxAttemptsReached = true;
            }
          }
          for (const rec of activeFs) {
            const nextAttempts = rec.attempts + 1;
            if (nextAttempts >= 5) {
              maxAttemptsReached = true;
              await rec.sourceDb.collection('otp_codes').doc(rec.docId).delete().catch(() => {});
            } else {
              await rec.sourceDb.collection('otp_codes').doc(rec.docId).set({ attempts: nextAttempts }, { merge: true }).catch(() => {});
            }
          }
          if (maxAttemptsReached) {
            await clearOtpRecord(coreDigits);
            if (parsedChallenge) usedOtpChallenges.add(parsedChallenge.jti);
            return res.status(400).json({
              success: false,
              error: 'تعداد تلاش‌های ناموفق بیش از حد مجاز بود. لطفاً کد جدید دریافت کنید.',
            });
          }
          return res.status(400).json({ success: false, error: 'کد تایید اشتباه است' });
        }

        if (hadExpiredOnly) {
          return res.status(400).json({ success: false, error: 'کد تایید منقضی شده است' });
        }
        return res.status(400).json({ success: false, error: 'کد تایید منقضی شده یا درخواستی ثبت نشده است' });
      }

      let user = await findUserByPhone(canonicalPhone, coreDigits);
      if (!user && matchedFsRecord?.telegram_id) {
        user = await findUserByTelegramId(matchedFsRecord.telegram_id);
      }
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

      // Normalize stored phone_number to canonical 09xxxxxxxxx on login if needed
      if (user._col && (!user.phone_core_digits || user.phone_number !== canonicalPhone)) {
        await user._col
          .doc(String(user.id))
          .set({ phone_number: canonicalPhone, phone_core_digits: coreDigits, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
        user.phone_number = canonicalPhone;
        user.phone_core_digits = coreDigits;
      }

      // Successful verification: invalidate OTP across all layers to prevent replay
      await clearOtpRecord(coreDigits);
      if (matchedFsRecord) {
        await matchedFsRecord.sourceDb.collection('otp_codes').doc(matchedFsRecord.docId).delete().catch(() => {});
      }
      const jtiToRevoke = usedChallengeJti || parsedChallenge?.jti;
      if (jtiToRevoke) {
        usedOtpChallenges.add(jtiToRevoke);
        otpChallengeAttempts.delete(jtiToRevoke);
        if (usedOtpChallenges.size > 2000) usedOtpChallenges.clear();
      }

      // Never mint Firebase customToken when Supabase is the active persistence layer
      let customToken: string | null = null;
      if (!supabaseState.ready && hasAdminCredentials && adminApp) {
        try {
          customToken = await getAuth(adminApp).createCustomToken(user.id.toString());
        } catch {
          console.warn('[AUTH] createCustomToken unavailable in current environment; returning session fallback');
        }
      }

      const { _col: _dropCol, financial_pin_hash: _dropPinHash, ...safeUser } = user;
      const sessionToken = await issueTrackedSession(req, res, safeUser);
      void recordSecurityAuditLog({
        userId: String(safeUser.id),
        phoneNumber: safeUser.phone_number || canonicalPhone,
        event: 'otp_login_success',
        category: 'auth',
        status: 'success',
        details: `ورود موفق با OTP از IP ${String(req.ip || 'unknown')}`,
      });
      res.json({ success: true, user: safeUser, customToken, sessionToken });
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
      const parsedPhone = parseIranMobile(String(phone || ''));
      if (!parsedPhone.valid) {
        return res.status(400).json({
          success: false,
          error: 'شماره همراه وارد شده معتبر نیست (نمونه مجاز: 09123456789 یا 9123456789 یا +989123456789).',
        });
      }
      const cleanName = String(full_name || '').trim().slice(0, 80);
      if (cleanName.length < 2) {
        return res.status(400).json({ success: false, error: 'لطفاً نام و نام خانوادگی (حداقل ۲ کاراکتر) را وارد کنید.' });
      }

      const coreDigits = parsedPhone.core10;
      const canonicalPhone = parsedPhone.local;
      let existingUser = await findUserByPhone(canonicalPhone, coreDigits);
      if (!existingUser) {
        const uid = `u_${coreDigits}`;
        const nowIso = new Date().toISOString();
        const newUser: any = {
          id: uid,
          full_name: cleanName,
          phone_number: canonicalPhone,
          phone_core_digits: coreDigits,
          username: `user_${coreDigits.slice(-4)}`,
          role: 'user',
          kyc_status: 'verified',
          is_verified: true,
          wallet_balance: 0,
          escrow_locked_balance: 0,
          is_blocked: false,
          created_at: nowIso,
          createdAt: nowIso,
        };
        await strictFirestoreWrite(`users/${uid}#register-preview`, (db) =>
          db.collection('users').doc(uid).set(
            {
              ...newUser,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        );
        memoryUsers.set(uid, newUser);
        existingUser = newUser;
      }

      const code = crypto.randomInt(100000, 1000000).toString();
      const expires = Date.now() + 15 * 60000;
      const otpChallenge = await saveOtpRecord(coreDigits, code, expires, { phone: canonicalPhone });

      res.json({
        success: true,
        phone: canonicalPhone,
        previewOtp: code,
        otpChallenge,
        telegramDelivered: false,
        user: existingUser,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت‌نام پیش‌نمایش' });
    }
  });

  const handleTelegramWebAppAuth = async (req: express.Request, res: express.Response) => {
    if (!checkBucketLimit(authTelegramRateMap, `twa:${req.ip || 'ip'}`, 25, 15 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'تعداد درخواست‌های ورود بیش از حد مجاز است.' });
    }
    const { initData } = req.body || {};
    if (!initData || typeof initData !== 'string') {
      return res.status(400).json({ success: false, error: 'initData is required' });
    }

    const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!botToken) {
      return res.status(503).json({
        success: false,
        error: 'احراز هویت مینی‌اپ تلگرام روی سرور پیکربندی نشده است (BOT_TOKEN).',
      });
    }

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
      if (hash) {
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        isValid = timingSafeEqualStr(calculatedHash, hash);
      }

      if (!hash || !isValid) {
        return res.status(401).json({ success: false, error: 'امضای تلگرام نامعتبر است' });
      }

      const authDateSec = Number(urlParams.get('auth_date') || 0);
      if (!authDateSec || Math.abs(Math.floor(Date.now() / 1000) - authDateSec) > 86400) {
        return res.status(401).json({ success: false, error: 'نشست تلگرام منقضی شده است. لطفاً ربات را دوباره باز کنید.' });
      }

      const userStr = urlParams.get('user');
      if (!userStr) {
        return res.status(400).json({ success: false, error: 'اطلاعات کاربر در initData یافت نشد' });
      }

      const tgUser = JSON.parse(userStr);
      const userId = tgUser.id.toString();
      const fullName = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() || 'کاربر تلگرام';
      const username = tgUser.username || '';

      const ownerId = (process.env.OWNER_ID || '').trim();
      const adminId = (process.env.ADMIN_ID || '').trim();
      const resolvedRole = ownerId && userId === ownerId ? 'owner' : adminId && userId === adminId ? 'admin' : 'user';

      let matched = await findUserByTelegramId(userId);
      let resolvedUid = matched?.id ? String(matched.id) : userId;
      let userData: any = null;

      if (matched) {
        const { _col, ...cleanMatched } = matched;
        userData = {
          ...cleanMatched,
          id: resolvedUid,
          telegram_id: cleanMatched.telegram_id || userId,
          chat_id: cleanMatched.chat_id || (/^-?\d+$/.test(userId) ? Number(userId) : undefined),
          ...(username && !cleanMatched.username ? { username } : {}),
          ...(resolvedRole !== 'user' ? { role: resolvedRole } : {}),
        };
        if (_col && (!cleanMatched.telegram_id || !cleanMatched.chat_id)) {
          await strictFirestoreWrite(`users/${resolvedUid}#twa-link`, () =>
            _col.doc(resolvedUid).set(
              {
                telegram_id: userId,
                ...(/^-?\d+$/.test(userId) ? { chat_id: Number(userId) } : {}),
                ...(username && !cleanMatched.username ? { username } : {}),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true }
            )
          );
        }
      } else {
        const newDocData = {
          id: userId,
          telegram_id: userId,
          ...(/^-?\d+$/.test(userId) ? { chat_id: Number(userId) } : {}),
          full_name: fullName,
          username,
          phone_number: '',
          kyc_status: 'pending',
          wallet_balance: 0,
          escrow_locked_balance: 0,
          role: resolvedRole,
        };
        try {
          await strictFirestoreWrite(`users/${userId}#twa-create`, (db) =>
            db.collection('users').doc(userId).set({ ...newDocData, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          );
          memoryUsers.set(userId, newDocData);
          userData = { ...newDocData, updatedAt: new Date().toISOString() };
        } catch (createErr: any) {
          const errMsg = String(createErr?.message || '');
          if (errMsg.includes('23505') || errMsg.includes('users_telegram_id_key') || errMsg.toLowerCase().includes('duplicate key')) {
            const fallbackExisting = await findUserByTelegramId(userId);
            if (fallbackExisting) {
              const { _col: exCol, ...cleanEx } = fallbackExisting;
              resolvedUid = String(cleanEx.id);
              const recoveryPatch: Record<string, any> = {
                ...(username && !cleanEx.username ? { username } : {}),
                ...(/^-?\d+$/.test(userId) && !cleanEx.chat_id ? { chat_id: Number(userId) } : {}),
                updatedAt: FieldValue.serverTimestamp(),
              };
              if (exCol) {
                await strictFirestoreWrite(`users/${resolvedUid}#twa-link-recover`, () =>
                  exCol.doc(resolvedUid).set(recoveryPatch, { merge: true })
                );
              }
              userData = { ...cleanEx, ...recoveryPatch, id: resolvedUid };
              memoryUsers.set(resolvedUid, userData);
              pushRuntimeLog('warn', 'auth', `ادغام خودکار تداخل کلید یکتا در ورود مینی‌اپ (${resolvedUid})`, errMsg);
            } else {
              throw createErr;
            }
          } else {
            throw createErr;
          }
        }
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
      if (!supabaseState.ready && hasAdminCredentials && adminApp) {
        try {
          customToken = await getAuth(adminApp).createCustomToken(resolvedUid);
        } catch {
          console.warn('[TWA] createCustomToken unavailable; returning session fallback');
        }
      }

      const sessionToken = await issueTrackedSession(req, res, userData);
      void recordSecurityAuditLog({
        userId: resolvedUid,
        phoneNumber: userData.phone_number || null,
        event: 'telegram_webapp_login',
        category: 'auth',
        status: 'success',
        details: `ورود از مینی‌اپ تلگرام (${userId})`,
      });
      pushRuntimeLog('success', 'auth', `ورود مینی‌اپ تلگرام تایید شد (${resolvedUid})`, `tg=${userId}`);
      res.json({ success: true, user: userData, customToken, sessionToken });
    } catch (err: any) {
      console.error('Telegram WebApp Auth Error:', err);
      pushRuntimeLog('error', 'auth', 'خطا در ورود مینی‌اپ تلگرام (TWA)', err?.message || String(err));
      res.status(500).json({ success: false, error: err.message || 'خطای داخلی سرور' });
    }
  };

  // Auth: Telegram WebApp InitData login
  app.post('/api/auth/telegram-webapp', handleTelegramWebAppAuth);

  // Auth: Direct one-click Magic Login link from Telegram Bot (?tg_login=...)
  const usedMagicTokens = new Set<string>();
  const handleTelegramMagicAuth = async (req: express.Request, res: express.Response) => {
    if (!checkBucketLimit(authTelegramRateMap, `magic:${req.ip || 'ip'}`, 25, 15 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'تعداد درخواست‌های ورود بیش از حد مجاز است.' });
    }
    const rawToken = String(req.body?.token || req.body?.tg_login || '').trim();
    if (!rawToken || rawToken.length < 10) {
      return res.status(400).json({ success: false, error: 'توکن ورود مستقیم نامعتبر است.' });
    }

    try {
      let telegramId = '';
      let phone = '';
      let fullName = '';
      let username = '';
      let matchedFsDoc: { db: any; id: string; rawData: Record<string, any> } | null = null;

      // 1) Check one-time token document in database (`bot_login_tokens/{token}` or `token == rawToken`)
      const fsDbs = getOtpFirestoreTargets();
      for (const targetDb of fsDbs) {
        try {
          let snap: any = await targetDb.collection('bot_login_tokens').doc(rawToken).get();
          if (!snap?.exists) {
            const byToken = await targetDb
              .collection('bot_login_tokens')
              .where('token', '==', rawToken)
              .limit(1)
              .get()
              .catch(() => null);
            if (byToken && !byToken.empty) {
              snap = byToken.docs[0];
            }
          }
          if (snap?.exists) {
            const data = snap.data() || {};
            const isAlreadyUsed =
              data.used === true ||
              String(data.used).toLowerCase() === 'true' ||
              data.data?.used === true;
            if (isAlreadyUsed) {
              return res.status(401).json({ success: false, error: 'این لینک ورود قبلاً استفاده شده است. لطفاً لینک جدید از ربات بگیرید.' });
            }
            const rawExp = data.expires_at ?? data.expiresAt ?? data.expires;
            let expMs = 0;
            if (typeof rawExp === 'number') {
              expMs = rawExp < 1e12 ? rawExp * 1000 : rawExp;
            } else if (typeof rawExp?.toMillis === 'function') {
              expMs = rawExp.toMillis();
            } else if (typeof rawExp === 'string' && rawExp.trim()) {
              const numVal = Number(rawExp);
              if (Number.isFinite(numVal) && numVal > 0) {
                expMs = numVal < 1e12 ? numVal * 1000 : numVal;
              } else {
                const parsedMs = Date.parse(rawExp);
                if (Number.isFinite(parsedMs)) expMs = parsedMs;
              }
            }
            if (!expMs || Date.now() > expMs) {
              await targetDb.collection('bot_login_tokens').doc(snap.id).delete().catch(() => {});
              return res.status(401).json({ success: false, error: 'لینک ورود منقضی شده است. لطفاً دوباره از ربات وارد شوید.' });
            }
            telegramId = String(data.telegram_id || data.tg_id || data.user_id || data.uid || '').trim();
            phone = String(data.phone_number || data.phone || '').trim();
            fullName = String(data.full_name || data.name || '').trim();
            username = String(data.username || '').trim();
            matchedFsDoc = { db: targetDb, id: snap.id, rawData: data };
            break;
          }
        } catch {}
      }

      // 2) If not a DB doc, check HMAC-signed stateless token (`<payloadBase64Url>.<hmacHex>`) signed with shared BOT_TOKEN
      if (!matchedFsDoc) {
        const parts = rawToken.split('.');
        const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
        if (parts.length !== 2 || !botToken) {
          return res.status(401).json({ success: false, error: 'لینک ورود مستقیم نامعتبر یا منقضی شده است.' });
        }
        const [payloadB64, sigHex] = parts;
        const candidateKeys: (string | Buffer)[] = [
          botToken,
          crypto.createHash('sha256').update(botToken).digest(),
          crypto.createHmac('sha256', 'WebAppData').update(botToken).digest(),
          otpSecret,
        ];
        const validSig = candidateKeys.some((key) => {
          const expected = crypto.createHmac('sha256', key).update(payloadB64).digest('hex');
          return safeEqualHex(expected, sigHex.toLowerCase());
        });
        if (!validSig) {
          return res.status(401).json({ success: false, error: 'امضای لینک ورود تلگرام معتبر نیست.' });
        }
        if (usedMagicTokens.has(rawToken)) {
          return res.status(401).json({ success: false, error: 'این لینک ورود قبلاً استفاده شده است.' });
        }
        let parsed: any = null;
        try {
          parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        } catch {
          return res.status(400).json({ success: false, error: 'ساختار لینک ورود نامعتبر است.' });
        }
        const rawExp = Number(parsed?.exp || parsed?.expires || parsed?.expires_at || 0);
        const expMs = rawExp > 0 && rawExp < 1e12 ? rawExp * 1000 : rawExp;
        if (!expMs || Date.now() > expMs) {
          return res.status(401).json({ success: false, error: 'لینک ورود منقضی شده است. لطفاً لینک جدید از ربات بگیرید.' });
        }
        telegramId = String(parsed.telegram_id || parsed.tg_id || parsed.uid || parsed.id || '').trim();
        phone = String(parsed.phone_number || parsed.phone || '').trim();
        fullName = String(parsed.full_name || parsed.name || '').trim();
        username = String(parsed.username || '').trim();
      }

      if (!telegramId && !phone) {
        return res.status(400).json({ success: false, error: 'اطلاعات کاربر در لینک ورود یافت نشد.' });
      }

      // Immediately mark token single-use right after verification (`used = true` & `data.used = true`)
      const usedAtIso = new Date().toISOString();
      if (matchedFsDoc) {
        const prevInnerData =
          matchedFsDoc.rawData?.data && typeof matchedFsDoc.rawData.data === 'object'
            ? matchedFsDoc.rawData.data
            : {};
        await matchedFsDoc.db
          .collection('bot_login_tokens')
          .doc(matchedFsDoc.id)
          .set(
            {
              used: true,
              used_at: usedAtIso,
              data: {
                ...prevInnerData,
                used: true,
                used_at: usedAtIso,
              },
            },
            { merge: true }
          )
          .catch(() => {});
      } else {
        usedMagicTokens.add(rawToken);
        if (usedMagicTokens.size > 2000) usedMagicTokens.clear();
      }

      const parsedPhone = parseIranMobile(phone);
      const cleanPhone = parsedPhone.valid ? parsedPhone.local : normalizeIranPhone(phone);
      const coreDigits = parsedPhone.valid ? parsedPhone.core10 : getPhoneCore10(phone);
      let matched: any = null;
      if (telegramId) {
        matched = await findUserByTelegramId(telegramId);
      }
      if (!matched && coreDigits) {
        matched = await findUserByPhone(cleanPhone, coreDigits);
      }

      const ownerId = (process.env.OWNER_ID || '').trim();
      const adminId = (process.env.ADMIN_ID || '').trim();
      const resolvedRole =
        ownerId && telegramId === ownerId ? 'owner' : adminId && telegramId === adminId ? 'admin' : 'user';

      let userData: any = null;
      let resolvedUid = '';
      if (matched) {
        const { _col, ...cleanMatched } = matched;
        resolvedUid = String(cleanMatched.id);
        const linkPatch: Record<string, any> = {};
        if (telegramId && !cleanMatched.telegram_id) linkPatch.telegram_id = telegramId;
        if (telegramId && !cleanMatched.chat_id && /^-?\d+$/.test(telegramId)) linkPatch.chat_id = Number(telegramId);
        if (cleanPhone && !cleanMatched.phone_number) {
          linkPatch.phone_number = cleanPhone;
          if (coreDigits) linkPatch.phone_core_digits = coreDigits;
        }
        if (username && !cleanMatched.username) linkPatch.username = username;
        if (resolvedRole !== 'user' && cleanMatched.role !== resolvedRole) linkPatch.role = resolvedRole;
        if (Object.keys(linkPatch).length > 0 && _col) {
          await strictFirestoreWrite(`users/${resolvedUid}#magic-link`, () =>
            _col.doc(resolvedUid).set({ ...linkPatch, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          );
        }
        userData = {
          ...cleanMatched,
          ...linkPatch,
          id: resolvedUid,
        };
        memoryUsers.set(resolvedUid, userData);
      } else {
        resolvedUid = coreDigits ? `u_${coreDigits}` : telegramId;
        const newDocData = {
          id: resolvedUid,
          ...(telegramId ? { telegram_id: telegramId } : {}),
          ...(telegramId && /^-?\d+$/.test(telegramId) ? { chat_id: Number(telegramId) } : {}),
          phone_number: cleanPhone || '',
          ...(coreDigits ? { phone_core_digits: coreDigits } : {}),
          full_name: fullName || 'کاربر میانجی',
          username,
          kyc_status: cleanPhone ? 'verified' : 'pending',
          wallet_balance: 0,
          escrow_locked_balance: 0,
          role: resolvedRole,
        };
        try {
          await strictFirestoreWrite(`users/${resolvedUid}#magic-create`, (db) =>
            db.collection('users').doc(resolvedUid).set({ ...newDocData, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          );
          memoryUsers.set(resolvedUid, newDocData);
          userData = { ...newDocData, updatedAt: new Date().toISOString() };
        } catch (createErr: any) {
          const errMsg = String(createErr?.message || '');
          // Recover automatically if telegram_id already owns another row (23505 unique violation)
          if (telegramId && (errMsg.includes('23505') || errMsg.includes('users_telegram_id_key') || errMsg.toLowerCase().includes('duplicate key'))) {
            const fallbackExisting = await findUserByTelegramId(telegramId);
            if (fallbackExisting) {
              const { _col: exCol, ...cleanEx } = fallbackExisting;
              resolvedUid = String(cleanEx.id);
              const recoveryPatch: Record<string, any> = {
                ...(cleanPhone && !cleanEx.phone_number ? { phone_number: cleanPhone } : {}),
                ...(coreDigits && !cleanEx.phone_core_digits ? { phone_core_digits: coreDigits } : {}),
                ...(username && !cleanEx.username ? { username } : {}),
                updatedAt: FieldValue.serverTimestamp(),
              };
              if (exCol) {
                await strictFirestoreWrite(`users/${resolvedUid}#magic-link-recover`, () =>
                  exCol.doc(resolvedUid).set(recoveryPatch, { merge: true })
                );
              }
              userData = { ...cleanEx, ...recoveryPatch, id: resolvedUid };
              memoryUsers.set(resolvedUid, userData);
              pushRuntimeLog('warn', 'auth', `ادغام خودکار تداخل کلید یکتا در ورود جادویی (${resolvedUid})`, errMsg);
            } else {
              throw createErr;
            }
          } else {
            throw createErr;
          }
        }
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
      if (!supabaseState.ready && hasAdminCredentials && adminApp) {
        try {
          customToken = await getAuth(adminApp).createCustomToken(resolvedUid);
        } catch {}
      }

      const sessionToken = await issueTrackedSession(req, res, userData);
      pushRuntimeLog('success', 'auth', `ورود مستقیم با لینک ربات موفق (${resolvedUid})`, `tg=${telegramId || '-'}`);
      void recordSecurityAuditLog({
        userId: resolvedUid,
        phoneNumber: userData.phone_number || cleanPhone || null,
        event: 'telegram_magic_login',
        category: 'auth',
        status: 'success',
        details: `ورود یک‌بارمصرف از ربات تلگرام (${telegramId || resolvedUid})`,
      });
      res.json({ success: true, user: userData, customToken, sessionToken });
    } catch (err: any) {
      pushRuntimeLog('error', 'auth', 'خطا در ورود مستقیم از تلگرام (?tg_login)', err?.message || String(err));
      console.error('Telegram Magic Auth Error:', err);
      res.status(500).json({ success: false, error: err?.message || 'خطا در ورود مستقیم از تلگرام' });
    }
  };

  app.post('/api/auth/telegram-magic', handleTelegramMagicAuth);

  // Unified Auth Endpoint supporting BOTH `token` (tg_login) and `initData` (Mini App)
  app.post('/api/auth/telegram', async (req, res) => {
    const body = req.body || {};
    if (body.token || body.tg_login) {
      return handleTelegramMagicAuth(req, res);
    }
    if (body.initData) {
      return handleTelegramWebAppAuth(req, res);
    }
    return res.status(400).json({ success: false, error: 'token یا initData الزامی است.' });
  });

  // Auth Sessions Management: list active sessions, revoke single session, revoke all others, logout
  app.get('/api/auth/sessions', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const currentJti = authResult.sessionJti;
      const merged = new Map<string, UserSessionRecord>();
      for (const s of memorySessions.values()) {
        if (s.user_id === uid && !s.revoked_at) {
          merged.set(s.id, s);
        }
      }
      const fsDb = getDb();
      if (fsDb) {
        try {
          const snap = await fsDb.collection('user_sessions').where('user_id', '==', uid).limit(30).get();
          snap.docs.forEach((docSnap) => {
            const d = docSnap.data() as UserSessionRecord;
            if (!d?.revoked_at) {
              merged.set(docSnap.id, { ...d, id: docSnap.id });
              memorySessions.set(docSnap.id, { ...d, id: docSnap.id });
            } else {
              memorySessions.set(docSnap.id, { ...d, id: docSnap.id });
              merged.delete(docSnap.id);
            }
          });
        } catch {}
      }
      // If current preview/token session isn't in store yet, synthesize a visible record for current browser
      if (currentJti && !merged.has(currentJti)) {
        const { ua, deviceLabel, platform, ipMasked } = parseDeviceInfo(req);
        const curRec: UserSessionRecord = {
          id: currentJti,
          user_id: uid,
          device_label: deviceLabel,
          platform,
          ip_masked: ipMasked,
          user_agent: ua,
          issued_at: Date.now(),
          last_seen_at: Date.now(),
        };
        merged.set(currentJti, curRec);
        memorySessions.set(currentJti, curRec);
      }

      const sessions = Array.from(merged.values())
        .sort((a, b) => (b.last_seen_at || b.issued_at) - (a.last_seen_at || a.issued_at))
        .map((s) => ({
          id: s.id,
          device_label: s.device_label,
          platform: s.platform,
          ip_masked: s.ip_masked,
          issued_at: s.issued_at,
          last_seen_at: s.last_seen_at,
          is_current: Boolean(currentJti && s.id === currentJti),
        }));

      res.json({ success: true, sessions });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت لیست نشست‌ها' });
    }
  });

  app.delete('/api/auth/sessions/:sessionId', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const targetSid = String(req.params.sessionId || '').trim();
      if (!targetSid) return res.status(400).json({ success: false, error: 'شناسه نشست نامعتبر است.' });
      if (authResult.sessionJti && targetSid === authResult.sessionJti) {
        return res.status(400).json({ success: false, error: 'برای خروج از نشست فعلی از دکمه خروج از حساب استفاده کنید.' });
      }
      const existing = memorySessions.get(targetSid);
      if (existing && existing.user_id !== uid) {
        return res.status(403).json({ success: false, error: 'دسترسی به این نشست مجاز نیست.' });
      }
      const now = Date.now();
      if (existing) {
        existing.revoked_at = now;
        memorySessions.set(targetSid, existing);
      } else {
        memorySessions.set(targetSid, {
          id: targetSid,
          user_id: uid,
          device_label: 'نشست لغوشده',
          platform: 'Web',
          ip_masked: '-',
          user_agent: '',
          issued_at: 0,
          last_seen_at: 0,
          revoked_at: now,
        });
      }
      const fsDb = getDb();
      if (fsDb) {
        const docRef = fsDb.collection('user_sessions').doc(targetSid);
        const snap = await docRef.get().catch(() => null);
        if (snap?.exists && String(snap.data()?.user_id || '') !== uid) {
          return res.status(403).json({ success: false, error: 'دسترسی به این نشست مجاز نیست.' });
        }
        await docRef.set({ revoked_at: now }, { merge: true }).catch(() => {});
      }
      disconnectUserWsSessions(uid, { onlySessionId: targetSid });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در بستن نشست' });
    }
  });

  app.post('/api/auth/sessions/revoke-others', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const currentJti = authResult.sessionJti;
      const now = Date.now();
      memoryRevokedBefore.set(uid, now);

      for (const [sid, s] of memorySessions.entries()) {
        if (s.user_id === uid && sid !== currentJti && !s.revoked_at) {
          s.revoked_at = now;
          memorySessions.set(sid, s);
        }
      }
      if (currentJti && memorySessions.has(currentJti)) {
        const cur = memorySessions.get(currentJti)!;
        cur.issued_at = now + 1;
        cur.last_seen_at = now + 1;
        memorySessions.set(currentJti, cur);
      }

      const memU = memoryUsers.get(uid);
      if (memU) {
        memU.sessions_revoked_before = now;
        memoryUsers.set(uid, memU);
      }

      const fsDb = getDb();
      if (fsDb) {
        const usersCol = getUsersCol();
        if (usersCol) {
          await usersCol.doc(uid).set({ sessions_revoked_before: now, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
        }
        try {
          const snap = await fsDb.collection('user_sessions').where('user_id', '==', uid).limit(30).get();
          const batch = fsDb.batch();
          snap.docs.forEach((docSnap) => {
            if (docSnap.id !== currentJti && !docSnap.data()?.revoked_at) {
              batch.set(docSnap.ref, { revoked_at: now }, { merge: true });
            } else if (docSnap.id === currentJti) {
              batch.set(docSnap.ref, { issued_at: now + 1, last_seen_at: now + 1 }, { merge: true });
            }
          });
          await batch.commit().catch(() => {});
        } catch {}
      }

      disconnectUserWsSessions(uid, { exceptSessionId: currentJti });
      const freshSessionToken = signSessionToken(uid, authResult.actor.role || 'user', {
        jti: currentJti,
        iat: now + 1,
      });
      setSessionCookie(req, res, freshSessionToken);

      res.json({ success: true, sessionToken: freshSessionToken });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در خروج از سایر نشست‌ها' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('actor' in authResult && authResult.sessionJti) {
      const now = Date.now();
      const s = memorySessions.get(authResult.sessionJti);
      if (s) {
        s.revoked_at = now;
        memorySessions.set(authResult.sessionJti, s);
      }
      const fsDb = getDb();
      if (fsDb) {
        fsDb.collection('user_sessions').doc(authResult.sessionJti).set({ revoked_at: now }, { merge: true }).catch(() => {});
      }
    }
    res.setHeader('Set-Cookie', 'mianji_sid=; Path=/; HttpOnly; Max-Age=0');
    res.json({ success: true });
  });

  const botSyncTelemetry: {
    lastBotSyncAt: string | null;
    lastBotSyncAction: string | null;
    lastBotSyncError: string | null;
    botSyncSuccessCount: number;
    botSyncAuthFailCount: number;
  } = {
    lastBotSyncAt: null,
    lastBotSyncAction: null,
    lastBotSyncError: null,
    botSyncSuccessCount: 0,
    botSyncAuthFailCount: 0,
  };

  const verifyBotSyncSecret = (req: express.Request): { ok: true } | { ok: false; status: number; error: string } => {
    const explicitBotSecret = (process.env.BOT_SYNC_SECRET || '').trim();
    const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const expectedSecret =
      explicitBotSecret ||
      (botToken ? crypto.createHmac('sha256', 'mianji-bot-sync').update(botToken).digest('hex') : '');

    if (!expectedSecret) {
      botSyncTelemetry.lastBotSyncError = 'BOT_SYNC_SECRET یا BOT_TOKEN روی سرور تنظیم نشده است.';
      pushRuntimeLog('error', 'bot_sync', 'درخواست ربات مسدود شد: BOT_SYNC_SECRET تنظیم نشده است', req.path);
      return {
        ok: false,
        status: 503,
        error: 'BOT_SYNC_SECRET یا BOT_TOKEN روی سرور تنظیم نشده است.',
      };
    }

    const providedHeader = String(req.headers['x-bot-secret'] || '').trim();
    const bearerHeader =
      typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bot ')
        ? req.headers.authorization.slice(4).trim()
        : '';
    const suppliedSecret = providedHeader || bearerHeader;

    if (!suppliedSecret || !timingSafeEqualStr(suppliedSecret, expectedSecret)) {
      botSyncTelemetry.botSyncAuthFailCount += 1;
      botSyncTelemetry.lastBotSyncError = `کلید x-bot-secret ارسالی ربات با BOT_SYNC_SECRET سرور یکسان نیست (${req.path})`;
      pushRuntimeLog('warn', 'bot_sync', `کلید x-bot-secret ربات نامعتبر بود (${req.path})`, `ip=${req.ip}`);
      return { ok: false, status: 401, error: 'احراز هویت ربات نامعتبر است.' };
    }
    return { ok: true };
  };

  // Bot Sync Endpoint: Telegram Bot registers or updates a user phone + telegramId (Authenticated via BOT_SYNC_SECRET)
  app.post('/api/bot/register-user', async (req, res) => {
    try {
      const authCheck = verifyBotSyncSecret(req);
      if (!authCheck.ok) {
        return res.status(authCheck.status).json({ success: false, error: authCheck.error });
      }

      const { telegramId, phone, fullName, username, chatId } = req.body || {};
      if (!telegramId || !phone) {
        return res.status(400).json({ success: false, error: 'telegramId and phone are required' });
      }

      const userId = String(telegramId).trim();
      if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid telegramId format' });
      }

      const parsedPhone = parseIranMobile(phone);
      const rawDigits = extractCleanPhone(phone);
      const coreDigits = parsedPhone.valid ? parsedPhone.core10 : rawDigits.length >= 10 ? rawDigits.slice(-10) : '';
      const cleanPhone = parsedPhone.valid ? parsedPhone.local : normalizeIranPhone(phone);
      if (!coreDigits) {
        return res.status(400).json({ success: false, error: 'Invalid phone number' });
      }
      const numericChatId =
        chatId !== undefined && /^-?\d+$/.test(String(chatId).trim())
          ? Number(String(chatId).trim())
          : /^-?\d+$/.test(userId)
          ? Number(userId)
          : undefined;
      const cleanUsername =
        typeof username === 'string' && username.trim() ? username.trim().replace(/^@+/, '').slice(0, 64) : undefined;

      // Check if an existing web account already owns this phone; safely link telegram_id without splitting or zeroing wallets
      const phoneOwner = await findUserByPhone(cleanPhone, coreDigits);
      const ownerId = (process.env.OWNER_ID || '').trim();
      const adminId = (process.env.ADMIN_ID || '').trim();

      if (phoneOwner && String(phoneOwner.id) !== userId) {
        const existingTg = String(phoneOwner.telegram_id || '').trim();
        if (existingTg && existingTg !== userId) {
          return res.status(409).json({
            success: false,
            error: 'این شماره همراه پیش‌تر به آیدی تلگرام دیگری متصل شده است.',
          });
        }
        const resolvedUid = String(phoneOwner.id);
        const safeMergedName = String(phoneOwner.full_name || fullName || 'کاربر میانجی').trim().slice(0, 100);
        let mergedWallet = Math.max(0, Number(phoneOwner.wallet_balance || 0));
        let mergedLocked = Math.min(mergedWallet, Math.max(0, Number(phoneOwner.escrow_locked_balance || 0)));

        const mergedPatch: Record<string, any> = {
          telegram_id: userId,
          ...(numericChatId !== undefined ? { chat_id: numericChatId } : {}),
          phone_core_digits: coreDigits,
          full_name: safeMergedName,
          ...(cleanUsername && !phoneOwner.username ? { username: cleanUsername } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        };
        const usersColMerge = getUsersCol();
        if (usersColMerge) {
          // Reconcile orphan telegram shadow row if one was created before phone sharing
          const shadowSnap = await usersColMerge.doc(userId).get().catch(() => null);
          if (shadowSnap?.exists) {
            const shadowData = shadowSnap.data() || {};
            const shadowPhone = extractCleanPhone(shadowData.phone_number || '');
            const shadowWallet = Math.max(0, Number(shadowData.wallet_balance || 0));
            const shadowLocked = Math.max(0, Number(shadowData.escrow_locked_balance || 0));
            if (!shadowPhone) {
              if (shadowWallet > 0 || shadowLocked > 0) {
                mergedWallet += shadowWallet;
                mergedLocked = Math.min(mergedWallet, mergedLocked + shadowLocked);
                mergedPatch.wallet_balance = mergedWallet;
                mergedPatch.escrow_locked_balance = mergedLocked;
              }
              await strictFirestoreWrite(`users/${userId}#bot-shadow-clean`, () => usersColMerge.doc(userId).delete());
              memoryUsers.delete(userId);
            }
          }
          await strictFirestoreWrite(`users/${resolvedUid}#bot-merge`, () =>
            usersColMerge.doc(resolvedUid).set(mergedPatch, { merge: true })
          );
        } else {
          const shadowMem = memoryUsers.get(userId);
          if (shadowMem && !extractCleanPhone(shadowMem.phone_number || '')) {
            mergedWallet += Math.max(0, Number(shadowMem.wallet_balance || 0));
            mergedLocked = Math.min(mergedWallet, mergedLocked + Math.max(0, Number(shadowMem.escrow_locked_balance || 0)));
            memoryUsers.delete(userId);
          }
        }
        const mergedUser = {
          ...phoneOwner,
          id: resolvedUid,
          telegram_id: userId,
          ...(numericChatId !== undefined ? { chat_id: numericChatId } : {}),
          phone_core_digits: coreDigits,
          full_name: safeMergedName,
          ...(cleanUsername && !phoneOwner.username ? { username: cleanUsername } : {}),
          wallet_balance: mergedWallet,
          escrow_locked_balance: mergedLocked,
          free_balance: Math.max(0, mergedWallet - mergedLocked),
          updatedAt: new Date().toISOString(),
        };
        memoryUsers.set(resolvedUid, mergedUser);
        const pendingWithdrawTotal = await getPendingWithdrawTotal(resolvedUid);
        const freeBalance = Math.max(0, mergedWallet - mergedLocked);
        const availableBalance = Math.max(0, freeBalance - pendingWithdrawTotal);
        void recordSecurityAuditLog({
          userId: resolvedUid,
          phoneNumber: cleanPhone,
          event: 'bot_register_user_linked',
          category: 'bot_sync',
          status: 'success',
          details: `اتصال آیدی تلگرام ${userId} به حساب موجود ${resolvedUid} بدون تغییر موجودی`,
        });
        console.log(`[BOT-SYNC] Linked telegram_id=${userId} to existing user ${resolvedUid}`);
        botSyncTelemetry.lastBotSyncAt = new Date().toISOString();
        botSyncTelemetry.lastBotSyncAction = 'register-user:link';
        botSyncTelemetry.lastBotSyncError = null;
        botSyncTelemetry.botSyncSuccessCount += 1;
        pushRuntimeLog('success', 'bot_sync', `اتصال ربات به حساب موجود (${resolvedUid})`, `tg=${userId}`);
        return res.json({
          success: true,
          user_id: resolvedUid,
          user: mergedUser,
          merged: true,
          wallet_balance: mergedWallet,
          escrow_locked_balance: mergedLocked,
          free_balance: freeBalance,
          balances: {
            wallet_balance: mergedWallet,
            escrow_locked_balance: mergedLocked,
            free_balance: freeBalance,
            pending_withdraw_total: pendingWithdrawTotal,
            available_balance: availableBalance,
          },
        });
      }

      const existingByTg = (await findUserByTelegramId(userId)) || memoryUsers.get(userId);
      if (existingByTg?.phone_number && extractCleanPhone(existingByTg.phone_number).slice(-10) !== coreDigits) {
        return res.status(409).json({
          success: false,
          error: 'شماره همراه این حساب کاربری قبلاً تایید شده و قابل بازنویسی خودکار نیست.',
        });
      }

      const safeName = String(fullName || existingByTg?.full_name || 'کاربر میانجی').trim().slice(0, 100);
      const targetDocId = String(existingByTg?.id || userId);
      const preservedWallet = Math.max(0, Number(existingByTg?.wallet_balance ?? 0));
      const preservedLocked = Math.min(preservedWallet, Math.max(0, Number(existingByTg?.escrow_locked_balance ?? 0)));
      const userData: Record<string, any> = {
        id: targetDocId,
        telegram_id: userId,
        ...(numericChatId !== undefined ? { chat_id: numericChatId } : {}),
        phone_number: cleanPhone,
        phone_core_digits: coreDigits,
        full_name: safeName,
        ...(cleanUsername ? { username: cleanUsername } : existingByTg?.username ? { username: existingByTg.username } : {}),
        kyc_status: existingByTg?.kyc_status || 'pending',
        wallet_balance: preservedWallet,
        escrow_locked_balance: preservedLocked,
        role:
          existingByTg?.role ||
          (ownerId && userId === ownerId ? 'owner' : adminId && userId === adminId ? 'admin' : 'user'),
      };

      const usersCol = getUsersCol();
      if (usersCol) {
        try {
          const docRef = usersCol.doc(targetDocId);
          const snap = await docRef.get();
          if (snap.exists) {
            const existingData = snap.data() || {};
            const existingPhone = extractCleanPhone(existingData.phone_number || '');
            if (existingPhone && existingPhone.slice(-10) !== coreDigits) {
              return res.status(409).json({
                success: false,
                error: 'شماره همراه این کاربر قبلاً ثبت شده و امکان تغییر بدون تایید وجود ندارد.',
              });
            }
            // NEVER overwrite or zero existing wallet_balance / escrow_locked_balance on existing user
            const patch: Record<string, any> = {
              id: targetDocId,
              telegram_id: userId,
              ...(numericChatId !== undefined ? { chat_id: numericChatId } : {}),
              phone_core_digits: coreDigits,
              full_name: fullName ? safeName : existingData.full_name || safeName,
              ...(cleanUsername ? { username: cleanUsername } : {}),
              updatedAt: FieldValue.serverTimestamp(),
            };
            if (!existingPhone) {
              patch.phone_number = cleanPhone;
            }
            await strictFirestoreWrite(`users/${targetDocId}#bot-update`, () => docRef.set(patch, { merge: true }));
            Object.assign(userData, {
              ...existingData,
              ...patch,
              wallet_balance: Math.max(0, Number(existingData.wallet_balance ?? preservedWallet)),
              escrow_locked_balance: Math.max(0, Number(existingData.escrow_locked_balance ?? preservedLocked)),
              updatedAt: new Date().toISOString(),
            });
          } else {
            await strictFirestoreWrite(`users/${targetDocId}#bot-create`, () =>
              docRef.set(
                {
                  ...userData,
                  updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
              )
            );
          }
        } catch (e) {
          pushRuntimeLog('error', 'bot_sync', `خطا در ذخیره کاربر ربات (${targetDocId})`, (e as Error)?.message);
          if (hasExplicitDb()) {
            throw e;
          }
          console.warn('[BOT-SYNC] DB sync skipped/unavailable:', (e as Error)?.message);
        }
      }

      memoryUsers.set(targetDocId, { ...userData, telegram_id: userId });
      const pendingWithdrawTotal = await getPendingWithdrawTotal(targetDocId);
      const walletBal = Math.max(0, Number(userData.wallet_balance || 0));
      const lockedBal = Math.min(walletBal, Math.max(0, Number(userData.escrow_locked_balance || 0)));
      const freeBal = Math.max(0, walletBal - lockedBal);
      void recordSecurityAuditLog({
        userId: targetDocId,
        phoneNumber: cleanPhone,
        event: 'bot_register_user',
        category: 'bot_sync',
        status: 'success',
        details: `همگام‌سازی کاربر تلگرام ${userId}`,
      });
      console.log(`[BOT-SYNC] Registered user ${targetDocId}`);
      botSyncTelemetry.lastBotSyncAt = new Date().toISOString();
      botSyncTelemetry.lastBotSyncAction = 'register-user:upsert';
      botSyncTelemetry.lastBotSyncError = null;
      botSyncTelemetry.botSyncSuccessCount += 1;
      pushRuntimeLog('success', 'bot_sync', `ثبت/به‌روزرسانی کاربر از ربات (${targetDocId})`, `tg=${userId}`);
      res.json({
        success: true,
        user_id: targetDocId,
        user: { ...userData, free_balance: freeBal },
        wallet_balance: walletBal,
        escrow_locked_balance: lockedBal,
        free_balance: freeBal,
        balances: {
          wallet_balance: walletBal,
          escrow_locked_balance: lockedBal,
          free_balance: freeBal,
          pending_withdraw_total: pendingWithdrawTotal,
          available_balance: Math.max(0, freeBal - pendingWithdrawTotal),
        },
      });
    } catch (err: any) {
      pushRuntimeLog('error', 'bot_sync', 'خطا در register-user ربات', err?.message || String(err));
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Bot Sync Endpoint: Read live unified wallet balance (matches Website calculation exactly)
  app.get('/api/bot/user-balance', async (req, res) => {
    try {
      const authCheck = verifyBotSyncSecret(req);
      if (!authCheck.ok) {
        return res.status(authCheck.status).json({ success: false, error: authCheck.error });
      }

      const rawTgId = String(req.query.telegramId || req.query.telegram_id || '').trim();
      const rawPhone = String(req.query.phone || '').trim();
      if (!rawTgId && !rawPhone) {
        return res.status(400).json({ success: false, error: 'telegramId or phone is required' });
      }

      let matched: any = rawTgId ? await findUserByTelegramId(rawTgId) : null;
      if (!matched && rawPhone) {
        const core10 = getPhoneCore10(rawPhone);
        if (core10) {
          matched = await findUserByPhone(normalizeIranPhone(rawPhone) || rawPhone, core10);
        }
      }

      if (!matched) {
        botSyncTelemetry.lastBotSyncAt = new Date().toISOString();
        botSyncTelemetry.lastBotSyncAction = 'user-balance:not_found';
        botSyncTelemetry.lastBotSyncError = `کاربر با شناسه تلگرام/شماره یافت نشد (${rawTgId || rawPhone.slice(-4)})`;
        botSyncTelemetry.botSyncSuccessCount += 1;
        pushRuntimeLog('warn', 'bot_sync', 'استعلام موجودی ربات: کاربر یافت نشد', `tg=${rawTgId || '-'} phone=${rawPhone ? rawPhone.slice(-4) : '-'}`);
        return res.status(404).json({ success: false, error: 'کاربر یافت نشد.' });
      }

      botSyncTelemetry.lastBotSyncAt = new Date().toISOString();
      botSyncTelemetry.lastBotSyncAction = 'user-balance:ok';
      botSyncTelemetry.lastBotSyncError = null;
      botSyncTelemetry.botSyncSuccessCount += 1;

      const { _col, ...cleanUser } = matched;
      const uid = String(cleanUser.id);
      if (rawTgId && !cleanUser.telegram_id) {
        cleanUser.telegram_id = rawTgId;
        memoryUsers.set(uid, cleanUser);
        const usersCol = _col || getUsersCol();
        if (usersCol) {
          await usersCol.doc(uid).set({ telegram_id: rawTgId, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
        }
      }

      const walletBal = Math.max(0, Number(cleanUser.wallet_balance || 0));
      const lockedBal = Math.min(walletBal, Math.max(0, Number(cleanUser.escrow_locked_balance || 0)));
      const freeBal = Math.max(0, walletBal - lockedBal);
      const pendingWithdrawTotal = await getPendingWithdrawTotal(uid);
      const availableBalance = Math.max(0, freeBal - pendingWithdrawTotal);

      res.json({
        success: true,
        persistence_mode: getPersistenceStatus().mode,
        user_id: uid,
        telegram_id: cleanUser.telegram_id || null,
        phone_number: cleanUser.phone_number || '',
        wallet_balance: walletBal,
        escrow_locked_balance: lockedBal,
        free_balance: freeBal,
        pending_withdraw_total: pendingWithdrawTotal,
        available_balance: availableBalance,
        user: {
          id: uid,
          telegram_id: cleanUser.telegram_id || null,
          phone_number: cleanUser.phone_number || '',
          full_name: cleanUser.full_name || 'کاربر میانجی',
          kyc_status: cleanUser.kyc_status || 'pending',
        },
        balances: {
          wallet_balance: walletBal,
          escrow_locked_balance: lockedBal,
          free_balance: freeBal,
          pending_withdraw_total: pendingWithdrawTotal,
          available_balance: availableBalance,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت موجودی کاربر' });
    }
  });

  // Bot Bi-Directional Sync Endpoint (14 shared tables, anti-duplicate user linking, unified accounting)
  app.post('/api/tgcloud/sync', async (req, res) => {
    try {
      const authCheck = verifyBotSyncSecret(req);
      if (!authCheck.ok) {
        return res.status(authCheck.status).json({ success: false, error: authCheck.error });
      }

      const body = req.body || {};
      const action = String(body.action || '').trim();
      if (!action) {
        return res.status(400).json({ success: false, error: 'فیلد action الزامی است.' });
      }

      botSyncTelemetry.lastBotSyncAt = new Date().toISOString();
      botSyncTelemetry.lastBotSyncAction = `tgcloud:${action}`;
      botSyncTelemetry.lastBotSyncError = null;
      botSyncTelemetry.botSyncSuccessCount += 1;

      const firestore = getDb();
      const nowIso = new Date().toISOString();

      switch (action) {
        case 'ensure_user':
        case 'upsert_user': {
          const rawUser = body.user || body.payload || body.data || (body.telegram_id || body.telegramId || body.phone || body.phone_number ? body : null);
          if (!rawUser || typeof rawUser !== 'object') {
            return res.status(400).json({ success: false, error: 'داده user نامعتبر است.' });
          }
          const preserveExistingBalances = action === 'ensure_user' ? true : body.preserveExistingBalances !== false;
          const tgId = rawUser.telegram_id
            ? String(rawUser.telegram_id).trim()
            : rawUser.telegramId
            ? String(rawUser.telegramId).trim()
            : '';
          const rawPhoneInput = rawUser.phone_number ?? rawUser.phone ?? '';
          const parsedPhone = parseIranMobile(rawPhoneInput);
          const cleanPhone = parsedPhone.valid
            ? parsedPhone.local
            : rawPhoneInput
            ? normalizeIranPhone(rawPhoneInput)
            : '';
          const coreDigits = rawUser.phone_core_digits
            ? extractPhoneCore10Digits(String(rawUser.phone_core_digits))
            : parsedPhone.valid
            ? parsedPhone.core10
            : getPhoneCore10(cleanPhone);

          let existing: any = null;
          if (rawUser.id) existing = await getUserById(String(rawUser.id));
          if (!existing && tgId) existing = await findUserByTelegramId(tgId);
          if (!existing && coreDigits) existing = await findUserByPhone(cleanPhone || coreDigits, coreDigits);

          const resolvedId = String(existing?.id || rawUser.id || (coreDigits ? `u_${coreDigits}` : tgId));
          if (!resolvedId) {
            return res.status(400).json({ success: false, error: 'شناسه کاربر (id / telegram_id / phone) یافت نشد.' });
          }

          const { _col, ...cleanExisting } = existing || {};
          const incomingWallet =
            rawUser.wallet_balance !== undefined ? Math.max(0, Math.round(Number(rawUser.wallet_balance) || 0)) : undefined;
          const incomingLocked =
            rawUser.escrow_locked_balance !== undefined
              ? Math.max(0, Math.round(Number(rawUser.escrow_locked_balance) || 0))
              : undefined;

          const nextWallet =
            existing && preserveExistingBalances
              ? Math.max(0, Number(cleanExisting.wallet_balance ?? 0))
              : incomingWallet ?? Math.max(0, Number(cleanExisting.wallet_balance ?? 0));
          const nextLockedRaw =
            existing && preserveExistingBalances
              ? Math.max(0, Number(cleanExisting.escrow_locked_balance ?? 0))
              : incomingLocked ?? Math.max(0, Number(cleanExisting.escrow_locked_balance ?? 0));
          const nextLocked = Math.min(nextWallet, Math.max(0, nextLockedRaw));

          const numericChatId =
            rawUser.chat_id !== undefined && /^-?\d+$/.test(String(rawUser.chat_id).trim())
              ? Number(String(rawUser.chat_id).trim())
              : rawUser.chatId !== undefined && /^-?\d+$/.test(String(rawUser.chatId).trim())
              ? Number(String(rawUser.chatId).trim())
              : tgId && /^-?\d+$/.test(tgId)
              ? Number(tgId)
              : cleanExisting.chat_id;

          const safeRawUser = { ...rawUser };
          delete (safeRawUser as any).wallet_balance;
          delete (safeRawUser as any).escrow_locked_balance;
          delete (safeRawUser as any).action;

          const dbWritePatch: Record<string, any> = {
            ...safeRawUser,
            id: resolvedId,
            ...(tgId ? { telegram_id: tgId } : cleanExisting.telegram_id ? { telegram_id: cleanExisting.telegram_id } : {}),
            ...(numericChatId !== undefined ? { chat_id: numericChatId } : {}),
            ...(cleanPhone ? { phone_number: cleanPhone } : cleanExisting.phone_number ? { phone_number: cleanExisting.phone_number } : {}),
            ...(coreDigits ? { phone_core_digits: coreDigits } : {}),
            ...(!existing || !preserveExistingBalances ? { wallet_balance: nextWallet, escrow_locked_balance: nextLocked } : {}),
            updated_at: nowIso,
          };
          delete dbWritePatch._col;

          await strictFirestoreWrite(`users/${resolvedId}#tgcloud-${action}`, (db) =>
            db.collection('users').doc(resolvedId).set({ ...dbWritePatch, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          );

          const mergedUser: Record<string, any> = {
            ...cleanExisting,
            ...dbWritePatch,
            wallet_balance: nextWallet,
            escrow_locked_balance: nextLocked,
          };
          memoryUsers.set(resolvedId, mergedUser);

          const pendingWithdrawTotal = await getPendingWithdrawTotal(resolvedId);
          const freeBal = Math.max(0, nextWallet - nextLocked);
          const availableBal = Math.max(0, freeBal - pendingWithdrawTotal);
          return res.json({
            success: true,
            user_id: resolvedId,
            telegram_id: mergedUser.telegram_id || null,
            phone_number: mergedUser.phone_number || '',
            wallet_balance: nextWallet,
            escrow_locked_balance: nextLocked,
            free_balance: freeBal,
            pending_withdraw_total: pendingWithdrawTotal,
            available_balance: availableBal,
            user: mergedUser,
            balances: {
              wallet_balance: nextWallet,
              escrow_locked_balance: nextLocked,
              free_balance: freeBal,
              pending_withdraw_total: pendingWithdrawTotal,
              available_balance: availableBal,
            },
          });
        }

        case 'upsert_deal': {
          const rawDeal = body.deal || body.payload || body.data;
          if (!rawDeal || typeof rawDeal !== 'object') {
            return res.status(400).json({ success: false, error: 'داده deal نامعتبر است.' });
          }
          const cid = String(rawDeal.contract_id || rawDeal.id || '').trim();
          if (!cid) {
            return res.status(400).json({ success: false, error: 'contract_id الزامی است.' });
          }
          const existing = (await getDealByContractId(cid)) || {};
          const mergedStatus = rawDeal.status ? normalizeDealStatus(rawDeal.status) : normalizeDealStatus(existing.status || 'pending_party_b');
          const mergedPayer = rawDeal.commission_payer
            ? normalizeCommissionPayer(rawDeal.commission_payer)
            : normalizeCommissionPayer(existing.commission_payer || 'freelancer');
          const mergedAmount = Math.max(0, Math.round(Number(rawDeal.amount ?? existing.amount ?? 0)));
          const limits = await loadGlobalLimits();
          const feePercent = Math.max(0, Math.min(15, Number(rawDeal.fee_percent ?? existing.fee_percent ?? limits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));
          const breakdown = computeCommissionBreakdown(mergedAmount, feePercent, mergedPayer);
          const mergedDeal = {
            ...existing,
            ...rawDeal,
            id: cid,
            contract_id: cid,
            invite_token: rawDeal.invite_token || existing.invite_token || `c_${cid}`,
            amount: mergedAmount,
            fee_percent: feePercent,
            fee_amount: rawDeal.fee_amount ?? existing.fee_amount ?? breakdown.totalFee,
            employer_fee: rawDeal.employer_fee ?? existing.employer_fee ?? breakdown.employerFee,
            freelancer_fee: rawDeal.freelancer_fee ?? existing.freelancer_fee ?? breakdown.freelancerFee,
            employer_total_payable: rawDeal.employer_total_payable ?? existing.employer_total_payable ?? breakdown.employerTotalPayable,
            net_seller_amount: rawDeal.net_seller_amount ?? existing.net_seller_amount ?? breakdown.netSellerAmount,
            status: mergedStatus,
            commission_payer: mergedPayer,
            escrow_deposit_status:
              rawDeal.escrow_deposit_status ||
              existing.escrow_deposit_status ||
              (mergedStatus === 'completed'
                ? 'released'
                : ['active', 'work_submitted', 'revisions_requested', 'in_dispute'].includes(mergedStatus)
                ? 'paid_locked'
                : mergedStatus === 'cancelled'
                ? 'refunded'
                : 'unpaid'),
            updated_at: nowIso,
            updatedAt: nowIso,
          };
          await strictFirestoreWrite(`deals/${cid}#tgcloud-upsert-deal`, (db) =>
            db.collection('deals').doc(cid).set({ ...mergedDeal, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          );
          const enriched = await enrichDealWithParties(mergedDeal);
          memoryDeals.set(cid, enriched);
          if (enriched.buyer_id && !isPendingPartyId(enriched.buyer_id)) wsBroadcastUser(String(enriched.buyer_id), 'deal:updated', { contract: enriched });
          if (enriched.seller_id && !isPendingPartyId(enriched.seller_id)) wsBroadcastUser(String(enriched.seller_id), 'deal:updated', { contract: enriched });
          return res.json({ success: true, deal: enriched });
        }

        case 'upsert_tx': {
          const rawTx = body.transaction || body.tx || body.payload || body.data;
          if (!rawTx || typeof rawTx !== 'object' || !rawTx.user_id) {
            return res.status(400).json({ success: false, error: 'transaction و user_id الزامی است.' });
          }
          const txId = String(rawTx.id || `tx_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
          const uid = String(rawTx.user_id);
          const entry = {
            ...rawTx,
            id: txId,
            user_id: uid,
            amount: Math.round(Number(rawTx.amount || 0)),
            status: rawTx.status || 'completed',
            created_at: rawTx.created_at || nowIso,
            updated_at: nowIso,
          };
          await strictFirestoreWrite(`transactions/${txId}#tgcloud-upsert-tx`, (db) =>
            db.collection('transactions').doc(txId).set({ ...entry, createdAt: FieldValue.serverTimestamp() }, { merge: true })
          );
          const prevList = memoryTransactions.get(uid) || [];
          memoryTransactions.set(uid, [entry, ...prevList.filter((t) => String(t.id) !== txId)]);
          return res.json({ success: true, transaction: entry });
        }

        case 'upsert_withdrawal': {
          const rawReq = body.withdrawal || body.wallet_request || body.payload || body.data;
          if (!rawReq || typeof rawReq !== 'object' || !rawReq.user_id) {
            return res.status(400).json({ success: false, error: 'اطلاعات درخواست برداشت الزامی است.' });
          }
          const reqId = String(rawReq.id || `wreq_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
          const uid = String(rawReq.user_id);
          const existing = memoryWalletRequests.get(reqId);
          const prevStatus = String(existing?.status || '');
          const nextStatus = String(rawReq.status || existing?.status || 'pending');
          const amt = Math.max(0, Math.round(Number(rawReq.amount ?? existing?.amount ?? 0)));

          let balances: { wallet_balance: number; escrow_locked_balance: number; free_balance: number } | undefined;
          if (
            body.apply_wallet_adjustment === true &&
            (prevStatus === '' || prevStatus === 'pending') &&
            (nextStatus === 'paid' || nextStatus === 'approved') &&
            amt > 0
          ) {
            balances = await adjustUserWalletAtomic(uid, -amt, 0, true);
          }

          const record = {
            ...(existing || {}),
            ...rawReq,
            id: reqId,
            user_id: uid,
            type: rawReq.type || existing?.type || 'withdraw',
            amount: amt,
            status: nextStatus,
            updated_at: nowIso,
            created_at: rawReq.created_at || existing?.created_at || nowIso,
          };
          await strictFirestoreWrite(`wallet_requests/${reqId}#tgcloud-upsert-withdrawal`, (db) =>
            db.collection('wallet_requests').doc(reqId).set(record, { merge: true })
          );
          memoryWalletRequests.set(reqId, record);
          wsBroadcastUser(uid, 'wallet:updated', { userId: uid, request: record, ...(balances ? { balances } : {}) });
          return res.json({ success: true, withdrawal: record, ...(balances ? { balances } : {}) });
        }

        case 'upsert_dispute': {
          const rawDispute = body.dispute || body.payload || body.data;
          if (!rawDispute || typeof rawDispute !== 'object') {
            return res.status(400).json({ success: false, error: 'داده dispute نامعتبر است.' });
          }
          const did = String(rawDispute.id || rawDispute.contract_id || '').trim();
          const cid = String(rawDispute.contract_id || did).trim();
          if (!did) {
            return res.status(400).json({ success: false, error: 'شناسه dispute یا contract_id الزامی است.' });
          }
          const existingMem = memoryDisputes.get(cid) || { evidence: [] };
          memoryDisputes.set(cid, {
            ...existingMem,
            ...rawDispute,
            evidence: Array.isArray(rawDispute.evidence_files) ? rawDispute.evidence_files : existingMem.evidence,
            ...(rawDispute.ruling ? { resolution: rawDispute.ruling } : {}),
          });
          const entry = {
            ...rawDispute,
            id: did,
            contract_id: cid,
            updated_at: nowIso,
            created_at: rawDispute.created_at || nowIso,
          };
          await strictFirestoreWrite(`disputes/${did}#tgcloud-upsert-dispute`, (db) =>
            db.collection('disputes').doc(did).set(entry, { merge: true })
          );
          return res.json({ success: true, dispute: entry });
        }

        case 'upsert_signature': {
          const rawSig = body.signature || body.payload || body.data;
          if (!rawSig || typeof rawSig !== 'object' || !rawSig.contract_id) {
            return res.status(400).json({ success: false, error: 'داده signature و contract_id الزامی است.' });
          }
          const sigId = String(rawSig.id || `sig_${rawSig.contract_id}_${rawSig.role || 'party'}_${rawSig.user_id || Date.now()}`);
          const entry = {
            ...rawSig,
            id: sigId,
            signed_at: rawSig.signed_at || nowIso,
            status: rawSig.status || 'signed',
            updated_at: nowIso,
          };
          await strictFirestoreWrite(`contract_signatures/${sigId}#tgcloud-upsert-sig`, (db) =>
            db.collection('contract_signatures').doc(sigId).set(entry, { merge: true })
          );
          return res.json({ success: true, signature: entry });
        }

        case 'upsert_pending_receipt': {
          const rawReceipt = body.receipt || body.pending_receipt || body.payload || body.data;
          if (!rawReceipt || typeof rawReceipt !== 'object' || !rawReceipt.user_id) {
            return res.status(400).json({ success: false, error: 'داده فیش در انتظار بررسی و user_id الزامی است.' });
          }
          const rid = String(rawReceipt.id || `rcpt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
          const uid = String(rawReceipt.user_id);
          const amt = Math.max(0, Math.round(Number(rawReceipt.amount || 0)));
          const rType = String(rawReceipt.type || 'wallet');
          const nextStatus = String(rawReceipt.status || 'pending');

          let prevStatus = '';
          if (firestore) {
            const existingSnap = await firestore.collection('pending_receipts').doc(rid).get().catch(() => null);
            if (existingSnap?.exists) prevStatus = String(existingSnap.data()?.status || '');
          }

          let balances: { wallet_balance: number; escrow_locked_balance: number; free_balance: number } | undefined;
          if (
            body.apply_wallet_adjustment === true &&
            (prevStatus === '' || prevStatus === 'pending') &&
            nextStatus === 'approved' &&
            amt > 0
          ) {
            // Card-to-card deal/milestone approval adds to BOTH wallet_balance AND escrow_locked_balance per unified accounting
            const lockDelta = rType === 'contract' || rType === 'milestone' || rType === 'extra_edit' ? amt : 0;
            balances = await adjustUserWalletAtomic(uid, amt, lockDelta, false);
          }

          const entry = {
            ...rawReceipt,
            id: rid,
            user_id: uid,
            type: rType,
            amount: amt,
            status: nextStatus,
            updated_at: nowIso,
            created_at: rawReceipt.created_at || nowIso,
          };
          await strictFirestoreWrite(`pending_receipts/${rid}#tgcloud-upsert-receipt`, (db) =>
            db.collection('pending_receipts').doc(rid).set(entry, { merge: true })
          );
          if (balances) {
            wsBroadcastUser(uid, 'wallet:updated', { userId: uid, balances });
          }
          return res.json({ success: true, receipt: entry, ...(balances ? { balances } : {}) });
        }

        case 'upsert_ambassador': {
          const rawAmb = body.ambassador || body.payload || body.data;
          if (!rawAmb || typeof rawAmb !== 'object' || (!rawAmb.id && !rawAmb.telegram_id)) {
            return res.status(400).json({ success: false, error: 'اطلاعات سفیر (id یا telegram_id) الزامی است.' });
          }
          const aid = String(rawAmb.id || rawAmb.telegram_id);
          const normRate = normalizeAmbassadorCommissionRate(rawAmb.commission_rate);
          const entry = {
            ...rawAmb,
            id: aid,
            telegram_id: String(rawAmb.telegram_id || aid),
            commission_rate: normRate.decimal,
            commission_rate_percent: normRate.percent,
            updated_at: nowIso,
            created_at: rawAmb.created_at || nowIso,
          };
          await strictFirestoreWrite(`ambassadors/${aid}#tgcloud-upsert-amb`, (db) =>
            db.collection('ambassadors').doc(aid).set(entry, { merge: true })
          );
          return res.json({ success: true, ambassador: entry });
        }

        case 'adjust_wallet': {
          const rawId = String(body.user_id || body.userId || '').trim();
          const rawTg = String(body.telegram_id || body.telegramId || '').trim();
          const rawPhone = String(body.phone || body.phone_number || '').trim();
          let matchedUser: any = rawId ? await getUserById(rawId) : null;
          if (!matchedUser && rawTg) matchedUser = await findUserByTelegramId(rawTg);
          if (!matchedUser && !rawTg && rawId) matchedUser = await findUserByTelegramId(rawId);
          if (!matchedUser && rawPhone) {
            const core10 = getPhoneCore10(rawPhone);
            if (core10) matchedUser = await findUserByPhone(normalizeIranPhone(rawPhone) || rawPhone, core10);
          }
          if (!matchedUser) {
            return res.status(404).json({ success: false, error: 'کاربر برای تغییر موجودی یافت نشد.' });
          }

          const targetUid = String(matchedUser.id);
          const walletDelta = Math.round(Number(body.wallet_delta ?? body.walletDelta ?? 0));
          const lockedDelta = Math.round(Number(body.locked_delta ?? body.lockedDelta ?? 0));
          const requireFreeCheck = body.require_free_check !== undefined
            ? Boolean(body.require_free_check)
            : body.requireFreeCheck !== undefined
            ? Boolean(body.requireFreeCheck)
            : true;
          const txId = body.tx_id || body.txId ? String(body.tx_id || body.txId).trim() : undefined;
          const txType = String(body.tx_type || body.txType || 'general').trim();
          const title = String(body.title || '').trim();
          const contractId = body.contract_id || body.contractId ? String(body.contract_id || body.contractId).trim() : undefined;

          try {
            const adj = await adjustUserWalletAtomic(
              targetUid,
              walletDelta,
              lockedDelta,
              requireFreeCheck,
              txId ? { txId, txType, title, contractId } : undefined
            );
            const pendingWithdrawTotal = await getPendingWithdrawTotal(targetUid);
            const availableBalance = Math.max(0, adj.free_balance - pendingWithdrawTotal);
            wsBroadcastUser(targetUid, 'wallet:updated', { userId: targetUid, balances: adj });
            pushRuntimeLog(
              'info',
              'bot_sync',
              `تغییر موجودی اتمیک از ربات (${targetUid})`,
              `wallet_delta=${walletDelta}, locked_delta=${lockedDelta}, new_wallet=${adj.wallet_balance}`
            );
            return res.json({
              success: true,
              user_id: targetUid,
              wallet_balance: adj.wallet_balance,
              escrow_locked_balance: adj.escrow_locked_balance,
              free_balance: adj.free_balance,
              pending_withdraw_total: pendingWithdrawTotal,
              available_balance: availableBalance,
              balances: {
                ...adj,
                pending_withdraw_total: pendingWithdrawTotal,
                available_balance: availableBalance,
              },
            });
          } catch (adjErr: any) {
            pushRuntimeLog('error', 'bot_sync', `خطا در adjust_wallet ربات (${targetUid})`, adjErr?.message || String(adjErr));
            return res.status(400).json({ success: false, error: adjErr?.message || 'خطا در به‌روزرسانی اتمیک کیف پول' });
          }
        }

        case 'create_commission_log': {
          const rawLog = body.log || body.commission_log || body.payload || body.data;
          if (!rawLog || typeof rawLog !== 'object') {
            return res.status(400).json({ success: false, error: 'داده commission_log نامعتبر است.' });
          }
          const lid = String(rawLog.id || `comm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
          const entry = {
            ...rawLog,
            id: lid,
            created_at: rawLog.created_at || nowIso,
          };
          await strictFirestoreWrite(`commission_logs/${lid}#tgcloud-comm-log`, (db) =>
            db.collection('commission_logs').doc(lid).set(entry, { merge: true })
          );
          return res.json({ success: true, log: entry });
        }

        case 'create_admin_log': {
          const rawLog = body.log || body.admin_log || body.payload || body.data;
          if (!rawLog || typeof rawLog !== 'object') {
            return res.status(400).json({ success: false, error: 'داده admin_log نامعتبر است.' });
          }
          const lid = String(rawLog.id || `adm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
          const entry = {
            ...rawLog,
            id: lid,
            admin_id: String(rawLog.admin_id || 'bot'),
            action: String(rawLog.action || 'bot_admin_action'),
            detail: String(rawLog.detail || rawLog.summary || ''),
            created_at: rawLog.created_at || nowIso,
          };
          memoryAuditLogs.unshift({
            id: lid,
            actor_id: entry.admin_id,
            actor_name: rawLog.actor_name || 'ربات تلگرام',
            actor_role: rawLog.actor_role || 'admin',
            action: entry.action,
            target_type: rawLog.target_type,
            target_id: rawLog.target_id,
            summary: entry.detail,
            created_at: entry.created_at,
          });
          if (memoryAuditLogs.length > 250) memoryAuditLogs.length = 250;
          await strictFirestoreWrite(`admin_logs/${lid}#tgcloud-admin-log`, (db) =>
            db.collection('admin_logs').doc(lid).set(entry, { merge: true })
          );
          return res.json({ success: true, log: entry });
        }

        case 'upsert_setting': {
          const key = String(body.key || body.setting?.key || '').trim();
          const value = body.value !== undefined ? body.value : body.setting?.value;
          const updatedBy = String(body.updated_by || body.setting?.updated_by || 'bot');
          if (!key) {
            return res.status(400).json({ success: false, error: 'کلید تنظیمات (key) الزامی است.' });
          }
          if (isSecretSettingKey(key)) {
            void recordSecurityAuditLog({
              event: 'blocked_secret_in_bot_settings',
              category: 'security',
              status: 'blocked',
              details: `تلاش مسدودشده برای ذخیره کلید حساس (${key}) در جدول bot_settings`,
            });
            return res.status(400).json({
              success: false,
              error: 'ذخیره کلیدهای محرمانه (SERVICE_ROLE / BOT_SYNC_SECRET / BOT_TOKEN) در جدول bot_settings ممنوع است.',
            });
          }
          const entry = {
            id: key,
            key,
            value: value ?? '',
            updated_by: updatedBy,
            updated_at: nowIso,
          };
          await strictFirestoreWrite(`bot_settings/${key}#tgcloud-setting`, (db) =>
            db.collection('bot_settings').doc(key).set(entry, { merge: true })
          );
          return res.json({ success: true, setting: entry });
        }

        case 'pull_user': {
          const rawId = String(body.id || '').trim();
          const rawTg = String(body.telegram_id || body.telegramId || '').trim();
          const rawPhone = String(body.phone || body.phone_number || '').trim();
          let matched: any = rawId ? await getUserById(rawId) : null;
          if (!matched && rawTg) matched = await findUserByTelegramId(rawTg);
          if (!matched && rawPhone) {
            const core10 = getPhoneCore10(rawPhone);
            if (core10) matched = await findUserByPhone(normalizeIranPhone(rawPhone) || rawPhone, core10);
          }
          if (!matched) {
            return res.status(404).json({ success: false, error: 'کاربر یافت نشد.' });
          }
          const { _col, financial_pin_hash: _pinHash, ...safeUser } = matched;
          const uid = String(safeUser.id);
          const walletBal = Math.max(0, Number(safeUser.wallet_balance || 0));
          const lockedBal = Math.min(walletBal, Math.max(0, Number(safeUser.escrow_locked_balance || 0)));
          const freeBal = Math.max(0, walletBal - lockedBal);
          const pendingWithdraw = await getPendingWithdrawTotal(uid);
          return res.json({
            success: true,
            user: {
              ...safeUser,
              free_balance: freeBal,
              pending_withdraw_total: pendingWithdraw,
              available_balance: Math.max(0, freeBal - pendingWithdraw),
            },
          });
        }

        case 'pull_deal': {
          const cid = String(body.contract_id || body.contractId || body.id || '').trim();
          if (!cid) {
            return res.status(400).json({ success: false, error: 'contract_id الزامی است.' });
          }
          const deal = await getDealByContractId(cid);
          if (!deal) {
            return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });
          }
          const enriched = await enrichDealWithParties(deal);
          return res.json({ success: true, deal: enriched });
        }

        case 'sign_contract':
        case 'pay_escrow':
        case 'deliver_contract':
        case 'request_revision':
        case 'approve_contract':
        case 'cancel_contract': {
          const cid = String(body.contract_id || body.contractId || body.deal?.contract_id || body.payload?.contract_id || body.id || '').trim();
          if (!cid) {
            return res.status(400).json({ success: false, error: 'contract_id الزامی است.' });
          }
          if (processingDealIds.has(cid)) {
            return res.status(409).json({ success: false, error: 'تغییر وضعیت همزمان در حال پردازش است.' });
          }
          processingDealIds.add(cid);
          try {
            const deal = await getDealByContractId(cid);
            if (!deal) {
              return res.status(404).json({ success: false, error: 'قرارداد مورد نظر یافت نشد.' });
            }
            const dealDocId = String(deal._docId || cid);
            const cur = normalizeDealStatus(deal.status);

            const rawActorId = String(body.user_id || body.userId || body.actor_id || body.actorId || '').trim();
            const rawActorTg = String(body.telegram_id || body.telegramId || body.tg_id || '').trim();
            const rawActorPhone = String(body.phone || body.phone_number || '').trim();
            let actor: any = rawActorId ? await getUserById(rawActorId) : null;
            if (!actor && rawActorTg) actor = await findUserByTelegramId(rawActorTg);
            if (!actor && !rawActorTg && rawActorId) actor = await findUserByTelegramId(rawActorId);
            if (!actor && rawActorPhone) {
              const core10 = getPhoneCore10(rawActorPhone);
              if (core10) actor = await findUserByPhone(normalizeIranPhone(rawActorPhone) || rawActorPhone, core10);
            }
            if (!actor && (rawActorId || rawActorTg)) {
              actor = {
                id: rawActorId || rawActorTg,
                telegram_id: rawActorTg || (/^\d+$/.test(rawActorId) ? rawActorId : undefined),
                full_name: String(body.full_name || body.fullName || 'کاربر میانجی'),
                phone_number: rawActorPhone || '',
              };
            }

            const noteText = String(body.note || body.reason || body.delivery_note || '').trim().slice(0, 1000);
            const attachmentUrl = typeof body.attachment_url === 'string' && body.attachment_url.length <= 2048 ? body.attachment_url : undefined;
            const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
            const prevHistory = Array.isArray(deal.history) ? deal.history : [];
            const amount = Math.max(0, Math.round(Number(deal.amount || 0)));
            const limits = await loadGlobalLimits();
            const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent ?? limits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));
            const breakdown = computeCommissionBreakdown(amount, feePercent, deal.commission_payer);

            if (action === 'sign_contract') {
              if (!actor) {
                return res.status(400).json({ success: false, error: 'اطلاعات امضاکننده (telegram_id یا user_id) الزامی است.' });
              }
              if (isTerminalStatus(cur)) {
                return res.status(400).json({ success: false, error: 'این قرارداد پیش‌تر مختومه شده است.' });
              }
              const actorStoredId = getStoredActorTelegramOrId(actor);
              const actorName = String(actor.full_name || actor.first_name || 'کاربر میانجی').trim();
              const actorPhone = normalizeIranPhone(String(actor.phone_number || '')) || null;
              const actorNationalId = actor.national_id ? normalizeDigits(String(actor.national_id)) : null;

              const buyerPending = isPendingPartyId(deal.buyer_id);
              const sellerPending = isPendingPartyId(deal.seller_id);
              const isBuyer = isUserDealBuyer(deal, actor);
              const isSeller = isUserDealSeller(deal, actor);

              let nextBuyerId: any = buyerPending ? null : deal.buyer_id;
              let nextSellerId: any = sellerPending ? null : deal.seller_id;
              let signRole: 'buyer' | 'seller' | null = isBuyer ? 'buyer' : isSeller ? 'seller' : null;

              if (!signRole) {
                if (buyerPending && !isUserDealCreator(deal, actor)) {
                  nextBuyerId = actorStoredId;
                  signRole = 'buyer';
                } else if (sellerPending && !isUserDealCreator(deal, actor)) {
                  nextSellerId = actorStoredId;
                  signRole = 'seller';
                } else if (buyerPending) {
                  nextBuyerId = actorStoredId;
                  signRole = 'buyer';
                } else if (sellerPending) {
                  nextSellerId = actorStoredId;
                  signRole = 'seller';
                }
              }

              if (!signRole) {
                return res.status(403).json({ success: false, error: 'کاربر مجاز به امضای این قرارداد نیست.' });
              }

              const sigHash = makeSignatureHash(cid, actorStoredId, signRole, nowIso);
              const buyerSignedAt = signRole === 'buyer' ? (deal.buyer_signed_at || nowIso) : (deal.buyer_signed_at ?? null);
              const sellerSignedAt = signRole === 'seller' ? (deal.seller_signed_at || nowIso) : (deal.seller_signed_at ?? null);
              const bothHaveParties = !isPendingPartyId(nextBuyerId) && !isPendingPartyId(nextSellerId);
              const bothSigned = Boolean(buyerSignedAt && sellerSignedAt);
              const nextStatus = cur === 'draft' && (!bothHaveParties || !bothSigned)
                ? 'pending_party_b'
                : ['draft', 'pending_party_b'].includes(cur) && bothHaveParties && bothSigned
                ? 'awaiting_payment'
                : cur === 'pending_party_b' && bothHaveParties
                ? 'awaiting_payment'
                : cur;

              const signNote = noteText || `قرارداد توسط ${actorName} از طریق ربات تلگرام تایید و امضا شد.`;
              const patchFields: Record<string, any> = {
                buyer_id: nextBuyerId,
                seller_id: nextSellerId,
                ...(signRole === 'buyer' && !deal.buyer_fullname ? { buyer_fullname: actorName, buyer_phone: actorPhone, buyer_national_id: actorNationalId } : {}),
                ...(signRole === 'seller' && !deal.seller_fullname ? { seller_fullname: actorName, seller_phone: actorPhone, seller_national_id: actorNationalId } : {}),
                buyer_signed_at: buyerSignedAt,
                seller_signed_at: sellerSignedAt,
                buyer_otp_verified: signRole === 'buyer' ? true : Boolean(deal.buyer_otp_verified),
                seller_otp_verified: signRole === 'seller' ? true : Boolean(deal.seller_otp_verified),
                buyer_signature_hash: signRole === 'buyer' ? sigHash : (deal.buyer_signature_hash ?? null),
                seller_signature_hash: signRole === 'seller' ? sigHash : (deal.seller_signature_hash ?? null),
                invite_mode: !bothHaveParties,
                status: nextStatus,
                timeline: [...prevTimeline, { id: `tl_${Date.now()}`, type: 'invite_signed', status: nextStatus, actor_id: String(actor.id), actor_name: actorName, note: signNote, timestamp: nowIso }],
                history: [...prevHistory, { event: signNote, timestamp: nowIso, actor: actorName, actor_id: actorStoredId }],
                updated_at: nowIso,
                updatedAt: nowIso,
              };

              await strictFirestoreWrite(`deals/${dealDocId}#bot-sign`, (db) =>
                db.collection('deals').doc(dealDocId).set({ ...patchFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
              );
              const updatedDeal = await enrichDealWithParties({ ...deal, ...patchFields });
              memoryDeals.set(cid, updatedDeal);
              void recordContractSignatureRecord({
                contractId: cid,
                user: actor,
                role: signRole,
                signatureHash: sigHash,
                signedAt: nowIso,
                otpVerified: true,
                verificationMethod: 'telegram_bot',
              });
              if (updatedDeal.buyer_id && !isPendingPartyId(updatedDeal.buyer_id)) wsBroadcastUser(String(updatedDeal.buyer_id), 'deal:updated', { contract: updatedDeal });
              if (updatedDeal.seller_id && !isPendingPartyId(updatedDeal.seller_id)) wsBroadcastUser(String(updatedDeal.seller_id), 'deal:updated', { contract: updatedDeal });
              wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal });
              return res.json({ success: true, deal: updatedDeal });
            }

            if (action === 'pay_escrow') {
              if (cur === 'active' && deal.escrow_deposit_status === 'paid_locked') {
                const enrichedExisting = await enrichDealWithParties(deal);
                return res.json({ success: true, already_paid: true, deal: enrichedExisting });
              }
              if (!['awaiting_payment', 'awaiting_receipt_approval'].includes(cur)) {
                return res.status(400).json({ success: false, error: `قرارداد در وضعیت ${cur} آماده قفل وجه نیست.` });
              }
              if (isPendingPartyId(deal.buyer_id) || isPendingPartyId(deal.seller_id)) {
                return res.status(400).json({ success: false, error: 'هر دو طرف قرارداد باید مشخص شده باشند.' });
              }

              const buyerId = String(deal.buyer_id);
              const buyer = (await getUserById(buyerId)) || { id: buyerId, wallet_balance: 0, escrow_locked_balance: 0 };
              const buyerDocId = String((buyer as any).id || buyerId);
              const lockAmount = breakdown.employerTotalPayable;
              const pendingWithdrawTotal = await getPendingWithdrawTotal(buyerDocId);
              const freeBal = Math.max(0, Number(buyer.wallet_balance || 0) - Number(buyer.escrow_locked_balance || 0));
              if (Math.max(0, freeBal - pendingWithdrawTotal) < lockAmount) {
                return res.status(400).json({ success: false, error: 'موجودی آزاد کارفرما برای قفل وجه امانی کافی نیست.' });
              }

              const lockTxId = `lock_${cid}_${Date.now()}`;
              const lockRes = await adjustUserWalletAtomic(buyerDocId, 0, lockAmount, true, {
                txId: lockTxId,
                txType: 'escrow_lock',
                title: `قفل امن وجه برای معامله ${deal.title}`,
                contractId: cid,
              });
              if (supabaseState.ready) {
                const prevList = memoryTransactions.get(buyerDocId) || [];
                if (!prevList.some((t) => String(t.id) === lockTxId)) {
                  memoryTransactions.set(buyerDocId, [{ id: lockTxId, user_id: buyerDocId, contract_id: cid, amount: lockAmount, type: 'escrow_lock', status: 'completed', description: `قفل امن وجه برای معامله ${deal.title}`, created_at: nowIso }, ...prevList]);
                }
              }

              const deadlineDays = Math.max(1, Math.min(365, Number(deal.deadline || 7) || 7));
              const deliveryDue = new Date(Date.now() + deadlineDays * 86400000).toISOString();
              const useStaged = Boolean((deal.staged_payment ?? deal.is_milestone) && Array.isArray(deal.milestones) && deal.milestones.length >= 2);
              const payNote = noteText || `مبلغ ${lockAmount.toLocaleString()} تومان از طریق ربات در حساب امانت قفل شد`;
              const patchFields: Record<string, any> = {
                status: 'active',
                escrow_deposit_status: 'paid_locked',
                locked_amount: lockAmount,
                escrow_locked_amount: lockAmount,
                escrow_released_amount: 0,
                paid_at: nowIso,
                delivery_due_at: deliveryDue,
                delivery_deadline: deliveryDue,
                ...(useStaged ? { milestones: deal.milestones.map((m: any, i: number) => ({ ...m, status: i === 0 ? 'active' : 'pending' })) } : {}),
                timeline: [...prevTimeline, { id: `tl_${Date.now()}`, type: 'status_change', status: 'active', actor_id: buyerDocId, actor_name: String(buyer.full_name || 'کارفرما'), note: payNote, timestamp: nowIso }],
                history: [...prevHistory, { event: payNote, timestamp: nowIso, actor: String(buyer.full_name || 'کارفرما'), actor_id: buyerId }],
                updated_at: nowIso,
                updatedAt: nowIso,
              };

              await strictFirestoreWrite(`deals/${dealDocId}#bot-pay`, (db) =>
                db.collection('deals').doc(dealDocId).set({ ...patchFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
              );
              const updatedDeal = await enrichDealWithParties({ ...deal, ...patchFields });
              memoryDeals.set(cid, updatedDeal);
              const bBal = { wallet_balance: lockRes.wallet_balance, escrow_locked_balance: lockRes.escrow_locked_balance };
              wsBroadcastUser(buyerDocId, 'deal:updated', { contract: updatedDeal, balances: { [buyerDocId]: bBal } });
              if (updatedDeal.seller_id) wsBroadcastUser(String(updatedDeal.seller_id), 'deal:updated', { contract: updatedDeal });
              wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: { [buyerDocId]: bBal } });
              return res.json({ success: true, deal: updatedDeal, balances: lockRes });
            }

            if (action === 'deliver_contract') {
              if (!['active', 'revisions_requested'].includes(cur)) {
                return res.status(400).json({ success: false, error: 'قرارداد در مرحله اجرا نیست.' });
              }
              if (actor && !isUserDealSeller(deal, actor) && actor.role !== 'owner' && actor.role !== 'admin') {
                return res.status(403).json({ success: false, error: 'فقط مجری می‌تواند تحویل کار را ثبت کند.' });
              }
              const minHours = isProd ? 1 : 0.001;
              const hours = Math.max(minHours, Math.min(720, Number(deal.inspection_hours) || 48));
              const actorName = String(actor?.full_name || deal.seller_fullname || 'مجری');
              const delNote = noteText || 'کار تحویل داده شد و دوره بازرسی آغاز شد';
              const patchFields: Record<string, any> = {
                status: 'work_submitted',
                work_submitted_at: nowIso,
                auto_release_at: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
                auto_release_warning_sent: null,
                ...(noteText ? { delivery_note: noteText } : {}),
                ...(attachmentUrl ? { delivery_attachment_url: attachmentUrl } : {}),
                timeline: [...prevTimeline, { id: `tl_${Date.now()}`, type: 'status_change', status: 'work_submitted', actor_id: String(actor?.id || deal.seller_id || ''), actor_name: actorName, note: delNote, ...(attachmentUrl ? { attachment_url: attachmentUrl } : {}), timestamp: nowIso }],
                history: [...prevHistory, { event: delNote, timestamp: nowIso, actor: actorName, actor_id: deal.seller_id }],
                updated_at: nowIso,
                updatedAt: nowIso,
              };
              await strictFirestoreWrite(`deals/${dealDocId}#bot-deliver`, (db) =>
                db.collection('deals').doc(dealDocId).set({ ...patchFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
              );
              const updatedDeal = await enrichDealWithParties({ ...deal, ...patchFields });
              memoryDeals.set(cid, updatedDeal);
              if (updatedDeal.buyer_id) wsBroadcastUser(String(updatedDeal.buyer_id), 'deal:updated', { contract: updatedDeal });
              if (updatedDeal.seller_id) wsBroadcastUser(String(updatedDeal.seller_id), 'deal:updated', { contract: updatedDeal });
              wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal });
              return res.json({ success: true, deal: updatedDeal });
            }

            if (action === 'request_revision') {
              if (cur !== 'work_submitted') {
                return res.status(400).json({ success: false, error: 'درخواست اصلاح فقط پس از تحویل کار ممکن است.' });
              }
              if (actor && !isUserDealBuyer(deal, actor) && actor.role !== 'owner' && actor.role !== 'admin') {
                return res.status(403).json({ success: false, error: 'فقط کارفرما می‌تواند درخواست اصلاح ثبت کند.' });
              }
              const actorName = String(actor?.full_name || deal.buyer_fullname || 'کارفرما');
              const curEditsLeft = Math.max(0, Number(deal.free_edits_left ?? deal.free_edits ?? deal.revisions ?? 0));
              const nextEditsLeft = curEditsLeft > 0 ? curEditsLeft - 1 : 0;
              const revNote = noteText || 'کارفرما درخواست اصلاح کار را ثبت کرد';
              const patchFields: Record<string, any> = {
                status: 'revisions_requested',
                auto_release_at: null,
                auto_release_warning_sent: null,
                free_edits_left: nextEditsLeft,
                revisions: String(nextEditsLeft),
                ...(noteText ? { revision_note: noteText } : {}),
                timeline: [...prevTimeline, { id: `tl_${Date.now()}`, type: 'status_change', status: 'revisions_requested', actor_id: String(actor?.id || deal.buyer_id || ''), actor_name: actorName, note: revNote, timestamp: nowIso }],
                history: [...prevHistory, { event: revNote, timestamp: nowIso, actor: actorName, actor_id: deal.buyer_id }],
                updated_at: nowIso,
                updatedAt: nowIso,
              };
              await strictFirestoreWrite(`deals/${dealDocId}#bot-revision`, (db) =>
                db.collection('deals').doc(dealDocId).set({ ...patchFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
              );
              const updatedDeal = await enrichDealWithParties({ ...deal, ...patchFields });
              memoryDeals.set(cid, updatedDeal);
              if (updatedDeal.buyer_id) wsBroadcastUser(String(updatedDeal.buyer_id), 'deal:updated', { contract: updatedDeal });
              if (updatedDeal.seller_id) wsBroadcastUser(String(updatedDeal.seller_id), 'deal:updated', { contract: updatedDeal });
              wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal });
              return res.json({ success: true, deal: updatedDeal });
            }

            if (action === 'approve_contract') {
              if (cur === 'completed' && deal.escrow_deposit_status === 'released') {
                const enrichedExisting = await enrichDealWithParties(deal);
                return res.json({ success: true, already_completed: true, deal: enrichedExisting });
              }
              if (cur !== 'work_submitted') {
                return res.status(400).json({ success: false, error: 'تایید و آزادسازی وجه فقط در وضعیت تحویل‌شده امکان‌پذیر است.' });
              }
              if (actor && !isUserDealBuyer(deal, actor) && actor.role !== 'owner' && actor.role !== 'admin') {
                return res.status(403).json({ success: false, error: 'فقط کارفرما یا مدیر می‌تواند معامله را تایید و تسویه کند.' });
              }
              const actorName = String(actor?.full_name || deal.buyer_fullname || 'کارفرما');
              const appNote = noteText || 'تایید نهایی انجام و وجه برای مجری آزاد شد';
              const nextFields: Record<string, any> = {
                status: 'completed',
                escrow_deposit_status: 'released',
                auto_release_at: null,
                auto_release_warning_sent: null,
                completed_at: nowIso,
                timeline: [...prevTimeline, { id: `tl_${Date.now()}`, type: 'status_change', status: 'completed', actor_id: String(actor?.id || deal.buyer_id || ''), actor_name: actorName, note: appNote, timestamp: nowIso }],
                history: [...prevHistory, { event: appNote, timestamp: nowIso, actor: actorName, actor_id: deal.buyer_id }],
                updated_at: nowIso,
                updatedAt: nowIso,
              };
              const payout = await executeEscrowPayout({
                cid,
                deal,
                grossUnlockAmount: breakdown.employerTotalPayable,
                sellerGrossAmount: amount,
                feePercent,
                buyerId: String(deal.buyer_id),
                sellerId: String(deal.seller_id),
                nextDealFields: nextFields,
                releaseDescription: `آزادسازی و تسویه معامله ${deal.title}`,
                incrementCompletedCount: true,
              });
              const updatedDeal = await enrichDealWithParties({ ...deal, ...nextFields });
              memoryDeals.set(cid, updatedDeal);
              if (updatedDeal.buyer_id) wsBroadcastUser(String(updatedDeal.buyer_id), 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
              if (updatedDeal.seller_id) wsBroadcastUser(String(updatedDeal.seller_id), 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
              wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: payout.balancesPayload });
              return res.json({ success: true, deal: updatedDeal, balances: payout.balancesPayload, fee_amount: payout.feeAmount, seller_net: payout.sellerNet });
            }

            // cancel_contract
            if (cur === 'cancelled') {
              const enrichedExisting = await enrichDealWithParties(deal);
              return res.json({ success: true, already_cancelled: true, deal: enrichedExisting });
            }
            if (cur === 'completed') {
              return res.status(400).json({ success: false, error: 'قرارداد تکمیل‌شده قابل لغو نیست.' });
            }
            if (
              actor &&
              !isUserDealBuyer(deal, actor) &&
              !isUserDealSeller(deal, actor) &&
              !isUserDealCreator(deal, actor) &&
              actor.role !== 'owner' &&
              actor.role !== 'admin'
            ) {
              return res.status(403).json({ success: false, error: 'شما مجاز به لغو این قرارداد نیستید.' });
            }

            let refundBalances: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};
            const buyerId = String(deal.buyer_id || '');
            const wasPaidLocked = deal.escrow_deposit_status === 'paid_locked';
            if (wasPaidLocked && buyerId && !isPendingPartyId(buyerId)) {
              const buyerObj = (await getUserById(buyerId)) || { id: buyerId, wallet_balance: 0, escrow_locked_balance: 0 };
              const buyerDocId = String((buyerObj as any).id || buyerId);
              const curLocked = Math.max(0, Number(buyerObj.escrow_locked_balance || 0));
              const lockedAmt = Math.min(curLocked, Number(deal.locked_amount ?? deal.escrow_locked_amount ?? breakdown.employerTotalPayable));
              if (lockedAmt > 0) {
                const unlockRes = await adjustUserWalletAtomic(buyerDocId, 0, -lockedAmt, false, {
                  txId: `unlock_cancel_${cid}_${Date.now()}`,
                  txType: 'escrow_refund',
                  title: `استرداد وجه قفل‌شده به دلیل لغو قرارداد ${deal.title}`,
                  contractId: cid,
                });
                const bBal = { wallet_balance: unlockRes.wallet_balance, escrow_locked_balance: unlockRes.escrow_locked_balance };
                refundBalances[buyerDocId] = bBal;
                refundBalances[buyerId] = bBal;
              }
            }

            const actorName = String(actor?.full_name || 'ربات میانجی');
            const cancelNote = noteText || 'قرارداد لغو شد';
            const patchFields: Record<string, any> = {
              status: 'cancelled',
              escrow_deposit_status: wasPaidLocked ? 'refunded' : 'unpaid',
              auto_release_at: null,
              auto_release_warning_sent: null,
              timeline: [...prevTimeline, { id: `tl_${Date.now()}`, type: 'status_change', status: 'cancelled', actor_id: String(actor?.id || 'bot'), actor_name: actorName, note: cancelNote, timestamp: nowIso }],
              history: [...prevHistory, { event: cancelNote, timestamp: nowIso, actor: actorName, actor_id: actor?.id || 'bot' }],
              updated_at: nowIso,
              updatedAt: nowIso,
            };
            await strictFirestoreWrite(`deals/${dealDocId}#bot-cancel`, (db) =>
              db.collection('deals').doc(dealDocId).set({ ...patchFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
            );
            const updatedDeal = await enrichDealWithParties({ ...deal, ...patchFields });
            memoryDeals.set(cid, updatedDeal);
            if (updatedDeal.buyer_id && !isPendingPartyId(updatedDeal.buyer_id)) wsBroadcastUser(String(updatedDeal.buyer_id), 'deal:updated', { contract: updatedDeal, balances: refundBalances });
            if (updatedDeal.seller_id && !isPendingPartyId(updatedDeal.seller_id)) wsBroadcastUser(String(updatedDeal.seller_id), 'deal:updated', { contract: updatedDeal, balances: refundBalances });
            wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal, balances: refundBalances });
            return res.json({ success: true, deal: updatedDeal, balances: refundBalances });
          } finally {
            processingDealIds.delete(cid);
          }
        }

        case 'pull_all': {
          const limitNum = Math.max(1, Math.min(500, Number(body.limit || 200)));
          const [usersList, dealsList, walletReqs] = await Promise.all([
            getAllUsersMerged(),
            getAllDealsMerged(),
            loadWalletRequests(),
          ]);
          const safeUsers = usersList.slice(0, limitNum).map((u: any) => {
            const { financial_pin_hash: _pin, ...rest } = u;
            return rest;
          });
          const dealsEnriched = await Promise.all(dealsList.slice(0, limitNum).map((d) => enrichDealWithParties(d)));
          let botSettings: any[] = [];
          if (firestore) {
            const snap = await firestore.collection('bot_settings').limit(100).get().catch(() => null);
            if (snap) {
              botSettings = snap.docs
                .map((d) => ({ id: d.id, ...(d.data() || {}) }))
                .filter((s: any) => !isSecretSettingKey(String(s.key || s.id || '')));
            }
          }
          return res.json({
            success: true,
            persistence_mode: getPersistenceStatus().mode,
            users: safeUsers,
            deals: dealsEnriched,
            wallet_requests: walletReqs.slice(0, limitNum),
            bot_settings: botSettings,
          });
        }

        default:
          return res.status(400).json({ success: false, error: `اکشن پشتیبانی‌نشده: ${action}` });
      }
    } catch (err: any) {
      pushRuntimeLog('error', 'bot_sync', 'خطا در tgcloud/sync', err?.message || String(err));
      res.status(500).json({ success: false, error: err?.message || 'خطا در همگام‌سازی ربات' });
    }
  });

  // Safe Authenticated User Lookup by Phone (rate-limited, requires valid session)
  app.get('/api/users/lookup', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const actorId = String(authResult.actor.id);
    if (!checkBucketLimit(lookupRateMap, actorId, 25, 60 * 1000)) {
      return res.status(429).json({
        success: false,
        error: 'تعداد استعلام شماره بیش از حد مجاز است. لطفاً کمی صبر کنید.',
      });
    }

    const { phone } = req.query;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, error: 'شماره همراه الزامی است' });
    }

    const parsedPhone = parseIranMobile(phone);
    if (!parsedPhone.valid) {
      return res.status(400).json({ success: false, error: 'شماره همراه معتبر نیست (مثال: 09123456789 یا +989123456789)' });
    }

    try {
      const found = await findUserByPhone(parsedPhone.local, parsedPhone.core10);
      if (found) {
        return res.json({
          success: true,
          user: {
            id: String(found.id),
            full_name: found.full_name || 'کاربر میانجی',
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
      const [limits, platformStats, bot_username] = await Promise.all([
        loadGlobalLimits(),
        loadPlatformStats(),
        resolveBotUsername(),
      ]);
      const previewMode = !isProd && !Boolean((process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim());
      res.json({ success: true, limits, platformStats, bot_username, previewMode, persistence: getPersistenceStatus() });
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

      let cleanCardNumber = typeof body.deposit_card_number === 'string'
        ? normalizeDigits(body.deposit_card_number).replace(/[^0-9]/g, '')
        : (globalLimits.deposit_card_number || '');
      if (cleanCardNumber) {
        const cardCheck = isValidIranianCard(cleanCardNumber);
        if (!cardCheck.valid) {
          return res.status(400).json({ success: false, error: 'شماره کارت ۱۶ رقمی مقصد واریز معتبر نیست.' });
        }
        cleanCardNumber = cardCheck.normalized;
      }

      let cleanSheba = typeof body.deposit_sheba === 'string'
        ? normalizeDigits(body.deposit_sheba).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
        : (globalLimits.deposit_sheba || '');
      if (cleanSheba) {
        const shebaCheck = validateIranianPayoutDestination(cleanSheba);
        if (!shebaCheck.valid || shebaCheck.kind !== 'sheba') {
          return res.status(400).json({ success: false, error: shebaCheck.error || 'شماره شبای مقصد معتبر نیست (IR + 24 رقم).' });
        }
        cleanSheba = shebaCheck.normalized || cleanSheba;
      }

      const cleanHolder = typeof body.deposit_card_holder === 'string'
        ? body.deposit_card_holder.trim().slice(0, 80)
        : (globalLimits.deposit_card_holder || '');
      const cleanNote = typeof body.deposit_note === 'string'
        ? body.deposit_note.trim().slice(0, 240)
        : (globalLimits.deposit_note || '');

      const nextLimits: GlobalLimits = {
        min_deal_amount: Math.max(1000, Number(body.min_deal_amount ?? globalLimits.min_deal_amount) || 10000),
        default_max_deal_amount: Math.max(10000, Number(body.default_max_deal_amount ?? globalLimits.default_max_deal_amount) || 100000000),
        default_daily_withdraw_limit: Math.max(10000, Number(body.default_daily_withdraw_limit ?? globalLimits.default_daily_withdraw_limit) || 50000000),
        default_max_active_deals: Math.max(1, Math.min(200, Number(body.default_max_active_deals ?? globalLimits.default_max_active_deals) || 10)),
        max_admin_balance_adjust: Math.max(0, Number(body.max_admin_balance_adjust ?? globalLimits.max_admin_balance_adjust) || 20000000),
        platform_fee_percent: (() => {
          const rawFee = body.platform_fee_percent ?? globalLimits.platform_fee_percent;
          const parsedFee = Number(rawFee);
          return Number.isFinite(parsedFee) ? Math.max(0, Math.min(15, parsedFee)) : DEFAULT_PLATFORM_FEE_PERCENT;
        })(),
        deposit_card_number: cleanCardNumber,
        deposit_card_holder: cleanHolder,
        deposit_sheba: cleanSheba,
        deposit_note: cleanNote,
      };
      globalLimits = nextLimits;

      await strictFirestoreWrite('system_settings/limits', (db) =>
        db.collection('system_settings').doc('limits').set(
          { ...nextLimits, updatedAt: FieldValue.serverTimestamp(), updated_by: String(authResult.actor.id) },
          { merge: true }
        )
      );

      await recordAuditLog(
        authResult.actor,
        'limits_updated',
        `به‌روزرسانی لیمیت‌های کل پلتفرم و کارمزد (${nextLimits.platform_fee_percent}٪)`,
        { type: 'system', id: 'limits' }
      );
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
    if (!hasAnyAdminPermission(authResult.actor, ['manage_users', 'manage_kyc'])) {
      return res.status(403).json({ success: false, error: 'شما مجوز مشاهده لیست کاربران یا احراز هویت را ندارید.' });
    }

    try {
      const limits = await loadGlobalLimits();
      const allUsers = await getAllUsersMerged();
      const q = normalizeDigits(String(req.query.q || '')).toLowerCase();

      const filtered = q
        ? allUsers.filter((u) => {
            const name = String(u.full_name || '').toLowerCase();
            const phoneDigits = normalizeDigits(String(u.phone_number || u.phone || '')).replace(/[^0-9]/g, '');
            const corePhone = getPhoneCore10(u.phone_number || u.phone || '');
            const qDigits = normalizeDigits(q).replace(/[^0-9]/g, '');
            const qCore = getPhoneCore10(q);
            const username = String(u.username || '').toLowerCase();
            const id = String(u.id || '').toLowerCase();
            const tgId = String(u.telegram_id || '').toLowerCase();
            return (
              name.includes(q) ||
              (qDigits ? phoneDigits.includes(qDigits) || (qCore ? corePhone === qCore : corePhone.includes(qDigits)) : false) ||
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
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_users');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
    }

    try {
      const { full_name, phone_number, username, wallet_balance, role, permissions, kyc_status, max_deal_amount, daily_withdraw_limit, max_active_deals } =
        req.body || {};
      const parsedPhone = parseIranMobile(phone_number || '');
      const cleanName = String(full_name || '').trim();
      if (!cleanName || !parsedPhone.valid) {
        return res.status(400).json({ success: false, error: 'نام کامل و شماره همراه معتبر (مثل 09123456789 یا +989123456789) الزامی است.' });
      }
      if (role && role !== 'user' && authResult.actor.role !== 'owner') {
        return res.status(403).json({ success: false, error: 'فقط مالک کل می‌تواند نقش مدیر تعیین کند.' });
      }

      const duplicateByPhone = await findUserByPhone(parsedPhone.local, parsedPhone.core10);
      if (duplicateByPhone) {
        return res.status(409).json({
          success: false,
          error: 'این شماره همراه قبلاً در سیستم ثبت شده است.',
        });
      }

      const assignedRole = ['user', 'admin', 'owner'].includes(role) ? role : 'user';
      const assignedKyc = ['pending', 'verified', 'rejected', 'needs_correction', 'unverified'].includes(kyc_status)
        ? kyc_status
        : 'verified';
      const userId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const nowIso = new Date().toISOString();
      const newUser: any = {
        id: userId,
        full_name: cleanName.slice(0, 100),
        phone_number: parsedPhone.local,
        phone_core_digits: parsedPhone.core10,
        username: String(username || '').trim().slice(0, 64),
        role: assignedRole,
        ...(assignedRole === 'admin'
          ? { permissions: sanitizeAdminPermissionsPatch(permissions, DEFAULT_ADMIN_PERMISSIONS) }
          : {}),
        kyc_status: assignedKyc,
        is_verified: assignedKyc === 'verified',
        wallet_balance: Math.max(0, Number(wallet_balance || 0)),
        escrow_locked_balance: 0,
        is_blocked: false,
        created_at: nowIso,
      };
      if (Number(max_deal_amount) > 0) newUser.max_deal_amount = Number(max_deal_amount);
      if (Number(daily_withdraw_limit) > 0) newUser.daily_withdraw_limit = Number(daily_withdraw_limit);
      if (Number(max_active_deals) > 0) newUser.max_active_deals = Number(max_active_deals);

      await strictFirestoreWrite(`users/${userId}#admin-create`, (db) =>
        db.collection('users').doc(userId).set({
          ...newUser,
          updatedAt: FieldValue.serverTimestamp(),
        })
      );
      memoryUsers.set(userId, newUser);

      await recordAuditLog(
        authResult.actor,
        'user_created',
        `ایجاد حساب جدید: ${newUser.full_name} (${newUser.role})`,
        { type: 'user', id: userId }
      );
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
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_users');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
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
        const parsedPhone = parseIranMobile(body.phone_number);
        if (!parsedPhone.valid) {
          return res.status(400).json({ success: false, error: 'شماره همراه وارد شده معتبر نیست (مثال: 09123456789 یا +989123456789).' });
        }
        const existingOther = await findUserByPhone(parsedPhone.local, parsedPhone.core10);
        if (existingOther && String(existingOther.id) !== targetId) {
          return res.status(409).json({ success: false, error: 'این شماره همراه متعلق به کاربر دیگری است.' });
        }
        updates.phone_number = parsedPhone.local;
        updates.phone_core_digits = parsedPhone.core10;
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
        if (body.role === 'admin' && !targetUser.permissions && !body.permissions) {
          updates.permissions = { ...DEFAULT_ADMIN_PERMISSIONS };
        }
      }

      if (body.permissions !== undefined) {
        if (!actorIsOwner) {
          return res.status(403).json({ success: false, error: 'فقط مالک کل می‌تواند سطوح دسترسی ادمین‌ها را تغییر دهد.' });
        }
        updates.permissions = sanitizeAdminPermissionsPatch(
          body.permissions,
          normalizeAdminPermissions(targetUser.permissions)
        );
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

      const curWallet = Math.max(0, Number(targetUser.wallet_balance || 0));
      const curLocked = Math.max(0, Number(targetUser.escrow_locked_balance || 0));
      const effectiveWallet = updates.wallet_balance !== undefined ? Number(updates.wallet_balance) : curWallet;
      const effectiveLocked = updates.escrow_locked_balance !== undefined ? Number(updates.escrow_locked_balance) : curLocked;
      if (effectiveLocked > effectiveWallet) {
        return res.status(400).json({
          success: false,
          error: 'موجودی قفل‌شده امانی (escrow_locked_balance) نمی‌تواند بیشتر از موجودی کل کیف پول (wallet_balance) باشد.',
        });
      }

      const walletDelta = updates.wallet_balance !== undefined ? Math.round(effectiveWallet - curWallet) : 0;
      const lockedDelta = updates.escrow_locked_balance !== undefined ? Math.round(effectiveLocked - curLocked) : 0;
      let finalWallet = effectiveWallet;
      let finalLocked = effectiveLocked;
      if (walletDelta !== 0 || lockedDelta !== 0) {
        const adj = await adjustUserWalletAtomic(targetId, walletDelta, lockedDelta, false, {
          txId: `adm_adj_${targetId}_${Date.now()}`,
          txType: 'admin_adjust',
          title: 'تعدیل موجودی توسط مدیر',
        });
        finalWallet = adj.wallet_balance;
        finalLocked = adj.escrow_locked_balance;
      }

      const nonBalanceUpdates = { ...updates };
      delete nonBalanceUpdates.wallet_balance;
      delete nonBalanceUpdates.escrow_locked_balance;

      const mergedUser = {
        ...targetUser,
        ...nonBalanceUpdates,
        wallet_balance: finalWallet,
        escrow_locked_balance: finalLocked,
        id: targetId,
      };
      memoryUsers.set(targetId, mergedUser);

      if (Object.keys(nonBalanceUpdates).length > 0 || !supabaseState.ready) {
        await strictFirestoreWrite(`users/${targetId}#admin-patch`, (db) =>
          db.collection('users').doc(targetId).set(
            {
              ...nonBalanceUpdates,
              ...(!supabaseState.ready ? { wallet_balance: finalWallet, escrow_locked_balance: finalLocked } : {}),
              id: targetId,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        );
      }

      if (typeof body.is_blocked === 'boolean' || typeof body.is_withdraw_locked === 'boolean') {
        void recordSecurityAuditLog({
          userId: targetId,
          phoneNumber: mergedUser.phone_number || null,
          event: typeof body.is_blocked === 'boolean' ? (body.is_blocked ? 'user_blocked' : 'user_unblocked') : 'withdraw_lock_changed',
          category: 'admin_security',
          status: 'success',
          details: `تغییر وضعیت امنیتی کاربر ${targetId} توسط مدیر ${authResult.actor.id}`,
        });
      }

      wsBroadcastUser(targetId, 'user:updated', { userId: targetId, user: mergedUser });
      await recordAuditLog(
        authResult.actor,
        'user_updated',
        `ویرایش کاربر ${mergedUser.full_name || targetId} (فیلدها: ${Object.keys(updates).join(', ')})`,
        { type: 'user', id: targetId }
      );
      console.log(`[ADMIN-AUDIT] ${authResult.actor.id} updated user ${targetId} fields=[${Object.keys(updates).join(',')}]`);
      res.json({ success: true, user: mergedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ویرایش اطلاعات کاربر' });
    }
  });

  app.patch('/api/admin/users/:targetId/permissions', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    if (authResult.actor.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'فقط مالک کل (Owner) می‌تواند دسترسی ادمین‌ها را تغییر دهد.' });
    }
    try {
      const targetId = String(req.params.targetId || '').trim();
      const targetUser = await getUserById(targetId);
      if (!targetUser) {
        return res.status(404).json({ success: false, error: 'حساب مدیر یافت نشد.' });
      }
      if (targetUser.role === 'owner') {
        return res.status(400).json({ success: false, error: 'دسترسی‌های مالک کل همواره کامل است و قابل محدودسازی نیست.' });
      }
      const nextPerms = sanitizeAdminPermissionsPatch(
        req.body?.permissions ?? req.body,
        normalizeAdminPermissions(targetUser.permissions)
      );
      const nextRole = targetUser.role === 'admin' ? 'admin' : 'admin';
      const mergedUser = { ...targetUser, id: targetId, role: nextRole, permissions: nextPerms };
      memoryUsers.set(targetId, mergedUser);

      await strictFirestoreWrite(`users/${targetId}#rbac`, (db) =>
        db.collection('users').doc(targetId).set(
          {
            role: nextRole,
            permissions: nextPerms,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      );

      wsBroadcastUser(targetId, 'user:updated', { userId: targetId, user: mergedUser });
      await recordAuditLog(
        authResult.actor,
        'admin_permissions_updated',
        `تغییر دسترسی ادمین ${mergedUser.full_name || targetId}: ${Object.entries(nextPerms)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ') || 'بدون دسترسی'}`,
        { type: 'user', id: targetId }
      );
      res.json({ success: true, user: mergedUser, permissions: nextPerms });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ذخیره سطح دسترسی ادمین' });
    }
  });

  app.post('/api/admin/users/:targetId/impersonate', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_users');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
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
      if (!supabaseState.ready && hasAdminCredentials && adminApp) {
        try {
          customToken = await getAuth(adminApp).createCustomToken(targetId);
        } catch {
          console.warn('[ADMIN] createCustomToken unavailable for impersonation; using session fallback');
        }
      }

      const sessionToken = signSessionToken(targetId, targetUser.role || 'user');
      await recordAuditLog(
        authResult.actor,
        'user_impersonated',
        `ورود مدیریتی به حساب ${targetUser.full_name || targetId}`,
        { type: 'user', id: targetId }
      );
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
    message_type: 'text' | 'image' | 'voice' | 'audio' | 'file';
    attachment_url?: string;
    views: number;
    silent?: boolean;
    reactions?: Record<string, string[]>;
    created_at: string;
  }

  const memoryChannels = new Map<string, ChannelRecord>();
  const memoryChannelPosts = new Map<string, ChannelPostRecord[]>();

  // GET all channels
  app.get('/api/channels', async (_req, res) => {
    try {
      const merged = new Map<string, ChannelRecord>(!hasDbReady() ? memoryChannels : []);
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
      const memPosts = !hasDbReady() ? memoryChannelPosts.get(channelId) || [] : [];
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
      let ch: ChannelRecord | undefined = memoryChannels.get(channelId);
      if (!ch) {
        const firestore = getDb();
        if (firestore) {
          const chSnap = await firestore.collection('channels').doc(channelId).get().catch(() => null);
          if (chSnap?.exists) {
            ch = { channel_id: chSnap.id, ...(chSnap.data() as any) } as ChannelRecord;
            memoryChannels.set(channelId, ch);
          }
        }
      }
      if (!ch) {
        return res.status(404).json({ success: false, error: 'کانال مورد نظر یافت نشد.' });
      }
      if (String(ch.owner_id) !== uid && !isAdminActor) {
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
        message_type: ['text', 'image', 'voice', 'audio', 'file'].includes(message_type) ? message_type : 'text',
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

      let ch = memoryChannels.get(channelId);
      const posts = memoryChannelPosts.get(channelId) || [];
      let target = posts.find((p) => p.id === postId);
      const firestore = getDb();
      if (firestore && (!ch || !target)) {
        if (!ch) {
          const chSnap = await firestore.collection('channels').doc(channelId).get().catch(() => null);
          if (chSnap?.exists) {
            ch = { channel_id: chSnap.id, ...(chSnap.data() as any) } as ChannelRecord;
            memoryChannels.set(channelId, ch);
          }
        }
        if (!target) {
          const pSnap = await firestore.collection('channel_posts').doc(postId).get().catch(() => null);
          if (pSnap?.exists) {
            const d = pSnap.data() as any;
            target = {
              id: pSnap.id,
              channel_id: d.channel_id || channelId,
              author_id: String(d.author_id || ''),
              author_name: d.author_name || 'مدیر کانال',
              text: d.text || '',
              message_type: d.message_type || 'text',
              views: Number(d.views || 1),
              reactions: d.reactions || {},
              created_at: String(d.created_at || ''),
            };
          }
        }
      }
      if (!target) {
        return res.status(404).json({ success: false, error: 'پست مورد نظر یافت نشد.' });
      }
      if (!isAdminActor && String(target.author_id) !== uid && String(ch?.owner_id || '') !== uid) {
        return res.status(403).json({ success: false, error: 'فقط نویسنده یا مدیر کانال می‌تواند پست را حذف کند.' });
      }

      memoryChannelPosts.set(channelId, posts.filter((p) => p.id !== postId));
      if (firestore) {
        await firestore.collection('channel_posts').doc(postId).delete().catch(() => {});
      }

      wsBroadcastRoom(`channel:${channelId}`, 'channel:post_deleted', { channelId, postId });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در حذف پست' });
    }
  });

  // POST toggle subscription count (deduplicated per actor)
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
      const firestore = getDb();

      let wasSubscribed = subs.has(uid);
      if (firestore && !wasSubscribed) {
        const subSnap = await firestore
          .collection('channels')
          .doc(channelId)
          .collection('subscribers')
          .doc(uid)
          .get()
          .catch(() => null);
        if (subSnap?.exists) wasSubscribed = true;
      }

      if (wasSubscribed === subscribed) {
        return res.json({ success: true, subscribers_count: memoryChannels.get(channelId)?.subscribers_count });
      }

      if (subscribed) subs.add(uid);
      else subs.delete(uid);
      memoryChannelSubscribers.set(channelId, subs);

      const ch = memoryChannels.get(channelId);
      if (ch) {
        const nextCount = Math.max(1, ch.subscribers_count + (subscribed ? 1 : -1));
        memoryChannels.set(channelId, { ...ch, subscribers_count: nextCount });
      }
      if (firestore) {
        try {
          const chRef = firestore.collection('channels').doc(channelId);
          const subRef = chRef.collection('subscribers').doc(uid);
          if (subscribed) {
            await subRef.set({ uid, subscribedAt: FieldValue.serverTimestamp() });
          } else {
            await subRef.delete();
          }
          await chRef.update({
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
    sessionId?: string;
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
    const raw = String(userId || '').trim();
    if (!raw || raw === 'null' || raw === 'undefined') return;
    const candidates = new Set<string>([raw, raw.replace(/^u_/, ''), raw.startsWith('u_') ? raw : `u_${raw}`]);
    const delivered = new Set<any>();
    for (const key of candidates) {
      const sockets = wsClientsByUser.get(key);
      if (!sockets) continue;
      for (const meta of sockets) {
        if (delivered.has(meta.ws)) continue;
        delivered.add(meta.ws);
        wsSend(meta.ws, type, payload);
      }
    }
  };

  const disconnectUserWsSessions = (userId: string, opts: { onlySessionId?: string; exceptSessionId?: string }) => {
    const sockets = wsClientsByUser.get(String(userId));
    if (!sockets) return;
    for (const meta of Array.from(sockets)) {
      if (opts.onlySessionId && meta.sessionId !== opts.onlySessionId) continue;
      if (opts.exceptSessionId && meta.sessionId === opts.exceptSessionId) continue;
      wsSend(meta.ws, 'session:revoked', { reason: 'نشست شما از دستگاه دیگری لغو شد.' });
      try {
        meta.ws.close(4001, 'Session Revoked');
      } catch {}
    }
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
      userObj?.role === 'owner' ? process.env.OWNER_ID : null,
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
      await telegramBotRequest(
        botToken,
        'sendMessage',
        {
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
        },
        4000
      );
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

  // --- Scalable Media Assets Store (<= 5MB: Strict MIME Allowlist + Capability Token Access Control) ---
  const ALLOWED_MEDIA_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'audio/webm',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/flac',
    'audio/wav',
    'audio/x-wav',
    'application/pdf',
    'application/zip',
    'text/plain',
  ]);
  const INLINE_SAFE_MEDIA_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'audio/webm',
    'audio/ogg',
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/flac',
    'audio/wav',
    'audio/x-wav',
  ]);
  const memoryMedia = new Map<
    string,
    { buffer: Buffer; mimeType: string; filename: string; etag: string; uploaderId: string; accessToken: string }
  >();
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
      const rawMime = String(mimeType || match[1] || '').split(';')[0].trim().toLowerCase().slice(0, 100);
      if (!ALLOWED_MEDIA_MIME_TYPES.has(rawMime)) {
        return res.status(400).json({
          success: false,
          error: 'این نوع فایل مجاز نیست (فقط تصویر استاندارد، صدا، PDF، ZIP یا متن ساده مجاز است).',
        });
      }
      const resolvedMime = rawMime;
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'حجم فایل باید بین ۱ بایت تا ۵ مگابایت باشد.' });
      }

      if (memoryMedia.size > 150) {
        const firstKey = memoryMedia.keys().next().value;
        if (firstKey) memoryMedia.delete(firstKey);
      }

      const mediaId = `med_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const accessToken = crypto.randomBytes(24).toString('hex');
      const uploaderId = String(authResult.actor.id);
      const cleanFilename = String(filename || 'attachment').replace(/[^\w.\-\u0600-\u06FF ]/g, '').slice(0, 120) || 'file';
      const etag = `"${crypto.createHash('sha1').update(buffer).digest('hex')}"`;
      memoryMedia.set(mediaId, {
        buffer,
        mimeType: resolvedMime,
        filename: cleanFilename,
        etag,
        uploaderId,
        accessToken,
      });

      let storagePath: string | undefined;
      if (!supabaseState.ready) {
        const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || (firebaseConfig as any).storageBucket || '').trim();
        if (hasAdminCredentials && adminApp && bucketName) {
          try {
            const bucket = getStorage(adminApp).bucket(bucketName);
            const remotePath = `mianji_media/${mediaId}`;
            await Promise.race([
              bucket.file(remotePath).save(buffer, {
                contentType: resolvedMime,
                metadata: { metadata: { uploaderId, filename: cleanFilename } },
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('GCS upload timeout')), 3500)),
            ]);
            storagePath = remotePath;
          } catch {}
        }
      }

      const firestore = getDb();
      if (firestore) {
        try {
          if (storagePath) {
            await firestore.collection('media_assets').doc(mediaId).set({
              id: mediaId,
              uploader_id: uploaderId,
              mime_type: resolvedMime,
              mimeType: resolvedMime,
              filename: cleanFilename,
              size_bytes: buffer.length,
              storage_path: storagePath,
              access_token: accessToken,
              created_at: new Date().toISOString(),
              createdAt: FieldValue.serverTimestamp(),
            });
          } else if (match[2].length <= MEDIA_CHUNK_CHARS) {
            await firestore.collection('media_assets').doc(mediaId).set({
              id: mediaId,
              uploader_id: uploaderId,
              mime_type: resolvedMime,
              mimeType: resolvedMime,
              filename: cleanFilename,
              size_bytes: buffer.length,
              chunk_count: 0,
              access_token: accessToken,
              data_base64: match[2],
              created_at: new Date().toISOString(),
              createdAt: FieldValue.serverTimestamp(),
            });
          } else {
            const totalChunks = Math.ceil(match[2].length / MEDIA_CHUNK_CHARS);
            await firestore.collection('media_assets').doc(mediaId).set({
              id: mediaId,
              uploader_id: uploaderId,
              mime_type: resolvedMime,
              mimeType: resolvedMime,
              filename: cleanFilename,
              size_bytes: buffer.length,
              chunk_count: totalChunks,
              access_token: accessToken,
              created_at: new Date().toISOString(),
              createdAt: FieldValue.serverTimestamp(),
            });
            await Promise.all(
              Array.from({ length: totalChunks }, (_, idx) => {
                const slice = match[2].slice(idx * MEDIA_CHUNK_CHARS, (idx + 1) * MEDIA_CHUNK_CHARS);
                const chunkId = `${mediaId}_${idx}`;
                return firestore.collection('media_chunks').doc(chunkId).set({
                  id: chunkId,
                  media_id: mediaId,
                  index: idx,
                  data_base64: slice,
                });
              })
            );
          }
        } catch {}
      }

      res.json({
        success: true,
        id: mediaId,
        url: `/api/media/${mediaId}?t=${accessToken}`,
        sizeBytes: buffer.length,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در آپلود فایل' });
    }
  });

  app.get('/api/media/:mediaId', async (req, res) => {
    const mediaId = String(req.params.mediaId || '').trim();
    if (!/^[a-zA-Z0-9_\-]{3,128}$/.test(mediaId)) {
      return res.status(400).send('Invalid media ID');
    }
    const suppliedToken = String(req.query.t || '').trim();

    let item = memoryMedia.get(mediaId);
    if (!item) {
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('media_assets').doc(mediaId).get();
          if (snap.exists) {
            const d = snap.data() || {};
            const mimeType = String(d.mime_type || d.mimeType || 'application/octet-stream').toLowerCase();
            const filename = String(d.filename || 'file');
            const uploaderId = String(d.uploader_id || '');
            const accessToken = String(d.access_token || '');
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
              item = { buffer, mimeType, filename, etag, uploaderId, accessToken };
              memoryMedia.set(mediaId, item);
            }
          }
        } catch {}
      }
    }
    if (!item) return res.status(404).send('Not found');

    const hasValidCapability = Boolean(item.accessToken && suppliedToken && timingSafeEqualStr(suppliedToken, item.accessToken));
    if (!hasValidCapability) {
      const actor = await tryAuthenticate(req);
      if (!actor) {
        return res.status(401).send('Unauthorized');
      }
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const isUploader = Boolean(item.uploaderId && String(actor.id) === String(item.uploaderId));
      if (!isAdminActor && !isUploader) {
        return res.status(403).send('Forbidden');
      }
    }

    if (!ALLOWED_MEDIA_MIME_TYPES.has(item.mimeType)) {
      return res.status(415).send('Unsupported media type');
    }

    if (req.headers['if-none-match'] === item.etag) {
      return res.status(304).end();
    }
    res.setHeader('Content-Type', item.mimeType);
    res.setHeader('ETag', item.etag);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    if (!INLINE_SAFE_MEDIA_TYPES.has(item.mimeType)) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(item.filename)}"`);
    }
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
          const resolvedCreatedAt =
            d.createdAt?.toDate?.()?.toISOString?.() ||
            d.createdAt ||
            d.created_at ||
            new Date().toISOString();
          merged.set(doc.id, {
            id: doc.id,
            ...d,
            createdAt: resolvedCreatedAt,
          });
        });
      } catch {}
    }
    const list = Array.from(merged.values()).sort(
      (a, b) => (Date.parse(b.createdAt || b.created_at || '') || 0) - (Date.parse(a.createdAt || a.created_at || '') || 0)
    );
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
  const memoryDealDrafts = new Map<string, any[]>();
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
      await strictFirestoreWrite(`transactions/${txId}`, (db) =>
        db.collection('transactions').doc(txId).set({
          ...txData,
          createdAt: FieldValue.serverTimestamp(),
        })
      );
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
        await strictFirestoreWrite(`users/${uid}#balance`, () =>
          usersCol.doc(uid).set(
            {
              wallet_balance: updated.wallet_balance,
              escrow_locked_balance: updated.escrow_locked_balance,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        );
      }
    }
    return updated;
  };

  const adjustUserWalletAtomic = async (
    uid: string,
    walletDelta: number,
    lockedDelta: number,
    requireFreeCheck = false,
    txMeta?: {
      txId?: string | null;
      txType?: string;
      title?: string;
      contractId?: string | null;
    }
  ): Promise<{ wallet_balance: number; escrow_locked_balance: number; free_balance: number }> => {
    const wDelta = Math.round(Number(walletDelta || 0));
    const lDelta = Math.round(Number(lockedDelta || 0));
    if (supabaseState.ready && supabaseState.client) {
      const res = await adjustWalletAtomicRpc(supabaseState.client, uid, wDelta, lDelta, requireFreeCheck, txMeta);
      if (!res.ok) {
        const errCode = String(res.error || '');
        if (errCode.includes('INSUFFICIENT_FREE_BALANCE') || errCode.includes('LOCKED_EXCEEDS_WALLET')) {
          throw new Error('موجودی آزاد کاربر کافی نیست');
        }
        throw new Error(res.error || 'خطا در به‌روزرسانی اتمیک کیف پول');
      }
      const resolvedId = res.user_id || uid;
      const nextWallet = Math.max(0, Number(res.wallet_balance ?? 0));
      const nextLocked = Math.min(nextWallet, Math.max(0, Number(res.escrow_locked_balance ?? 0)));
      const nextFree = Math.max(0, Number(res.free_balance ?? nextWallet - nextLocked));
      const existing = memoryUsers.get(resolvedId) || (await getUserById(resolvedId)) || { id: resolvedId };
      memoryUsers.set(resolvedId, {
        ...existing,
        id: resolvedId,
        wallet_balance: nextWallet,
        escrow_locked_balance: nextLocked,
      });
      return {
        wallet_balance: nextWallet,
        escrow_locked_balance: nextLocked,
        free_balance: nextFree,
      };
    }
    const cur = (await getUserById(uid)) || memoryUsers.get(uid) || { id: uid, wallet_balance: 0, escrow_locked_balance: 0 };
    const curWallet = Math.max(0, Number(cur.wallet_balance || 0));
    const curLocked = Math.max(0, Number(cur.escrow_locked_balance || 0));
    const curFree = Math.max(0, curWallet - curLocked);
    if (requireFreeCheck && lDelta > 0 && wDelta === 0 && curFree < lDelta) {
      throw new Error('موجودی آزاد کاربر کافی نیست');
    }
    const nextWallet = curWallet + wDelta;
    const nextLocked = Math.max(0, curLocked + lDelta);
    if (nextWallet < 0 || nextLocked > nextWallet) {
      throw new Error('تراکنش نامعتبر است: موجودی منفی یا قفل بیشتر از موجودی کل مجاز نیست');
    }
    await saveUserBalances(String(cur.id || uid), nextWallet, nextLocked);
    if (txMeta?.txId) {
      const targetUid = String(cur.id || uid);
      const txId = String(txMeta.txId);
      const txAmount = wDelta !== 0 ? Math.abs(wDelta) : Math.abs(lDelta);
      const txList = memoryTransactions.get(targetUid) || [];
      if (!txList.some((t) => String(t.id) === txId)) {
        const entry = {
          id: txId,
          user_id: targetUid,
          type: txMeta.txType || 'general',
          amount: txAmount,
          title: txMeta.title || '',
          description: txMeta.title || '',
          status: 'completed',
          contract_id: txMeta.contractId || null,
          created_at: new Date().toISOString(),
        };
        memoryTransactions.set(targetUid, [entry, ...txList]);
        const fsDb = getDb();
        if (fsDb) {
          await fsDb.collection('transactions').doc(txId).set(entry, { merge: true }).catch(() => {});
        }
      }
    }
    return {
      wallet_balance: nextWallet,
      escrow_locked_balance: nextLocked,
      free_balance: Math.max(0, nextWallet - nextLocked),
    };
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

  const cleanPartyVal = (val: any): string => (val === null || val === undefined ? '' : String(val).trim());

  const getStoredActorTelegramOrId = (actor: any): number | string => {
    const rawTg = actor?.telegram_id ?? actor?.telegramId ?? actor?.tg_id ?? actor?.chat_id ?? actor?.chatId;
    if (rawTg !== undefined && rawTg !== null && String(rawTg).trim() !== '') {
      const s = normalizeDigits(String(rawTg)).replace(/[^0-9-]/g, '');
      if (/^-?\d+$/.test(s)) return Number(s);
    }
    const idStr = String(actor?.id || '').trim();
    if (/^u_-?\d+$/.test(idStr)) return Number(idStr.slice(2));
    if (/^-?\d+$/.test(idStr)) return Number(idStr);
    return idStr;
  };

  const makeSignatureHash = (cid: string, actorId: string | number, roleLabel: string, tsIso: string) =>
    crypto
      .createHash('sha256')
      .update(`${cid}|${actorId}|${roleLabel}|${tsIso}|${crypto.randomBytes(6).toString('hex')}`)
      .digest('hex');

  const enrichDealWithParties = async (deal: any, usersById?: Map<string, any>, uid?: string) => {
    const rawBuyer = cleanPartyVal(deal?.buyer_id);
    const rawSeller = cleanPartyVal(deal?.seller_id);
    const buyerIsPending = isPendingPartyId(deal?.buyer_id);
    const sellerIsPending = isPendingPartyId(deal?.seller_id);
    const buyerId = buyerIsPending ? '' : rawBuyer;
    const sellerId = sellerIsPending ? '' : rawSeller;
    const buyer = buyerIsPending ? null : usersById?.get(buyerId) || (buyerId ? await getUserById(buyerId) : null);
    const seller = sellerIsPending ? null : usersById?.get(sellerId) || (sellerId ? await getUserById(sellerId) : null);
    const cid = String(deal?.contract_id || deal?.id || '');
    const createdAt = deal?.created_at || deal?.createdAt || new Date().toISOString();
    const updatedAt = deal?.updated_at || deal?.updatedAt || createdAt;
    const normStatus = normalizeDealStatus(deal?.status);
    const rawCatUpper = String(deal?.category || '').trim().toUpperCase();
    const normCategory = ['DEV', 'DESIGN', 'DS', 'ACADEMIC', 'TEACHING', 'CNS', 'GEN'].includes(rawCatUpper)
      ? rawCatUpper
      : normalizeCategoryCode(deal?.category);
    const normCommissionPayer = normalizeCommissionPayer(deal?.commission_payer);
    const feePercent = Math.max(0, Math.min(15, Number(deal?.fee_percent ?? globalLimits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));
    const amount = Number(deal?.amount || 0);
    const breakdown = computeCommissionBreakdown(amount, feePercent, normCommissionPayer);
    const freeEdits = Math.max(0, Math.floor(Number(deal?.free_edits ?? deal?.free_edits_total ?? deal?.revisions ?? 2) || 0));
    const freeEditsTotal = Math.max(0, Math.floor(Number(deal?.free_edits_total ?? freeEdits)));
    const freeEditsLeft = Math.max(0, Math.floor(Number(deal?.free_edits_left ?? freeEditsTotal)));
    const stagedPayment = Boolean(
      (deal?.staged_payment ?? deal?.is_milestone) && Array.isArray(deal?.milestones) && deal.milestones.length >= 2
    );
    const deadlineNum = Math.max(1, Math.min(365, Number(deal?.deadline || 7) || 7));

    const existingHistory = Array.isArray(deal?.history) ? deal.history : [];
    const existingTimeline = Array.isArray(deal?.timeline) ? deal.timeline : [];
    const defaultTimeline = [
      {
        id: `tl_init_${cid}`,
        type: 'created',
        status: normStatus,
        actor_id: deal?.creator_id ? String(deal.creator_id) : buyerIsPending ? sellerId : buyerId,
        actor_name: buyer?.full_name || seller?.full_name || 'کاربر میانجی',
        note: 'قرارداد امن ایجاد شد',
        timestamp: createdAt,
      },
    ];
    const resolvedTimeline =
      existingTimeline.length > 0
        ? existingTimeline
        : existingHistory.length > 0
        ? existingHistory.map((h: any, idx: number) => ({
            id: `tl_hist_${idx}_${cid}`,
            type: 'history',
            status: normStatus,
            actor_id: h?.actor_id ? String(h.actor_id) : '',
            actor_name: h?.actor || 'سیستم میانجی',
            note: h?.event || 'به‌روزرسانی قرارداد',
            timestamp: h?.timestamp || createdAt,
          }))
        : defaultTimeline;
    const resolvedHistory =
      existingHistory.length > 0
        ? existingHistory
        : resolvedTimeline.map((t: any) => ({
            event: t?.note || t?.type || 'به‌روزرسانی قرارداد',
            timestamp: t?.timestamp || createdAt,
            actor: t?.actor_name || 'کاربر میانجی',
            ...(t?.actor_id ? { actor_id: t.actor_id } : {}),
          }));

    const reviews = cid ? await getReviewsForDeal(cid) : [];
    const createdAtMs = Date.parse(String(createdAt)) || Date.now();
    const fallbackDeliveryDueAt =
      deal?.delivery_due_at ||
      (normStatus === 'active' ? new Date(createdAtMs + deadlineNum * 86400000).toISOString() : undefined);
    const disputeMem = cid ? memoryDisputes.get(cid) : undefined;
    const appealObj = deal?.appeal || disputeMem?.appeal || undefined;
    const isPendingCounterparty = buyerIsPending || sellerIsPending;
    const botUsername = await resolveBotUsername().catch(() => 'mianji_ir_bot');
    const inviteToken = deal?.invite_token ? String(deal.invite_token) : `c_${cid}`;

    const buyerResolvedName = buyerIsPending
      ? 'در انتظار عضویت/امضای کارفرما'
      : deal?.buyer_fullname || buyer?.full_name || deal?.buyer_name || 'کارفرما';
    const sellerResolvedName = sellerIsPending
      ? 'در انتظار عضویت/امضای مجری'
      : deal?.seller_fullname || seller?.full_name || deal?.seller_name || 'مجری';

    return {
      ...deal,
      id: String(deal?.id || cid),
      contract_id: cid,
      _docId: String(deal?._docId || cid),
      category: normCategory,
      status: normStatus,
      raw_status: deal?.status ? String(deal.status) : normStatus,
      commission_payer: normCommissionPayer,
      buyer_role: deal?.buyer_role || 'employer',
      seller_role: deal?.seller_role || 'freelancer',
      buyer_id: buyerIsPending ? (deal?.buyer_id ?? null) : (deal?.buyer_id ?? buyerId),
      seller_id: sellerIsPending ? (deal?.seller_id ?? null) : (deal?.seller_id ?? sellerId),
      buyer_name: buyerResolvedName,
      buyer_fullname: buyerIsPending ? null : buyerResolvedName,
      buyer_phone: buyerIsPending ? null : deal?.buyer_phone || buyer?.phone_number || null,
      buyer_national_id: buyerIsPending ? null : deal?.buyer_national_id || buyer?.national_id || null,
      buyer_kyc: buyerIsPending ? 'pending' : deal?.buyer_kyc || buyer?.kyc_status || 'verified',
      buyer_rating_avg: buyerIsPending ? 0 : Number(buyer?.rating_avg || 0),
      buyer_rating_count: buyerIsPending ? 0 : Number(buyer?.rating_count || 0),
      seller_name: sellerResolvedName,
      seller_fullname: sellerIsPending ? null : sellerResolvedName,
      seller_phone: sellerIsPending ? null : deal?.seller_phone || seller?.phone_number || null,
      seller_national_id: sellerIsPending ? null : deal?.seller_national_id || seller?.national_id || null,
      seller_kyc: sellerIsPending ? 'pending' : deal?.seller_kyc || seller?.kyc_status || 'verified',
      seller_rating_avg: sellerIsPending ? 0 : Number(seller?.rating_avg || 0),
      seller_rating_count: sellerIsPending ? 0 : Number(seller?.rating_count || 0),
      invite_mode: Boolean(deal?.invite_mode || isPendingCounterparty || normStatus === 'pending_party_b'),
      is_pending_counterparty: isPendingCounterparty,
      invite_token: inviteToken,
      bot_invite_url: buildTelegramBotDealLink(cid, botUsername),
      bot_link: buildTelegramBotDealLink(cid, botUsername),
      creator_id: deal?.creator_id ?? '',
      created_by: deal?.created_by ?? deal?.creator_id ?? '',
      pending_phone: deal?.pending_phone ? String(deal.pending_phone) : '',
      amount,
      deadline: deadlineNum,
      free_edits: freeEdits,
      free_edits_total: freeEditsTotal,
      free_edits_left: freeEditsLeft,
      revisions: String(freeEditsLeft),
      fee_percent: feePercent,
      fee_amount: deal?.fee_amount !== undefined ? Number(deal.fee_amount) : breakdown.totalFee,
      employer_fee: breakdown.employerFee,
      freelancer_fee: breakdown.freelancerFee,
      employer_total_payable: breakdown.employerTotalPayable,
      net_seller_amount:
        deal?.net_seller_amount !== undefined ? Number(deal.net_seller_amount) : breakdown.netSellerAmount,
      staged_payment: stagedPayment,
      is_milestone: stagedPayment,
      milestones: Array.isArray(deal?.milestones) ? deal.milestones : [],
      inspection_hours: String(deal?.inspection_hours || '48'),
      escrow_deposit_status: deal?.escrow_deposit_status || (normStatus === 'completed' ? 'released' : ['active', 'work_submitted', 'revisions_requested', 'in_dispute'].includes(normStatus) ? 'paid_locked' : normStatus === 'cancelled' ? 'refunded' : 'unpaid'),
      buyer_signed_at: deal?.buyer_signed_at ?? null,
      seller_signed_at: deal?.seller_signed_at ?? null,
      buyer_otp_verified: Boolean(deal?.buyer_otp_verified),
      seller_otp_verified: Boolean(deal?.seller_otp_verified),
      buyer_signature_hash: deal?.buyer_signature_hash ?? null,
      seller_signature_hash: deal?.seller_signature_hash ?? null,
      created_at: createdAt,
      updated_at: updatedAt,
      createdAt,
      updatedAt,
      ...(fallbackDeliveryDueAt ? { delivery_due_at: fallbackDeliveryDueAt } : {}),
      ...(appealObj ? { appeal: appealObj } : {}),
      reviews,
      history: resolvedHistory,
      timeline: resolvedTimeline,
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
    const dealDocId = String(deal?._docId || cid);

    const cleanFeePct = Math.max(0, Math.min(15, Number(feePercent || 0)));
    const breakdown = computeCommissionBreakdown(sellerGrossAmount, cleanFeePct, deal?.commission_payer);
    const feeAmount = breakdown.totalFee;
    const sellerNet = breakdown.netSellerAmount;

    const buyer = (await getUserById(buyerId)) || { id: buyerId, wallet_balance: grossUnlockAmount, escrow_locked_balance: grossUnlockAmount };
    const seller = (await getUserById(sellerId)) || { id: sellerId, wallet_balance: 0, escrow_locked_balance: 0 };
    const buyerDocId = String((buyer as any).id || buyerId);
    const sellerDocId = String((seller as any).id || sellerId);

    const effectiveUnlock = Math.max(grossUnlockAmount, breakdown.employerTotalPayable);
    const buyerWalletDebit = Math.max(sellerGrossAmount, breakdown.employerTotalPayable);

    let releasedInTx = false;
    if (supabaseState.ready && supabaseState.client) {
      const bWallet = Math.max(0, Number((buyer as any).wallet_balance ?? 0));
      const bLocked = Math.max(0, Number((buyer as any).escrow_locked_balance ?? 0));
      const sLocked = Math.max(0, Number((seller as any).escrow_locked_balance ?? 0));

      const rawUnlock = bLocked >= effectiveUnlock ? effectiveUnlock : grossUnlockAmount;
      const unlockAmount = Math.min(bLocked, Math.max(0, rawUnlock));
      const rawDebit = sellerGrossAmount <= 0 ? 0 : bLocked >= effectiveUnlock ? buyerWalletDebit : sellerGrossAmount;
      const nextBuyerLockedTarget = Math.max(0, bLocked - unlockAmount);
      const debitAmount = Math.min(Math.max(0, bWallet - nextBuyerLockedTarget), Math.max(0, rawDebit));

      const buyerRes = await adjustUserWalletAtomic(buyerDocId, -debitAmount, -unlockAmount, false);
      const bBal = { wallet_balance: buyerRes.wallet_balance, escrow_locked_balance: buyerRes.escrow_locked_balance };
      balancesPayload[buyerDocId] = bBal;
      balancesPayload[buyerId] = bBal;

      if (sellerNet > 0) {
        const sellerRes = await adjustUserWalletAtomic(sellerDocId, sellerNet, 0, false);
        const sBal = { wallet_balance: sellerRes.wallet_balance, escrow_locked_balance: sellerRes.escrow_locked_balance };
        balancesPayload[sellerDocId] = sBal;
        balancesPayload[sellerId] = sBal;
      } else {
        const sBal = { wallet_balance: Math.max(0, Number((seller as any).wallet_balance ?? 0)), escrow_locked_balance: sLocked };
        balancesPayload[sellerDocId] = sBal;
        balancesPayload[sellerId] = sBal;
      }

      if (firestore) {
        if (incrementCompletedCount) {
          await firestore.collection('users').doc(buyerDocId).set({ completed_deals_count: FieldValue.increment(1) }, { merge: true }).catch(() => {});
          await firestore.collection('users').doc(sellerDocId).set({ completed_deals_count: FieldValue.increment(1) }, { merge: true }).catch(() => {});
        }
        await firestore
          .collection('deals')
          .doc(dealDocId)
          .set({ ...nextDealFields, updated_at: new Date().toISOString(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }
      releasedInTx = true;
    } else if (firestore) {
      try {
        await firestore.runTransaction(async (tx) => {
          const bSnap = await tx.get(firestore.collection('users').doc(buyerDocId));
          const sSnap = await tx.get(firestore.collection('users').doc(sellerDocId));
          const bData = bSnap.exists ? bSnap.data() || {} : buyer;
          const sData = sSnap.exists ? sSnap.data() || {} : seller;

          const bWallet = Number(bData.wallet_balance ?? 0);
          const bLocked = Number(bData.escrow_locked_balance ?? 0);
          const sWallet = Number(sData.wallet_balance ?? 0);
          const sLocked = Number(sData.escrow_locked_balance ?? 0);

          const unlockAmount = Math.min(bLocked, bLocked >= effectiveUnlock ? effectiveUnlock : grossUnlockAmount);
          const debitAmount = sellerGrossAmount <= 0 ? 0 : bLocked >= effectiveUnlock ? buyerWalletDebit : sellerGrossAmount;
          const nextBuyerLocked = Math.max(0, bLocked - unlockAmount);
          const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - debitAmount);
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

          tx.set(firestore.collection('users').doc(buyerDocId), bUpdate, { merge: true });
          tx.set(firestore.collection('users').doc(sellerDocId), sUpdate, { merge: true });
          tx.set(
            firestore.collection('deals').doc(dealDocId),
            {
              ...nextDealFields,
              updated_at: new Date().toISOString(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          const bBal = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
          const sBal = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };
          balancesPayload[buyerDocId] = bBal;
          balancesPayload[buyerId] = bBal;
          balancesPayload[sellerDocId] = sBal;
          balancesPayload[sellerId] = sBal;
        });

        const bMem = memoryUsers.get(buyerDocId) || buyer;
        const sMem = memoryUsers.get(sellerDocId) || seller;
        memoryUsers.set(buyerDocId, {
          ...bMem,
          id: buyerDocId,
          ...balancesPayload[buyerDocId],
          ...(incrementCompletedCount ? { completed_deals_count: Number(bMem.completed_deals_count || 0) + 1 } : {}),
        });
        memoryUsers.set(sellerDocId, {
          ...sMem,
          id: sellerDocId,
          ...balancesPayload[sellerDocId],
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

      const unlockAmount = Math.min(bLocked, bLocked >= effectiveUnlock ? effectiveUnlock : grossUnlockAmount);
      const debitAmount = sellerGrossAmount <= 0 ? 0 : bLocked >= effectiveUnlock ? buyerWalletDebit : sellerGrossAmount;
      const nextBuyerLocked = Math.max(0, bLocked - unlockAmount);
      const nextBuyerWallet = Math.max(nextBuyerLocked, bWallet - debitAmount);
      const nextSellerWallet = sWallet + sellerNet;

      await saveUserBalances(buyerDocId, nextBuyerWallet, nextBuyerLocked);
      await saveUserBalances(sellerDocId, nextSellerWallet, sLocked);
      const bBal = { wallet_balance: nextBuyerWallet, escrow_locked_balance: nextBuyerLocked };
      const sBal = { wallet_balance: nextSellerWallet, escrow_locked_balance: sLocked };
      balancesPayload[buyerDocId] = bBal;
      balancesPayload[buyerId] = bBal;
      balancesPayload[sellerDocId] = sBal;
      balancesPayload[sellerId] = sBal;

      if (firestore) {
        await firestore
          .collection('deals')
          .doc(dealDocId)
          .set({ ...nextDealFields, updated_at: new Date().toISOString(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }
    }

    if (sellerNet > 0) {
      await recordTransaction(firestore, {
        user_id: sellerDocId,
        contract_id: cid,
        amount: sellerNet,
        type: 'escrow_release',
        status: 'completed',
        description:
          feeAmount > 0
            ? `${releaseDescription} (خالص پس از کسر ${breakdown.freelancerFee.toLocaleString()} تومان کارمزد مجری)`
            : releaseDescription,
      });
    }

    if (feeAmount > 0) {
      memoryTotalFeesCollected += feeAmount;
      await recordTransaction(firestore, {
        user_id: sellerDocId,
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

  const memoryContacts = new Map<string, any[]>();
  const memoryContactInvites = new Map<string, any>();

  const getContactsListForUser = async (uid: string): Promise<any[]> => {
    if (!uid || uid === 'support') return [];
    const merged = new Map<string, any>();
    (memoryContacts.get(uid) || []).forEach((c) => merged.set(String(c.id), c));
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('users').doc(uid).collection('contacts').limit(150).get();
        snap.docs.forEach((d) => merged.set(d.id, { id: d.id, ...d.data() }));
      } catch {}
    }
    return Array.from(merged.values());
  };

  const userSavedCounterpartyInContacts = async (
    ownerUid: string,
    targetUid: string,
    targetPhones: string[] = []
  ): Promise<boolean> => {
    if (!ownerUid || !targetUid || ownerUid === 'support' || targetUid === 'support') return false;
    const list = await getContactsListForUser(ownerUid);
    if (list.length === 0) return false;
    const targetTokens = new Set<string>([String(targetUid)]);
    const targetUser = await getUserById(targetUid).catch(() => null);
    if (targetUser) {
      getUserIdentityTokens(targetUser).forEach((t) => targetTokens.add(String(t)));
    }
    const targetCores = new Set<string>();
    [...targetPhones, targetUser?.phone_number || ''].forEach((p) => {
      const c = extractCleanPhone(String(p || ''));
      if (c.length >= 10) targetCores.add(c.slice(-10));
    });
    return list.some((c) => {
      if (c?.target_user_id && targetTokens.has(String(c.target_user_id))) return true;
      const cPhone = extractCleanPhone(String(c?.phone_number || ''));
      if (cPhone.length >= 10 && targetCores.has(cPhone.slice(-10))) return true;
      return false;
    });
  };

  const checkMutualContactAndDealStatus = async (
    actorA: any,
    userIdB: string,
    phoneHintB?: string,
    allDealsCache?: any[]
  ): Promise<{ isMutualContact: boolean; hasDealTogether: boolean; canViewPhone: boolean; counterpartyPhone: string }> => {
    const uidA = String(actorA?.id || '');
    if (!uidA || !userIdB || userIdB === 'support' || String(userIdB).startsWith('pending_')) {
      return { isMutualContact: false, hasDealTogether: false, canViewPhone: false, counterpartyPhone: '' };
    }
    const userB = await getUserById(userIdB).catch(() => null);
    const resolvedPhoneB = String(userB?.phone_number || phoneHintB || '').trim();
    const resolvedIdB = String(userB?.id || userIdB);

    const [aSavedB, bSavedA] = await Promise.all([
      userSavedCounterpartyInContacts(uidA, resolvedIdB, [resolvedPhoneB]),
      userSavedCounterpartyInContacts(resolvedIdB, uidA, [String(actorA?.phone_number || '')]),
    ]);
    const isMutualContact = Boolean(aSavedB && bSavedA);

    const dealsList = allDealsCache || (await getAllDealsMerged());
    const fakeActorB = userB || { id: resolvedIdB, phone_number: resolvedPhoneB };
    const hasDealTogether = dealsList.some(
      (d) =>
        (isUserDealBuyer(d, actorA) && isUserDealSeller(d, fakeActorB)) ||
        (isUserDealSeller(d, actorA) && isUserDealBuyer(d, fakeActorB))
    );

    const canViewPhone = isMutualContact || hasDealTogether;
    const formattedPhone = canViewPhone && resolvedPhoneB ? normalizeIranPhone(resolvedPhoneB) || resolvedPhoneB : '';
    return {
      isMutualContact,
      hasDealTogether,
      canViewPhone,
      counterpartyPhone: formattedPhone,
    };
  };

  const getAllDealsMerged = async () => {
    const merged = new Map<string, any>();
    for (const d of memoryDeals.values()) {
      const cid = String(d?.contract_id || d?.id || '');
      if (cid) merged.set(cid, d);
    }
    const firestore = getDb();
    if (firestore) {
      try {
        const snap = await firestore.collection('deals').get();
        snap.docs.forEach((doc) => {
          const d = doc.data() || {};
          const cid = String(d.contract_id || doc.id);
          merged.set(cid, {
            ...d,
            _docId: doc.id,
            id: String(d.id || cid),
            contract_id: cid,
            created_at: d.created_at || d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt,
            updated_at: d.updated_at || d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt,
            createdAt: d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt || d.created_at,
            updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt || d.updated_at,
          });
        });
      } catch (err: any) {
        console.warn('[DEALS] Firestore read failed:', err?.message || err);
      }
    }
    return Array.from(merged.values());
  };

  const getDealByContractId = async (contractId: string) => {
    const rawCid = normalizeDigits(String(contractId || '').trim());
    if (!rawCid) return null;
    const upperCid = rawCid.toUpperCase();
    const candidates = rawCid === upperCid ? [rawCid] : [rawCid, upperCid];
    let mem = memoryDeals.get(rawCid) || memoryDeals.get(upperCid);
    if (!mem) {
      for (const d of memoryDeals.values()) {
        const dCid = String(d?.contract_id || '').toUpperCase();
        const dId = String(d?.id || '').toUpperCase();
        if (dCid === upperCid || dId === upperCid) {
          mem = d;
          break;
        }
      }
    }
    const cid = mem?.contract_id ? String(mem.contract_id) : upperCid;
    const firestore = getDb();
    if (firestore) {
      try {
        for (const tryCid of candidates) {
          const docSnap = await firestore.collection('deals').doc(tryCid).get();
          if (docSnap.exists) {
            const d = docSnap.data() || {};
            return {
              ...d,
              _docId: docSnap.id,
              id: String(d.id || d.contract_id || docSnap.id),
              contract_id: String(d.contract_id || docSnap.id),
              created_at: d.created_at || d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt,
              updated_at: d.updated_at || d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt,
              createdAt: d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt || d.created_at,
              updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt || d.updated_at,
            };
          }
        }
        const byCid = await firestore.collection('deals').where('contract_id', '==', cid).limit(1).get().catch(() => null);
        if (byCid && !byCid.empty) {
          const doc = byCid.docs[0];
          const d = doc.data() || {};
          return {
            ...d,
            _docId: doc.id,
            id: String(d.id || d.contract_id || doc.id),
            contract_id: String(d.contract_id || doc.id),
            created_at: d.created_at || d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt,
            updated_at: d.updated_at || d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt,
            createdAt: d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt || d.created_at,
            updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt || d.updated_at,
          };
        }
        const byId = await firestore.collection('deals').where('id', '==', cid).limit(1).get().catch(() => null);
        if (byId && !byId.empty) {
          const doc = byId.docs[0];
          const d = doc.data() || {};
          return {
            ...d,
            _docId: doc.id,
            id: String(d.id || d.contract_id || doc.id),
            contract_id: String(d.contract_id || doc.id),
            created_at: d.created_at || d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt,
            updated_at: d.updated_at || d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt,
            createdAt: d.createdAt?.toDate?.()?.toISOString?.() || d.createdAt || d.created_at,
            updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || d.updatedAt || d.updated_at,
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
      const actor = authResult.actor;
      const uid = String(actor.id);
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      const includeAll =
        isAdminActor &&
        req.query.scope === 'all' &&
        hasAnyAdminPermission(actor, ['manage_disputes', 'manage_finance']);
      const [all, allUsers] = await Promise.all([getAllDealsMerged(), getAllUsersMerged()]);
      const usersById = new Map<string, any>();
      for (const u of allUsers) {
        for (const tok of getUserIdentityTokens(u)) {
          if (!usersById.has(tok)) usersById.set(tok, u);
        }
      }

      const actorPhoneCore10 = getPhoneCore10(String(actor.phone_number || ''));
      const filtered = includeAll
        ? all
        : all.filter((d) => {
            if (isUserDealBuyer(d, actor) || isUserDealSeller(d, actor) || isUserDealCreator(d, actor)) {
              return true;
            }
            if (
              actorPhoneCore10 &&
              d.pending_phone &&
              getPhoneCore10(String(d.pending_phone)) === actorPhoneCore10 &&
              (isPendingPartyId(d.buyer_id) || isPendingPartyId(d.seller_id))
            ) {
              return true;
            }
            return false;
          });
      filtered.sort(
        (a, b) =>
          Date.parse(String(b.updated_at || b.created_at || b.createdAt || 0)) -
          Date.parse(String(a.updated_at || a.created_at || a.createdAt || 0))
      );
      const enrichedBase = await Promise.all(filtered.map((d) => enrichDealWithParties(d, usersById, uid)));
      const mutualCache = new Map<string, boolean>();
      const enriched = await Promise.all(
        enrichedBase.map(async (d) => {
          const isBuyer = isUserDealBuyer(d, actor);
          const cpRawId = isBuyer ? String(d.seller_id || '') : String(d.buyer_id || '');
          const cpPhone = isBuyer ? String(d.seller_phone || '') : String(d.buyer_phone || '');
          if (!cpRawId || isPendingPartyId(cpRawId)) {
            return { ...d, is_mutual_contact: false };
          }
          if (!mutualCache.has(cpRawId)) {
            const st = await checkMutualContactAndDealStatus(actor, cpRawId, cpPhone, all);
            mutualCache.set(cpRawId, st.isMutualContact);
          }
          return { ...d, is_mutual_contact: Boolean(mutualCache.get(cpRawId)) };
        })
      );
      res.json({ success: true, deals: enriched });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت معاملات' });
    }
  });

  const verifySignedPdfLink = async (
    req: express.Request,
    contractId: string,
    deal: any
  ): Promise<{ ok: true } | { ok: false; reason?: string }> => {
    const sigHex = String(req.query.sig || req.query.signature || '').trim().toLowerCase();
    const expRaw = String(req.query.exp || req.query.expires || '').trim();
    const uid = String(req.query.uid || req.query.telegram_id || req.query.tg_id || '').trim();
    if (!sigHex || !expRaw) return { ok: false };

    const expNum = Number(expRaw);
    if (!Number.isFinite(expNum) || expNum <= 0) return { ok: false, reason: 'expired' };
    const expMs = expNum < 1e12 ? expNum * 1000 : expNum;
    if (Date.now() > expMs) return { ok: false, reason: 'expired' };

    const explicitBotSecret = (process.env.BOT_SYNC_SECRET || '').trim();
    const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const derivedBotSyncSecret = botToken
      ? crypto.createHmac('sha256', 'mianji-bot-sync').update(botToken).digest('hex')
      : '';
    const candidateKeys = [explicitBotSecret, botToken, derivedBotSyncSecret, runtimeSecret].filter(Boolean);
    if (candidateKeys.length === 0) return { ok: false };

    const candidateMessages = Array.from(
      new Set(
        [
          uid ? `${contractId}:${uid}:${expRaw}` : '',
          deal?.contract_id && uid ? `${deal.contract_id}:${uid}:${expRaw}` : '',
          `${contractId}:${expRaw}`,
          deal?.contract_id ? `${deal.contract_id}:${expRaw}` : '',
        ].filter(Boolean)
      )
    );

    let sigValid = false;
    for (const key of candidateKeys) {
      for (const msg of candidateMessages) {
        const expectedHex = crypto.createHmac('sha256', key).update(msg).digest('hex').toLowerCase();
        if (safeEqualHex(expectedHex, sigHex)) {
          sigValid = true;
          break;
        }
      }
      if (sigValid) break;
    }
    if (!sigValid) return { ok: false, reason: 'invalid_sig' };

    if (uid) {
      const ownerId = (process.env.OWNER_ID || '').trim();
      const adminId = (process.env.ADMIN_ID || '').trim();
      const isPrivilegedUid = (ownerId && uid === ownerId) || (adminId && uid === adminId);
      if (!isPrivilegedUid) {
        const targetUser = await getUserById(uid);
        const actorOrUid = targetUser || uid;
        const isParticipant =
          isUserDealBuyer(deal, actorOrUid) ||
          isUserDealSeller(deal, actorOrUid) ||
          isUserDealCreator(deal, actorOrUid);
        const isPrivRole = targetUser?.role === 'owner' || targetUser?.role === 'admin';
        if (!isParticipant && !isPrivRole) {
          return { ok: false, reason: 'forbidden' };
        }
      }
    }

    return { ok: true };
  };

  const handleContractPdfDownload = async (req: express.Request, res: express.Response) => {
    try {
      const rawCid = String(req.params.contractId || '').trim();
      const cid = rawCid.replace(/\.pdf$/i, '');
      if (!cid || cid.length > 100) {
        return res.status(400).json({ success: false, error: 'شناسه قرارداد معتبر نیست.' });
      }

      const deal = await getDealByContractId(cid);
      if (!deal) {
        return res.status(404).json({ success: false, error: 'قرارداد مورد نظر یافت نشد.' });
      }

      let authorized = false;

      // 1. Bot server-to-server secret (x-bot-secret or Authorization: Bot ...)
      if (req.headers['x-bot-secret'] || (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bot '))) {
        const botAuth = verifyBotSyncSecret(req);
        if (!botAuth.ok) {
          return res.status(botAuth.status).json({ success: false, error: botAuth.error });
        }
        const requestedUid = String(req.query.uid || req.query.telegram_id || '').trim();
        if (requestedUid) {
          const ownerId = (process.env.OWNER_ID || '').trim();
          const adminId = (process.env.ADMIN_ID || '').trim();
          const targetUser = await getUserById(requestedUid);
          const actorOrUid = targetUser || requestedUid;
          const allowed =
            (ownerId && requestedUid === ownerId) ||
            (adminId && requestedUid === adminId) ||
            targetUser?.role === 'owner' ||
            targetUser?.role === 'admin' ||
            isUserDealBuyer(deal, actorOrUid) ||
            isUserDealSeller(deal, actorOrUid) ||
            isUserDealCreator(deal, actorOrUid);
          if (!allowed) {
            return res.status(403).json({ success: false, error: 'این کاربر مجاز به دریافت PDF این قرارداد نیست.' });
          }
        }
        authorized = true;
      }

      // 2. Signed expiring download URL from Bot (?uid=...&exp=...&sig=...)
      if (!authorized && req.query.sig && req.query.exp) {
        const signedCheck = await verifySignedPdfLink(req, cid, deal);
        if (signedCheck.ok) {
          authorized = true;
        } else if (signedCheck.reason === 'forbidden') {
          return res.status(403).json({ success: false, error: 'شما مجاز به دریافت نسخه PDF این قرارداد نیستید.' });
        }
      }

      // 3. Logged-in user session (Website / Mini App)
      if (!authorized) {
        const authResult = await authenticateActor(req);
        if ('actor' in authResult) {
          const actor = authResult.actor;
          const isAdminAllowed =
            (actor.role === 'owner' || actor.role === 'admin') &&
            hasAnyAdminPermission(actor, ['manage_disputes', 'manage_finance']);
          const isParticipant =
            isUserDealBuyer(deal, actor) ||
            isUserDealSeller(deal, actor) ||
            isUserDealCreator(deal, actor);
          const actorCore10 = getPhoneCore10(String(actor.phone_number || ''));
          const pendingCore10 = deal.pending_phone ? getPhoneCore10(String(deal.pending_phone)) : '';
          const matchesPending = Boolean(actorCore10 && pendingCore10 && actorCore10 === pendingCore10);
          if (!isParticipant && !isAdminAllowed && !matchesPending) {
            return res.status(403).json({ success: false, error: 'شما مجاز به دریافت فایل PDF این قرارداد نیستید.' });
          }
          authorized = true;
        }
      }

      if (!authorized) {
        const accept = String(req.headers.accept || '');
        if (accept.includes('text/html')) {
          return res.redirect(302, `/?contract_id=${encodeURIComponent(String(deal.contract_id || cid))}`);
        }
        return res.status(401).json({ success: false, error: 'برای دانلود PDF قرارداد باید وارد حساب خود شوید یا لینک معتبر داشته باشید.' });
      }

      const enriched = await enrichDealWithParties(deal);
      const origin =
        process.env.APP_URL ||
        process.env.PUBLIC_URL ||
        `${req.headers['x-forwarded-proto'] || req.protocol || 'https'}://${req.headers['x-forwarded-host'] || req.get('host') || 'mianji.ir'}`;
      const cleanCid = String(enriched.contract_id || cid).replace(/[^a-zA-Z0-9_-]/g, '_');
      const verifyUrl = `${String(origin).replace(/\/+$/, '')}/?contract_id=${encodeURIComponent(String(enriched.contract_id || cid))}`;

      const pdfBuffer = await buildContractPdfBuffer(enriched, { verifyUrl });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Mianji-Contract-${cleanCid}.pdf"`);
      res.setHeader('Content-Length', String(pdfBuffer.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.send(pdfBuffer);
    } catch (err: any) {
      console.error('[PDF] Contract PDF generation error:', err?.message || err);
      return res.status(500).json({ success: false, error: err?.message || 'خطا در تولید فایل PDF قرارداد' });
    }
  };

  app.get(
    [
      '/api/deals/:contractId/pdf',
      '/api/contracts/:contractId/pdf',
      '/api/bot/deals/:contractId/pdf',
      '/deals/:contractId/pdf',
      '/contracts/:contractId/pdf',
      '/contract/:contractId/pdf',
    ],
    handleContractPdfDownload
  );

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
        target_user_id,
        category,
        description,
        deadline,
        free_edits,
        revisions,
        commission_payer,
        inspection_hours,
        contract_id,
        staged_payment,
        is_milestone,
        milestones,
        save_as_draft,
        status,
      } = req.body || {};
      const cleanTitle = String(title || '').trim().slice(0, 200);
      const numAmount = Math.floor(Number(normalizeDigits(String(amount ?? '0')) || 0));
      const rawPhoneStr = String(phone || '').trim();
      const parsedPhone = parseIranMobile(rawPhoneStr);
      const normPhone = parsedPhone.valid ? parsedPhone.local : '';
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

      const useStagedPayment = Boolean(staged_payment ?? is_milestone);
      let normalizedMilestones: any[] = [];
      if (useStagedPayment) {
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
          const mAmt = Math.floor(Number(normalizeDigits(String(item.amount ?? '0')) || 0));
          const mDays =
            item.deadline_days !== undefined && item.deadline_days !== '' && Number(item.deadline_days) > 0
              ? Math.max(1, Math.min(365, Math.floor(Number(item.deadline_days))))
              : undefined;
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
            ...(mDays ? { deadline_days: mDays } : {}),
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
          (isUserDealBuyer(d, actor) || isUserDealSeller(d, actor)) &&
          !isTerminalStatus(d.status)
      ).length;
      const maxActive = Number(actor.max_active_deals || limits.default_max_active_deals || 0);
      if (maxActive > 0 && myActiveDeals >= maxActive) {
        return res.status(400).json({
          success: false,
          error: `شما به سقف مجاز معاملات فعال همزمان (${maxActive} معامله) رسیده‌اید.`,
        });
      }

      if (rawPhoneStr && !parsedPhone.valid) {
        return res.status(400).json({ success: false, error: 'شماره همراه طرف مقابل معتبر نیست (مثال: 09123456789 یا +989123456789).' });
      }

      const rawUpperCat = String(category || '').trim().toUpperCase();
      const normCat = ['DEV', 'DESIGN', 'DS', 'ACADEMIC', 'TEACHING', 'CNS', 'GEN'].includes(rawUpperCat)
        ? rawUpperCat
        : normalizeCategoryCode(category);
      const cid = contract_id
        ? String(contract_id).replace(/[^a-zA-Z0-9_-]/g, '')
        : generateContractId(normCat);
      const inviteToken = `c_${cid}`;

      let counterparty =
        parsedPhone.valid ? await findUserByPhone(parsedPhone.local, parsedPhone.core10) : null;
      if (!counterparty && target_user_id && String(target_user_id) !== 'support' && !isPendingPartyId(String(target_user_id))) {
        counterparty = await getUserById(String(target_user_id));
      }
      if (counterparty && getUserIdentityTokens(actor).some((t) => getUserIdentityTokens(counterparty).includes(t))) {
        return res.status(400).json({ success: false, error: 'امکان ایجاد معامله با حساب خودتان وجود ندارد.' });
      }

      const isDraft = Boolean(save_as_draft) || String(status || '').trim().toLowerCase() === 'draft';
      const initialStatus = isDraft ? 'draft' : 'pending_party_b';
      const creatorRole: 'buyer' | 'seller' = role === 'buyer' ? 'buyer' : 'seller';
      const creatorStoredId = getStoredActorTelegramOrId(actor);
      const creatorName = String(actor.full_name || actor.first_name || 'کاربر میانجی').trim();
      const creatorPhone = normalizeIranPhone(String(actor.phone_number || '')) || null;
      const creatorNationalId = actor.national_id ? normalizeDigits(String(actor.national_id)) : null;

      const matchedOtherStoredId = counterparty ? getStoredActorTelegramOrId(counterparty) : null;
      const matchedOtherName = counterparty ? String(counterparty.full_name || counterparty.first_name || 'کاربر میانجی').trim() : null;
      const matchedOtherPhone = counterparty ? normalizeIranPhone(String(counterparty.phone_number || '')) || null : null;
      const matchedOtherNationalId = counterparty?.national_id ? normalizeDigits(String(counterparty.national_id)) : null;

      const buyerIdVal: number | string | null = creatorRole === 'buyer' ? creatorStoredId : matchedOtherStoredId;
      const sellerIdVal: number | string | null = creatorRole === 'seller' ? creatorStoredId : matchedOtherStoredId;
      const isOpenInvite = buyerIdVal === null || sellerIdVal === null;
      const pendingPhone = !counterparty && normPhone ? normPhone : '';

      const feePercent = Math.max(0, Math.min(15, Number(limits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));
      const normPayer = normalizeCommissionPayer(commission_payer);
      const breakdown = computeCommissionBreakdown(numAmount, feePercent, normPayer);
      const numDeadline = Math.max(1, Math.min(365, Math.floor(Number(normalizeDigits(String(deadline ?? '7')) || 7))));
      const numFreeEdits = Math.max(0, Math.min(50, Math.floor(Number(normalizeDigits(String(free_edits ?? revisions ?? '2')) || 0))));
      const cleanDescription = String(description || '').trim().slice(0, 4000);
      const nowIso = new Date().toISOString();

      const creatorSigHash = !isDraft ? makeSignatureHash(cid, creatorStoredId, creatorRole, nowIso) : null;
      const buyerSignedAt = creatorRole === 'buyer' && !isDraft ? nowIso : null;
      const sellerSignedAt = creatorRole === 'seller' && !isDraft ? nowIso : null;
      const buyerOtpVerified = creatorRole === 'buyer' && !isDraft;
      const sellerOtpVerified = creatorRole === 'seller' && !isDraft;
      const buyerSigHash = creatorRole === 'buyer' ? creatorSigHash : null;
      const sellerSigHash = creatorRole === 'seller' ? creatorSigHash : null;

      const createdEventText = isDraft
        ? `پیش‌نویس قرارداد «${cleanTitle}» ایجاد شد`
        : useStagedPayment
        ? `قرارداد مرحله‌ای «${cleanTitle}» (${normalizedMilestones.length} مرحله) ایجاد و امضا شد`
        : `قرارداد «${cleanTitle}» ایجاد و توسط ${creatorRole === 'buyer' ? 'کارفرما' : 'مجری'} امضا شد`;

      const initialHistory = [
        {
          event: createdEventText,
          timestamp: nowIso,
          actor: creatorName,
          actor_id: creatorStoredId,
        },
      ];
      const initialTimeline = [
        {
          id: `tl_${Date.now()}`,
          type: 'created',
          status: initialStatus,
          actor_id: String(actor.id),
          actor_name: creatorName,
          note: `${createdEventText} (${numAmount.toLocaleString()} تومان)`,
          timestamp: nowIso,
        },
      ];

      const botUsername = await resolveBotUsername().catch(() => 'mianji_ir_bot');
      const botLink = buildTelegramBotDealLink(cid, botUsername);

      const firestoreDoc: Record<string, any> = {
        id: cid,
        contract_id: cid,
        invite_token: inviteToken,
        title: cleanTitle,
        category: normCat,
        amount: numAmount,
        deadline: numDeadline,
        description: cleanDescription,
        free_edits: numFreeEdits,
        free_edits_total: numFreeEdits,
        free_edits_left: numFreeEdits,
        revisions: String(numFreeEdits),
        commission_payer: normPayer,
        fee_percent: feePercent,
        fee_amount: breakdown.totalFee,
        net_seller_amount: breakdown.netSellerAmount,
        staged_payment: useStagedPayment,
        is_milestone: useStagedPayment,
        milestones: normalizedMilestones,
        creator_id: creatorStoredId,
        created_by: creatorStoredId,
        buyer_role: 'employer',
        seller_role: 'freelancer',
        buyer_id: buyerIdVal,
        buyer_fullname: creatorRole === 'buyer' ? creatorName : matchedOtherName,
        buyer_phone: creatorRole === 'buyer' ? creatorPhone : matchedOtherPhone,
        buyer_national_id: creatorRole === 'buyer' ? creatorNationalId : matchedOtherNationalId,
        seller_id: sellerIdVal,
        seller_fullname: creatorRole === 'seller' ? creatorName : matchedOtherName,
        seller_phone: creatorRole === 'seller' ? creatorPhone : matchedOtherPhone,
        seller_national_id: creatorRole === 'seller' ? creatorNationalId : matchedOtherNationalId,
        invite_mode: isOpenInvite || initialStatus === 'pending_party_b',
        ...(pendingPhone ? { pending_phone: pendingPhone } : {}),
        status: initialStatus,
        escrow_deposit_status: 'unpaid',
        inspection_hours: String(inspection_hours || '48').slice(0, 10),
        buyer_signed_at: buyerSignedAt,
        seller_signed_at: sellerSignedAt,
        buyer_otp_verified: buyerOtpVerified,
        seller_otp_verified: sellerOtpVerified,
        buyer_signature_hash: buyerSigHash,
        seller_signature_hash: sellerSigHash,
        history: initialHistory,
        timeline: initialTimeline,
        created_at: nowIso,
        updated_at: nowIso,
      };

      const dealRecord = await enrichDealWithParties(firestoreDoc, undefined, String(actor.id));
      await strictFirestoreWrite(`deals/${cid}#create`, (db) =>
        db.collection('deals').doc(cid).set({
          ...firestoreDoc,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        })
      );
      memoryDeals.set(cid, dealRecord);
      if (creatorSigHash && !isDraft) {
        void recordContractSignatureRecord({
          contractId: cid,
          user: actor,
          role: creatorRole,
          signatureHash: creatorSigHash,
          signedAt: nowIso,
          otpVerified: true,
          clientIp: req.ip,
          verificationMethod: 'web_session',
        });
      }

      const counterpartyWebId = counterparty ? String(counterparty.id) : '';
      const recipients = counterpartyWebId ? [String(actor.id), counterpartyWebId] : [String(actor.id)];
      await appendContractMilestoneMessage(
        cid,
        actor,
        isDraft
          ? `📝 پیش‌نویس قرارداد «${cleanTitle}» ذخیره شد.`
          : `🛡️ قرارداد امن «${cleanTitle}» (${cid}) به مبلغ ${numAmount.toLocaleString()} تومان ایجاد شد و در انتظار تایید/امضای طرف دوم است.`,
        undefined,
        recipients
      );

      if (counterpartyWebId) {
        await pushUserNotification(
          counterpartyWebId,
          'قرارداد امن جدید ثبت شد',
          `${creatorName} قرارداد «${cleanTitle}» به مبلغ ${numAmount.toLocaleString()} تومان را با شما ثبت کرد.`,
          `🤝 <b>قرارداد جدید میانجی</b>\n\nعنوان: <b>${cleanTitle}</b>\nشناسه: <code>${cid}</code>\nمبلغ: <b>${numAmount.toLocaleString()} تومان</b>\n\nلینک مشاهده در ربات:\n${botLink}`,
          {
            kind: 'deal',
            contract_id: cid,
            url: `/?view=detail&contract_id=${cid}`,
            tag: `mianji-deal-${cid}-created`,
          }
        );
        wsBroadcastUser(counterpartyWebId, 'deal:updated', { contract: dealRecord });
      }

      wsBroadcastUser(String(actor.id), 'deal:updated', { contract: dealRecord });
      res.json({ success: true, deal: dealRecord, bot_link: botLink });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ایجاد معامله' });
    }
  });

  app.get('/api/deals/invite/:contractId', async (req, res) => {
    try {
      const cid = String(req.params.contractId || '').trim();
      const token = String(req.query.token || '').trim();
      const deal = await getDealByContractId(cid);
      if (!deal) {
        return res.status(404).json({ success: false, error: 'قرارداد مورد نظر یافت نشد.' });
      }

      const caller = await tryAuthenticate(req);
      const callerId = caller ? String(caller.id) : '';
      const callerPhoneCore = caller?.phone_number ? getPhoneCore10(String(caller.phone_number)) : '';
      const pendingCore = deal.pending_phone ? getPhoneCore10(String(deal.pending_phone)) : '';

      const isParticipant = Boolean(
        caller && (isUserDealBuyer(deal, caller) || isUserDealSeller(deal, caller) || isUserDealCreator(deal, caller))
      );
      const botTokenMatch = token === `c_${cid}` || token === `c_${deal.contract_id}`;
      const tokenMatches = Boolean((deal.invite_token && token && String(deal.invite_token) === token) || botTokenMatch);
      const pendingPhoneMatches = Boolean(callerPhoneCore && pendingCore && callerPhoneCore === pendingCore);

      if (deal.invite_token && !tokenMatches && !isParticipant && !pendingPhoneMatches && !isPendingPartyId(deal.buyer_id) && !isPendingPartyId(deal.seller_id)) {
        return res.status(403).json({ success: false, error: 'لینک یا توکن امضای این قرارداد معتبر نیست.' });
      }

      const enriched = await enrichDealWithParties(deal, undefined, callerId || undefined);
      const buyerPending = isPendingPartyId(enriched.buyer_id);
      const sellerPending = isPendingPartyId(enriched.seller_id);
      const missingRole = buyerPending ? 'buyer' : sellerPending ? 'seller' : null;
      const isCallerCreator = Boolean(caller && isUserDealCreator(enriched, caller));
      const normStatus = normalizeDealStatus(enriched.status);
      const isCallerBuyer = Boolean(caller && isUserDealBuyer(enriched, caller));
      const isCallerSeller = Boolean(caller && isUserDealSeller(enriched, caller));

      const creatorIsBuyer = isCallerCreator ? isCallerBuyer : sellerPending || (!buyerPending && String(enriched.creator_id) === String(enriched.buyer_id));
      const creatorName = creatorIsBuyer ? enriched.buyer_name : enriched.seller_name;

      res.json({
        success: true,
        invite: {
          contract_id: enriched.contract_id,
          title: enriched.title,
          amount: enriched.amount,
          fee_percent: enriched.fee_percent,
          fee_amount: enriched.fee_amount,
          employer_fee: enriched.employer_fee,
          freelancer_fee: enriched.freelancer_fee,
          employer_total_payable: enriched.employer_total_payable,
          net_seller_amount: enriched.net_seller_amount,
          commission_payer: enriched.commission_payer,
          staged_payment: enriched.staged_payment,
          is_milestone: enriched.is_milestone,
          milestones: enriched.milestones,
          category: enriched.category,
          description: enriched.description,
          deadline: enriched.deadline,
          free_edits: enriched.free_edits,
          revisions: enriched.revisions,
          inspection_hours: enriched.inspection_hours,
          status: normStatus,
          invite_mode: Boolean(enriched.invite_mode),
          bot_invite_url: enriched.bot_invite_url,
          missing_role: missingRole,
          creator_id: String(enriched.creator_id || ''),
          creator_name: creatorName,
          buyer_id: enriched.buyer_id,
          seller_id: enriched.seller_id,
          buyer_name: enriched.buyer_name,
          seller_name: enriched.seller_name,
          already_claimed: !buyerPending && !sellerPending,
          is_caller_creator: isCallerCreator,
          can_claim_and_sign:
            !isTerminalStatus(normStatus) &&
            ((missingRole !== null && !isCallerCreator) ||
              (missingRole === null &&
                ['draft', 'pending_party_b'].includes(normStatus) &&
                ((isCallerBuyer && !enriched.buyer_signed_at) || (isCallerSeller && !enriched.seller_signed_at)))),
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت اطلاعات دعوت قرارداد' });
    }
  });

  app.post('/api/deals/:contractId/claim-and-sign', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const cid = String(req.params.contractId || '').trim();
    if (processingDealIds.has(cid)) {
      return res.status(409).json({ success: false, error: 'درخواست همزمان در حال پردازش است.' });
    }
    processingDealIds.add(cid);
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      const storedActorId = getStoredActorTelegramOrId(actor);
      const token = String(req.body?.token || '').trim();
      const action = String(req.body?.action || 'join_and_sign').trim();

      const deal = await getDealByContractId(cid);
      if (!deal) {
        return res.status(404).json({ success: false, error: 'قرارداد مورد نظر یافت نشد.' });
      }
      const dealDocId = String(deal._docId || cid);
      const curStatus = normalizeDealStatus(deal.status);
      if (isTerminalStatus(curStatus)) {
        return res.status(400).json({ success: false, error: 'این قرارداد پیش‌تر مختومه شده است.' });
      }

      const buyerPending = isPendingPartyId(deal.buyer_id);
      const sellerPending = isPendingPartyId(deal.seller_id);
      const hasPendingSlot = buyerPending || sellerPending;
      const actorPhoneCore = actor.phone_number ? getPhoneCore10(String(actor.phone_number)) : '';
      const pendingCore = deal.pending_phone ? getPhoneCore10(String(deal.pending_phone)) : '';

      const botTokenMatch = token === `c_${cid}` || token === `c_${deal.contract_id}`;
      const tokenMatches = Boolean((deal.invite_token && token && String(deal.invite_token) === token) || botTokenMatch);
      const phoneMatches = Boolean(actorPhoneCore && pendingCore && actorPhoneCore === pendingCore);
      const isAlreadyBuyer = isUserDealBuyer(deal, actor);
      const isAlreadySeller = isUserDealSeller(deal, actor);
      const isAlreadyParticipant = isAlreadyBuyer || isAlreadySeller;

      if (deal.invite_token && !tokenMatches && !phoneMatches && !isAlreadyParticipant && !hasPendingSlot) {
        return res.status(403).json({ success: false, error: 'لینک یا توکن امضای این قرارداد معتبر نیست.' });
      }

      let nextBuyerId: any = buyerPending ? null : deal.buyer_id;
      let nextSellerId: any = sellerPending ? null : deal.seller_id;
      let joinedAs: 'buyer' | 'seller' | null = null;

      if (hasPendingSlot) {
        if (isUserDealCreator(deal, actor) || isAlreadyParticipant) {
          return res.status(400).json({ success: false, error: 'ایجادکننده قرارداد نمی‌تواند جایگاه طرف مقابل را امضا کند.' });
        }
        if (actor.is_deal_locked) {
          return res.status(403).json({ success: false, error: 'امکان ثبت یا عضویت در معامله برای حساب شما محدود شده است.' });
        }
        const limits = await loadGlobalLimits();
        const allDeals = await getAllDealsMerged();
        const myActiveDeals = allDeals.filter(
          (d) =>
            (isUserDealBuyer(d, actor) || isUserDealSeller(d, actor)) &&
            !isTerminalStatus(d.status)
        ).length;
        const maxActive = Number(actor.max_active_deals || limits.default_max_active_deals || 0);
        if (maxActive > 0 && myActiveDeals >= maxActive) {
          return res.status(400).json({
            success: false,
            error: `شما به سقف مجاز معاملات فعال همزمان (${maxActive} معامله) رسیده‌اید.`,
          });
        }
        if (buyerPending) {
          nextBuyerId = storedActorId;
          joinedAs = 'buyer';
        } else if (sellerPending) {
          nextSellerId = storedActorId;
          joinedAs = 'seller';
        }
      } else if (!isAlreadyParticipant) {
        return res.status(409).json({ success: false, error: 'طرف مقابل این قرارداد پیش‌تر تکمیل شده است.' });
      }

      const nowIso = new Date().toISOString();
      const actorName = String(actor.full_name || actor.first_name || 'کاربر میانجی').trim();
      const actorPhone = normalizeIranPhone(String(actor.phone_number || '')) || null;
      const actorNationalId = actor.national_id ? normalizeDigits(String(actor.national_id)) : null;

      const shouldSign = action !== 'join_only' && ['draft', 'pending_party_b'].includes(curStatus);
      const actorRoleInDeal: 'buyer' | 'seller' = joinedAs || (isAlreadyBuyer ? 'buyer' : 'seller');
      const sigHash = shouldSign ? makeSignatureHash(cid, storedActorId, actorRoleInDeal, nowIso) : null;

      const buyerSignedAt = actorRoleInDeal === 'buyer' && shouldSign ? nowIso : (deal.buyer_signed_at ?? null);
      const sellerSignedAt = actorRoleInDeal === 'seller' && shouldSign ? nowIso : (deal.seller_signed_at ?? null);
      const buyerOtpVerified = actorRoleInDeal === 'buyer' && shouldSign ? true : Boolean(deal.buyer_otp_verified);
      const sellerOtpVerified = actorRoleInDeal === 'seller' && shouldSign ? true : Boolean(deal.seller_otp_verified);
      const buyerSigHash = actorRoleInDeal === 'buyer' && sigHash ? sigHash : (deal.buyer_signature_hash ?? null);
      const sellerSigHash = actorRoleInDeal === 'seller' && sigHash ? sigHash : (deal.seller_signature_hash ?? null);

      const nextStatus = shouldSign ? 'awaiting_payment' : curStatus;
      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const prevHistory = Array.isArray(deal.history) ? deal.history : [];
      const joinNote = hasPendingSlot
        ? shouldSign
          ? `${actorName} به قرارداد پیوست و آن را امضا کرد.`
          : `${actorName} از طریق لینک/QR به قرارداد پیوست.`
        : `قرارداد توسط ${actorName} تایید و امضا شد.`;

      const nextTimeline = [
        ...prevTimeline,
        {
          id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          type: 'invite_signed',
          status: nextStatus,
          actor_id: uid,
          actor_name: actorName,
          note: joinNote,
          timestamp: nowIso,
        },
      ];
      const nextHistory = [
        ...prevHistory,
        {
          event: joinNote,
          timestamp: nowIso,
          actor: actorName,
          actor_id: storedActorId,
        },
      ];

      const updateFields: Record<string, any> = {
        buyer_id: nextBuyerId,
        seller_id: nextSellerId,
        ...(joinedAs === 'buyer'
          ? {
              buyer_fullname: actorName,
              buyer_phone: actorPhone,
              buyer_national_id: actorNationalId,
            }
          : {}),
        ...(joinedAs === 'seller'
          ? {
              seller_fullname: actorName,
              seller_phone: actorPhone,
              seller_national_id: actorNationalId,
            }
          : {}),
        buyer_signed_at: buyerSignedAt,
        seller_signed_at: sellerSignedAt,
        buyer_otp_verified: buyerOtpVerified,
        seller_otp_verified: sellerOtpVerified,
        buyer_signature_hash: buyerSigHash,
        seller_signature_hash: sellerSigHash,
        invite_mode: false,
        invite_claimed_at: deal.invite_claimed_at || nowIso,
        status: nextStatus,
        timeline: nextTimeline,
        history: nextHistory,
        updatedAt: nowIso,
        updated_at: nowIso,
      };

      await strictFirestoreWrite(`deals/${dealDocId}#claim`, (db) =>
        db.collection('deals').doc(dealDocId).set(
          {
            ...updateFields,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      );

      const updatedDeal = await enrichDealWithParties({ ...deal, ...updateFields }, undefined, uid);
      memoryDeals.set(cid, updatedDeal);
      if (sigHash && shouldSign) {
        void recordContractSignatureRecord({
          contractId: cid,
          user: actor,
          role: actorRoleInDeal,
          signatureHash: sigHash,
          signedAt: nowIso,
          otpVerified: true,
          clientIp: req.ip,
          verificationMethod: 'web_invite_sign',
        });
      }

      const buyerNotifyId = String(nextBuyerId ?? '');
      const sellerNotifyId = String(nextSellerId ?? '');
      await appendContractMilestoneMessage(cid, actor, `✍️ ${joinNote}`, undefined, [buyerNotifyId, sellerNotifyId].filter(Boolean));
      const otherId = actorRoleInDeal === 'buyer' ? sellerNotifyId : buyerNotifyId;
      if (otherId && !isPendingPartyId(otherId)) {
        await pushUserNotification(
          otherId,
          `امضای قرارداد ${cid}`,
          joinNote,
          `✍️ <b>امضای قرارداد ${cid}</b>\n\n${joinNote}`,
          {
            kind: 'deal',
            contract_id: cid,
            url: `/?view=detail&contract_id=${cid}`,
            tag: `mianji-deal-${cid}-claimed`,
          }
        );
      }

      if (buyerNotifyId) wsBroadcastUser(buyerNotifyId, 'deal:updated', { contract: updatedDeal });
      if (sellerNotifyId) wsBroadcastUser(sellerNotifyId, 'deal:updated', { contract: updatedDeal });
      wsBroadcastRoom(`contract:${cid}`, 'deal:updated', { contract: updatedDeal });

      res.json({ success: true, deal: updatedDeal });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در پیوستن و امضای قرارداد' });
    } finally {
      processingDealIds.delete(cid);
    }
  });

  // --- User Auto-Saved Deal Drafts API ---
  app.get('/api/deal-drafts', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const merged = new Map<string, any>();
      (memoryDealDrafts.get(uid) || []).forEach((d) => merged.set(String(d.id), d));

      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('users').doc(uid).collection('deal_drafts').limit(30).get();
          snap.docs.forEach((docSnap) => {
            const d = docSnap.data() || {};
            merged.set(docSnap.id, {
              ...d,
              id: docSnap.id,
              updated_at: d.updated_at?.toDate?.()?.toISOString?.() || d.updated_at || new Date().toISOString(),
            });
          });
        } catch {}
      }

      const drafts = Array.from(merged.values()).sort(
        (a, b) => Date.parse(String(b.updated_at || 0)) - Date.parse(String(a.updated_at || 0))
      );
      memoryDealDrafts.set(uid, drafts);
      res.json({ success: true, drafts });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت پیش‌نویس‌ها' });
    }
  });

  app.put('/api/deal-drafts/:draftId', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const draftId = String(req.params.draftId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      if (!draftId) {
        return res.status(400).json({ success: false, error: 'شناسه پیش‌نویس نامعتبر است.' });
      }
      const b = req.body || {};
      const nowIso = new Date().toISOString();
      const draftObj = {
        id: draftId,
        owner_id: uid,
        title: String(b.title || '').slice(0, 200),
        amount: String(b.amount || '').slice(0, 24),
        role: b.role === 'buyer' ? 'buyer' : 'seller',
        phone: String(b.phone || '').slice(0, 24),
        category: normalizeCategoryCode(b.category),
        deadline: String(b.deadline || '7').slice(0, 20),
        free_edits: String(b.free_edits ?? b.revisions ?? '2').slice(0, 20),
        revisions: String(b.revisions ?? b.free_edits ?? '2').slice(0, 20),
        commission_payer: normalizeCommissionPayer(b.commission_payer),
        inspection_hours: String(b.inspection_hours || '48').slice(0, 10),
        description: String(b.description || '').slice(0, 4000),
        staged_payment: Boolean(b.staged_payment ?? b.is_milestone),
        is_milestone: Boolean(b.staged_payment ?? b.is_milestone),
        milestones: Array.isArray(b.milestones)
          ? b.milestones.slice(0, 8).map((m: any) => ({
              title: String(m?.title || '').slice(0, 120),
              amount: String(m?.amount || '').slice(0, 24),
              ...(m?.deadline_days !== undefined ? { deadline_days: String(m.deadline_days).slice(0, 10) } : {}),
              ...(m?.percentage !== undefined ? { percentage: String(m.percentage).slice(0, 10) } : {}),
            }))
          : [],
        step: Math.max(1, Math.min(10, Number(b.step || 1))),
        updated_at: nowIso,
      };

      const existing = memoryDealDrafts.get(uid) || [];
      const nextList = [draftObj, ...existing.filter((d) => String(d.id) !== draftId)].slice(0, 25);
      memoryDealDrafts.set(uid, nextList);

      const firestore = getDb();
      if (firestore) {
        try {
          await firestore.collection('users').doc(uid).collection('deal_drafts').doc(draftId).set(draftObj);
        } catch {}
      }

      res.json({ success: true, draft: draftObj });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ذخیره پیش‌نویس' });
    }
  });

  app.delete('/api/deal-drafts/:draftId', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const draftId = String(req.params.draftId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      const existing = memoryDealDrafts.get(uid) || [];
      memoryDealDrafts.set(
        uid,
        existing.filter((d) => String(d.id) !== draftId)
      );

      const firestore = getDb();
      if (firestore && draftId) {
        try {
          await firestore.collection('users').doc(uid).collection('deal_drafts').doc(draftId).delete();
        } catch {}
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در حذف پیش‌نویس' });
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
      const rawNextStatus = String(req.body?.status || '').trim();
      const nextStatus = normalizeDealStatus(rawNextStatus);
      const transitionNote = String(req.body?.note || '').trim().slice(0, 1000);
      const transitionAttachment =
        typeof req.body?.attachment_url === 'string' && req.body.attachment_url.length <= 2048
          ? req.body.attachment_url
          : undefined;

      const deal = await getDealByContractId(cid);
      if (!deal) {
        return res.status(404).json({ success: false, error: 'قرارداد مورد نظر یافت نشد.' });
      }
      const dealDocId = String(deal._docId || cid);

      const uid = String(actor.id);
      const actorStoredId = getStoredActorTelegramOrId(actor);
      const actorName = String(actor.full_name || actor.first_name || 'کاربر میانجی').trim();
      const isBuyer = isUserDealBuyer(deal, actor);
      const isSeller = isUserDealSeller(deal, actor);
      const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
      if (!isBuyer && !isSeller && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'شما مجاز به تغییر وضعیت این معامله نیستید.' });
      }

      const cur = normalizeDealStatus(deal.status);
      if (isTerminalStatus(cur)) {
        return res.status(400).json({ success: false, error: 'این قرارداد پیش‌تر مختومه شده است.' });
      }

      if (
        ['awaiting_payment', 'active'].includes(nextStatus) &&
        (isPendingPartyId(deal.buyer_id) || isPendingPartyId(deal.seller_id))
      ) {
        return res.status(400).json({
          success: false,
          error: 'هنوز طرف مقابل از طریق لینک یا کد QR به این قرارداد ملحق نشده است.',
        });
      }

      const useStaged = Boolean((deal.staged_payment ?? deal.is_milestone) && Array.isArray(deal.milestones) && deal.milestones.length >= 2);
      if (useStaged && ['work_submitted', 'completed'].includes(nextStatus) && !isAdminActor) {
        return res.status(400).json({
          success: false,
          error: 'این قرارداد مرحله‌ای است؛ لطفاً از کارت مراحل پروژه هر مرحله را تحویل یا آزادسازی کنید.',
        });
      }

      const allowed =
        (['draft', 'pending_party_b'].includes(cur) && nextStatus === 'awaiting_payment' && (isBuyer || isAdminActor)) ||
        (cur === 'draft' && nextStatus === 'pending_party_b' && (isBuyer || isSeller || isAdminActor)) ||
        (['awaiting_payment', 'awaiting_receipt_approval'].includes(cur) && nextStatus === 'active' && (isBuyer || isAdminActor)) ||
        (['active', 'revisions_requested'].includes(cur) && nextStatus === 'work_submitted' && (isSeller || isAdminActor)) ||
        (cur === 'work_submitted' && ['completed', 'active', 'revisions_requested'].includes(nextStatus) && (isBuyer || isAdminActor)) ||
        (['draft', 'pending_party_b', 'awaiting_payment', 'awaiting_receipt_approval'].includes(cur) && nextStatus === 'cancelled') ||
        (['awaiting_payment', 'awaiting_receipt_approval', 'active', 'work_submitted', 'revisions_requested'].includes(cur) &&
          isDisputedStatus(nextStatus));

      if (!allowed) {
        return res.status(400).json({ success: false, error: 'تغییر وضعیت درخواستی در این مرحله مجاز نیست.' });
      }

      const amount = Number(deal.amount || 0);
      const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent ?? globalLimits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));
      const breakdown = computeCommissionBreakdown(amount, feePercent, deal.commission_payer);
      const buyerId = String(deal.buyer_id ?? '');
      const sellerId = String(deal.seller_id ?? '');
      const firestore = getDb();
      let balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};

      const nowIso = new Date().toISOString();
      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const prevHistory = Array.isArray(deal.history) ? deal.history : [];
      const timelineEntry: any = {
        id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        type: 'status_change',
        status: nextStatus,
        actor_id: uid,
        actor_name: actorName,
        ...(transitionNote ? { note: transitionNote } : {}),
        ...(transitionAttachment ? { attachment_url: transitionAttachment } : {}),
        timestamp: nowIso,
      };
      const nextTimeline = [...prevTimeline, timelineEntry];

      const statusEventMap: Record<string, string> = {
        pending_party_b: 'قرارداد برای تایید طرف دوم ارسال شد',
        awaiting_payment: 'قرارداد توسط طرفین تایید و آماده پرداخت شد',
        active:
          cur === 'work_submitted'
            ? 'درخواست اصلاحات ثبت و به مجری ارجاع شد'
            : `مبلغ ${breakdown.employerTotalPayable.toLocaleString()} تومان در حساب امانت قفل شد`,
        revisions_requested: 'کارفرما درخواست اصلاح کار را ثبت کرد',
        work_submitted: 'کار تحویل داده شد و دوره بازرسی آغاز شد',
        completed: 'تایید نهایی انجام و وجه برای مجری آزاد شد',
        cancelled: 'قرارداد لغو شد',
        in_dispute: 'پرونده برای بررسی داوری ارجاع شد',
      };
      const nextHistory = [
        ...prevHistory,
        {
          event: transitionNote
            ? `${statusEventMap[nextStatus] || nextStatus}: ${transitionNote}`
            : statusEventMap[nextStatus] || `تغییر وضعیت به ${nextStatus}`,
          timestamp: nowIso,
          actor: actorName,
          actor_id: actorStoredId,
        },
      ];

      const extraDealFields: Record<string, any> = {
        timeline: nextTimeline,
        history: nextHistory,
        updated_at: nowIso,
      };
      if (cur === 'draft' && ['pending_party_b', 'awaiting_payment'].includes(nextStatus)) {
        if (isBuyer && !deal.buyer_signed_at) {
          extraDealFields.buyer_signed_at = nowIso;
          extraDealFields.buyer_otp_verified = true;
          extraDealFields.buyer_signature_hash = makeSignatureHash(cid, actorStoredId, 'buyer', nowIso);
          void recordContractSignatureRecord({
            contractId: cid,
            user: actor,
            role: 'buyer',
            signatureHash: extraDealFields.buyer_signature_hash,
            signedAt: nowIso,
            otpVerified: true,
            clientIp: req.ip,
            verificationMethod: 'web_transition_sign',
          });
        } else if (isSeller && !deal.seller_signed_at) {
          extraDealFields.seller_signed_at = nowIso;
          extraDealFields.seller_otp_verified = true;
          extraDealFields.seller_signature_hash = makeSignatureHash(cid, actorStoredId, 'seller', nowIso);
          void recordContractSignatureRecord({
            contractId: cid,
            user: actor,
            role: 'seller',
            signatureHash: extraDealFields.seller_signature_hash,
            signedAt: nowIso,
            otpVerified: true,
            clientIp: req.ip,
            verificationMethod: 'web_transition_sign',
          });
        }
        if (nextStatus === 'pending_party_b') {
          extraDealFields.invite_mode = true;
        }
      }
      if (['awaiting_payment', 'awaiting_receipt_approval'].includes(cur) && nextStatus === 'active') {
        const deadlineDays = Math.max(1, Math.min(365, Number(deal.deadline || 7) || 7));
        extraDealFields.delivery_due_at = new Date(Date.now() + deadlineDays * 86400000).toISOString();
        extraDealFields.paid_at = nowIso;
        extraDealFields.deadline_warning_sent = null;
        extraDealFields.deadline_overdue_sent = null;
        extraDealFields.escrow_deposit_status = 'paid_locked';
        extraDealFields.locked_amount = breakdown.employerTotalPayable;
        extraDealFields.escrow_locked_amount = breakdown.employerTotalPayable;
        extraDealFields.escrow_released_amount = 0;
      }
      if (nextStatus === 'work_submitted') {
        const minHours = isProd ? 1 : 0.001;
        const hours = Math.max(minHours, Math.min(720, Number(deal.inspection_hours) || 48));
        extraDealFields.work_submitted_at = nowIso;
        extraDealFields.auto_release_at = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        extraDealFields.auto_release_warning_sent = null;
        if (transitionNote) extraDealFields.delivery_note = transitionNote;
        if (transitionAttachment) extraDealFields.delivery_attachment_url = transitionAttachment;
      } else if (cur === 'work_submitted' && (nextStatus === 'active' || nextStatus === 'revisions_requested')) {
        extraDealFields.auto_release_at = null;
        extraDealFields.auto_release_warning_sent = null;
        if (transitionNote) extraDealFields.revision_note = transitionNote;
        const curEditsLeft = Math.max(0, Number(deal.free_edits_left ?? deal.free_edits ?? deal.revisions ?? 0));
        if (curEditsLeft > 0) {
          extraDealFields.free_edits_left = curEditsLeft - 1;
          extraDealFields.revisions = String(curEditsLeft - 1);
        }
      } else if (isDisputedStatus(nextStatus)) {
        extraDealFields.auto_release_at = null;
        extraDealFields.auto_release_warning_sent = null;
        if (Array.isArray(deal.milestones) && deal.milestones.length > 0) {
          extraDealFields.milestones = deal.milestones.map((m: any) => ({ ...m, auto_release_at: null, auto_release_warning_sent: null }));
        }
        if (transitionNote) extraDealFields.dispute_reason = transitionNote;
      } else if (nextStatus === 'completed') {
        extraDealFields.auto_release_at = null;
        extraDealFields.auto_release_warning_sent = null;
        extraDealFields.completed_at = nowIso;
        extraDealFields.escrow_deposit_status = 'released';
      } else if (nextStatus === 'cancelled') {
        extraDealFields.escrow_deposit_status = deal.escrow_deposit_status === 'paid_locked' ? 'refunded' : 'unpaid';
      }

      if (['awaiting_payment', 'awaiting_receipt_approval'].includes(cur) && nextStatus === 'active' && useStaged && Array.isArray(deal.milestones) && deal.milestones.length > 0) {
        extraDealFields.milestones = deal.milestones.map((m: any, i: number) => ({
          ...m,
          status: i === 0 ? 'active' : 'pending',
        }));
      }

      // Atomic financial operations
      if (['awaiting_payment', 'awaiting_receipt_approval'].includes(cur) && nextStatus === 'active') {
        const buyer = (await getUserById(buyerId)) || { id: buyerId, wallet_balance: 0, escrow_locked_balance: 0 };
        const buyerDocId = String((buyer as any).id || buyerId);
        const wallet = Number(buyer.wallet_balance || 0);
        const locked = Number(buyer.escrow_locked_balance || 0);
        const pendingWithdrawTotal = await getPendingWithdrawTotal(buyerDocId);
        const lockAmount = breakdown.employerTotalPayable;
        const available = Math.max(0, wallet - locked - pendingWithdrawTotal);
        if (available < lockAmount) {
          return res.status(400).json({
            success: false,
            error:
              pendingWithdrawTotal > 0
                ? `موجودی آزاد کارفرما کافی نیست (مبلغ ${pendingWithdrawTotal.toLocaleString()} تومان در صف برداشت در انتظار بررسی است). موجودی آزاد: ${available.toLocaleString()} تومان`
                : `موجودی قابل برداشت کارفرما کافی نیست. موجودی فعلی: ${available.toLocaleString()} تومان | مبلغ مورد نیاز: ${lockAmount.toLocaleString()} تومان`,
          });
        }

        let lockedInTx = false;
        if (supabaseState.ready && supabaseState.client) {
          // Rule #3 Lock: ONLY escrow_locked_balance += lockAmount (no change to wallet_balance)
          const lockRes = await adjustUserWalletAtomic(buyerDocId, 0, lockAmount, true);
          const bBal = { wallet_balance: lockRes.wallet_balance, escrow_locked_balance: lockRes.escrow_locked_balance };
          balancesPayload[buyerDocId] = bBal;
          balancesPayload[buyerId] = bBal;
          if (firestore) {
            await firestore
              .collection('deals')
              .doc(dealDocId)
              .set({ status: 'active', ...extraDealFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          }
          lockedInTx = true;
        } else if (firestore) {
          try {
            await firestore.runTransaction(async (tx) => {
              const bSnap = await tx.get(firestore.collection('users').doc(buyerDocId));
              const bData = bSnap.exists ? bSnap.data() || {} : buyer;
              const liveWallet = Number(bData.wallet_balance ?? wallet);
              const liveLocked = Number(bData.escrow_locked_balance ?? locked);
              if (liveWallet - liveLocked - pendingWithdrawTotal < lockAmount) {
                throw new Error('INSUFFICIENT_BALANCE_ESCROW');
              }
              const nextLocked = liveLocked + lockAmount;
              tx.set(
                firestore.collection('users').doc(buyerDocId),
                {
                  wallet_balance: liveWallet,
                  escrow_locked_balance: nextLocked,
                  updatedAt: FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
              tx.set(
                firestore.collection('deals').doc(dealDocId),
                { status: 'active', ...extraDealFields, updatedAt: FieldValue.serverTimestamp() },
                { merge: true }
              );
              const bBal = { wallet_balance: liveWallet, escrow_locked_balance: nextLocked };
              balancesPayload[buyerDocId] = bBal;
              balancesPayload[buyerId] = bBal;
            });
            const bMem = memoryUsers.get(buyerDocId) || buyer;
            memoryUsers.set(buyerDocId, { ...bMem, id: buyerDocId, ...balancesPayload[buyerDocId] });
            lockedInTx = true;
          } catch (txErr: any) {
            if (txErr?.message === 'INSUFFICIENT_BALANCE_ESCROW') {
              throw new Error('موجودی قابل برداشت کافی نیست.');
            }
            console.warn('[ESCROW-LOCK] Firestore tx fallback:', txErr?.message || txErr);
          }
        }
        if (!lockedInTx) {
          await saveUserBalances(buyerDocId, wallet, locked + lockAmount);
          const bBal = { wallet_balance: wallet, escrow_locked_balance: locked + lockAmount };
          balancesPayload[buyerDocId] = bBal;
          balancesPayload[buyerId] = bBal;
        }

        await recordTransaction(firestore, {
          user_id: buyerDocId,
          contract_id: cid,
          amount: lockAmount,
          type: 'escrow_lock',
          status: 'completed',
          description: `قفل امن وجه برای معامله ${deal.title}`,
        });
      } else if (cur === 'work_submitted' && nextStatus === 'completed') {
        const payout = await executeEscrowPayout({
          cid,
          deal,
          grossUnlockAmount: breakdown.employerTotalPayable,
          sellerGrossAmount: amount,
          feePercent,
          buyerId,
          sellerId,
          nextDealFields: { status: 'completed', ...extraDealFields },
          releaseDescription: `آزادسازی و تسویه معامله ${deal.title}`,
          incrementCompletedCount: true,
        });
        balancesPayload = payout.balancesPayload;
      } else {
        if (nextStatus === 'cancelled' && deal.escrow_deposit_status === 'paid_locked' && buyerId && !isPendingPartyId(buyerId)) {
          const buyerObj = (await getUserById(buyerId)) || { id: buyerId, wallet_balance: 0, escrow_locked_balance: 0 };
          const buyerDocId = String((buyerObj as any).id || buyerId);
          const curLocked = Math.max(0, Number(buyerObj.escrow_locked_balance || 0));
          const lockedAmt = Math.min(curLocked, Number(deal.locked_amount ?? deal.escrow_locked_amount ?? breakdown.employerTotalPayable));
          if (lockedAmt > 0) {
            // Rule #3 Cancel Refund: ONLY escrow_locked_balance -= lockedAmt (NEVER add to wallet_balance!)
            const unlockRes = await adjustUserWalletAtomic(buyerDocId, 0, -lockedAmt, false);
            const bBal = { wallet_balance: unlockRes.wallet_balance, escrow_locked_balance: unlockRes.escrow_locked_balance };
            balancesPayload[buyerDocId] = bBal;
            balancesPayload[buyerId] = bBal;
          }
        }
        if (firestore) {
          await strictFirestoreWrite(`deals/${dealDocId}#transition`, (db) =>
            db
              .collection('deals')
              .doc(dealDocId)
              .set({ status: nextStatus, ...extraDealFields, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          );
        }
      }

      const rawUpdated = { ...deal, ...extraDealFields, status: nextStatus, updatedAt: nowIso, updated_at: nowIso };
      const updatedDeal = await enrichDealWithParties(rawUpdated, undefined, uid);
      memoryDeals.set(cid, updatedDeal);

      const otherPartyId = isBuyer ? sellerId : buyerId;
      const statusMsgMap: Record<string, string> = {
        pending_party_b: `قرارداد «${deal.title}» برای تایید و امضای طرف مقابل ارسال شد.`,
        awaiting_payment: `قرارداد «${deal.title}» تایید شد و در انتظار قفل وجه است.`,
        active:
          cur === 'work_submitted'
            ? `کارفرما برای قرارداد «${deal.title}» درخواست اصلاحات ثبت کرد.`
            : `مبلغ ${breakdown.employerTotalPayable.toLocaleString()} تومان در حساب امانی برای «${deal.title}» قفل شد. اجرا را آغاز کنید.`,
        revisions_requested: `کارفرما برای قرارداد «${deal.title}» درخواست اصلاحات ثبت کرد.`,
        work_submitted: `مجری کار پروژه «${deal.title}» را تحویل داد. مهلت بازرسی ${deal.inspection_hours || 48} ساعته آغاز شد.`,
        completed: `معامله «${deal.title}» با موفقیت تایید و مبلغ آزاد شد.`,
        cancelled: `قرارداد «${deal.title}» لغو شد.`,
        in_dispute: `برای قرارداد «${deal.title}» درخواست حل اختلاف ثبت شد.`,
      };
      const summaryText = statusMsgMap[nextStatus] || `وضعیت معامله «${deal.title}» تغییر کرد.`;
      const chatMilestoneText = transitionNote ? `${summaryText}\n📝 توضیح: ${transitionNote}` : summaryText;

      await appendContractMilestoneMessage(cid, actor, chatMilestoneText, transitionAttachment, [buyerId, sellerId].filter(Boolean));

      if (otherPartyId && !isPendingPartyId(otherPartyId)) {
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
      }
      if (nextStatus === 'completed' && buyerId && !isPendingPartyId(buyerId)) {
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

      if (buyerId) wsBroadcastUser(buyerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
      if (sellerId) wsBroadcastUser(sellerId, 'deal:updated', { contract: updatedDeal, balances: balancesPayload });
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
      const actorStoredId = getStoredActorTelegramOrId(actor);
      const actorName = String(actor.full_name || actor.first_name || 'کاربر میانجی').trim();
      const action = String(req.body?.action || '').trim(); // 'submit' | 'revision' | 'release'
      const note = String(req.body?.note || '').trim().slice(0, 1000);
      const attachmentUrl =
        typeof req.body?.attachment_url === 'string' && req.body.attachment_url.length <= 2048
          ? req.body.attachment_url
          : undefined;

      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });
      const dealDocId = String(deal._docId || cid);
      const useStaged = Boolean((deal.staged_payment ?? deal.is_milestone) && Array.isArray(deal.milestones) && deal.milestones.length >= 2);
      if (!useStaged) {
        return res.status(400).json({ success: false, error: 'این قرارداد از نوع مرحله‌ای نیست.' });
      }
      if (normalizeDealStatus(deal.status) !== 'active') {
        return res.status(400).json({ success: false, error: 'فقط قراردادهای در حال اجرا قابل پیشبرد مرحله‌ای هستند.' });
      }

      const buyerId = String(deal.buyer_id ?? '');
      const sellerId = String(deal.seller_id ?? '');
      const isBuyer = isUserDealBuyer(deal, actor);
      const isSeller = isUserDealSeller(deal, actor);
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
        if (!['active', 'in_progress'].includes(String(targetMs.status))) {
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
        if (!['work_submitted', 'delivered'].includes(String(targetMs.status))) {
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
        if (!['work_submitted', 'delivered', 'active', 'in_progress'].includes(String(targetMs.status))) {
          return res.status(400).json({ success: false, error: 'امکان آزادسازی این مرحله در وضعیت فعلی نیست.' });
        }
        updatedMilestones[msIdx] = {
          ...targetMs,
          status: 'completed',
          completed_at: nowIso,
          auto_release_at: null,
        };
        const nextPendingIdx = updatedMilestones.findIndex((m: any) => ['pending', 'locked', 'awaiting_payment'].includes(String(m.status)));
        if (nextPendingIdx !== -1) {
          updatedMilestones[nextPendingIdx] = { ...updatedMilestones[nextPendingIdx], status: 'active' };
        }
        const allDone = updatedMilestones.every((m: any) => ['completed', 'paid'].includes(String(m.status)));
        if (allDone) nextDealStatus = 'completed';

        const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
        const prevHistory = Array.isArray(deal.history) ? deal.history : [];
        const timelineEntry = {
          id: `tl_ms_${Date.now()}`,
          type: 'milestone_release',
          status: nextDealStatus,
          actor_id: uid,
          actor_name: actorName,
          note: `مرحله ${msIdx + 1} («${targetMs.title}») تایید و مبلغ ${Number(targetMs.amount).toLocaleString()} تومان آزاد شد.`,
          timestamp: nowIso,
        };
        const nextTimeline = [...prevTimeline, timelineEntry];
        const nextHistory = [
          ...prevHistory,
          { event: timelineEntry.note, timestamp: nowIso, actor: actorName, actor_id: actorStoredId },
        ];
        const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent ?? globalLimits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));
        const msAmt = Number(targetMs.amount || 0);
        const msBreakdown = computeCommissionBreakdown(msAmt, feePercent, deal.commission_payer);
        const prevReleased = Number(deal.escrow_released_amount || 0);
        const totalDealLocked =
          deal.escrow_locked_amount !== undefined
            ? Number(deal.escrow_locked_amount)
            : computeCommissionBreakdown(Number(deal.amount || 0), feePercent, deal.commission_payer).employerTotalPayable;
        const remainingDealLocked = Math.max(0, totalDealLocked - prevReleased);
        const grossUnlock = allDone ? Math.max(msBreakdown.employerTotalPayable, remainingDealLocked) : msBreakdown.employerTotalPayable;
        const nextReleasedTotal = prevReleased + grossUnlock;

        const payout = await executeEscrowPayout({
          cid,
          deal,
          grossUnlockAmount: grossUnlock,
          sellerGrossAmount: msAmt,
          feePercent,
          buyerId,
          sellerId,
          nextDealFields: {
            status: nextDealStatus,
            ...(allDone ? { escrow_deposit_status: 'released' } : {}),
            escrow_released_amount: nextReleasedTotal,
            milestones: updatedMilestones,
            timeline: nextTimeline,
            history: nextHistory,
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
            ...(allDone ? { escrow_deposit_status: 'released' } : {}),
            escrow_released_amount: nextReleasedTotal,
            milestones: updatedMilestones,
            timeline: nextTimeline,
            history: nextHistory,
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
      const prevHistory = Array.isArray(deal.history) ? deal.history : [];
      const nextTimeline = [
        ...prevTimeline,
        {
          id: `tl_ms_${Date.now()}`,
          type: 'milestone_update',
          status: nextDealStatus,
          actor_id: uid,
          actor_name: actorName,
          note: note ? `${timelineNote}\n📝 ${note}` : timelineNote,
          ...(attachmentUrl ? { attachment_url: attachmentUrl } : {}),
          timestamp: nowIso,
        },
      ];
      const nextHistory = [
        ...prevHistory,
        { event: note ? `${timelineNote} (${note})` : timelineNote, timestamp: nowIso, actor: actorName, actor_id: actorStoredId },
      ];

      await strictFirestoreWrite(`deals/${dealDocId}#milestone-transition`, (db) =>
        db.collection('deals').doc(dealDocId).set(
          { milestones: updatedMilestones, timeline: nextTimeline, history: nextHistory, updated_at: nowIso, updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        )
      );

      const updatedDeal = await enrichDealWithParties(
        {
          ...deal,
          milestones: updatedMilestones,
          timeline: nextTimeline,
          history: nextHistory,
          updatedAt: nowIso,
          updated_at: nowIso,
        },
        undefined,
        uid
      );
      memoryDeals.set(cid, updatedDeal);

      const notifyUserId = isBuyer ? sellerId : buyerId;
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

      const buyerId = String(deal.buyer_id ?? '');
      const sellerId = String(deal.seller_id ?? '');
      const isBuyer = isUserDealBuyer(deal, actor);
      const isSeller = isUserDealSeller(deal, actor);
      if (!isBuyer && !isSeller) {
        return res.status(403).json({ success: false, error: 'فقط طرفین معامله می‌توانند امتیاز ثبت کنند.' });
      }

      const targetRawId = isBuyer ? sellerId : buyerId;
      const targetUserObj = (await getUserById(targetRawId)) || { id: targetRawId };
      const targetUserId = String((targetUserObj as any).id || targetRawId);
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
      const nextTrustScore = Math.min(100, Math.max(50, Math.round(75 + ratingAvg * 5)));

      const updatedTargetUser = {
        ...targetUserObj,
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
      const allDeals = await getAllDealsMerged();
      const visibleRooms = Array.from(merged.values()).filter(
        (room) => room.participants?.includes(uid) || (isAdminActor && room.is_support)
      );
      const chatsRaw = await Promise.all(
        visibleRooms.map(async (room) => {
          const otherId = room.participants.find((p) => p !== uid && !(isAdminActor && p === 'support')) || 'support';
          const isSupportRoom = Boolean(room.is_support || otherId === 'support');
          const title =
            room.title_map?.[uid] ||
            (isAdminActor && isSupportRoom ? room.title_map?.['support'] : undefined) ||
            (isSupportRoom ? 'پشتیبانی میانجی' : `کاربر ${otherId.slice(-4)}`);
          const rawPhone =
            room.phone_map?.[uid] ||
            (isAdminActor && isSupportRoom ? room.phone_map?.['support'] : undefined) ||
            (isSupportRoom ? '0210000' : '');

          const privacy = isSupportRoom
            ? { isMutualContact: false, hasDealTogether: false, canViewPhone: false, counterpartyPhone: '0210000' }
            : await checkMutualContactAndDealStatus(actor, otherId, rawPhone, allDeals);

          return {
            id: room.id,
            counterparty_id: otherId,
            full_name: title,
            phone_number: isSupportRoom ? '0210000' : privacy.canViewPhone ? privacy.counterpartyPhone : '',
            can_view_phone: isSupportRoom ? false : privacy.canViewPhone,
            is_mutual_contact: isSupportRoom ? false : privacy.isMutualContact,
            has_deal_together: isSupportRoom ? false : privacy.hasDealTogether,
            last_msg: room.last_msg || 'گفتگوی مستقیم',
            time: room.time || room.createdAt,
            unread: getUnreadCount(`direct:${room.id}`, uid),
            online: isSupportRoom || onlineSet.has(otherId),
            is_support: isSupportRoom,
          };
        })
      );
      const chats = chatsRaw.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));

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
      const isSupport = String(resolvedTargetParam) === '101' || String(resolvedTargetParam) === 'support';
      const rawPhoneStr = String(phone || '').trim();
      const parsedPhone = parseIranMobile(rawPhoneStr);

      let targetUser: any = null;
      if (resolvedTargetParam && !isSupport) {
        targetUser = await getUserById(String(resolvedTargetParam));
      }
      if (!targetUser && !isSupport && parsedPhone.valid) {
        targetUser = await findUserByPhone(parsedPhone.local, parsedPhone.core10);
      }
      if (!targetUser && !isSupport && !resolvedTargetParam && rawPhoneStr && !parsedPhone.valid) {
        return res.status(400).json({ success: false, error: 'شماره همراه طرف مقابل معتبر نیست.' });
      }

      const counterpartyId = isSupport
        ? 'support'
        : String(targetUser?.id || resolvedTargetParam || `u_${parsedPhone.core10 || Date.now()}`);
      if (!isSupport && counterpartyId === uid) {
        return res.status(400).json({ success: false, error: 'نمی‌توانید با خودتان گفتگوی مستقیم باز کنید.' });
      }

      const roomId = buildDirectRoomId(uid, counterpartyId, isSupport);
      const targetDisplayName = isSupport
        ? 'پشتیبانی میانجی'
        : String(targetUser?.full_name || fullName || `کاربر ${(parsedPhone.core10 || counterpartyId).slice(-4)}`);
      const targetPhone = isSupport ? '0210000' : String(targetUser?.phone_number || parsedPhone.local || '');

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

      const privacy = isSupport
        ? { isMutualContact: false, hasDealTogether: false, canViewPhone: false, counterpartyPhone: '0210000' }
        : await checkMutualContactAndDealStatus(actor, counterpartyId, targetPhone);

      res.json({
        success: true,
        chat: {
          id: roomId,
          counterparty_id: counterpartyId,
          full_name: targetDisplayName,
          phone_number: isSupport ? '0210000' : privacy.canViewPhone ? privacy.counterpartyPhone : '',
          can_view_phone: isSupport ? false : privacy.canViewPhone,
          is_mutual_contact: isSupport ? false : privacy.isMutualContact,
          has_deal_together: isSupport ? false : privacy.hasDealTogether,
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

  const canActorAccessChatRoom = async (
    scope: 'contract' | 'direct',
    chatId: string,
    actor: any
  ): Promise<boolean> => {
    if (!actor?.id || !chatId) return false;
    const uid = String(actor.id);
    const isAdminActor = actor.role === 'owner' || actor.role === 'admin';
    if (isAdminActor) return true;

    if (scope === 'contract') {
      const deal = await getDealByContractId(chatId);
      if (!deal) return false;
      return isUserDealBuyer(deal, actor) || isUserDealSeller(deal, actor) || isUserDealCreator(deal, actor);
    }

    let room: any = memoryDirectChats.get(chatId);
    if (!room) {
      const firestore = getDb();
      if (firestore) {
        const rSnap = await firestore.collection('direct_chats').doc(chatId).get().catch(() => null);
        if (rSnap?.exists) {
          room = { id: rSnap.id, ...(rSnap.data() || {}) };
          memoryDirectChats.set(chatId, room);
        }
      }
    }
    if (room && Array.isArray(room.participants)) {
      return room.participants.map((p: any) => String(p)).includes(uid);
    }
    return chatId === `support_${uid}`;
  };

  app.get('/api/chats/:scope/:chatId/messages', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const scope = req.params.scope === 'contract' ? 'contract' : 'direct';
      const chatId = String(req.params.chatId || '').trim();
      const allowed = await canActorAccessChatRoom(scope, chatId, authResult.actor);
      if (!allowed) {
        return res.status(403).json({ success: false, error: 'دسترسی به این گفتگو مجاز نیست.' });
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
      if (!(await canActorAccessChatRoom(scope, chatId, actor))) {
        return res.status(403).json({ success: false, error: 'دسترسی به ارسال پیام در این گفتگو مجاز نیست.' });
      }
      const { text, type, attachment_url, reply_to, deal_id, forwarded_from } = req.body || {};

      let cleanText = String(text || '').trim().slice(0, 1000);
      const msgType = ['text', 'image', 'voice', 'audio', 'file', 'deal'].includes(type) ? type : 'text';
      const rawAtt = typeof attachment_url === 'string' && attachment_url.length <= 2048 ? attachment_url.trim() : '';
      const cleanAttachment =
        rawAtt && (rawAtt.startsWith('/api/media/') || /^https?:\/\//i.test(rawAtt)) ? rawAtt : undefined;
      const cleanForwardedFrom =
        forwarded_from && typeof forwarded_from === 'object'
          ? {
              sender_name: String(forwarded_from.sender_name || 'پیام فوروارد شده').trim().slice(0, 100),
              ...(forwarded_from.source_title
                ? { source_title: String(forwarded_from.source_title).trim().slice(0, 120) }
                : {}),
            }
          : undefined;

      let dealSnapshot: any = undefined;
      let cleanDealId: string | undefined = undefined;
      if (msgType === 'deal' && deal_id) {
        const targetDeal = await getDealByContractId(String(deal_id));
        if (!targetDeal) {
          return res.status(404).json({ success: false, error: 'قرارداد انتخاب‌شده یافت نشد.' });
        }
        if (!isAdminActor && !isUserDealBuyer(targetDeal, actor) && !isUserDealSeller(targetDeal, actor)) {
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
        if (deal && !isAdminActor && !isUserDealBuyer(deal, authResult.actor) && !isUserDealSeller(deal, authResult.actor)) {
          return res.status(403).json({ success: false, error: 'دسترسی به این معامله مجاز نیست.' });
        }
        if (deal) {
          dealTitle = deal.title;
          recipientIds = [String(deal.buyer_id || ''), String(deal.seller_id || '')]
            .filter((id) => id && !isPendingPartyId(id) && id !== uid);
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
        ...(cleanForwardedFrom ? { forwarded_from: cleanForwardedFrom } : {}),
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
          : msgType === 'audio'
          ? `🎵 ${cleanText}`
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
            if (cleanForwardedFrom) fsPayload.forwarded_from = cleanForwardedFrom;
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
            if (cleanForwardedFrom) fsPayload.forwarded_from = cleanForwardedFrom;
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
      if (!(await canActorAccessChatRoom(scope, chatId, authResult.actor))) {
        return res.status(403).json({ success: false, error: 'دسترسی به این گفتگو مجاز نیست.' });
      }
      const nextText = String(req.body?.text || '').trim().slice(0, 1000);
      if (!nextText) {
        return res.status(400).json({ success: false, error: 'متن پیام نمی‌تواند خالی باشد.' });
      }

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      const idx = list.findIndex((m) => String(m.id) === msgId);
      const firestore = getDb();
      const colName = scope === 'contract' ? 'contract_messages' : 'direct_messages';
      let ownerSenderId = idx >= 0 ? String(list[idx].sender_id) : '';
      let belongsToRoom = idx >= 0;

      if (idx < 0 && firestore) {
        const snap = await firestore.collection(colName).doc(msgId).get().catch(() => null);
        if (snap?.exists) {
          const d = snap.data() || {};
          ownerSenderId = String(d.sender_id || '');
          const docRoomId = scope === 'contract' ? String(d.contract_id || '') : String(d.chat_id || d.room_id || '');
          belongsToRoom = docRoomId === chatId;
        }
      }

      if (!belongsToRoom) {
        return res.status(404).json({ success: false, error: 'پیام یافت نشد.' });
      }
      if (ownerSenderId !== uid && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'فقط فرستنده می‌تواند پیام را ویرایش کند.' });
      }

      const editedAt = new Date().toISOString();
      if (idx >= 0) {
        list[idx] = { ...list[idx], text: nextText, edited_at: editedAt };
        memMap.set(chatId, list);
      }

      if (firestore) {
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
          [String(deal.buyer_id || ''), String(deal.seller_id || '')]
            .filter((pid) => !isPendingPartyId(pid))
            .forEach((pid) => wsBroadcastUser(pid, 'chat:edited', payload));
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
      if (!(await canActorAccessChatRoom(scope, chatId, authResult.actor))) {
        return res.status(403).json({ success: false, error: 'دسترسی به این گفتگو مجاز نیست.' });
      }
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
          [String(deal.buyer_id || ''), String(deal.seller_id || '')]
            .filter((pid) => !isPendingPartyId(pid))
            .forEach((pid) => wsBroadcastUser(pid, 'chat:reacted', payload));
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
      if (!(await canActorAccessChatRoom(scope, chatId, authResult.actor))) {
        return res.status(403).json({ success: false, error: 'دسترسی به این گفتگو مجاز نیست.' });
      }
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
          [String(deal.buyer_id || ''), String(deal.seller_id || '')]
            .filter((pid) => !isPendingPartyId(pid))
            .forEach((pid) => wsBroadcastUser(pid, 'chat:read', payload));
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
      if (!(await canActorAccessChatRoom(scope, chatId, authResult.actor))) {
        return res.status(403).json({ success: false, error: 'دسترسی به این گفتگو مجاز نیست.' });
      }

      const memMap = scope === 'contract' ? memoryContractMessages : memoryDirectMessages;
      const list = memMap.get(chatId) || [];
      const target = list.find((m) => String(m.id) === msgId);
      const firestore = getDb();
      const colName = scope === 'contract' ? 'contract_messages' : 'direct_messages';
      let ownerSenderId = target ? String(target.sender_id) : '';
      let belongsToRoom = Boolean(target);

      if (!target && firestore) {
        const snap = await firestore.collection(colName).doc(msgId).get().catch(() => null);
        if (snap?.exists) {
          const d = snap.data() || {};
          ownerSenderId = String(d.sender_id || '');
          const docRoomId = scope === 'contract' ? String(d.contract_id || '') : String(d.chat_id || d.room_id || '');
          belongsToRoom = docRoomId === chatId;
        }
      }

      if (!belongsToRoom) {
        return res.status(404).json({ success: false, error: 'پیام یافت نشد.' });
      }
      if (ownerSenderId !== uid && !isAdminActor) {
        return res.status(403).json({ success: false, error: 'فقط فرستنده پیام می‌تواند آن را حذف کند.' });
      }
      memMap.set(chatId, list.filter((m) => String(m.id) !== msgId));

      if (firestore) {
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
    if (!(await canActorAccessChatRoom(scope, chatId, authResult.actor))) {
      return res.status(403).json({ success: false, error: 'دسترسی به پین کردن پیام در این گفتگو مجاز نیست.' });
    }
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

  const saveUserCardsWithBroadcast = async (uid: string, currentUser: any, nextCards: any[]) => {
    const updatedUser = { ...currentUser, saved_cards: nextCards, id: uid };
    memoryUsers.set(uid, updatedUser);
    if (getUsersCol()) {
      await strictFirestoreWrite(`users/${uid}#cards`, (db) =>
        db.collection('users').doc(uid).set(
          {
            saved_cards: nextCards,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      );
    }
    wsBroadcastUser(uid, 'user:updated', { userId: uid, user: updatedUser });
    return updatedUser;
  };

  const buildSavedCardEntry = (
    currentUser: any,
    params: { number: string; label?: string; holder_name?: string; make_default?: boolean; existingCards: any[] }
  ) => {
    const payoutCheck = validateIranianPayoutDestination(String(params.number || ''));
    if (!payoutCheck.valid || !payoutCheck.normalized) {
      return { error: payoutCheck.error || 'شماره کارت یا شبا معتبر نیست.' };
    }
    const cardKind: 'card' | 'sheba' = payoutCheck.kind === 'card' ? 'card' : 'sheba';
    const detectedBank =
      detectIranianBankName(payoutCheck.normalized) ||
      (cardKind === 'card' ? 'کارت بانکی شتاب' : 'حساب بانکی (شبا)');
    const formattedNumber =
      cardKind === 'card' ? formatIranianCard(payoutCheck.normalized) : payoutCheck.normalized;
    const cleanLabel = String(params.label || '').trim().slice(0, 64) || detectedBank;
    const cleanHolder = String(params.holder_name || currentUser?.full_name || '')
      .trim()
      .slice(0, 100);
    const shouldDefault = Boolean(params.make_default) || params.existingCards.length === 0;

    return {
      payoutCheck,
      card: {
        id: `card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: cardKind,
        number: payoutCheck.normalized,
        formatted: formattedNumber,
        bank_name: detectedBank,
        label: cleanLabel,
        ...(cleanHolder ? { holder_name: cleanHolder } : {}),
        is_default: shouldDefault,
        created_at: new Date().toISOString(),
      },
    };
  };

  app.get('/api/wallet/requests', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const liveActor = authResult.actor;
      const isAdminActor = liveActor.role === 'owner' || liveActor.role === 'admin';
      const wantAll =
        isAdminActor &&
        req.query.scope === 'admin' &&
        hasAdminPermission(liveActor, 'manage_finance');
      const filtered = wantAll
        ? await loadWalletRequests()
        : await loadWalletRequestsForUser(String(liveActor.id));
      const pendingWithdrawTotal = filtered
        .filter((r) => String(r.user_id) === String(liveActor.id) && r.type === 'withdraw' && r.status === 'pending')
        .reduce((sum, r) => sum + Math.max(0, Number(r.amount || 0)), 0);
      res.json({
        success: true,
        requests: filtered,
        saved_cards: Array.isArray(liveActor.saved_cards) ? liveActor.saved_cards : [],
        balances: {
          wallet_balance: Number(liveActor.wallet_balance || 0),
          escrow_locked_balance: Number(liveActor.escrow_locked_balance || 0),
          pending_withdraw_total: pendingWithdrawTotal,
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
      const origin = (process.env.APP_URL || process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
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

      if (supabaseState.ready && supabaseState.client && firestore) {
        const paySnap = await firestore.collection('payment_sessions').doc(sessionId).get().catch(() => null);
        if (paySnap?.exists && paySnap.data()?.status === 'verified') {
          return res.redirect(`/?view=wallet&payment_status=success&amount=${amt}&ref=${encodeURIComponent(refId)}`);
        }
        const adj = await adjustUserWalletAtomic(targetUid, amt, 0, false);
        nextBalances = { wallet_balance: adj.wallet_balance, escrow_locked_balance: adj.escrow_locked_balance };
        await firestore
          .collection('payment_sessions')
          .doc(sessionId)
          .set({ status: 'verified', ref_id: refId, verified_at: nowIso }, { merge: true })
          .catch(() => {});
      } else if (firestore) {
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
      const uid = String(authResult.actor.id);
      if (!checkBucketLimit(walletReqRateMap, `wreq:${uid}`, 15, 60 * 60 * 1000)) {
        return res.status(429).json({
          success: false,
          error: 'تعداد درخواست‌های مالی شما در یک ساعت اخیر بیش از حد مجاز بوده است. لطفاً کمی بعد تلاش کنید.',
        });
      }
      const actor = authResult.actor;
      const { type, amount, ref_code, slip_image_url, card_id, save_card, holder_name, source_card } = req.body || {};
      const reqType = type === 'withdraw' ? 'withdraw' : 'deposit';
      const amt = Math.floor(Number(amount || 0));
      if (!Number.isFinite(amt) || amt < 10000) {
        return res.status(400).json({ success: false, error: 'حداقل مبلغ تراکنش ۱۰,۰۰۰ تومان است.' });
      }

      const [limits, userReqs] = await Promise.all([loadGlobalLimits(), loadWalletRequestsForUser(uid)]);
      const savedCardsList: any[] = Array.isArray(actor.saved_cards) ? [...actor.saved_cards] : [];
      const matchedSavedCard =
        card_id ? savedCardsList.find((c) => String(c.id) === String(card_id).trim()) : undefined;

      let cleanRefCode = normalizeDigits(String(ref_code || matchedSavedCard?.number || '')).trim();
      const cleanSlipUrl =
        typeof slip_image_url === 'string' && slip_image_url.trim().length > 0 && slip_image_url.trim().length <= 2048
          ? slip_image_url.trim()
          : undefined;

      let cleanSourceCard: string | undefined;
      let sourceBankName: string | undefined;
      if (reqType === 'deposit') {
        if (cleanRefCode.length < 4 || cleanRefCode.length > 64) {
          return res.status(400).json({
            success: false,
            error: 'لطفاً شماره پیگیری یا شماره ارجاع فیش واریزی را وارد کنید (حداقل ۴ کاراکتر).',
          });
        }
        if (!cleanSlipUrl) {
          return res.status(400).json({
            success: false,
            error: 'برای ثبت واریز کارت‌به‌کارت، بارگذاری تصویر فیش واریزی الزامی است.',
          });
        }
        const normalizedRefKey = cleanRefCode.replace(/[\s\-_]/g, '').toLowerCase();
        let duplicateSlip = userReqs.find(
          (r) =>
            r.type === 'deposit' &&
            (r.status === 'pending' || r.status === 'approved') &&
            normalizeDigits(String(r.ref_code || ''))
              .replace(/[\s\-_]/g, '')
              .toLowerCase() === normalizedRefKey
        );
        if (!duplicateSlip) {
          if (supabaseState.ready && supabaseState.client) {
            const { data: dupRows } = await supabaseState.client
              .from('wallet_requests')
              .select('id,type,status,ref_code')
              .eq('type', 'deposit')
              .in('status', ['pending', 'approved'])
              .ilike('ref_code', `%${cleanRefCode.slice(0, 64)}%`)
              .limit(10);
            if (Array.isArray(dupRows)) {
              duplicateSlip = dupRows.find(
                (r: any) =>
                  normalizeDigits(String(r.ref_code || ''))
                    .replace(/[\s\-_]/g, '')
                    .toLowerCase() === normalizedRefKey
              );
            }
          } else {
            const firestore = getDb();
            if (firestore) {
              const snap = await firestore
                .collection('wallet_requests')
                .where('ref_code', '==', cleanRefCode)
                .limit(5)
                .get()
                .catch(() => null);
              if (snap && !snap.empty) {
                duplicateSlip = snap.docs
                  .map((d) => ({ id: d.id, ...(d.data() || {}) }))
                  .find((r: any) => r.type === 'deposit' && (r.status === 'pending' || r.status === 'approved'));
              }
            } else {
              for (const r of memoryWalletRequests.values()) {
                if (
                  r.type === 'deposit' &&
                  (r.status === 'pending' || r.status === 'approved') &&
                  normalizeDigits(String(r.ref_code || ''))
                    .replace(/[\s\-_]/g, '')
                    .toLowerCase() === normalizedRefKey
                ) {
                  duplicateSlip = r;
                  break;
                }
              }
            }
          }
        }
        if (duplicateSlip) {
          return res.status(409).json({
            success: false,
            error: 'این شماره پیگیری قبلاً در سیستم ثبت شده است. لطفاً شماره پیگیری صحیح و یکتای تراکنش خود را وارد کنید.',
          });
        }
        if (source_card && String(source_card).trim()) {
          const rawSource = normalizeDigits(String(source_card)).replace(/[^0-9]/g, '');
          if (rawSource.length === 16) {
            const srcCheck = isValidIranianCard(rawSource);
            if (!srcCheck.valid) {
              return res.status(400).json({ success: false, error: 'شماره کارت مبدأ ۱۶ رقمی معتبر نیست.' });
            }
            cleanSourceCard = formatIranianCard(srcCheck.normalized);
            sourceBankName = detectIranianBankName(srcCheck.normalized) || undefined;
          } else if (rawSource.length === 4) {
            cleanSourceCard = `••••-••••-••••-${rawSource}`;
          } else {
            return res.status(400).json({
              success: false,
              error: 'کارت مبدأ باید ۱۶ رقم معتبر یا ۴ رقم آخر کارت باشد.',
            });
          }
        }
      }

      let pendingWithdrawTotal = userReqs
        .filter((r) => r.type === 'withdraw' && r.status === 'pending')
        .reduce((sum, r) => sum + Math.max(0, Number(r.amount || 0)), 0);

      let payoutKind: 'card' | 'sheba' | undefined;
      let resolvedBankName: string | undefined;
      let resolvedHolderName: string | undefined;

      if (reqType === 'withdraw') {
        if (actor.is_withdraw_locked) {
          return res.status(403).json({ success: false, error: 'برداشت وجه برای حساب شما قفل شده است.' });
        }
        const available = Math.max(0, Number(actor.wallet_balance || 0) - Number(actor.escrow_locked_balance || 0) - pendingWithdrawTotal);
        if (amt > available) {
          return res.status(400).json({
            success: false,
            error:
              pendingWithdrawTotal > 0
                ? `با احتساب ${pendingWithdrawTotal.toLocaleString()} تومان برداشت در انتظار بررسی، موجودی قابل برداشت شما (${available.toLocaleString()} تومان) کافی نیست.`
                : 'موجودی قابل برداشت شما کافی نیست.',
          });
        }
        const todayStr = new Date().toDateString();
        const todayTotal = userReqs
          .filter(
            (r) =>
              r.type === 'withdraw' &&
              r.status !== 'rejected' &&
              r.status !== 'cancelled' &&
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
        payoutKind = destCheck.kind === 'card' ? 'card' : 'sheba';
        const cardByNumber =
          matchedSavedCard || savedCardsList.find((c) => String(c.number) === cleanRefCode);
        resolvedBankName =
          cardByNumber?.bank_name ||
          detectIranianBankName(cleanRefCode) ||
          (payoutKind === 'card' ? 'کارت بانکی شتاب' : 'حساب بانکی (شبا)');
        resolvedHolderName =
          String(holder_name || cardByNumber?.holder_name || actor.full_name || '')
            .trim()
            .slice(0, 100) || undefined;
        pendingWithdrawTotal += amt;
      }

      const reqId = `slip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const nowIso = new Date().toISOString();
      const record: Record<string, any> = {
        id: reqId,
        user_id: uid,
        user_name: actor.full_name || 'کاربر میانجی',
        phone: actor.phone_number || '',
        type: reqType,
        amount: amt,
        ref_code: cleanRefCode,
        ...(payoutKind ? { payout_kind: payoutKind } : {}),
        ...(resolvedBankName ? { bank_name: resolvedBankName } : {}),
        ...(resolvedHolderName ? { holder_name: resolvedHolderName } : {}),
        ...(cleanSourceCard ? { source_card: cleanSourceCard } : {}),
        ...(sourceBankName ? { source_bank_name: sourceBankName } : {}),
        ...(cleanSlipUrl ? { slip_image_url: cleanSlipUrl } : {}),
        status: 'pending',
        created_at: nowIso,
      };
      await strictFirestoreWrite(`wallet_requests/${reqId}#create`, (db) =>
        db.collection('wallet_requests').doc(reqId).set({
          ...record,
          created_at: FieldValue.serverTimestamp(),
        })
      );
      memoryWalletRequests.set(reqId, record);

      let nextSavedCards: any[] | undefined;
      let cardSaved = false;
      if (reqType === 'withdraw' && save_card === true) {
        const alreadyExists = savedCardsList.some((c) => String(c.number) === cleanRefCode);
        if (!alreadyExists && savedCardsList.length < 10) {
          const built = buildSavedCardEntry(actor, {
            number: cleanRefCode,
            holder_name: resolvedHolderName,
            existingCards: savedCardsList,
          });
          if (!('error' in built) && built.card) {
            nextSavedCards = [...savedCardsList, built.card];
            await saveUserCardsWithBroadcast(uid, actor, nextSavedCards);
            cardSaved = true;
          }
        }
      }

      void wsBroadcastAdmins('wallet:updated', { userId: uid, request: record });
      res.json({
        success: true,
        request: record,
        pending_withdraw_total: pendingWithdrawTotal,
        ...(nextSavedCards ? { saved_cards: nextSavedCards } : {}),
        card_saved: cardSaved,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت درخواست مالی' });
    }
  });

  app.post('/api/wallet/requests/:reqId/cancel', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const reqId = String(req.params.reqId || '').trim();
    if (processingWalletReqIds.has(reqId)) {
      return res.status(409).json({ success: false, error: 'این درخواست هم‌اکنون در حال بررسی است.' });
    }
    processingWalletReqIds.add(reqId);
    try {
      const uid = String(authResult.actor.id);
      const firestore = getDb();
      let target = memoryWalletRequests.get(reqId);
      if (!target && firestore) {
        const snap = await firestore.collection('wallet_requests').doc(reqId).get().catch(() => null);
        if (snap?.exists) {
          const d = snap.data() || {};
          target = {
            id: snap.id,
            ...d,
            created_at: d.created_at?.toDate?.()?.toISOString?.() || d.created_at || new Date().toISOString(),
          };
        }
      }
      if (!target) {
        return res.status(404).json({ success: false, error: 'درخواست مالی یافت نشد.' });
      }
      if (String(target.user_id) !== uid) {
        return res.status(403).json({ success: false, error: 'شما مجاز به لغو درخواست کاربر دیگر نیستید.' });
      }
      if (target.status !== 'pending') {
        return res.status(400).json({ success: false, error: 'تنها درخواست‌های در حال بررسی قابل لغو هستند.' });
      }

      const updated = {
        ...target,
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      };
      memoryWalletRequests.set(reqId, updated);
      if (firestore) {
        try {
          await firestore.collection('wallet_requests').doc(reqId).set(updated, { merge: true });
        } catch {}
      }

      const pendingWithdrawTotal = await getPendingWithdrawTotal(uid);
      const balances = {
        wallet_balance: Number(authResult.actor.wallet_balance || 0),
        escrow_locked_balance: Number(authResult.actor.escrow_locked_balance || 0),
        pending_withdraw_total: pendingWithdrawTotal,
      };
      wsBroadcastUser(uid, 'wallet:updated', { userId: uid, request: updated, balances });
      void wsBroadcastAdmins('wallet:updated', { userId: uid, request: updated, balances });
      res.json({ success: true, request: updated, balances });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در لغو درخواست مالی' });
    } finally {
      processingWalletReqIds.delete(reqId);
    }
  });

  app.post('/api/admin/wallet-requests/:reqId/decide', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_finance');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
    }
    const reqId = String(req.params.reqId || '').trim();
    if (processingWalletReqIds.has(reqId)) {
      return res.status(409).json({ success: false, error: 'این درخواست در حال پردازش است.' });
    }
    processingWalletReqIds.add(reqId);
    try {
      const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
      const firestore = getDb();
      let slip = memoryWalletRequests.get(reqId);
      if (!slip && firestore) {
        const snap = await firestore.collection('wallet_requests').doc(reqId).get().catch(() => null);
        if (snap?.exists) {
          const d = snap.data() || {};
          slip = {
            id: snap.id,
            ...d,
            created_at: d.created_at?.toDate?.()?.toISOString?.() || d.created_at || new Date().toISOString(),
          };
        }
      }
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

      let nextWallet = curWallet;
      const decidedAt = new Date().toISOString();
      const updatedSlip = {
        ...slip,
        status: decision,
        decided_by: String(authResult.actor.id),
        decided_at: decidedAt,
      };

      let txCommitted = false;
      if (supabaseState.ready && supabaseState.client && firestore) {
        const liveSlipSnap = await firestore.collection('wallet_requests').doc(reqId).get().catch(() => null);
        const liveSlipData = liveSlipSnap?.exists ? liveSlipSnap.data() : slip;
        if (liveSlipData?.status && liveSlipData.status !== 'pending') {
          return res.status(400).json({ success: false, error: 'این درخواست پیش‌تر بررسی شده است.' });
        }
        if (decision === 'approved') {
          if (slip.type === 'deposit') {
            const adj = await adjustUserWalletAtomic(targetUid, amt, 0, false);
            nextWallet = adj.wallet_balance;
          } else {
            const available = Math.max(0, curWallet - curLocked);
            if (amt > available) {
              return res.status(400).json({ success: false, error: 'موجودی قابل برداشت کاربر دیگر کافی نیست.' });
            }
            const adj = await adjustUserWalletAtomic(targetUid, -amt, 0, false);
            nextWallet = adj.wallet_balance;
          }
        }
        await firestore.collection('wallet_requests').doc(reqId).set(updatedSlip, { merge: true });
        lastFirestoreError = null;
        txCommitted = true;
      } else if (firestore) {
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
          lastFirestoreError = null;
          txCommitted = true;
        } catch (txErr: any) {
          if (txErr?.message === 'ALREADY_DECIDED') {
            return res.status(400).json({ success: false, error: 'این درخواست پیش‌تر بررسی شده است.' });
          }
          if (txErr?.message === 'INSUFFICIENT_AVAILABLE') {
            return res.status(400).json({ success: false, error: 'موجودی قابل برداشت کاربر دیگر کافی نیست.' });
          }
          const msg = String(txErr?.message || txErr || 'Wallet transaction error');
          lastFirestoreError = `wallet_decide/${reqId}: ${msg}`;
          console.error('[FIRESTORE-WRITE-ERROR] wallet_decide:', msg);
          if (hasExplicitDb()) {
            return res.status(500).json({ success: false, error: 'خطا در ثبت تراکنش مالی در دیتابیس. لطفاً اتصال دیتابیس را بررسی کنید.' });
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

      void pushUserNotification(
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
      void recordAuditLog(
        authResult.actor,
        `wallet_request_${decision}`,
        `${decision === 'approved' ? 'تایید' : 'رد'} درخواست ${slip.type === 'deposit' ? 'واریز' : 'برداشت'} به مبلغ ${amt.toLocaleString()} تومان برای ${slip.user_name || targetUid}`,
        { type: 'wallet_request', id: reqId }
      );

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

    const parsedPhone = parseIranMobile(params.phoneNumber);
    if (!parsedPhone.valid) {
      return {
        status: 'mismatch',
        matched: false,
        note: params.phoneNumber
          ? 'شماره موبایل ثبت‌شده معتبر نیست (فرمت استاندارد 09xxxxxxxxx).'
          : 'شماره موبایل شما هنوز ثبت نشده است. لطفاً ابتدا ربات تلگرام میانجی را استارت و شماره خود را تایید کنید.',
        checked_at,
      };
    }

    // Inquiry exclusively against shared users store
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
        note: 'این کد ملی پیش‌تر به نام حساب دیگری در سیستم میانجی تایید شده است.',
        checked_at,
      };
    }

    return {
      status: 'matched',
      matched: true,
      note: `فرمت کد ملی (${nidCheck.normalized}) صحیح و در سیستم یکتا است. احراز نهایی پس از بررسی دستی تصویر کارت ملی، سلفی و کارت بانکی توسط تیم میانجی انجام می‌شود.`,
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

      const existingCards: any[] = Array.isArray(actor.saved_cards) ? [...actor.saved_cards] : [];
      let nextSavedCards = existingCards;
      if (!existingCards.some((c) => String(c.number) === cardCheck.normalized) && existingCards.length < 10) {
        nextSavedCards = [
          ...existingCards,
          {
            id: `card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'card',
            number: cardCheck.normalized,
            formatted: formatIranianCard(cardCheck.normalized),
            bank_name: bankName,
            label: 'کارت احراز هویت',
            holder_name: cleanName,
            is_default: existingCards.length === 0,
            created_at: new Date().toISOString(),
          },
        ];
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
        saved_cards: nextSavedCards,
      };
      memoryUsers.set(uid, updatedUser);

      if (getUsersCol()) {
        await strictFirestoreWrite(`users/${uid}#kyc`, (db) =>
          db.collection('users').doc(uid).set(
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
              saved_cards: nextSavedCards,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        );
      }

      void wsBroadcastAdmins('kyc:updated', { user: updatedUser });
      wsBroadcastUser(uid, 'user:updated', { userId: uid, user: updatedUser });
      res.json({ success: true, user: updatedUser, match: matchResult });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت اطلاعات احراز هویت' });
    }
  });

  // Profile Editing & Saved Iranian Bank Cards / Sheba Management
  app.get('/api/profile', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    const uid = String(authResult.actor.id);
    const [live, pendingWithdrawTotal] = await Promise.all([
      getUserById(uid).then((u) => u || authResult.actor),
      getPendingWithdrawTotal(uid),
    ]);
    const walletBal = Math.max(0, Number(live.wallet_balance || 0));
    const lockedBal = Math.min(walletBal, Math.max(0, Number(live.escrow_locked_balance || 0)));
    const freeBal = Math.max(0, walletBal - lockedBal);
    res.json({
      success: true,
      user: {
        ...live,
        wallet_balance: walletBal,
        escrow_locked_balance: lockedBal,
        free_balance: freeBal,
        pending_withdraw_total: pendingWithdrawTotal,
        available_balance: Math.max(0, freeBal - pendingWithdrawTotal),
        saved_cards: Array.isArray(live.saved_cards) ? live.saved_cards : [],
      },
    });
  });

  app.put('/api/profile', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const current = (await getUserById(uid)) || authResult.actor;
      const { full_name, username, avatar_url } = req.body || {};

      const patch: Record<string, any> = {};
      if (full_name !== undefined) {
        const cleanName = String(full_name || '').trim();
        if (cleanName.length < 2 || cleanName.length > 100) {
          return res.status(400).json({ success: false, error: 'نام و نام خانوادگی باید بین ۲ تا ۱۰۰ کاراکتر باشد.' });
        }
        patch.full_name = cleanName;
      }

      if (username !== undefined) {
        const cleanUsername = String(username || '').trim().replace(/^@+/, '').toLowerCase();
        if (cleanUsername.length > 0) {
          if (!/^[a-z0-9_]{3,32}$/.test(cleanUsername)) {
            return res.status(400).json({
              success: false,
              error: 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، اعداد و _ (۳ تا ۳۲ کاراکتر) باشد.',
            });
          }
          const allUsers = await getAllUsersMerged();
          const taken = allUsers.find(
            (u) => String(u.id) !== uid && String(u.username || '').toLowerCase() === cleanUsername
          );
          if (taken) {
            return res.status(409).json({ success: false, error: 'این نام کاربری قبلاً توسط کاربر دیگری ثبت شده است.' });
          }
        }
        patch.username = cleanUsername;
      }

      if (avatar_url !== undefined) {
        const cleanAvatar = String(avatar_url || '').trim();
        if (cleanAvatar.length === 0) {
          patch.avatar_url = '';
        } else if (
          cleanAvatar.length <= 2048 &&
          (cleanAvatar.startsWith('/api/media/') || /^https?:\/\//i.test(cleanAvatar))
        ) {
          patch.avatar_url = cleanAvatar;
        } else {
          return res.status(400).json({ success: false, error: 'آدرس تصویر پروفایل نامعتبر است.' });
        }
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ success: false, error: 'تغییری برای ذخیره ارسال نشده است.' });
      }

      const updatedUser = { ...current, ...patch, id: uid };
      memoryUsers.set(uid, updatedUser);

      if (getUsersCol()) {
        await strictFirestoreWrite(`users/${uid}#profile`, (db) =>
          db.collection('users').doc(uid).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        );
      }

      wsBroadcastUser(uid, 'user:updated', { userId: uid, user: updatedUser });
      res.json({ success: true, user: updatedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در به‌روزرسانی پروفایل' });
    }
  });

  const handleGetCards = async (req: express.Request, res: express.Response) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    const uid = String(authResult.actor.id);
    const current = (await getUserById(uid)) || authResult.actor;
    res.json({
      success: true,
      saved_cards: Array.isArray(current.saved_cards) ? current.saved_cards : [],
    });
  };

  const handleCreateCard = async (req: express.Request, res: express.Response) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const current = (await getUserById(uid)) || authResult.actor;
      const existingCards: any[] = Array.isArray(current.saved_cards) ? [...current.saved_cards] : [];
      if (existingCards.length >= 10) {
        return res.status(400).json({ success: false, error: 'حداکثر ۱۰ کارت یا شبای بانکی قابل ذخیره است.' });
      }

      const { number, label, holder_name, is_default } = req.body || {};
      const built = buildSavedCardEntry(current, {
        number: String(number || ''),
        label: label !== undefined ? String(label) : undefined,
        holder_name: holder_name !== undefined ? String(holder_name) : undefined,
        make_default: Boolean(is_default),
        existingCards,
      });
      if ('error' in built || !built.card) {
        return res.status(400).json({ success: false, error: built.error || 'شماره کارت یا شبا معتبر نیست.' });
      }

      if (existingCards.some((c) => String(c.number) === built.card.number)) {
        return res.status(409).json({ success: false, error: 'این شماره کارت یا شبا قبلاً ذخیره شده است.' });
      }

      const nextExisting = built.card.is_default
        ? existingCards.map((c) => ({ ...c, is_default: false }))
        : existingCards;
      const nextCards = [...nextExisting, built.card];
      const updatedUser = await saveUserCardsWithBroadcast(uid, current, nextCards);

      res.json({ success: true, card: built.card, saved_cards: nextCards, user: updatedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ذخیره کارت بانکی' });
    }
  };

  const handleUpdateCard = async (req: express.Request, res: express.Response) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const cardId = String(req.params.cardId || '').trim();
      const current = (await getUserById(uid)) || authResult.actor;
      const existingCards: any[] = Array.isArray(current.saved_cards) ? [...current.saved_cards] : [];
      const targetIdx = existingCards.findIndex((c) => String(c.id) === cardId);
      if (targetIdx === -1) {
        return res.status(404).json({ success: false, error: 'کارت یا شبای مورد نظر یافت نشد.' });
      }

      const { label, holder_name, is_default } = req.body || {};
      const makeDefault = Boolean(is_default);
      const nextCards = existingCards.map((c, idx) => {
        if (idx !== targetIdx) {
          return makeDefault ? { ...c, is_default: false } : c;
        }
        const nextLabel =
          label !== undefined ? String(label).trim().slice(0, 64) || c.bank_name || c.label : c.label;
        const nextHolder =
          holder_name !== undefined ? String(holder_name).trim().slice(0, 100) : c.holder_name;
        return {
          ...c,
          label: nextLabel,
          ...(nextHolder ? { holder_name: nextHolder } : { holder_name: undefined }),
          is_default: makeDefault ? true : c.is_default,
        };
      });

      const updatedUser = await saveUserCardsWithBroadcast(uid, current, nextCards);
      res.json({ success: true, card: nextCards[targetIdx], saved_cards: nextCards, user: updatedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ویرایش اطلاعات کارت بانکی' });
    }
  };

  const handleSetDefaultCard = async (req: express.Request, res: express.Response) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const cardId = String(req.params.cardId || '').trim();
      const current = (await getUserById(uid)) || authResult.actor;
      const existingCards: any[] = Array.isArray(current.saved_cards) ? [...current.saved_cards] : [];
      if (!existingCards.some((c) => String(c.id) === cardId)) {
        return res.status(404).json({ success: false, error: 'کارت یا شبای مورد نظر یافت نشد.' });
      }
      const nextCards = existingCards.map((c) => ({ ...c, is_default: String(c.id) === cardId }));
      const updatedUser = await saveUserCardsWithBroadcast(uid, current, nextCards);

      res.json({ success: true, saved_cards: nextCards, user: updatedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در تغییر کارت پیش‌فرض' });
    }
  };

  const handleDeleteCard = async (req: express.Request, res: express.Response) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, revoked: authResult.revoked, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const cardId = String(req.params.cardId || '').trim();
      const current = (await getUserById(uid)) || authResult.actor;
      const existingCards: any[] = Array.isArray(current.saved_cards) ? [...current.saved_cards] : [];
      const filtered = existingCards.filter((c) => String(c.id) !== cardId);
      if (filtered.length === existingCards.length) {
        return res.status(404).json({ success: false, error: 'کارت یا شبای مورد نظر یافت نشد.' });
      }
      if (filtered.length > 0 && !filtered.some((c) => c.is_default)) {
        filtered[0] = { ...filtered[0], is_default: true };
      }
      const updatedUser = await saveUserCardsWithBroadcast(uid, current, filtered);

      res.json({ success: true, saved_cards: filtered, user: updatedUser });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در حذف کارت بانکی' });
    }
  };

  app.get('/api/profile/cards', handleGetCards);
  app.post('/api/profile/cards', handleCreateCard);
  app.patch('/api/profile/cards/:cardId', handleUpdateCard);
  app.patch('/api/profile/cards/:cardId/default', handleSetDefaultCard);
  app.delete('/api/profile/cards/:cardId', handleDeleteCard);

  app.get('/api/wallet/cards', handleGetCards);
  app.post('/api/wallet/cards', handleCreateCard);
  app.patch('/api/wallet/cards/:cardId', handleUpdateCard);
  app.patch('/api/wallet/cards/:cardId/default', handleSetDefaultCard);
  app.delete('/api/wallet/cards/:cardId', handleDeleteCard);

  app.get('/api/admin/finance/summary', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_finance');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
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
        platform_fee_percent: limits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT,
        total_fees_collected: platformStats.total_fees_collected || 0,
        recent_fee_transactions: feeTxs.slice(0, 20),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در دریافت گزارش درآمد پلتفرم' });
    }
  });

  app.get('/api/admin/finance/report', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_finance');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
    }
    try {
      const [limits, platformStats, allUsers, allDeals, walletRequests] = await Promise.all([
        loadGlobalLimits(),
        loadPlatformStats(),
        getAllUsersMerged(),
        getAllDealsMerged(),
        loadWalletRequests(),
      ]);

      const txMap = new Map<string, any>();
      for (const userTxList of memoryTransactions.values()) {
        for (const t of userTxList) {
          if (t?.id) {
            txMap.set(String(t.id), { ...t, created_at: t.created_at || t.createdAt });
          }
        }
      }
      const firestore = getDb();
      if (firestore) {
        try {
          const snap = await firestore.collection('transactions').limit(500).get();
          snap.docs.forEach((docSnap) => {
            const d = docSnap.data();
            const iso = d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.created_at || d.createdAt;
            txMap.set(docSnap.id, { id: docSnap.id, ...d, created_at: iso });
          });
        } catch {}
      }

      const allTransactions = Array.from(txMap.values()).sort(
        (a, b) => Date.parse(String(b.created_at || b.createdAt || 0)) - Date.parse(String(a.created_at || a.createdAt || 0))
      );

      const nowMs = Date.now();
      const day7Ms = nowMs - 7 * 86400000;
      const day30Ms = nowMs - 30 * 86400000;

      let fees7d = 0;
      let fees30d = 0;
      let approvedDepositsTotal = 0;
      let approvedWithdrawsTotal = 0;

      for (const t of allTransactions) {
        const ms = Date.parse(String(t.created_at || 0));
        const amt = Math.max(0, Number(t.amount || 0));
        if (t.type === 'platform_fee' && t.status === 'completed') {
          if (!Number.isNaN(ms) && ms >= day7Ms) fees7d += amt;
          if (!Number.isNaN(ms) && ms >= day30Ms) fees30d += amt;
        }
      }
      for (const r of walletRequests) {
        if (r.status === 'approved') {
          if (r.type === 'deposit') approvedDepositsTotal += Number(r.amount || 0);
          if (r.type === 'withdraw') approvedWithdrawsTotal += Number(r.amount || 0);
        }
      }

      const totalUserWallets = allUsers.reduce((s, u) => s + Math.max(0, Number(u.wallet_balance || 0)), 0);
      const totalEscrowLocked = allUsers.reduce((s, u) => s + Math.max(0, Number(u.escrow_locked_balance || 0)), 0);

      res.json({
        success: true,
        summary: {
          platform_fee_percent: limits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT,
          total_fees_collected: platformStats.total_fees_collected || 0,
          fees_7d: fees7d,
          fees_30d: fees30d,
          approved_deposits_total: approvedDepositsTotal,
          approved_withdraws_total: approvedWithdrawsTotal,
          total_user_wallets: totalUserWallets,
          total_escrow_locked: totalEscrowLocked,
          deals_total: allDeals.length,
          deals_completed: allDeals.filter((d) => normalizeDealStatus(d.status) === 'completed').length,
          deals_disputed: allDeals.filter((d) => normalizeDealStatus(d.status) === 'in_dispute').length,
        },
        transactions: allTransactions,
        wallet_requests: walletRequests,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در تهیه گزارش مالی کامل' });
    }
  });

  app.post('/api/admin/users/:targetId/kyc-decide', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_kyc');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
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
      await recordAuditLog(
        authResult.actor,
        `kyc_${decision}`,
        `${decision === 'verified' ? 'تایید' : 'رد'} احراز هویت کاربر ${updatedUser.full_name || targetId}`,
        { type: 'user', id: targetId }
      );
      void recordSecurityAuditLog({
        userId: targetId,
        phoneNumber: updatedUser.phone_number || null,
        event: `kyc_${decision}`,
        category: 'kyc',
        status: decision === 'verified' ? 'success' : 'rejected',
        details: `${decision === 'verified' ? 'تایید' : 'رد'} احراز هویت توسط مدیر ${authResult.actor.id}`,
      });
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
      const wantAll =
        isAdminActor &&
        req.query.scope === 'admin' &&
        hasAdminPermission(actor, 'manage_support');
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
      if (!checkBucketLimit(supportTicketRateMap, `ticket:${String(actor.id)}`, 10, 60 * 60 * 1000)) {
        return res.status(429).json({
          success: false,
          error: 'تعداد تیکت‌های ارسالی در یک ساعت اخیر بیش از حد مجاز بوده است.',
        });
      }
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
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_support');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
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
      await recordAuditLog(
        authResult.actor,
        'support_ticket_replied',
        `پاسخ به تیکت ${ticketId} برای ${ticket.user_name || ticket.user_id}`,
        { type: 'support_ticket', id: ticketId }
      );

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
      if (!isAdminActor && !isUserDealBuyer(deal, authResult.actor) && !isUserDealSeller(deal, authResult.actor)) {
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
      const uid = String(authResult.actor.id);
      if (!checkBucketLimit(disputeActionRateMap, `ev:${uid}`, 25, 60 * 60 * 1000)) {
        return res.status(429).json({ success: false, error: 'تعداد مدارک ارسالی در یک ساعت اخیر بیش از حد مجاز است.' });
      }
      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });

      const isAdminActor = authResult.actor.role === 'owner' || authResult.actor.role === 'admin';
      const isBuyer = isUserDealBuyer(deal, authResult.actor);
      const isSeller = isUserDealSeller(deal, authResult.actor);
      if (!isAdminActor && !isBuyer && !isSeller) {
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

      wsBroadcastUser(String(deal.buyer_id ?? ''), 'dispute:updated', { contractId: cid, evidence: item });
      wsBroadcastUser(String(deal.seller_id ?? ''), 'dispute:updated', { contractId: cid, evidence: item });
      const otherDisputeParty = isBuyer ? String(deal.seller_id ?? '') : String(deal.buyer_id ?? '');
      if (otherDisputeParty && !isPendingPartyId(otherDisputeParty)) {
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
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_disputes');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
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
      const dealDocId = String(deal._docId || cid);
      if (isTerminalStatus(deal.status)) {
        return res.status(400).json({ success: false, error: 'این پرونده پیش‌تر مختومه شده است.' });
      }

      const amount = Number(deal.amount || 0);
      const useStaged = Boolean((deal.staged_payment ?? deal.is_milestone) && Array.isArray(deal.milestones) && deal.milestones.length > 0);
      const remainingEscrow =
        useStaged
          ? deal.milestones
              .filter((m: any) => !['completed', 'paid'].includes(String(m.status)))
              .reduce((sum: number, m: any) => sum + Number(m.amount || 0), 0)
          : amount;

      const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent ?? globalLimits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));
      const expectedRemainingLocked =
        deal.escrow_locked_amount !== undefined
          ? Math.max(0, Number(deal.escrow_locked_amount) - Number(deal.escrow_released_amount || 0))
          : computeCommissionBreakdown(remainingEscrow, feePercent, deal.commission_payer).employerTotalPayable;

      const buyerId = String(deal.buyer_id ?? '');
      const sellerId = String(deal.seller_id ?? '');
      const buyer = (await getUserById(buyerId)) || { wallet_balance: 0, escrow_locked_balance: 0 };
      const buyerLockedNow = Number(buyer.escrow_locked_balance || 0);
      const hasLockedFunds =
        (deal.escrow_deposit_status === 'paid_locked' || buyerLockedNow >= remainingEscrow) &&
        remainingEscrow > 0 &&
        buyerLockedNow > 0;
      const unlockForDeal = hasLockedFunds
        ? Math.min(buyerLockedNow, Math.max(remainingEscrow, expectedRemainingLocked))
        : 0;

      const sellerGross = hasLockedFunds ? Math.round((remainingEscrow * sellerPercent) / 100) : 0;
      const verdictBreakdown = computeCommissionBreakdown(sellerGross, feePercent, deal.commission_payer);
      const buyerDebit = hasLockedFunds
        ? sellerPercent === 0
          ? 0
          : Math.min(unlockForDeal, Math.max(sellerGross, verdictBreakdown.employerTotalPayable))
        : 0;
      const buyerRefund = hasLockedFunds ? Math.max(0, unlockForDeal - buyerDebit) : 0;

      const nextStatus = sellerPercent === 0 ? 'cancelled' : 'completed';
      const nextEscrowStatus = sellerPercent === 0 ? 'refunded' : 'released';
      const nowIso = new Date().toISOString();
      const prevTimeline = Array.isArray(deal.timeline) ? deal.timeline : [];
      const prevHistory = Array.isArray(deal.history) ? deal.history : [];
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
      const nextHistory = [
        ...prevHistory,
        {
          event: verdictTimelineEntry.note,
          timestamp: nowIso,
          actor: verdictTimelineEntry.actor_name,
          actor_id: getStoredActorTelegramOrId(authResult.actor),
        },
      ];
      const resolvedMilestones =
        Array.isArray(deal.milestones) && deal.milestones.length > 0
          ? deal.milestones.map((m: any) =>
              ['completed', 'paid'].includes(String(m.status)) ? m : { ...m, status: sellerPercent === 0 ? 'cancelled' : 'completed', auto_release_at: null }
            )
          : [];

      let balancesPayload: Record<string, { wallet_balance: number; escrow_locked_balance: number }> = {};
      let feeAmount = 0;
      let sellerNet = 0;

      if (hasLockedFunds) {
        const payout = await executeEscrowPayout({
          cid,
          deal,
          grossUnlockAmount: unlockForDeal,
          sellerGrossAmount: sellerGross,
          feePercent,
          buyerId,
          sellerId,
          nextDealFields: {
            status: nextStatus,
            escrow_deposit_status: nextEscrowStatus,
            escrow_released_amount: Number(deal.escrow_released_amount || 0) + unlockForDeal,
            auto_release_at: null,
            ...(resolvedMilestones.length > 0 ? { milestones: resolvedMilestones } : {}),
            timeline: nextTimeline,
            history: nextHistory,
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
            .doc(dealDocId)
            .set(
              {
                status: nextStatus,
                escrow_deposit_status: nextEscrowStatus,
                auto_release_at: null,
                ...(resolvedMilestones.length > 0 ? { milestones: resolvedMilestones } : {}),
                timeline: nextTimeline,
                history: nextHistory,
                updated_at: nowIso,
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
        escrow_deposit_status: nextEscrowStatus,
        auto_release_at: null,
        ...(resolvedMilestones.length > 0 ? { milestones: resolvedMilestones } : {}),
        timeline: nextTimeline,
        history: nextHistory,
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
      await recordAuditLog(
        authResult.actor,
        'dispute_verdict_issued',
        `صدور رأی داوری برای ${cid}: ${verdictSummaryText}`,
        { type: 'deal', id: cid }
      );

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
      const uid = String(authResult.actor.id);
      if (!checkBucketLimit(disputeActionRateMap, `appeal:${uid}`, 8, 60 * 60 * 1000)) {
        return res.status(429).json({ success: false, error: 'تعداد درخواست‌های تجدیدنظر بیش از حد مجاز بوده است.' });
      }
      const deal = await getDealByContractId(cid);
      if (!deal) return res.status(404).json({ success: false, error: 'قرارداد یافت نشد.' });

      const dealDocId = String(deal._docId || cid);
      const buyerId = String(deal.buyer_id ?? '');
      const sellerId = String(deal.seller_id ?? '');
      const isBuyer = isUserDealBuyer(deal, authResult.actor);
      const isSeller = isUserDealSeller(deal, authResult.actor);
      if (!isBuyer && !isSeller) {
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
        requester_role: isBuyer ? 'buyer' : 'seller',
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
        await firestore.collection('deals').doc(dealDocId).set({ appeal, timeline: nextTimeline, updated_at: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
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

      const otherPartyId = isBuyer ? sellerId : buyerId;
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
    const permCheck = ensureAdminPermission(authResult.actor, 'manage_disputes');
    if (!permCheck.ok) {
      return res.status(permCheck.status).json({ success: false, error: permCheck.error });
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
        const dealDocId = String(deal._docId || cid);
        await firestore.collection('dispute_records').doc(cid).set({ appeal: updatedAppeal, updated_at: nowIso }, { merge: true }).catch(() => {});
        await firestore.collection('deals').doc(dealDocId).set({ appeal: updatedAppeal, timeline: nextTimeline, updated_at: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
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
      await recordAuditLog(
        authResult.actor,
        `appeal_${decision}`,
        `تصمیم هیئت تجدیدنظر برای ${cid}: ${decision === 'accepted' ? 'پذیرفته شد' : 'رد شد'}`,
        { type: 'deal', id: cid }
      );

      res.json({ success: true, appeal: updatedAppeal, contract: updatedDeal });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ثبت نتیجه تجدیدنظر' });
    }
  });

  // --- Server-Synced Contacts ---
  app.get('/api/contacts', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const uid = String(authResult.actor.id);
      const list = await getContactsListForUser(uid);

      const allUsers = await getAllUsersMerged();
      const byPhone = new Map<string, any>();
      allUsers.forEach((u) => {
        const core = getPhoneCore10(u.phone_number || u.phone || '');
        if (core) byPhone.set(core, u);
      });
      const onlineIds = new Set(getOnlineUserIds());

      const enriched = list.map((c) => {
        const core = getPhoneCore10(c.phone_number || '');
        const matched = core ? byPhone.get(core) : null;
        return {
          ...c,
          phone_number: normalizeIranPhone(c.phone_number || '') || c.phone_number,
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
      const actor = authResult.actor;
      const uid = String(actor.id);
      const name = String(req.body?.full_name || '').trim().slice(0, 100);
      const parsedPhone = parseIranMobile(String(req.body?.phone_number || ''));
      const category = String(req.body?.category || 'طرف معامله').trim().slice(0, 40) || 'طرف معامله';
      const note = String(req.body?.note || '').trim().slice(0, 300);
      if (!name || !parsedPhone.valid) {
        return res.status(400).json({ success: false, error: 'نام و شماره همراه معتبر (مثال: 09123456789 یا +989123456789) الزامی است.' });
      }
      const ownCore = getPhoneCore10(String(actor.phone_number || ''));
      if (ownCore && parsedPhone.core10 === ownCore) {
        return res.status(400).json({ success: false, error: 'شماره خودتان را نمی‌توانید به عنوان مخاطب ثبت کنید.' });
      }
      const matched = await findUserByPhone(parsedPhone.local, parsedPhone.core10);
      if (!matched) {
        return res.status(404).json({
          success: false,
          code: 'USER_NOT_FOUND',
          error: 'این شماره هنوز در میانجی ثبت‌نام نکرده است. می‌توانید از طریق پیامک دعوتش کنید.',
        });
      }

      const normPhone = parsedPhone.local;
      const cid = `cnt_${parsedPhone.core10}_${Date.now().toString(36)}`;
      const item = {
        id: cid,
        owner_id: uid,
        full_name: name,
        phone_number: normPhone,
        phone_core_digits: parsedPhone.core10,
        category,
        note,
        target_user_id: String(matched.id),
        status: 'verified',
        trust_score: Number(matched.trust_score || 96),
        createdAt: new Date().toISOString(),
      };
      const prev = memoryContacts.get(uid) || [];
      const deduped = prev.filter((c) => getPhoneCore10(c.phone_number || '') !== parsedPhone.core10);
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

  app.post('/api/contacts/invite-sms', async (req, res) => {
    const authResult = await authenticateActor(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    try {
      const actor = authResult.actor;
      const uid = String(actor.id);
      if (!checkBucketLimit(lookupRateMap, `invite_${uid}`, 15, 60 * 1000)) {
        return res.status(429).json({
          success: false,
          error: 'تعداد درخواست‌های دعوت پیامکی بیش از حد مجاز است. لطفاً کمی صبر کنید.',
        });
      }

      const rawPhone = String(req.body?.phone_number || '');
      const parsedPhone = parseIranMobile(rawPhone);
      if (!parsedPhone.valid) {
        return res.status(400).json({ success: false, error: 'شماره همراه معتبر نیست (مثال: 09123456789 یا +989123456789).' });
      }
      const normPhone = parsedPhone.local;
      const inviteeName = String(req.body?.full_name || '').trim().slice(0, 80);

      const existing = await findUserByPhone(parsedPhone.local, parsedPhone.core10);
      if (existing) {
        return res.status(409).json({
          success: false,
          alreadyRegistered: true,
          user: { id: String(existing.id), full_name: existing.full_name || 'کاربر میانجی' },
          error: 'این شماره قبلاً در میانجی عضو شده است.',
        });
      }

      const botUsername = await resolveBotUsername().catch(() => 'mianji_ir_bot');
      const origin = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
      const inviterName = String(actor.full_name || actor.first_name || 'یکی از کاربران میانجی').trim();
      const inviteText = `سلام${inviteeName ? ` ${inviteeName}` : ''}؛ ${inviterName} شما را به پلتفرم معاملات امانی و پیام‌رسان امن «میانجی» دعوت کرده است.\nبرای ثبت‌نام و شروع گفتگو وارد شوید:\n${origin}\nیا ربات تلگرام: https://t.me/${botUsername}`;

      let smsSentViaGateway = false;
      const kavenegarKey = String(process.env.KAVENEGAR_API_KEY || '').trim();
      const smsWebhookUrl = String(process.env.SMS_WEBHOOK_URL || '').trim();

      if (kavenegarKey) {
        try {
          const kvRes = await fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(kavenegarKey)}/sms/send.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ receptor: normPhone, message: inviteText }).toString(),
          });
          if (kvRes.ok) smsSentViaGateway = true;
        } catch {}
      } else if (smsWebhookUrl) {
        try {
          const whRes = await fetch(smsWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: normPhone, message: inviteText, inviter_id: uid }),
          });
          if (whRes.ok) smsSentViaGateway = true;
        } catch {}
      }

      const inviteId = `inv_${parsedPhone.core10}_${Date.now().toString(36)}`;
      const inviteRecord = {
        id: inviteId,
        inviter_id: uid,
        inviter_name: inviterName,
        phone_number: normPhone,
        invitee_name: inviteeName || undefined,
        sent_via_gateway: smsSentViaGateway,
        createdAt: new Date().toISOString(),
      };
      memoryContactInvites.set(inviteId, inviteRecord);

      const firestore = getDb();
      if (firestore) {
        await firestore.collection('contact_invites').doc(inviteId).set(inviteRecord).catch(() => {});
      }

      const smsUri = `sms:${normPhone}?body=${encodeURIComponent(inviteText)}`;
      res.json({
        success: true,
        smsSentViaGateway,
        phone: normPhone,
        inviteText,
        smsUri,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در ارسال دعوت‌نامه پیامکی' });
    }
  });

  app.post('/api/logs', (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkBucketLimit(logsRateMap, ip, 25, 60 * 1000)) {
      return res.sendStatus(429);
    }
    const rawLevel = String(req.body?.level || 'info').toLowerCase();
    const safeLevel = ['info', 'warn', 'error'].includes(rawLevel) ? rawLevel.toUpperCase() : 'INFO';
    const safeMessage = String(req.body?.message || '')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 300);
    let safeDetails = '';
    if (req.body?.details !== undefined && req.body?.details !== null) {
      try {
        safeDetails = JSON.stringify(req.body.details).replace(/[\r\n]+/g, ' ').slice(0, 400);
      } catch {
        safeDetails = '[unserializable]';
      }
    }
    console.log(`[CLIENT-LOG] [${safeLevel}] ${safeMessage}`, safeDetails);
    res.sendStatus(200);
  });

  // --- Durable Local Disk Snapshot Engine & Owner Backup/Restore API ---
  const mapToEntries = <K, V>(m: Map<K, V>) => Array.from(m.entries());
  const restoreMap = <V>(target: Map<string, V>, raw: any) => {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length >= 2 && entry[0] !== undefined && entry[0] !== null) {
        target.set(String(entry[0]), entry[1] as V);
      }
    }
  };

  const buildSnapshotPayload = () => ({
    version: 1,
    savedAt: new Date().toISOString(),
    users: mapToEntries(memoryUsers),
    deals: mapToEntries(memoryDeals),
    dealDrafts: mapToEntries(memoryDealDrafts),
    walletRequests: mapToEntries(memoryWalletRequests),
    transactions: mapToEntries(memoryTransactions),
    directChats: mapToEntries(memoryDirectChats),
    directMessages: mapToEntries(memoryDirectMessages),
    contractMessages: mapToEntries(memoryContractMessages),
    chatPins: mapToEntries(memoryPinnedMessages),
    unreadCounts: Array.from(memoryUnreadCounts.entries()).map(([k, inner]) => [k, Array.from(inner.entries())]),
    notifications: mapToEntries(memoryNotifications),
    channels: mapToEntries(memoryChannels),
    channelPosts: mapToEntries(memoryChannelPosts),
    channelSubscribers: Array.from(memoryChannelSubscribers.entries()).map(([k, s]) => [k, Array.from(s.values())]),
    disputes: mapToEntries(memoryDisputes),
    tickets: mapToEntries(memoryTickets),
    contacts: mapToEntries(memoryContacts),
    dealReviews: mapToEntries(memoryDealReviews),
    paymentSessions: mapToEntries(memoryPaymentSessions),
    userSessions: mapToEntries(memorySessions),
    revokedBefore: mapToEntries(memoryRevokedBefore),
    notificationPrefs: mapToEntries(memoryNotificationPrefs),
    pushSubscriptions: mapToEntries(memoryPushSubscriptions),
    globalLimits,
    totalFeesCollected: memoryTotalFeesCollected,
  });

  if (!hasDbReady() && initialDiskSnapshot) {
    try {
      restoreMap(memoryUsers, initialDiskSnapshot.users);
      memoryUsers.delete('u_admin_owner');
      restoreMap(memoryDeals, initialDiskSnapshot.deals);
      restoreMap(memoryDealDrafts, initialDiskSnapshot.dealDrafts);
      restoreMap(memoryWalletRequests, initialDiskSnapshot.walletRequests);
      restoreMap(memoryTransactions, initialDiskSnapshot.transactions);
      restoreMap(memoryDirectChats, initialDiskSnapshot.directChats);
      restoreMap(memoryDirectMessages, initialDiskSnapshot.directMessages);
      restoreMap(memoryContractMessages, initialDiskSnapshot.contractMessages);
      restoreMap(memoryPinnedMessages, initialDiskSnapshot.chatPins);
      if (Array.isArray(initialDiskSnapshot.unreadCounts)) {
        for (const [roomKey, pairs] of initialDiskSnapshot.unreadCounts) {
          if (typeof roomKey === 'string' && Array.isArray(pairs)) {
            const inner = new Map<string, number>();
            for (const [uid, cnt] of pairs) inner.set(String(uid), Number(cnt || 0));
            memoryUnreadCounts.set(roomKey, inner);
          }
        }
      }
      restoreMap(memoryNotifications, initialDiskSnapshot.notifications);
      restoreMap(memoryChannels, initialDiskSnapshot.channels);
      for (const [chId, ch] of memoryChannels.entries()) {
        if (ch?.owner_id === 'u_admin_owner') memoryChannels.delete(chId);
      }
      restoreMap(memoryChannelPosts, initialDiskSnapshot.channelPosts);
      for (const [chId] of memoryChannelPosts.entries()) {
        if (!memoryChannels.has(chId) && (chId === 'ch_mianji_official' || chId === 'ch_mianji_academy')) {
          memoryChannelPosts.delete(chId);
        }
      }
      if (Array.isArray(initialDiskSnapshot.channelSubscribers)) {
        for (const [chId, subs] of initialDiskSnapshot.channelSubscribers) {
          if (typeof chId === 'string' && Array.isArray(subs)) {
            memoryChannelSubscribers.set(chId, new Set(subs.map((x: any) => String(x))));
          }
        }
      }
      restoreMap(memoryDisputes, initialDiskSnapshot.disputes);
      restoreMap(memoryTickets, initialDiskSnapshot.tickets);
      restoreMap(memoryContacts, initialDiskSnapshot.contacts);
      restoreMap(memoryDealReviews, initialDiskSnapshot.dealReviews);
      restoreMap(memoryPaymentSessions, initialDiskSnapshot.paymentSessions);
      restoreMap(memorySessions, initialDiskSnapshot.userSessions);
      restoreMap(memoryRevokedBefore, initialDiskSnapshot.revokedBefore);
      restoreMap(memoryNotificationPrefs, initialDiskSnapshot.notificationPrefs);
      restoreMap(memoryPushSubscriptions, initialDiskSnapshot.pushSubscriptions);
      if (initialDiskSnapshot.globalLimits && typeof initialDiskSnapshot.globalLimits === 'object') {
        globalLimits = { ...globalLimits, ...initialDiskSnapshot.globalLimits };
      }
      if (typeof initialDiskSnapshot.totalFeesCollected === 'number') {
        memoryTotalFeesCollected = initialDiskSnapshot.totalFeesCollected;
      }
      console.log(
        `[PERSISTENCE] Hydrated local disk snapshot (${memoryUsers.size} users, ${memoryDeals.size} deals, ${memoryWalletRequests.size} wallet requests)`
      );
    } catch (hydrateErr: any) {
      console.warn('[PERSISTENCE] Snapshot hydration warning:', hydrateErr?.message || hydrateErr);
    }
  }

  let snapshotTimer: NodeJS.Timeout | null = null;
  const flushSnapshotSync = () => {
    if (hasDbReady() || !diskWritable) return;
    try {
      const tmpPath = `${SNAPSHOT_FILE}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(buildSnapshotPayload()), 'utf8');
      fs.renameSync(tmpPath, SNAPSHOT_FILE);
    } catch (saveErr: any) {
      console.warn('[PERSISTENCE] Disk snapshot write failed:', saveErr?.message || saveErr);
    }
  };
  snapshotFlushRequested = () => {
    if (hasDbReady() || !diskWritable) return;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      flushSnapshotSync();
    }, 150);
  };

  app.get('/api/admin/backup/export', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    if (authResult.actor.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'فقط مالک کل مجاز به دریافت نسخه پشتیبان کامل است.' });
    }
    try {
      const [users, deals, walletRequests, tickets, limits, platformStats] = await Promise.all([
        getAllUsersMerged(),
        getAllDealsMerged(),
        loadWalletRequests(),
        loadAllTickets(),
        loadGlobalLimits(),
        loadPlatformStats(),
      ]);
      const firestore = getDb();
      let transactions: any[] = [];
      let disputes: any[] = [];
      if (firestore) {
        const [txSnap, dispSnap] = await Promise.all([
          firestore.collection('transactions').get().catch(() => null),
          firestore.collection('dispute_records').get().catch(() => null),
        ]);
        if (txSnap) transactions = txSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (dispSnap) disputes = dispSnap.docs.map((d) => ({ contract_id: d.id, ...d.data() }));
      } else {
        for (const list of memoryTransactions.values()) transactions.push(...list);
        for (const [cid, rec] of memoryDisputes.entries()) disputes.push({ contract_id: cid, ...rec });
      }
      res.json({
        success: true,
        backup: {
          version: 1,
          exportedAt: new Date().toISOString(),
          persistence: getPersistenceStatus(),
          users,
          deals,
          walletRequests,
          transactions,
          disputes,
          tickets,
          globalLimits: limits,
          totalFeesCollected: platformStats.total_fees_collected,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در تهیه نسخه پشتیبان' });
    }
  });

  app.post('/api/admin/backup/import', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    if (authResult.actor.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'فقط مالک کل مجاز به بازیابی نسخه پشتیبان است.' });
    }
    try {
      const b = req.body?.backup || req.body || {};
      const usersList: any[] = Array.isArray(b.users) ? b.users : [];
      const dealsList: any[] = Array.isArray(b.deals) ? b.deals : [];
      const walletList: any[] = Array.isArray(b.walletRequests) ? b.walletRequests : [];
      const txList: any[] = Array.isArray(b.transactions) ? b.transactions : [];
      const disputeList: any[] = Array.isArray(b.disputes) ? b.disputes : [];
      const ticketList: any[] = Array.isArray(b.tickets) ? b.tickets : [];

      const firestore = getDb();
      let importedCounts = { users: 0, deals: 0, walletRequests: 0, transactions: 0, disputes: 0, tickets: 0 };

      for (const u of usersList) {
        if (!u?.id) continue;
        const uid = String(u.id);
        memoryUsers.set(uid, { ...u, id: uid });
        if (firestore) await firestore.collection('users').doc(uid).set({ ...u, id: uid }, { merge: true });
        importedCounts.users += 1;
      }
      for (const d of dealsList) {
        const cid = String(d?.contract_id || d?.id || '').trim();
        if (!cid) continue;
        memoryDeals.set(cid, { ...d, id: String(d.id || cid), contract_id: cid });
        if (firestore) await firestore.collection('deals').doc(cid).set({ ...d, id: String(d.id || cid), contract_id: cid }, { merge: true });
        importedCounts.deals += 1;
      }
      for (const w of walletList) {
        if (!w?.id) continue;
        const wid = String(w.id);
        memoryWalletRequests.set(wid, { ...w, id: wid });
        if (firestore) await firestore.collection('wallet_requests').doc(wid).set({ ...w, id: wid }, { merge: true });
        importedCounts.walletRequests += 1;
      }
      for (const t of txList) {
        if (!t?.id || !t?.user_id) continue;
        const uid = String(t.user_id);
        const cur = memoryTransactions.get(uid) || [];
        if (!cur.some((x) => x.id === t.id)) memoryTransactions.set(uid, [t, ...cur]);
        if (firestore) await firestore.collection('transactions').doc(String(t.id)).set(t, { merge: true });
        importedCounts.transactions += 1;
      }
      for (const disp of disputeList) {
        const cid = String(disp?.contract_id || '').trim();
        if (!cid) continue;
        const rec = { evidence: Array.isArray(disp.evidence) ? disp.evidence : [], ...(disp.resolution ? { resolution: disp.resolution } : {}), ...(disp.appeal ? { appeal: disp.appeal } : {}) };
        memoryDisputes.set(cid, rec);
        if (firestore) await firestore.collection('dispute_records').doc(cid).set(rec, { merge: true });
        importedCounts.disputes += 1;
      }
      for (const tk of ticketList) {
        if (!tk?.id) continue;
        const tid = String(tk.id);
        memoryTickets.set(tid, { ...tk, id: tid });
        if (firestore) await firestore.collection('support_tickets').doc(tid).set({ ...tk, id: tid }, { merge: true });
        importedCounts.tickets += 1;
      }
      if (b.globalLimits && typeof b.globalLimits === 'object') {
        globalLimits = { ...globalLimits, ...b.globalLimits };
        if (firestore) await firestore.collection('system_settings').doc('limits').set(globalLimits, { merge: true });
      }

      flushSnapshotSync();
      await recordAuditLog(
        authResult.actor,
        'backup_imported',
        `بازیابی فایل پشتیبان (${importedCounts.users} کاربر، ${importedCounts.deals} قرارداد، ${importedCounts.walletRequests} درخواست مالی)`,
        { type: 'system', id: 'backup' }
      );
      res.json({ success: true, imported: importedCounts, persistence: getPersistenceStatus() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در بازیابی نسخه پشتیبان' });
    }
  });

  app.get('/api/admin/system/readiness', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    if (authResult.actor.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'فقط مالک کل به چک‌لیست استقرار و لاگ ممیزی دسترسی دارد.' });
    }
    try {
      const persistence = getPersistenceStatus();
      const botTokenOk = Boolean((process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim());
      const botUsernameOk = Boolean((process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || '').trim() || cachedBotUsername);
      const botSyncOk = Boolean((process.env.BOT_SYNC_SECRET || '').trim() || botTokenOk);
      const sessionSecretOk = Boolean((process.env.ADMIN_SESSION_SECRET || '').trim());
      const appUrlOk = Boolean((process.env.APP_URL || process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_APP_URL || '').trim());
      const vapidOk = Boolean((process.env.VAPID_PUBLIC_KEY || '').trim() && (process.env.VAPID_PRIVATE_KEY || '').trim());
      const ownerIdOk = Boolean((process.env.OWNER_ID || '').trim());
      const gatewayProvider = getActiveGatewayProvider();

      const checks = [
        {
          id: 'database',
          label: 'اتصال دائمی دیتابیس امن (Supabase PostgreSQL / RLS)',
          ok: (persistence.mode === 'supabase' || persistence.mode === 'firestore') && !persistence.lastWriteError,
          severity: 'critical',
          detail:
            persistence.lastWriteError
              ? `خطا در آخرین عملیات نوشتن: ${persistence.lastWriteError}`
              : persistence.mode === 'supabase'
              ? `متصل به Supabase (${persistence.supabaseHost || 'PostgreSQL'})`
              : persistence.mode === 'firestore'
              ? `متصل به Firestore (${persistence.projectId})`
              : persistence.lastError
              ? `حالت فعلی: ${persistence.mode} — ${persistence.lastError}`
              : `حالت فعلی: ${persistence.mode} (متغیرهای SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY تنظیم نشده‌اند)`,
        },
        {
          id: 'session_secret',
          label: 'کلید پایدار نشست کاربران (ADMIN_SESSION_SECRET)',
          ok: sessionSecretOk,
          severity: 'critical',
          detail: sessionSecretOk ? 'تنظیم شده (پایدار بین ری‌استارت‌ها)' : 'تنظیم نشده (با ری‌استارت سرور، کلید موقت تغییر می‌کند)',
        },
        {
          id: 'bot_token',
          label: 'اتصال ربات تلگرام و ارسال OTP (BOT_TOKEN)',
          ok: botTokenOk,
          severity: 'critical',
          detail: botTokenOk ? (botUsernameOk ? `توکن و یوزرنیم ربات فعال است (@${cachedBotUsername || process.env.BOT_USERNAME || ''})` : 'توکن فعال است') : 'تنظیم نشده',
        },
        {
          id: 'bot_sync',
          label: 'همگام‌سازی امن ربات و سایت (BOT_SYNC_SECRET)',
          ok: botSyncOk,
          severity: 'important',
          detail: (process.env.BOT_SYNC_SECRET || '').trim() ? 'کلید اختصاصی همگام‌سازی تنظیم شده' : botTokenOk ? 'از BOT_TOKEN به عنوان fallback استفاده می‌شود' : 'تنظیم نشده',
        },
        {
          id: 'app_url',
          label: 'نشانی دامنه عمومی سرور (APP_URL / PUBLIC_APP_URL)',
          ok: appUrlOk,
          severity: 'important',
          detail: appUrlOk ? String(process.env.APP_URL || process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_APP_URL) : 'تنظیم نشده',
        },
        {
          id: 'owner_id',
          label: 'شناسه عددی مالک کل (OWNER_ID)',
          ok: ownerIdOk,
          severity: 'important',
          detail: ownerIdOk ? 'تنظیم شده' : 'تنظیم نشده',
        },
        {
          id: 'vapid',
          label: 'کلیدهای اعلان پوش مرورگر (VAPID_PUBLIC_KEY / PRIVATE)',
          ok: vapidOk,
          severity: 'recommended',
          detail: vapidOk ? 'اعلان Web Push فعال است' : 'غیرفعال (اعلان پوش بدون کلید VAPID ارسال نمی‌شود)',
        },
        {
          id: 'gateway',
          label: 'درگاه پرداخت آنلاین (اختیاری در این مرحله)',
          ok: Boolean(gatewayProvider && gatewayProvider !== 'sandbox'),
          severity: 'optional',
          detail: gatewayProvider === 'zarinpal' ? 'زرین‌پال فعال' : gatewayProvider === 'zibal' ? 'زیبال فعال' : 'حالت پرداخت کارت‌به‌کارت دستی',
        },
      ];

      // Live Supabase shared-table health & row count probe (all 14 shared tables)
      const probedTables = [
        'users',
        'otp_codes',
        'bot_login_tokens',
        'deals',
        'contract_signatures',
        'transactions',
        'wallet_requests',
        'pending_receipts',
        'disputes',
        'ambassadors',
        'commission_logs',
        'bot_settings',
        'security_audit_logs',
        'admin_logs',
      ];
      let dbTables: Array<{ name: string; ok: boolean; count: number | null; error?: string }> = [];
      let rpcStatus: { ok: boolean; detail: string } = {
        ok: false,
        detail: supabaseState.ready ? 'بررسی نشد' : 'Supabase متصل نیست',
      };

      if (supabaseState.ready && supabaseState.client) {
        const sb = supabaseState.client;
        const [tableResults, rpcProbe] = await Promise.all([
          Promise.all(
            probedTables.map(async (tbl) => {
              try {
                const { count, error } = await sb.from(tbl).select('id', { count: 'exact', head: true });
                if (error) {
                  return { name: tbl, ok: false, count: null, error: error.message };
                }
                return { name: tbl, ok: true, count: typeof count === 'number' ? count : 0 };
              } catch (e: any) {
                return { name: tbl, ok: false, count: null, error: e?.message || String(e) };
              }
            })
          ),
          (async () => {
            try {
              const { data, error } = await sb.rpc('miyanji_adjust_wallet_atomic', {
                p_user_id: '__health_probe_nonexistent__',
                p_wallet_delta: 0,
                p_locked_delta: 0,
                p_require_free_check: false,
              });
              if (error) {
                return { ok: false, detail: `خطای RPC: ${error.message}` };
              }
              if (data && (data.ok === true || data.error === 'USER_NOT_FOUND')) {
                return { ok: true, detail: 'تابع اتمیک miyanji_adjust_wallet_atomic فعال و قابل اجرا است' };
              }
              return { ok: false, detail: `پاسخ غیرمنتظره RPC: ${JSON.stringify(data)}` };
            } catch (e: any) {
              return { ok: false, detail: e?.message || String(e) };
            }
          })(),
        ]);
        dbTables = tableResults;
        rpcStatus = rpcProbe;
      }

      const usersRowCount = dbTables.find((t) => t.name === 'users')?.count ?? null;
      const missingTablesCount = dbTables.filter((t) => !t.ok).length;
      const syncStatusCheck = {
        id: 'bot_db_sync',
        label: 'وضعیت همگام‌سازی واقعی دیتابیس بین ربات تلگرام و وب‌سایت',
        ok: Boolean(
          supabaseState.ready &&
            missingTablesCount === 0 &&
            rpcStatus.ok &&
            ((usersRowCount !== null && usersRowCount > 0) || botSyncTelemetry.botSyncSuccessCount > 0) &&
            botSyncTelemetry.botSyncAuthFailCount === 0
        ),
        severity: 'important',
        detail: !supabaseState.ready
          ? supabaseState.lastError || 'Supabase متصل نیست'
          : missingTablesCount > 0
          ? `${missingTablesCount} جدول مشترک در Supabase یافت نشد — فایل supabase/schema.sql را کامل در SQL Editor اجرا کنید.`
          : !rpcStatus.ok
          ? `تابع اتمیک miyanji_adjust_wallet_atomic فعال نیست — فایل supabase/schema.sql را مجدد اجرا کنید.`
          : botSyncTelemetry.botSyncAuthFailCount > 0
          ? `ربات درخواست زده ولی به دلیل عدم تطابق BOT_SYNC_SECRET رد شده (${botSyncTelemetry.botSyncAuthFailCount} بار خطای 401)`
          : usersRowCount === 0 && botSyncTelemetry.botSyncSuccessCount === 0
          ? 'جداول سایت سالم‌اند ولی جدول users هنوز ۰ رکورد دارد و ربات هیچ درخواستی به سایت یا این Supabase نفرستاده است (پروژه ربات باید به همین SUPABASE_URL و SERVICE_ROLE_KEY متصل و ریدپلوی شود).'
          : `همگام‌سازی فعال · کاربران در جدول مشترک: ${usersRowCount ?? 0} · درخواست موفق ربات: ${botSyncTelemetry.botSyncSuccessCount}`,
      };
      checks.splice(1, 0, syncStatusCheck);

      const [auditLogs, securityLogs] = await Promise.all([loadAuditLogs(80), loadSecurityAuditLogs(100)]);
      res.json({
        success: true,
        env: isProd ? 'production' : 'development',
        persistence,
        checks,
        db_tables: dbTables,
        rpc_status: rpcStatus,
        bot_sync_telemetry: {
          ...botSyncTelemetry,
          users_row_count: usersRowCount,
        },
        runtime_logs: runtimeEventLogs.slice(0, 200),
        security_logs: securityLogs,
        audit_logs: auditLogs,
      });
    } catch (err: any) {
      pushRuntimeLog('error', 'system', 'خطا در بررسی سلامت استقرار سیستم', err?.message || String(err));
      res.status(500).json({ success: false, error: err?.message || 'خطا در بررسی سلامت استقرار سیستم' });
    }
  });

  app.post('/api/admin/system/test-connection', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    if (authResult.actor.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'فقط مالک کل مجاز به اجرای تست اتصال است.' });
    }
    try {
      const target = String(req.body?.target || 'all');
      const results: Record<string, any> = {};

      if (target === 'all' || target === 'supabase') {
        const started = Date.now();
        if (!supabaseState.ready || !supabaseState.client) {
          results.supabase = {
            ok: false,
            latency_ms: Date.now() - started,
            key_role: supabaseState.keyRole || null,
            supabase_host: supabaseState.urlHost || null,
            error: supabaseState.lastError || 'SUPABASE_URL یا SUPABASE_SERVICE_ROLE_KEY فعال نیست.',
          };
          pushRuntimeLog('error', 'supabase', 'تست زنده Supabase ناموفق بود', results.supabase.error);
        } else {
          const [{ count, error }, writeProbe] = await Promise.all([
            supabaseState.client.from('users').select('id', { count: 'exact', head: true }),
            probeSupabaseWriteHealth(supabaseState.client),
          ]);
          const latency = Date.now() - started;
          if (error || !writeProbe.writeOk || !writeProbe.usersWriteOk) {
            const combinedErr =
              error?.message ||
              writeProbe.usersWriteError ||
              writeProbe.writeError ||
              'خطای نوشتن در دیتابیس';
            lastFirestoreError = combinedErr;
            results.supabase = {
              ok: false,
              latency_ms: latency,
              users_count: count ?? 0,
              key_role: supabaseState.keyRole || 'unknown',
              supabase_host: supabaseState.urlHost,
              write_ok: writeProbe.writeOk,
              users_write_ok: writeProbe.usersWriteOk,
              summary_view_ok: writeProbe.summaryViewOk,
              error: combinedErr,
            };
            pushRuntimeLog('error', 'supabase', 'تست خواندن/نوشتن Supabase با خطا مواجه شد', combinedErr);
          } else {
            lastFirestoreError = null;
            results.supabase = {
              ok: true,
              latency_ms: latency,
              users_count: count ?? 0,
              key_role: supabaseState.keyRole || 'service_role',
              supabase_host: supabaseState.urlHost,
              write_ok: true,
              users_write_ok: true,
              summary_view_ok: writeProbe.summaryViewOk,
            };
            pushRuntimeLog(
              'success',
              'supabase',
              `تست زنده خواندن و نوشتن Supabase موفق (${latency}ms)`,
              `host=${supabaseState.urlHost} · role=${supabaseState.keyRole || 'service_role'} · users=${count ?? 0} · write=OK`
            );
          }
        }
      }

      if (target === 'all' || target === 'telegram') {
        const started = Date.now();
        const botToken = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
        if (!botToken) {
          results.telegram = { ok: false, latency_ms: Date.now() - started, error: 'BOT_TOKEN تنظیم نشده است.' };
          pushRuntimeLog('warn', 'telegram', 'تست ربات تلگرام: BOT_TOKEN تنظیم نشده است');
        } else {
          try {
            const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
            const tgJson: any = await tgRes.json().catch(() => ({}));
            const latency = Date.now() - started;
            if (tgRes.ok && tgJson?.ok && tgJson?.result) {
              cachedBotUsername = tgJson.result.username || cachedBotUsername;
              results.telegram = {
                ok: true,
                latency_ms: latency,
                username: tgJson.result.username,
                id: tgJson.result.id,
              };
              pushRuntimeLog('success', 'telegram', `اتصال به ربات @${tgJson.result.username} تایید شد (${latency}ms)`);
            } else {
              const desc = tgJson?.description || `HTTP ${tgRes.status}`;
              results.telegram = { ok: false, latency_ms: latency, error: desc };
              pushRuntimeLog('error', 'telegram', 'تست اتصال ربات تلگرام ناموفق بود', desc);
            }
          } catch (e: any) {
            const latency = Date.now() - started;
            results.telegram = { ok: false, latency_ms: latency, error: e?.message || String(e) };
            pushRuntimeLog('error', 'telegram', 'خطای شبکه در تست ربات تلگرام', results.telegram.error);
          }
        }
      }

      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'خطا در اجرای تست اتصال' });
    }
  });

  app.post('/api/admin/system/clear-runtime-logs', async (req, res) => {
    const authResult = await authenticateAdmin(req);
    if ('error' in authResult) {
      return res.status(authResult.status).json({ success: false, error: authResult.error });
    }
    if (authResult.actor.role !== 'owner') {
      return res.status(403).json({ success: false, error: 'فقط مالک کل مجاز به پاک کردن لاگ‌های موقت سرور است.' });
    }
    runtimeEventLogs.length = 0;
    lastFirestoreError = null;
    pushRuntimeLog('info', 'system', `لاگ زنده سرور توسط ${authResult.actor.full_name || 'مالک'} بازنشانی شد`);
    res.json({ success: true });
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
      server: {
        middlewareMode: true,
        ...(process.env.DISABLE_HMR === 'true' || isGcpRuntime ? { hmr: false } : {}),
      },
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
    let sessionClaims: { uid: string; role: string; jti?: string; iat?: number } | null = null;

    try {
      const urlObj = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
      const token = urlObj.searchParams.get('token') || extractSessionCookie(req as any) || undefined;
      const fallbackUid = urlObj.searchParams.get('uid') || '';
      sessionClaims = verifySessionToken(token);
      if (sessionClaims) {
        resolvedUserId = sessionClaims.uid;
        resolvedRole = sessionClaims.role;
      } else if (!isProd && !hasDbReady() && fallbackUid) {
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
    if (sessionClaims && (await isSessionRevoked(resolvedUserId, sessionClaims, liveUser))) {
      wsSend(ws, 'session:revoked', { reason: 'نشست شما لغو شده است.' });
      ws.close(4001, 'Session Revoked');
      return;
    }
    if (liveUser?.role) resolvedRole = liveUser.role;

    const actorObj = liveUser || { id: resolvedUserId, role: resolvedRole, full_name: 'کاربر میانجی' };
    const meta: WsClientMeta = {
      ws,
      userId: resolvedUserId,
      role: resolvedRole,
      sessionId: sessionClaims?.jti,
      rooms: new Set(),
    };
    const existingSet = wsClientsByUser.get(resolvedUserId) || new Set<WsClientMeta>();
    const wasOffline = existingSet.size === 0;
    existingSet.add(meta);
    wsClientsByUser.set(resolvedUserId, existingSet);

    wsSend(ws, 'presence:snapshot', { onlineIds: getOnlineUserIds() });
    if (wasOffline) {
      wsBroadcastAll('presence:update', { userId: resolvedUserId, online: true });
    }

    ws.on('message', async (raw) => {
      try {
        const parsed = JSON.parse(String(raw || '{}'));
        if (parsed.type === 'ping') {
          wsSend(ws, 'pong', { t: Date.now() });
          return;
        }
        if (parsed.type === 'room:join' && typeof parsed.room === 'string') {
          const room = parsed.room.slice(0, 120);
          if (room.startsWith('contract:')) {
            const cid = room.slice('contract:'.length);
            if (!(await canActorAccessChatRoom('contract', cid, actorObj))) return;
          } else if (room.startsWith('direct:')) {
            const chatId = room.slice('direct:'.length);
            if (!(await canActorAccessChatRoom('direct', chatId, actorObj))) return;
          }
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
          if (!meta.rooms.has(room)) {
            if (room.startsWith('contract:') && !(await canActorAccessChatRoom('contract', room.slice('contract:'.length), actorObj))) return;
            if (room.startsWith('direct:') && !(await canActorAccessChatRoom('direct', room.slice('direct:'.length), actorObj))) return;
          }
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
          return;
        }
        if (['call:invite', 'call:accept', 'call:reject', 'call:signal', 'call:end'].includes(parsed.type)) {
          const targetUserId = String(parsed.targetUserId || '').trim();
          const callId = String(parsed.callId || '').trim().slice(0, 80);
          if (!targetUserId || targetUserId === resolvedUserId || !callId) return;
          if (parsed.scope && parsed.chatId) {
            const scope = parsed.scope === 'contract' ? 'contract' : 'direct';
            const cid = String(parsed.chatId || '').trim();
            if (!(await canActorAccessChatRoom(scope, cid, actorObj))) return;
          }
          if (parsed.type === 'call:invite') {
            const targetSockets = wsClientsByUser.get(targetUserId);
            if (!targetSockets || targetSockets.size === 0) {
              wsSend(ws, 'call:unavailable', {
                callId,
                targetUserId,
                reason: 'کاربر در حال حاضر در شبکه آنلاین نیست.',
              });
              return;
            }
          }
          wsBroadcastUser(targetUserId, parsed.type, {
            callId,
            fromUserId: resolvedUserId,
            fromName: String(liveUser?.full_name || 'کاربر میانجی').slice(0, 80),
            fromAvatar: String(liveUser?.avatar_url || '').slice(0, 2048),
            targetUserId,
            mode: parsed.mode === 'video' ? 'video' : 'audio',
            ...(parsed.signal !== undefined ? { signal: parsed.signal } : {}),
            ...(parsed.reason ? { reason: String(parsed.reason).slice(0, 120) } : {}),
          });
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
        const dealDocId = String(deal._docId || cid);
        const normDealStatus = normalizeDealStatus(deal.status);
        const useStaged = Boolean((deal.staged_payment ?? deal.is_milestone) && Array.isArray(deal.milestones) && deal.milestones.length >= 2);

        const buyerId = String(deal.buyer_id ?? '');
        const sellerId = String(deal.seller_id ?? '');
        const feePercent = Math.max(0, Math.min(15, Number(deal.fee_percent ?? globalLimits.platform_fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT)));

        // Case 0: Active deal delivery deadline reminders & overdue alerts
        if (normDealStatus === 'active' && buyerId && sellerId && !isPendingPartyId(buyerId) && !isPendingPartyId(sellerId)) {
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
                await firestore.collection('deals').doc(dealDocId).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
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
                await firestore.collection('deals').doc(dealDocId).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
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
        if (normDealStatus === 'work_submitted' && !useStaged && deal.auto_release_at && buyerId && sellerId) {
          const expMs = Date.parse(String(deal.auto_release_at));
          if (!Number.isNaN(expMs) && expMs > nowMs && expMs - nowMs <= 6 * 3600 * 1000 && !deal.auto_release_warning_sent) {
            const nowIso = new Date().toISOString();
            const hoursLeft = Math.max(1, Math.ceil((expMs - nowMs) / 3600000));
            const warnText = `⏰ هشدار اتمام مهلت بازرسی: حدود ${hoursLeft} ساعت تا آزادسازی خودکار وجه قرارداد «${deal.title}» باقی مانده است. در صورت نیاز به اصلاح، پیش از اتمام زمان اقدام کنید.`;
            const firestore = getDb();
            if (firestore) {
              await firestore.collection('deals').doc(dealDocId).set({ auto_release_warning_sent: nowIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
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
              if (normalizeDealStatus(liveDeal.status) === 'work_submitted' && liveDeal.auto_release_at && Date.parse(String(liveDeal.auto_release_at)) <= nowMs) {
                const nowIso = new Date().toISOString();
                const amount = Number(liveDeal.amount || 0);
                const liveBreakdown = computeCommissionBreakdown(amount, feePercent, liveDeal.commission_payer);
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
                  grossUnlockAmount: liveBreakdown.employerTotalPayable,
                  sellerGrossAmount: amount,
                  feePercent,
                  buyerId,
                  sellerId,
                  nextDealFields: {
                    status: 'completed',
                    escrow_deposit_status: 'released',
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
                  escrow_deposit_status: 'released',
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
        if (normDealStatus === 'active' && useStaged && Array.isArray(deal.milestones)) {
          const warnMsIdx = deal.milestones.findIndex((m: any) => {
            if (!['work_submitted', 'delivered'].includes(String(m.status)) || !m.auto_release_at || m.auto_release_warning_sent) return false;
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
              await firestore.collection('deals').doc(dealDocId).set({ milestones: nextMilestones, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
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
            (m: any) =>
              ['work_submitted', 'delivered'].includes(String(m.status)) &&
              m.auto_release_at &&
              Date.parse(String(m.auto_release_at)) <= nowMs
          );
          if (expiredMsIdx !== -1) {
            processingDealIds.add(cid);
            try {
              const liveDeal = (await getDealByContractId(cid)) || deal;
              if (normalizeDealStatus(liveDeal.status) === 'active' && Array.isArray(liveDeal.milestones)) {
                const targetMs = liveDeal.milestones[expiredMsIdx];
                if (
                  targetMs &&
                  ['work_submitted', 'delivered'].includes(String(targetMs.status)) &&
                  targetMs.auto_release_at &&
                  Date.parse(String(targetMs.auto_release_at)) <= nowMs
                ) {
                  const nowIso = new Date().toISOString();
                  const nextMilestones = liveDeal.milestones.map((m: any) => ({ ...m }));
                  nextMilestones[expiredMsIdx] = {
                    ...targetMs,
                    status: 'completed',
                    completed_at: nowIso,
                    auto_release_at: null,
                  };
                  const nextPendingIdx = nextMilestones.findIndex((m: any) =>
                    ['pending', 'locked', 'awaiting_payment'].includes(String(m.status))
                  );
                  if (nextPendingIdx !== -1) {
                    nextMilestones[nextPendingIdx] = { ...nextMilestones[nextPendingIdx], status: 'active' };
                  }
                  const allDone = nextMilestones.every((m: any) => ['completed', 'paid'].includes(String(m.status)));
                  const nextStatus = allDone ? 'completed' : 'active';
                  const prevTimeline = Array.isArray(liveDeal.timeline) ? liveDeal.timeline : [];
                  const prevHistory = Array.isArray(liveDeal.history) ? liveDeal.history : [];
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
                  const nextHistory = [
                    ...prevHistory,
                    {
                      event: tlEntry.note,
                      timestamp: nowIso,
                      actor: 'system',
                    },
                  ];
                  const msAmtAuto = Number(targetMs.amount || 0);
                  const msAutoBreakdown = computeCommissionBreakdown(msAmtAuto, feePercent, liveDeal.commission_payer);
                  const prevReleasedAuto = Number(liveDeal.escrow_released_amount || 0);
                  const totalLockedAuto =
                    liveDeal.escrow_locked_amount !== undefined
                      ? Number(liveDeal.escrow_locked_amount)
                      : computeCommissionBreakdown(Number(liveDeal.amount || 0), feePercent, liveDeal.commission_payer).employerTotalPayable;
                  const remainingLockedAuto = Math.max(0, totalLockedAuto - prevReleasedAuto);
                  const grossUnlockAuto = allDone
                    ? Math.max(msAutoBreakdown.employerTotalPayable, remainingLockedAuto)
                    : msAutoBreakdown.employerTotalPayable;
                  const nextReleasedAuto = prevReleasedAuto + grossUnlockAuto;

                  const payout = await executeEscrowPayout({
                    cid,
                    deal: liveDeal,
                    grossUnlockAmount: grossUnlockAuto,
                    sellerGrossAmount: msAmtAuto,
                    feePercent,
                    buyerId,
                    sellerId,
                    nextDealFields: {
                      status: nextStatus,
                      ...(allDone ? { escrow_deposit_status: 'released' } : {}),
                      escrow_released_amount: nextReleasedAuto,
                      milestones: nextMilestones,
                      timeline: nextTimeline,
                      history: nextHistory,
                      ...(allDone ? { auto_released: true } : {}),
                    },
                    releaseDescription: `آزادسازی خودکار مرحله ${expiredMsIdx + 1} (${targetMs.title}) در ${liveDeal.title}`,
                    incrementCompletedCount: allDone,
                  });
                  const updatedDeal = await enrichDealWithParties({
                    ...liveDeal,
                    status: nextStatus,
                    escrow_released_amount: nextReleasedAuto,
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
      snapshotFlushRequested();
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
    flushSnapshotSync();
    server.close();
  });
  process.once('SIGTERM', () => {
    clearInterval(autoReleaseTimer);
    flushSnapshotSync();
    server.close();
  });
}

bootstrap();
