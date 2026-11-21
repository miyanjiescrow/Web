import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SENTINEL_BRAND = '__mianji_db_sentinel__';

export interface SentinelValue {
  [SENTINEL_BRAND]: 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
  operand?: any;
}

export const DbSentinel = {
  serverTimestamp: (): SentinelValue => ({ [SENTINEL_BRAND]: 'serverTimestamp' }),
  increment: (n: number): SentinelValue => ({ [SENTINEL_BRAND]: 'increment', operand: Number(n || 0) }),
  arrayUnion: (...items: any[]): SentinelValue => ({ [SENTINEL_BRAND]: 'arrayUnion', operand: items }),
  arrayRemove: (...items: any[]): SentinelValue => ({ [SENTINEL_BRAND]: 'arrayRemove', operand: items }),
  delete: (): SentinelValue => ({ [SENTINEL_BRAND]: 'delete' }),
};

const PERSIAN_ARABIC_DIGITS_MAP: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

export function extractPhoneCore10Digits(raw: any): string {
  const str = String(raw || '').replace(/[۰-۹٠-٩]/g, (c) => PERSIAN_ARABIC_DIGITS_MAP[c] || c);
  const digits = str.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function toIsoOrNull(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    const ms = val < 1e12 ? val * 1000 : val;
    return new Date(ms).toISOString();
  }
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString();
  }
  if (typeof val?.toDate === 'function') {
    try {
      return val.toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function toNumOrNull(val: any): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function isSentinel(val: any): SentinelValue | null {
  if (!val || typeof val !== 'object') return null;
  if (val[SENTINEL_BRAND]) return val as SentinelValue;
  const ctorName = val.constructor?.name || '';
  if (ctorName === 'ServerTimestampTransform' || val.methodName === 'FieldValue.serverTimestamp') {
    return { [SENTINEL_BRAND]: 'serverTimestamp' };
  }
  if (ctorName === 'NumericIncrementTransform' || val.methodName === 'FieldValue.increment') {
    return { [SENTINEL_BRAND]: 'increment', operand: Number(val.operand ?? 0) };
  }
  if (ctorName === 'ArrayUnionTransform' || val.methodName === 'FieldValue.arrayUnion') {
    return { [SENTINEL_BRAND]: 'arrayUnion', operand: Array.isArray(val.elements) ? val.elements : [] };
  }
  if (ctorName === 'ArrayRemoveTransform' || val.methodName === 'FieldValue.arrayRemove') {
    return { [SENTINEL_BRAND]: 'arrayRemove', operand: Array.isArray(val.elements) ? val.elements : [] };
  }
  if (ctorName === 'DeleteTransform' || val.methodName === 'FieldValue.delete') {
    return { [SENTINEL_BRAND]: 'delete' };
  }
  return null;
}

function stripUndefinedDeep(input: any): any {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object') return input;
  if (isSentinel(input)) return input;
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) {
    return input.map((item) => stripUndefinedDeep(item)).filter((item) => item !== undefined);
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    const clean = stripUndefinedDeep(v);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

function resolvePayloadWithExisting(
  incoming: Record<string, any>,
  existing: Record<string, any> | null,
  merge: boolean
): Record<string, any> {
  const nowIso = new Date().toISOString();
  const base: Record<string, any> = merge && existing ? { ...existing } : {};
  const cleanedIncoming = stripUndefinedDeep(incoming) || {};

  for (const [key, rawVal] of Object.entries(cleanedIncoming)) {
    const sentinel = isSentinel(rawVal);
    if (sentinel) {
      if (sentinel[SENTINEL_BRAND] === 'serverTimestamp') {
        base[key] = nowIso;
      } else if (sentinel[SENTINEL_BRAND] === 'increment') {
        const curNum = Number(base[key] ?? existing?.[key] ?? 0);
        base[key] = (Number.isFinite(curNum) ? curNum : 0) + Number(sentinel.operand || 0);
      } else if (sentinel[SENTINEL_BRAND] === 'arrayUnion') {
        const curArr = Array.isArray(base[key]) ? [...base[key]] : Array.isArray(existing?.[key]) ? [...existing[key]] : [];
        const items = Array.isArray(sentinel.operand) ? sentinel.operand : [];
        for (const item of items) {
          const serialized = JSON.stringify(item);
          if (!curArr.some((x) => JSON.stringify(x) === serialized)) {
            curArr.push(item);
          }
        }
        base[key] = curArr;
      } else if (sentinel[SENTINEL_BRAND] === 'arrayRemove') {
        const curArr = Array.isArray(base[key]) ? [...base[key]] : Array.isArray(existing?.[key]) ? [...existing[key]] : [];
        const removeSet = new Set((Array.isArray(sentinel.operand) ? sentinel.operand : []).map((x: any) => JSON.stringify(x)));
        base[key] = curArr.filter((x) => !removeSet.has(JSON.stringify(x)));
      } else if (sentinel[SENTINEL_BRAND] === 'delete') {
        delete base[key];
      }
    } else {
      base[key] = rawVal;
    }
  }
  return base;
}

export const SHARED_CORE_TABLES = new Set([
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
]);

export const TYPED_TABLES = new Set([
  ...SHARED_CORE_TABLES,
  'user_sessions',
  'user_contacts',
  'contact_invites',
  'deal_drafts',
  'deal_reviews',
  'direct_chats',
  'direct_messages',
  'contract_messages',
  'chat_pins',
  'channels',
  'channel_posts',
  'channel_subscribers',
  'notifications',
  'notification_prefs',
  'push_subscriptions',
  'support_tickets',
  'payment_sessions',
  'media_assets',
  'media_chunks',
  'system_settings',
]);

interface TableTarget {
  table: string;
  logicalCollection: string;
  implicitOwnerId?: string;
}

export function resolveTableTarget(collectionPath: string): TableTarget {
  if (collectionPath === 'dispute_records') {
    return { table: 'disputes', logicalCollection: 'dispute_records' };
  }
  if (collectionPath === 'audit_logs') {
    return { table: 'admin_logs', logicalCollection: 'audit_logs' };
  }
  if (collectionPath === 'subscribers') {
    return { table: 'channel_subscribers', logicalCollection: 'subscribers' };
  }
  const contactsSubMatch = collectionPath.match(/^users\/([^/]+)\/contacts$/);
  if (contactsSubMatch) {
    return { table: 'user_contacts', logicalCollection: 'user_contacts', implicitOwnerId: contactsSubMatch[1] };
  }
  const draftsSubMatch = collectionPath.match(/^users\/([^/]+)\/deal_drafts$/);
  if (draftsSubMatch) {
    return { table: 'deal_drafts', logicalCollection: 'deal_drafts', implicitOwnerId: draftsSubMatch[1] };
  }
  if (TYPED_TABLES.has(collectionPath)) {
    return { table: collectionPath, logicalCollection: collectionPath };
  }
  return { table: 'app_documents', logicalCollection: collectionPath };
}

const TYPED_COLUMNS_BY_TABLE: Record<string, Set<string>> = {
  users: new Set(['id', 'telegram_id', 'phone_number', 'phone_core_digits', 'role', 'kyc_status', 'national_id', 'is_blocked', 'referral_code']),
  otp_codes: new Set(['id', 'phone', 'purpose', 'telegram_id']),
  bot_login_tokens: new Set(['id', 'token', 'telegram_id', 'used']),
  deals: new Set(['id', 'contract_id', 'status', 'buyer_id', 'seller_id', 'creator_id', 'escrow_deposit_status']),
  contract_signatures: new Set(['id', 'contract_id', 'user_id', 'telegram_id', 'role', 'status']),
  transactions: new Set(['id', 'user_id', 'contract_id', 'type', 'status']),
  wallet_requests: new Set(['id', 'user_id', 'type', 'status', 'ref_code']),
  pending_receipts: new Set(['id', 'type', 'related_id', 'user_id', 'status']),
  disputes: new Set(['id', 'contract_id', 'claimant_id', 'status']),
  ambassadors: new Set(['id', 'telegram_id', 'is_active']),
  commission_logs: new Set(['id', 'ambassador_id', 'contract_id']),
  bot_settings: new Set(['id', 'key']),
  security_audit_logs: new Set(['id', 'user_id', 'event', 'category', 'status']),
  admin_logs: new Set(['id', 'admin_id', 'action', 'target_id']),
  user_sessions: new Set(['id', 'user_id']),
  user_contacts: new Set(['id', 'owner_id', 'contact_user_id', 'phone_core_digits']),
  contact_invites: new Set(['id', 'inviter_id', 'phone_core_digits', 'status']),
  deal_drafts: new Set(['id', 'owner_id']),
  deal_reviews: new Set(['id', 'contract_id', 'reviewer_id', 'target_user_id']),
  direct_chats: new Set(['id', 'is_support']),
  direct_messages: new Set(['id', 'chat_id', 'sender_id']),
  contract_messages: new Set(['id', 'contract_id', 'sender_id']),
  chat_pins: new Set(['id', 'scope', 'chat_id']),
  channels: new Set(['id', 'slug', 'owner_id']),
  channel_posts: new Set(['id', 'channel_id']),
  channel_subscribers: new Set(['id', 'channel_id', 'user_id']),
  notifications: new Set(['id', 'user_id', 'kind', 'is_read']),
  notification_prefs: new Set(['id', 'user_id']),
  push_subscriptions: new Set(['id', 'user_id']),
  support_tickets: new Set(['id', 'user_id', 'status']),
  payment_sessions: new Set(['id', 'user_id', 'provider', 'status']),
  media_assets: new Set(['id', 'owner_id']),
  media_chunks: new Set(['id', 'media_id', 'chunk_index']),
  system_settings: new Set(['id']),
};

function extractComparableValue(val: any): any {
  if (val && typeof val === 'object') {
    if (typeof val.toMillis === 'function') return val.toMillis();
    if (typeof val.toDate === 'function') return val.toDate().getTime();
  }
  if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) {
    const ms = Date.parse(val);
    if (!Number.isNaN(ms)) return ms;
  }
  return val;
}

export function normalizeAmbassadorCommissionRate(rawRate: unknown): {
  decimal: number;
  percent: number;
} {
  if (rawRate === undefined || rawRate === null || rawRate === '') {
    return { decimal: 0.1, percent: 10 };
  }
  const n = Number(rawRate);
  if (!Number.isFinite(n) || n < 0) {
    return { decimal: 0.1, percent: 10 };
  }
  const decimal = n > 1 ? Math.min(1, Number((n / 100).toFixed(4))) : Number(n.toFixed(4));
  const percent = Number((decimal * 100).toFixed(2));
  return { decimal, percent };
}

export function rowToDocData(target: TableTarget, row: any): Record<string, any> | null {
  if (!row) return null;
  const jsonPayload = row.data && typeof row.data === 'object' ? { ...row.data } : {};
  const table = target.table;

  if (table === 'users') {
    const out: Record<string, any> = {
      ...jsonPayload,
      id: String(row.id),
      phone_number: row.phone_number ?? jsonPayload.phone_number ?? '',
      phone_core_digits: row.phone_core_digits ?? jsonPayload.phone_core_digits ?? extractPhoneCore10Digits(row.phone_number ?? jsonPayload.phone_number),
      full_name: row.full_name ?? jsonPayload.full_name ?? 'کاربر میانجی',
      role: row.role ?? jsonPayload.role ?? 'user',
      kyc_status: row.kyc_status ?? jsonPayload.kyc_status ?? 'pending',
      kyc_level: row.kyc_level ?? jsonPayload.kyc_level ?? 'basic',
      is_verified: Boolean(row.is_verified ?? jsonPayload.is_verified ?? row.kyc_status === 'verified'),
      wallet_balance: Number(row.wallet_balance ?? jsonPayload.wallet_balance ?? 0),
      escrow_locked_balance: Number(row.escrow_locked_balance ?? jsonPayload.escrow_locked_balance ?? 0),
      saved_cards: Array.isArray(row.saved_cards) ? row.saved_cards : Array.isArray(jsonPayload.saved_cards) ? jsonPayload.saved_cards : [],
      has_financial_pin: Boolean(row.has_financial_pin ?? jsonPayload.has_financial_pin ?? false),
      pin_failed_attempts: Number(row.pin_failed_attempts ?? jsonPayload.pin_failed_attempts ?? 0),
      security_score: Number(row.security_score ?? jsonPayload.security_score ?? 0),
      is_blocked: Boolean(row.is_blocked ?? jsonPayload.is_blocked ?? false),
    };
    if (row.telegram_id) out.telegram_id = String(row.telegram_id);
    if (row.chat_id !== undefined && row.chat_id !== null) out.chat_id = Number(row.chat_id);
    if (row.username !== undefined && row.username !== null) out.username = row.username;
    if (row.avatar_url !== undefined && row.avatar_url !== null) out.avatar_url = row.avatar_url;
    if (row.national_id !== undefined && row.national_id !== null) out.national_id = row.national_id;
    if (row.sheba !== undefined && row.sheba !== null) out.sheba = row.sheba;
    if (row.sheba_owner_name !== undefined && row.sheba_owner_name !== null) out.sheba_owner_name = row.sheba_owner_name;
    if (row.sheba_verified !== undefined && row.sheba_verified !== null) out.sheba_verified = Boolean(row.sheba_verified);
    if (row.sheba_locked_to_national_id !== undefined && row.sheba_locked_to_national_id !== null) {
      out.sheba_locked_to_national_id = Boolean(row.sheba_locked_to_national_id);
    }
    if (row.financial_pin_hash !== undefined && row.financial_pin_hash !== null) out.financial_pin_hash = row.financial_pin_hash;
    if (row.pin_locked_until !== undefined && row.pin_locked_until !== null) out.pin_locked_until = row.pin_locked_until;
    if (row.referral_code !== undefined && row.referral_code !== null) out.referral_code = row.referral_code;
    if (row.invited_by !== undefined && row.invited_by !== null) out.invited_by = row.invited_by;
    if (row.created_at && !out.createdAt) out.createdAt = row.created_at;
    if (row.updated_at && !out.updatedAt) out.updatedAt = row.updated_at;
    return out;
  }

  if (table === 'deals') {
    const out: Record<string, any> = {
      ...jsonPayload,
      id: String(row.id),
      contract_id: String(row.contract_id || jsonPayload.contract_id || row.id),
      title: row.title ?? jsonPayload.title ?? '',
      category: row.category ?? jsonPayload.category ?? 'other',
      description: row.description ?? jsonPayload.description ?? '',
      amount: Number(row.amount ?? jsonPayload.amount ?? 0),
      locked_amount: Number(row.locked_amount ?? jsonPayload.locked_amount ?? jsonPayload.escrow_locked_amount ?? 0),
      held_extra_amount: Number(row.held_extra_amount ?? jsonPayload.held_extra_amount ?? 0),
      status: row.status ?? jsonPayload.status ?? 'draft',
      escrow_deposit_status: row.escrow_deposit_status ?? jsonPayload.escrow_deposit_status ?? 'unpaid',
      commission_payer: row.commission_payer ?? jsonPayload.commission_payer ?? 'freelancer',
      staged_payment: Boolean(row.staged_payment ?? jsonPayload.staged_payment ?? jsonPayload.is_milestone ?? false),
      milestones: Array.isArray(row.milestones) ? row.milestones : Array.isArray(jsonPayload.milestones) ? jsonPayload.milestones : [],
    };
    if (row.invite_token !== undefined && row.invite_token !== null) out.invite_token = row.invite_token;
    if (row.creator_id !== undefined && row.creator_id !== null) out.creator_id = row.creator_id;
    if (row.creator_role !== undefined && row.creator_role !== null) out.creator_role = row.creator_role;
    if (row.buyer_id !== undefined && row.buyer_id !== null) out.buyer_id = row.buyer_id;
    if (row.seller_id !== undefined && row.seller_id !== null) out.seller_id = row.seller_id;
    if (row.deadline !== undefined && row.deadline !== null) out.deadline = Number(row.deadline);
    if (row.buyer_signed_at && !out.buyer_signed_at) out.buyer_signed_at = row.buyer_signed_at;
    if (row.seller_signed_at && !out.seller_signed_at) out.seller_signed_at = row.seller_signed_at;
    if (row.paid_at && !out.paid_at) out.paid_at = row.paid_at;
    if (row.delivery_deadline && !out.delivery_deadline) out.delivery_deadline = row.delivery_deadline;
    if (row.completed_at && !out.completed_at) out.completed_at = row.completed_at;
    if (row.created_at && !out.created_at) out.created_at = row.created_at;
    if (row.updated_at && !out.updated_at) out.updated_at = row.updated_at;
    return out;
  }

  if (table === 'wallet_requests') {
    return {
      ...jsonPayload,
      id: String(row.id),
      user_id: String(row.user_id ?? jsonPayload.user_id ?? ''),
      type: row.type ?? jsonPayload.type ?? 'withdraw',
      amount: Number(row.amount ?? jsonPayload.amount ?? 0),
      status: row.status ?? jsonPayload.status ?? 'pending',
      ...(row.sheba ? { sheba: row.sheba } : {}),
      ...(row.holder_name ? { holder_name: row.holder_name } : {}),
      ...(row.source ? { source: row.source } : {}),
      ...(row.ref_code !== undefined && row.ref_code !== null ? { ref_code: row.ref_code } : {}),
      ...(row.admin_id ? { admin_id: row.admin_id } : {}),
      ...(row.document_note ? { document_note: row.document_note } : {}),
      documents: Array.isArray(row.documents) ? row.documents : Array.isArray(jsonPayload.documents) ? jsonPayload.documents : [],
      created_at: jsonPayload.created_at || row.created_at,
      updated_at: jsonPayload.updated_at || row.updated_at,
    };
  }

  if (table === 'transactions') {
    return {
      ...jsonPayload,
      id: String(row.id),
      user_id: String(row.user_id ?? jsonPayload.user_id ?? ''),
      contract_id: row.contract_id ?? jsonPayload.contract_id ?? '',
      amount: Number(row.amount ?? jsonPayload.amount ?? 0),
      type: row.type ?? jsonPayload.type ?? 'deposit',
      status: row.status ?? jsonPayload.status ?? 'completed',
      title: row.title ?? jsonPayload.title ?? '',
      description: row.description ?? jsonPayload.description ?? '',
      ...(row.ref_id ? { ref_id: row.ref_id } : {}),
      ...(row.sheba ? { sheba: row.sheba } : {}),
      createdAt: jsonPayload.createdAt || row.created_at,
      created_at: jsonPayload.created_at || row.created_at,
      updated_at: jsonPayload.updated_at || row.updated_at,
    };
  }

  if (table === 'otp_codes') {
    return {
      ...jsonPayload,
      id: String(row.id),
      ...(row.phone !== undefined && row.phone !== null ? { phone: row.phone } : {}),
      ...(row.code !== undefined && row.code !== null ? { code: row.code } : {}),
      ...(row.code_hash !== undefined && row.code_hash !== null ? { code_hash: row.code_hash } : {}),
      expires: Number(row.expires ?? jsonPayload.expires ?? 0),
      attempts: Number(row.attempts ?? jsonPayload.attempts ?? 0),
      purpose: row.purpose ?? jsonPayload.purpose ?? 'login',
      ...(row.telegram_id ? { telegram_id: row.telegram_id } : {}),
    };
  }

  if (table === 'bot_login_tokens') {
    return {
      ...jsonPayload,
      id: String(row.id),
      token: row.token ?? jsonPayload.token ?? row.id,
      ...(row.telegram_id ? { telegram_id: row.telegram_id } : {}),
      ...(row.phone_number ? { phone_number: row.phone_number } : {}),
      ...(row.full_name ? { full_name: row.full_name } : {}),
      ...(row.username ? { username: row.username } : {}),
      ...(row.expires_at !== undefined && row.expires_at !== null ? { expires_at: Number(row.expires_at) } : {}),
      used: Boolean(row.used ?? jsonPayload.used ?? false),
    };
  }

  if (table === 'disputes') {
    const evidence = Array.isArray(jsonPayload.evidence)
      ? jsonPayload.evidence
      : Array.isArray(row.evidence_files)
      ? row.evidence_files
      : [];
    const resolution = jsonPayload.resolution ?? row.ruling ?? undefined;
    return {
      ...jsonPayload,
      id: String(row.id),
      contract_id: String(row.contract_id || jsonPayload.contract_id || row.id),
      evidence,
      evidence_files: Array.isArray(row.evidence_files) ? row.evidence_files : evidence,
      ...(resolution ? { resolution, ruling: resolution } : {}),
      status: row.status ?? jsonPayload.status ?? 'under_review',
      messages: Array.isArray(row.messages) ? row.messages : Array.isArray(jsonPayload.messages) ? jsonPayload.messages : [],
      created_at: jsonPayload.created_at || row.created_at,
      updated_at: jsonPayload.updated_at || row.updated_at,
    };
  }

  if (table === 'admin_logs') {
    return {
      ...jsonPayload,
      id: String(row.id),
      admin_id: row.admin_id ?? jsonPayload.admin_id ?? jsonPayload.actor_id ?? 'system',
      actor_id: jsonPayload.actor_id ?? row.admin_id ?? 'system',
      action: row.action ?? jsonPayload.action ?? '',
      detail: row.detail ?? jsonPayload.detail ?? jsonPayload.summary ?? '',
      summary: jsonPayload.summary ?? row.detail ?? '',
      ...(row.target_id ? { target_id: row.target_id } : {}),
      created_at: jsonPayload.created_at || row.created_at,
    };
  }

  if (table === 'ambassadors') {
    const rate = normalizeAmbassadorCommissionRate(row.commission_rate ?? jsonPayload.commission_rate);
    return {
      ...jsonPayload,
      id: String(row.id),
      telegram_id: row.telegram_id ?? jsonPayload.telegram_id ?? String(row.id),
      tier_level: row.tier_level ?? jsonPayload.tier_level ?? 'bronze',
      commission_rate: rate.decimal,
      commission_rate_percent: rate.percent,
      total_referrals: Number(row.total_referrals ?? jsonPayload.total_referrals ?? 0),
      monthly_deals: Number(row.monthly_deals ?? jsonPayload.monthly_deals ?? 0),
      withdrawable_balance: Number(row.withdrawable_balance ?? jsonPayload.withdrawable_balance ?? 0),
      total_earnings: Number(row.total_earnings ?? jsonPayload.total_earnings ?? 0),
      is_active: row.is_active !== false,
      created_at: jsonPayload.created_at || row.created_at,
      updated_at: jsonPayload.updated_at || row.updated_at,
    };
  }

  if (table === 'app_documents') {
    return {
      ...jsonPayload,
      ...(row.doc_id ? { id: jsonPayload.id ?? String(row.doc_id) } : {}),
    };
  }

  return {
    ...jsonPayload,
    id: String(row.id ?? jsonPayload.id ?? ''),
    ...(row.created_at && !jsonPayload.created_at ? { created_at: row.created_at } : {}),
    ...(row.updated_at && !jsonPayload.updated_at ? { updated_at: row.updated_at } : {}),
  };
}

export function docDataToTypedRow(target: TableTarget, docId: string, docData: Record<string, any>): Record<string, any> {
  const nowIso = new Date().toISOString();
  const table = target.table;
  const cleanJson = { ...docData, id: docId };

  if (table === 'users') {
    const cleanTg = docData.telegram_id ? String(docData.telegram_id).trim() : null;
    const rawChatId = toNumOrNull(docData.chat_id ?? (cleanTg && /^-?\d+$/.test(cleanTg) ? cleanTg : null));
    const phoneStr = docData.phone_number ? String(docData.phone_number) : '';
    const core10 = docData.phone_core_digits
      ? extractPhoneCore10Digits(docData.phone_core_digits)
      : extractPhoneCore10Digits(phoneStr);
    const savedCards = Array.isArray(docData.saved_cards) ? docData.saved_cards : [];
    const role = ['user', 'admin', 'owner'].includes(String(docData.role)) ? String(docData.role) : 'user';
    const kyc = ['pending', 'unverified', 'verified', 'rejected', 'needs_correction'].includes(String(docData.kyc_status))
      ? String(docData.kyc_status)
      : 'pending';
    const walletBal = Math.max(0, Math.round(Number(docData.wallet_balance || 0)));
    const lockedBal = Math.min(walletBal, Math.max(0, Math.round(Number(docData.escrow_locked_balance || 0))));
    return {
      id: docId,
      telegram_id: cleanTg || null,
      chat_id: rawChatId !== null ? Math.trunc(rawChatId) : null,
      phone_number: phoneStr,
      phone_core_digits: core10 || null,
      full_name: String(docData.full_name || 'کاربر میانجی').slice(0, 100),
      username: docData.username ? String(docData.username) : null,
      avatar_url: docData.avatar_url ? String(docData.avatar_url) : null,
      role,
      kyc_status: kyc,
      kyc_level: String(docData.kyc_level || (kyc === 'verified' ? 'verified' : 'basic')),
      is_verified: Boolean(docData.is_verified ?? kyc === 'verified'),
      national_id: docData.national_id ? String(docData.national_id) : null,
      sheba: docData.sheba ? String(docData.sheba) : null,
      sheba_owner_name: docData.sheba_owner_name ? String(docData.sheba_owner_name) : null,
      sheba_verified: Boolean(docData.sheba_verified),
      sheba_locked_to_national_id: Boolean(docData.sheba_locked_to_national_id),
      wallet_balance: walletBal,
      escrow_locked_balance: lockedBal,
      saved_cards: savedCards,
      has_financial_pin: Boolean(docData.has_financial_pin ?? docData.financial_pin_hash),
      financial_pin_hash: docData.financial_pin_hash ? String(docData.financial_pin_hash) : null,
      pin_failed_attempts: Math.max(0, Math.trunc(Number(docData.pin_failed_attempts || 0))),
      pin_locked_until: toIsoOrNull(docData.pin_locked_until),
      security_score: Math.trunc(Number(docData.security_score || 0)),
      referral_code: docData.referral_code ? String(docData.referral_code) : null,
      invited_by: docData.invited_by ? String(docData.invited_by) : null,
      is_blocked: Boolean(docData.is_blocked),
      data: {
        ...cleanJson,
        phone_core_digits: core10 || undefined,
        wallet_balance: walletBal,
        escrow_locked_balance: lockedBal,
      },
      updated_at: nowIso,
    };
  }

  if (table === 'otp_codes') {
    return {
      id: docId,
      phone: docData.phone ? String(docData.phone) : docId,
      code: docData.code !== undefined && docData.code !== null ? String(docData.code) : null,
      code_hash: docData.code_hash ? String(docData.code_hash) : null,
      expires: Math.trunc(Number(docData.expires || 0)),
      attempts: Math.max(0, Math.trunc(Number(docData.attempts || 0))),
      purpose: String(docData.purpose || 'login'),
      telegram_id: docData.telegram_id ? String(docData.telegram_id) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'bot_login_tokens') {
    const usedFlag = Boolean(docData.used);
    return {
      id: docId,
      token: String(docData.token || docId),
      telegram_id: docData.telegram_id ? String(docData.telegram_id) : null,
      phone_number: docData.phone_number ? String(docData.phone_number) : null,
      full_name: docData.full_name ? String(docData.full_name) : null,
      username: docData.username ? String(docData.username) : null,
      expires_at: toNumOrNull(docData.expires_at ?? docData.expires),
      used: usedFlag,
      data: {
        ...cleanJson,
        id: docId,
        token: String(docData.token || docId),
        used: usedFlag,
      },
      updated_at: nowIso,
    };
  }

  if (table === 'deals') {
    const cid = String(docData.contract_id || docData.id || docId);
    const rawLocked = Number(docData.locked_amount ?? docData.escrow_locked_amount ?? 0);
    const depositStatus = ['unpaid', 'paid_locked', 'released', 'refunded'].includes(String(docData.escrow_deposit_status))
      ? String(docData.escrow_deposit_status)
      : 'unpaid';
    const commPayer = ['freelancer', 'employer', 'shared', 'split_50_50'].includes(String(docData.commission_payer))
      ? String(docData.commission_payer)
      : 'freelancer';
    return {
      id: docId,
      contract_id: cid,
      invite_token: docData.invite_token ? String(docData.invite_token) : null,
      title: String(docData.title || 'قرارداد میانجی').slice(0, 250),
      category: docData.category ? String(docData.category) : null,
      description: docData.description ? String(docData.description) : null,
      status: String(docData.status || 'draft'),
      escrow_deposit_status: depositStatus,
      commission_payer: commPayer,
      creator_id: docData.creator_id !== undefined && docData.creator_id !== null ? String(docData.creator_id) : null,
      creator_role: docData.creator_role ? String(docData.creator_role) : null,
      buyer_id: docData.buyer_id !== undefined && docData.buyer_id !== null ? String(docData.buyer_id) : null,
      seller_id: docData.seller_id !== undefined && docData.seller_id !== null ? String(docData.seller_id) : null,
      amount: Math.max(0, Math.round(Number(docData.amount || 0))),
      locked_amount: Math.max(0, Math.round(rawLocked)),
      held_extra_amount: Math.max(0, Math.round(Number(docData.held_extra_amount || 0))),
      deadline: toNumOrNull(docData.deadline) !== null ? Math.trunc(Number(docData.deadline)) : null,
      staged_payment: Boolean(docData.staged_payment ?? docData.is_milestone),
      milestones: Array.isArray(docData.milestones) ? docData.milestones : [],
      buyer_signed_at: toIsoOrNull(docData.buyer_signed_at),
      seller_signed_at: toIsoOrNull(docData.seller_signed_at),
      paid_at: toIsoOrNull(docData.paid_at),
      delivery_deadline: toIsoOrNull(docData.delivery_deadline ?? docData.delivery_due_at),
      completed_at: toIsoOrNull(docData.completed_at),
      data: { ...cleanJson, id: String(docData.id || docId), contract_id: cid },
      updated_at: nowIso,
    };
  }

  if (table === 'contract_signatures') {
    return {
      id: docId,
      contract_id: String(docData.contract_id || ''),
      user_id: String(docData.user_id || ''),
      telegram_id: docData.telegram_id ? String(docData.telegram_id) : null,
      telegram_username: docData.telegram_username ? String(docData.telegram_username) : null,
      full_name: docData.full_name ? String(docData.full_name) : null,
      national_id: docData.national_id ? String(docData.national_id) : null,
      phone_number: docData.phone_number ? String(docData.phone_number) : null,
      role: docData.role ? String(docData.role) : null,
      signed_at: toIsoOrNull(docData.signed_at) || nowIso,
      otp_verified: Boolean(docData.otp_verified),
      client_ip: docData.client_ip ? String(docData.client_ip) : null,
      verification_method: docData.verification_method ? String(docData.verification_method) : null,
      signature_hash: docData.signature_hash ? String(docData.signature_hash) : null,
      status: String(docData.status || 'signed'),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'transactions') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      type: String(docData.type || 'deposit'),
      amount: Math.round(Number(docData.amount || 0)),
      title: docData.title ? String(docData.title) : null,
      description: docData.description ? String(docData.description) : '',
      status: String(docData.status || 'completed'),
      ref_id: docData.ref_id ? String(docData.ref_id) : null,
      contract_id: docData.contract_id ? String(docData.contract_id) : null,
      sheba: docData.sheba ? String(docData.sheba) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'wallet_requests') {
    const allowedStatus = ['pending', 'paid', 'approved', 'rejected', 'cancelled'];
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      type: docData.type === 'deposit' ? 'deposit' : 'withdraw',
      amount: Math.max(0, Math.round(Number(docData.amount || 0))),
      sheba: docData.sheba ? String(docData.sheba) : docData.payout_kind === 'sheba' && docData.ref_code ? String(docData.ref_code) : null,
      holder_name: docData.holder_name ? String(docData.holder_name) : null,
      source: String(docData.source || 'web'),
      status: allowedStatus.includes(String(docData.status)) ? String(docData.status) : 'pending',
      ref_code: docData.ref_code ? String(docData.ref_code) : null,
      suspicious_flag: Boolean(docData.suspicious_flag),
      admin_id: docData.admin_id ? String(docData.admin_id) : docData.decided_by ? String(docData.decided_by) : null,
      document_note: docData.document_note ? String(docData.document_note) : null,
      documents: Array.isArray(docData.documents) ? docData.documents : [],
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'pending_receipts') {
    const allowedTypes = ['wallet', 'contract', 'milestone', 'extra_edit'];
    const allowedStatus = ['pending', 'approved', 'rejected'];
    return {
      id: docId,
      type: allowedTypes.includes(String(docData.type)) ? String(docData.type) : 'wallet',
      related_id: String(docData.related_id || docData.contract_id || docData.user_id || ''),
      user_id: String(docData.user_id || ''),
      file_id: docData.file_id ? String(docData.file_id) : docData.slip_image_url ? String(docData.slip_image_url) : null,
      amount: Math.max(0, Math.round(Number(docData.amount || 0))),
      description: docData.description ? String(docData.description) : null,
      status: allowedStatus.includes(String(docData.status)) ? String(docData.status) : 'pending',
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'disputes') {
    const hasResolution = Boolean(docData.resolution || docData.ruling || docData.status === 'resolved');
    const evidenceArr = Array.isArray(docData.evidence_files)
      ? docData.evidence_files
      : Array.isArray(docData.evidence)
      ? docData.evidence
      : [];
    return {
      id: docId,
      contract_id: String(docData.contract_id || docId),
      contract_title: docData.contract_title ? String(docData.contract_title) : null,
      claimant_id: docData.claimant_id ? String(docData.claimant_id) : null,
      claimant_name: docData.claimant_name ? String(docData.claimant_name) : null,
      reason: docData.reason ? String(docData.reason) : null,
      description: docData.description ? String(docData.description) : null,
      evidence_files: evidenceArr,
      status: hasResolution ? 'resolved' : 'under_review',
      messages: Array.isArray(docData.messages) ? docData.messages : [],
      ruling: docData.ruling ?? docData.resolution ?? null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'ambassadors') {
    const rate = normalizeAmbassadorCommissionRate(docData.commission_rate);
    return {
      id: docId,
      telegram_id: docData.telegram_id ? String(docData.telegram_id) : null,
      tier_level: String(docData.tier_level || 'bronze'),
      commission_rate: rate.decimal,
      total_referrals: Math.trunc(Number(docData.total_referrals || 0)),
      monthly_deals: Math.trunc(Number(docData.monthly_deals || 0)),
      withdrawable_balance: Math.max(0, Math.round(Number(docData.withdrawable_balance || 0))),
      total_earnings: Math.max(0, Math.round(Number(docData.total_earnings || 0))),
      is_active: docData.is_active !== false,
      data: {
        ...cleanJson,
        commission_rate: rate.decimal,
        commission_rate_percent: rate.percent,
      },
      updated_at: nowIso,
    };
  }

  if (table === 'commission_logs') {
    return {
      id: docId,
      ambassador_id: String(docData.ambassador_id || ''),
      contract_id: String(docData.contract_id || ''),
      deal_amount: Math.round(Number(docData.deal_amount || 0)),
      commission_amount: Math.round(Number(docData.commission_amount || 0)),
      share_amount: Math.round(Number(docData.share_amount || 0)),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'bot_settings') {
    return {
      id: docId,
      key: String(docData.key || docId),
      value: docData.value !== undefined && docData.value !== null ? String(docData.value) : null,
      updated_by: docData.updated_by ? String(docData.updated_by) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'security_audit_logs') {
    return {
      id: docId,
      user_id: docData.user_id ? String(docData.user_id) : null,
      phone_number: docData.phone_number ? String(docData.phone_number) : null,
      event: String(docData.event || 'security_event'),
      category: String(docData.category || 'auth'),
      status: String(docData.status || 'info'),
      details: docData.details ? String(docData.details) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'admin_logs') {
    return {
      id: docId,
      admin_id: String(docData.admin_id || docData.actor_id || 'system'),
      action: String(docData.action || ''),
      detail: docData.detail ? String(docData.detail) : docData.summary ? String(docData.summary) : null,
      target_id: docData.target_id ? String(docData.target_id) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'user_sessions') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      device_label: docData.device_label ? String(docData.device_label) : null,
      platform: docData.platform ? String(docData.platform) : null,
      ip_masked: docData.ip_masked ? String(docData.ip_masked) : null,
      issued_at: toNumOrNull(docData.issued_at),
      last_seen_at: toNumOrNull(docData.last_seen_at),
      revoked_at: toNumOrNull(docData.revoked_at),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'user_contacts') {
    const phone = docData.phone_number ? String(docData.phone_number) : '';
    return {
      id: docId,
      owner_id: String(docData.owner_id || target.implicitOwnerId || ''),
      contact_user_id: docData.contact_user_id ? String(docData.contact_user_id) : docData.user_id ? String(docData.user_id) : null,
      name: docData.name ? String(docData.name) : null,
      phone_number: phone || null,
      phone_core_digits: extractPhoneCore10Digits(phone) || null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'contact_invites') {
    const phone = docData.phone_number ? String(docData.phone_number) : '';
    return {
      id: docId,
      inviter_id: String(docData.inviter_id || docData.user_id || ''),
      phone_number: phone || null,
      phone_core_digits: extractPhoneCore10Digits(phone) || null,
      status: String(docData.status || 'sent'),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'deal_drafts') {
    return {
      id: docId,
      owner_id: String(docData.owner_id || target.implicitOwnerId || ''),
      title: docData.title ? String(docData.title) : null,
      role: docData.role ? String(docData.role) : null,
      step: Math.max(1, Math.trunc(Number(docData.step || 1))),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'deal_reviews') {
    return {
      id: docId,
      contract_id: String(docData.contract_id || ''),
      reviewer_id: String(docData.reviewer_id || ''),
      target_user_id: String(docData.target_user_id || ''),
      rating: Math.max(1, Math.min(5, Math.trunc(Number(docData.rating || 5)))),
      comment: docData.comment ? String(docData.comment) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'direct_chats') {
    return {
      id: docId,
      participants: Array.isArray(docData.participants) ? docData.participants : [],
      is_support: Boolean(docData.is_support),
      last_msg: docData.last_msg ? String(docData.last_msg) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'direct_messages') {
    return {
      id: docId,
      chat_id: String(docData.chat_id || docData.room_id || ''),
      sender_id: String(docData.sender_id || ''),
      message_text: docData.message_text ? String(docData.message_text) : docData.text ? String(docData.text) : null,
      message_type: String(docData.message_type || docData.type || 'text'),
      attachment_url: docData.attachment_url ? String(docData.attachment_url) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'contract_messages') {
    return {
      id: docId,
      contract_id: String(docData.contract_id || ''),
      sender_id: String(docData.sender_id || ''),
      message_text: docData.message_text ? String(docData.message_text) : docData.text ? String(docData.text) : null,
      message_type: String(docData.message_type || docData.type || 'text'),
      attachment_url: docData.attachment_url ? String(docData.attachment_url) : null,
      is_system: Boolean(docData.is_system),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'chat_pins') {
    return {
      id: docId,
      scope: String(docData.scope || ''),
      chat_id: String(docData.chat_id || ''),
      message_id: docData.message_id ? String(docData.message_id) : null,
      pinned_by: docData.pinned_by ? String(docData.pinned_by) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'channels') {
    return {
      id: docId,
      slug: docData.slug ? String(docData.slug) : null,
      title: String(docData.title || 'کانال میانجی'),
      owner_id: docData.owner_id ? String(docData.owner_id) : null,
      is_public: docData.is_public !== false,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'channel_posts') {
    return {
      id: docId,
      channel_id: String(docData.channel_id || ''),
      author_id: docData.author_id ? String(docData.author_id) : null,
      title: docData.title ? String(docData.title) : null,
      body: docData.body ? String(docData.body) : docData.text ? String(docData.text) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'channel_subscribers') {
    return {
      id: docId,
      channel_id: String(docData.channel_id || ''),
      user_id: String(docData.user_id || ''),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'notifications') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      kind: String(docData.kind || 'system'),
      title: docData.title ? String(docData.title) : null,
      body: docData.body ? String(docData.body) : null,
      is_read: Boolean(docData.is_read),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'notification_prefs') {
    return {
      id: docId,
      user_id: String(docData.user_id || docId),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'push_subscriptions') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      endpoint: docData.endpoint ? String(docData.endpoint) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'support_tickets') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      subject: docData.subject ? String(docData.subject) : null,
      message: docData.message ? String(docData.message) : null,
      status: String(docData.status || 'pending'),
      reply: docData.reply ? String(docData.reply) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'payment_sessions') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      provider: String(docData.provider || 'zibal'),
      amount: Math.max(0, Math.round(Number(docData.amount || 0))),
      status: String(docData.status || 'pending'),
      ref_id: docData.ref_id ? String(docData.ref_id) : null,
      track_id: docData.track_id ? String(docData.track_id) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'media_assets') {
    return {
      id: docId,
      owner_id: docData.owner_id ? String(docData.owner_id) : null,
      mime_type: docData.mime_type ? String(docData.mime_type) : null,
      size_bytes: Math.max(0, Math.trunc(Number(docData.size_bytes || 0))),
      chunk_count: Math.max(0, Math.trunc(Number(docData.chunk_count || 0))),
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'media_chunks') {
    return {
      id: docId,
      media_id: String(docData.media_id || ''),
      chunk_index: Math.max(0, Math.trunc(Number(docData.chunk_index || 0))),
      content: docData.content ? String(docData.content) : null,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  if (table === 'system_settings') {
    return {
      id: docId,
      data: cleanJson,
      updated_at: nowIso,
    };
  }

  return {
    collection_path: target.logicalCollection,
    doc_id: docId,
    data: docData,
    updated_at: nowIso,
  };
}

export async function adjustWalletAtomicRpc(
  client: SupabaseClient,
  userId: string,
  walletDelta: number,
  lockedDelta: number,
  requireFreeCheck = true,
  txMeta?: {
    txId?: string | null;
    txType?: string;
    title?: string;
    contractId?: string | null;
  }
): Promise<{
  ok: boolean;
  user_id?: string;
  wallet_balance?: number;
  escrow_locked_balance?: number;
  free_balance?: number;
  error?: string;
}> {
  const rpcArgs: Record<string, any> = {
    p_user_id: String(userId),
    p_wallet_delta: Math.round(Number(walletDelta || 0)),
    p_locked_delta: Math.round(Number(lockedDelta || 0)),
    p_require_free_check: Boolean(requireFreeCheck),
  };
  if (txMeta?.txId) {
    rpcArgs.p_tx_id = String(txMeta.txId);
    rpcArgs.p_tx_type = String(txMeta.txType || 'general');
    rpcArgs.p_title = String(txMeta.title || '');
    rpcArgs.p_contract_id = txMeta.contractId ? String(txMeta.contractId) : null;
  }
  const { data, error } = await client.rpc('miyanji_adjust_wallet_atomic', rpcArgs);
  if (error) {
    return { ok: false, error: error.message };
  }
  const result = typeof data === 'object' && data !== null ? data : { ok: false, error: 'INVALID_RPC_RESULT' };
  return {
    ok: Boolean(result.ok),
    user_id: result.user_id ? String(result.user_id) : undefined,
    wallet_balance: result.wallet_balance !== undefined ? Number(result.wallet_balance) : undefined,
    escrow_locked_balance: result.escrow_locked_balance !== undefined ? Number(result.escrow_locked_balance) : undefined,
    free_balance: result.free_balance !== undefined ? Number(result.free_balance) : undefined,
    error: result.error ? String(result.error) : undefined,
  };
}

export interface SupabaseDocSnapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, any> | undefined;
}

export interface SupabaseQuerySnapshot {
  empty: boolean;
  size: number;
  docs: SupabaseDocSnapshot[];
}

type WhereClause = { field: string; op: string; value: any };
type OrderClause = { field: string; dir: 'asc' | 'desc' };

export class SupabaseDocRef {
  constructor(
    private readonly client: SupabaseClient,
    public readonly collectionPath: string,
    public readonly id: string
  ) {}

  collection(subCollection: string): SupabaseCollectionRef {
    return new SupabaseCollectionRef(this.client, `${this.collectionPath}/${this.id}/${subCollection}`);
  }

  async get(): Promise<SupabaseDocSnapshot> {
    const target = resolveTableTarget(this.collectionPath);
    if (target.table !== 'app_documents') {
      let q = this.client.from(target.table).select('*').eq('id', this.id);
      if (target.implicitOwnerId) {
        q = q.eq('owner_id', target.implicitOwnerId);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`Supabase read ${target.table}/${this.id}: ${error.message}`);
      if (!data) return { id: this.id, exists: false, data: () => undefined };
      const mapped = rowToDocData(target, data) || undefined;
      return { id: this.id, exists: Boolean(mapped), data: () => mapped };
    }

    const { data, error } = await this.client
      .from('app_documents')
      .select('doc_id, data')
      .eq('collection_path', target.logicalCollection)
      .eq('doc_id', this.id)
      .maybeSingle();
    if (error) throw new Error(`Supabase read ${this.collectionPath}/${this.id}: ${error.message}`);
    if (!data) return { id: this.id, exists: false, data: () => undefined };
    const mapped = rowToDocData(target, data) || undefined;
    return { id: this.id, exists: Boolean(mapped), data: () => mapped };
  }

  async set(payload: Record<string, any>, options?: { merge?: boolean }): Promise<void> {
    const merge = Boolean(options?.merge);
    let existingData: Record<string, any> | null = null;
    const needsExistingRead =
      merge ||
      Object.values(payload || {}).some((v) => {
        const s = isSentinel(v);
        return s && (s[SENTINEL_BRAND] === 'increment' || s[SENTINEL_BRAND] === 'arrayUnion' || s[SENTINEL_BRAND] === 'arrayRemove');
      });

    if (needsExistingRead) {
      const snap = await this.get();
      if (snap.exists) {
        existingData = snap.data() || null;
      }
    }

    const finalDoc = resolvePayloadWithExisting(payload, existingData, merge);
    await this.writeRaw(finalDoc);
  }

  async writeRaw(finalDoc: Record<string, any>): Promise<void> {
    const target = resolveTableTarget(this.collectionPath);
    const row = docDataToTypedRow(target, this.id, finalDoc);
    if (target.table !== 'app_documents') {
      const { error } = await this.client.from(target.table).upsert(row, { onConflict: 'id' });
      if (error) throw new Error(`Supabase write ${target.table}/${this.id}: ${error.message}`);
      return;
    }

    const { error } = await this.client
      .from('app_documents')
      .upsert(row, { onConflict: 'collection_path,doc_id' });
    if (error) throw new Error(`Supabase write ${this.collectionPath}/${this.id}: ${error.message}`);
  }

  async update(payload: Record<string, any>): Promise<void> {
    await this.set(payload, { merge: true });
  }

  async delete(): Promise<void> {
    const target = resolveTableTarget(this.collectionPath);
    if (target.table !== 'app_documents') {
      let q = this.client.from(target.table).delete().eq('id', this.id);
      if (target.implicitOwnerId) {
        q = q.eq('owner_id', target.implicitOwnerId);
      }
      const { error } = await q;
      if (error) throw new Error(`Supabase delete ${target.table}/${this.id}: ${error.message}`);
      return;
    }
    const { error } = await this.client
      .from('app_documents')
      .delete()
      .eq('collection_path', target.logicalCollection)
      .eq('doc_id', this.id);
    if (error) throw new Error(`Supabase delete ${this.collectionPath}/${this.id}: ${error.message}`);
  }
}

export class SupabaseQueryRef {
  constructor(
    protected readonly client: SupabaseClient,
    public readonly collectionPath: string,
    protected readonly wheres: WhereClause[] = [],
    protected readonly orders: OrderClause[] = [],
    protected readonly limitVal?: number
  ) {}

  where(field: string, op: string, value: any): SupabaseQueryRef {
    return new SupabaseQueryRef(this.client, this.collectionPath, [...this.wheres, { field, op, value }], this.orders, this.limitVal);
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): SupabaseQueryRef {
    return new SupabaseQueryRef(this.client, this.collectionPath, this.wheres, [...this.orders, { field, dir }], this.limitVal);
  }

  limit(n: number): SupabaseQueryRef {
    return new SupabaseQueryRef(this.client, this.collectionPath, this.wheres, this.orders, n);
  }

  async get(): Promise<SupabaseQuerySnapshot> {
    const target = resolveTableTarget(this.collectionPath);
    let docsList: SupabaseDocSnapshot[] = [];

    if (target.table !== 'app_documents') {
      let query = this.client.from(target.table).select('*');
      if (target.implicitOwnerId) {
        query = query.eq('owner_id', target.implicitOwnerId);
      }
      const pushedIndexes = new Set<number>();
      const allowedCols = TYPED_COLUMNS_BY_TABLE[target.table] || new Set<string>();
      this.wheres.forEach((w, idx) => {
        if (w.op === '==' && allowedCols.has(w.field) && w.value !== undefined && w.value !== null) {
          query = query.eq(w.field, typeof w.value === 'boolean' || typeof w.value === 'number' ? w.value : String(w.value));
          pushedIndexes.add(idx);
        }
      });

      const { data, error } = await query;
      if (error) throw new Error(`Supabase query ${target.table}: ${error.message}`);
      docsList = (data || [])
        .map((row: any) => {
          const docData = rowToDocData(target, row);
          return docData ? { id: String(row.id), exists: true, data: () => docData } : null;
        })
        .filter(Boolean) as SupabaseDocSnapshot[];

      const remainingWheres = this.wheres.filter((_, idx) => !pushedIndexes.has(idx));
      if (remainingWheres.length > 0) {
        docsList = docsList.filter((d) => matchesWheres(d.data() || {}, remainingWheres));
      }
    } else {
      const { data, error } = await this.client
        .from('app_documents')
        .select('doc_id, data')
        .eq('collection_path', target.logicalCollection);
      if (error) throw new Error(`Supabase query ${this.collectionPath}: ${error.message}`);
      docsList = (data || [])
        .map((row: any) => {
          const docData = rowToDocData(target, row);
          return docData ? { id: String(row.doc_id), exists: true, data: () => docData } : null;
        })
        .filter(Boolean) as SupabaseDocSnapshot[];

      if (this.wheres.length > 0) {
        docsList = docsList.filter((d) => matchesWheres(d.data() || {}, this.wheres));
      }
    }

    if (this.orders.length > 0) {
      docsList.sort((a, b) => {
        const da = a.data() || {};
        const db = b.data() || {};
        for (const o of this.orders) {
          const va = extractComparableValue(da[o.field]);
          const vb = extractComparableValue(db[o.field]);
          if (va === vb) continue;
          if (va === undefined || va === null) return o.dir === 'desc' ? 1 : -1;
          if (vb === undefined || vb === null) return o.dir === 'desc' ? -1 : 1;
          const cmp = va < vb ? -1 : 1;
          return o.dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }

    if (typeof this.limitVal === 'number' && this.limitVal >= 0) {
      docsList = docsList.slice(0, this.limitVal);
    }

    return {
      empty: docsList.length === 0,
      size: docsList.length,
      docs: docsList,
    };
  }
}

function matchesWheres(data: Record<string, any>, wheres: WhereClause[]): boolean {
  for (const w of wheres) {
    const actual = data[w.field];
    if (w.op === '==') {
      if (actual !== w.value) return false;
    } else if (w.op === 'array-contains') {
      if (!Array.isArray(actual) || !actual.includes(w.value)) return false;
    } else if (w.op === '!=') {
      if (actual === w.value) return false;
    } else if (w.op === 'in') {
      if (!Array.isArray(w.value) || !w.value.includes(actual)) return false;
    }
  }
  return true;
}

export class SupabaseCollectionRef extends SupabaseQueryRef {
  constructor(client: SupabaseClient, collectionPath: string) {
    super(client, collectionPath, [], [], undefined);
  }

  doc(id?: string): SupabaseDocRef {
    const resolvedId =
      id && String(id).trim()
        ? String(id).trim()
        : `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new SupabaseDocRef(this.client, this.collectionPath, resolvedId);
  }

  async add(payload: Record<string, any>): Promise<SupabaseDocRef> {
    const ref = this.doc();
    await ref.set(payload, { merge: false });
    return ref;
  }
}

export class SupabaseTransaction {
  private readonly reads = new Map<string, { ref: SupabaseDocRef; snapshot: SupabaseDocSnapshot }>();
  private readonly writes: Array<
    | { kind: 'set'; ref: SupabaseDocRef; payload: Record<string, any>; merge: boolean }
    | { kind: 'delete'; ref: SupabaseDocRef }
  > = [];

  private keyOf(ref: SupabaseDocRef) {
    return `${ref.collectionPath}::${ref.id}`;
  }

  async get(ref: SupabaseDocRef): Promise<SupabaseDocSnapshot> {
    const key = this.keyOf(ref);
    const cached = this.reads.get(key);
    if (cached) return cached.snapshot;
    const snapshot = await ref.get();
    this.reads.set(key, { ref, snapshot });
    return snapshot;
  }

  set(ref: SupabaseDocRef, payload: Record<string, any>, options?: { merge?: boolean }) {
    this.writes.push({
      kind: 'set',
      ref,
      payload,
      merge: Boolean(options?.merge),
    });
    return this;
  }

  update(ref: SupabaseDocRef, payload: Record<string, any>) {
    return this.set(ref, payload, { merge: true });
  }

  delete(ref: SupabaseDocRef) {
    this.writes.push({ kind: 'delete', ref });
    return this;
  }

  async commit(): Promise<void> {
    const rollbacks: Array<{ ref: SupabaseDocRef; existed: boolean; prevData: Record<string, any> | null }> = [];
    const stagedWrites: Array<{ kind: 'set' | 'delete'; ref: SupabaseDocRef; finalDoc?: Record<string, any> }> = [];

    const workingState = new Map<string, Record<string, any> | null>();
    for (const [k, entry] of this.reads.entries()) {
      workingState.set(k, entry.snapshot.exists ? { ...(entry.snapshot.data() || {}) } : null);
    }

    for (const w of this.writes) {
      const key = this.keyOf(w.ref);
      let curDoc = workingState.get(key);
      if (curDoc === undefined) {
        const snap = await w.ref.get();
        curDoc = snap.exists ? { ...(snap.data() || {}) } : null;
        this.reads.set(key, { ref: w.ref, snapshot: snap });
        workingState.set(key, curDoc);
      }

      if (!rollbacks.some((r) => this.keyOf(r.ref) === key)) {
        rollbacks.push({
          ref: w.ref,
          existed: Boolean(curDoc),
          prevData: curDoc ? { ...curDoc } : null,
        });
      }

      if (w.kind === 'delete') {
        workingState.set(key, null);
        stagedWrites.push({ kind: 'delete', ref: w.ref });
      } else {
        const resolved = resolvePayloadWithExisting(w.payload, curDoc, w.merge);
        workingState.set(key, resolved);
        stagedWrites.push({ kind: 'set', ref: w.ref, finalDoc: resolved });
      }
    }

    for (const [, entry] of this.reads.entries()) {
      const latest = await entry.ref.get();
      if (latest.exists !== entry.snapshot.exists) {
        throw new Error('CONCURRENT_MODIFICATION');
      }
      if (latest.exists && entry.snapshot.exists) {
        const prevUpdated = entry.snapshot.data()?.updated_at || entry.snapshot.data()?.updatedAt;
        const latestUpdated = latest.data()?.updated_at || latest.data()?.updatedAt;
        if (prevUpdated && latestUpdated && prevUpdated !== latestUpdated) {
          throw new Error('CONCURRENT_MODIFICATION');
        }
      }
    }

    try {
      for (const sw of stagedWrites) {
        if (sw.kind === 'delete') {
          await sw.ref.delete();
        } else if (sw.finalDoc) {
          await sw.ref.writeRaw(sw.finalDoc);
        }
      }
    } catch (err) {
      for (const rb of rollbacks.reverse()) {
        try {
          if (rb.existed && rb.prevData) {
            await rb.ref.writeRaw(rb.prevData);
          } else {
            await rb.ref.delete();
          }
        } catch {}
      }
      throw err;
    }
  }
}

export class SupabaseFirestoreAdapter {
  private readonly txQueue = new Map<string, Promise<any>>();

  constructor(private readonly client: SupabaseClient) {}

  get rawClient(): SupabaseClient {
    return this.client;
  }

  collection(name: string): SupabaseCollectionRef {
    return new SupabaseCollectionRef(this.client, name);
  }

  batch() {
    const ops: Array<
      | { kind: 'set'; ref: SupabaseDocRef; payload: Record<string, any>; merge: boolean }
      | { kind: 'update'; ref: SupabaseDocRef; payload: Record<string, any> }
      | { kind: 'delete'; ref: SupabaseDocRef }
    > = [];
    return {
      set(ref: SupabaseDocRef, payload: Record<string, any>, options?: { merge?: boolean }) {
        ops.push({ kind: 'set', ref, payload, merge: Boolean(options?.merge) });
      },
      update(ref: SupabaseDocRef, payload: Record<string, any>) {
        ops.push({ kind: 'update', ref, payload });
      },
      delete(ref: SupabaseDocRef) {
        ops.push({ kind: 'delete', ref });
      },
      commit: async () => {
        for (const op of ops) {
          if (op.kind === 'delete') {
            await op.ref.delete();
          } else if (op.kind === 'update') {
            await op.ref.update(op.payload);
          } else {
            await op.ref.set(op.payload, { merge: op.merge });
          }
        }
      },
    };
  }

  settings(_opts: any) {
    // No-op compatibility shim
  }

  async runTransaction<T>(fn: (tx: SupabaseTransaction) => Promise<T>): Promise<T> {
    const prev = this.txQueue.get('global') || Promise.resolve();
    const run = prev.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const tx = new SupabaseTransaction();
        const result = await fn(tx);
        try {
          await tx.commit();
          return result;
        } catch (err: any) {
          if (err?.message === 'CONCURRENT_MODIFICATION' && attempt === 0) {
            continue;
          }
          throw err;
        }
      }
      throw new Error('Transaction retry exhausted');
    });
    this.txQueue.set(
      'global',
      run.catch(() => {})
    );
    return run;
  }
}

export interface SupabaseInitResult {
  configured: boolean;
  ready: boolean;
  urlHost: string | null;
  client: SupabaseClient | null;
  adapter: SupabaseFirestoreAdapter | null;
  lastError: string | null;
  verifiedAt: string | null;
}

export async function initializeAndVerifySupabase(): Promise<SupabaseInitResult> {
  const url = (process.env.SUPABASE_URL || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url || !serviceKey) {
    return {
      configured: false,
      ready: false,
      urlHost: null,
      client: null,
      adapter: null,
      lastError: !url && !serviceKey
        ? 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not configured'
        : !url
        ? 'SUPABASE_URL missing'
        : 'SUPABASE_SERVICE_ROLE_KEY missing',
      verifiedAt: null,
    };
  }

  let urlHost: string | null = null;
  try {
    urlHost = new URL(url).host;
  } catch {
    return {
      configured: true,
      ready: false,
      urlHost: null,
      client: null,
      adapter: null,
      lastError: 'Invalid SUPABASE_URL format',
      verifiedAt: null,
    };
  }

  const client = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  try {
    const probePromise = client.from('users').select('id').limit(1);
    const { error } = (await Promise.race([
      probePromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Supabase connection timeout (10s)')), 10000)),
    ])) as { error: any };

    if (error) {
      const code = String(error.code || '');
      const msg = String(error.message || 'Unknown Supabase error');
      const hint =
        code === '42P01' || msg.includes('Could not find the table')
          ? `جدول‌های Supabase هنوز ساخته نشده‌اند. فایل supabase/schema.sql را در SQL Editor سوپابیس اجرا کنید. (${msg})`
          : msg;
      return {
        configured: true,
        ready: false,
        urlHost,
        client,
        adapter: null,
        lastError: hint,
        verifiedAt: null,
      };
    }

    const adapter = new SupabaseFirestoreAdapter(client);
    return {
      configured: true,
      ready: true,
      urlHost,
      client,
      adapter,
      lastError: null,
      verifiedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    return {
      configured: true,
      ready: false,
      urlHost,
      client,
      adapter: null,
      lastError: String(err?.message || err || 'Supabase probe failed'),
      verifiedAt: null,
    };
  }
}
