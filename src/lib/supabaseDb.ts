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

function isSentinel(val: any): SentinelValue | null {
  if (!val || typeof val !== 'object') return null;
  if (val[SENTINEL_BRAND]) return val as SentinelValue;
  // Also gracefully recognize firebase-admin FieldValue objects if passed directly
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

const TYPED_TABLES = new Set([
  'users',
  'deals',
  'wallet_requests',
  'transactions',
  'otp_codes',
  'bot_login_tokens',
]);

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

function rowToDocData(collectionPath: string, row: any): Record<string, any> | null {
  if (!row) return null;
  const jsonPayload = row.data && typeof row.data === 'object' ? { ...row.data } : {};

  if (collectionPath === 'users') {
    const out: Record<string, any> = {
      ...jsonPayload,
      id: String(row.id),
      phone_number: row.phone_number ?? jsonPayload.phone_number ?? '',
      full_name: row.full_name ?? jsonPayload.full_name ?? 'کاربر میانجی',
      role: row.role ?? jsonPayload.role ?? 'user',
      kyc_status: row.kyc_status ?? jsonPayload.kyc_status ?? 'pending',
      wallet_balance: Number(row.wallet_balance ?? jsonPayload.wallet_balance ?? 0),
      escrow_locked_balance: Number(row.escrow_locked_balance ?? jsonPayload.escrow_locked_balance ?? 0),
      saved_cards: Array.isArray(row.saved_cards) ? row.saved_cards : Array.isArray(jsonPayload.saved_cards) ? jsonPayload.saved_cards : [],
      is_blocked: Boolean(row.is_blocked ?? jsonPayload.is_blocked ?? false),
    };
    if (row.telegram_id) out.telegram_id = String(row.telegram_id);
    if (row.username !== undefined && row.username !== null) out.username = row.username;
    if (row.avatar_url !== undefined && row.avatar_url !== null) out.avatar_url = row.avatar_url;
    if (row.national_id !== undefined && row.national_id !== null) out.national_id = row.national_id;
    if (row.created_at && !out.createdAt) out.createdAt = row.created_at;
    if (row.updated_at && !out.updatedAt) out.updatedAt = row.updated_at;
    return out;
  }

  if (collectionPath === 'deals') {
    const out: Record<string, any> = {
      ...jsonPayload,
      id: String(row.id),
      contract_id: String(row.contract_id || jsonPayload.contract_id || row.id),
      title: row.title ?? jsonPayload.title ?? '',
      amount: Number(row.amount ?? jsonPayload.amount ?? 0),
      status: row.status ?? jsonPayload.status ?? 'draft',
      escrow_deposit_status: row.escrow_deposit_status ?? jsonPayload.escrow_deposit_status ?? 'unpaid',
    };
    if (row.buyer_id !== undefined && row.buyer_id !== null) out.buyer_id = row.buyer_id;
    if (row.seller_id !== undefined && row.seller_id !== null) out.seller_id = row.seller_id;
    if (row.creator_id !== undefined && row.creator_id !== null) out.creator_id = row.creator_id;
    if (row.created_at && !out.created_at) out.created_at = row.created_at;
    if (row.updated_at && !out.updated_at) out.updated_at = row.updated_at;
    return out;
  }

  if (collectionPath === 'wallet_requests') {
    return {
      ...jsonPayload,
      id: String(row.id),
      user_id: String(row.user_id ?? jsonPayload.user_id ?? ''),
      type: row.type ?? jsonPayload.type ?? 'deposit',
      amount: Number(row.amount ?? jsonPayload.amount ?? 0),
      status: row.status ?? jsonPayload.status ?? 'pending',
      ...(row.ref_code !== undefined && row.ref_code !== null ? { ref_code: row.ref_code } : {}),
      created_at: jsonPayload.created_at || row.created_at,
      updated_at: jsonPayload.updated_at || row.updated_at,
    };
  }

  if (collectionPath === 'transactions') {
    return {
      ...jsonPayload,
      id: String(row.id),
      user_id: String(row.user_id ?? jsonPayload.user_id ?? ''),
      contract_id: row.contract_id ?? jsonPayload.contract_id ?? '',
      amount: Number(row.amount ?? jsonPayload.amount ?? 0),
      type: row.type ?? jsonPayload.type ?? 'deposit',
      status: row.status ?? jsonPayload.status ?? 'completed',
      description: row.description ?? jsonPayload.description ?? '',
      createdAt: jsonPayload.createdAt || row.created_at,
    };
  }

  if (collectionPath === 'otp_codes') {
    return {
      ...jsonPayload,
      id: String(row.id),
      ...(row.phone !== undefined && row.phone !== null ? { phone: row.phone } : {}),
      ...(row.code !== undefined && row.code !== null ? { code: row.code } : {}),
      ...(row.code_hash !== undefined && row.code_hash !== null ? { code_hash: row.code_hash } : {}),
      expires: Number(row.expires ?? jsonPayload.expires ?? 0),
      attempts: Number(row.attempts ?? jsonPayload.attempts ?? 0),
    };
  }

  if (collectionPath === 'bot_login_tokens') {
    return {
      ...jsonPayload,
      id: String(row.id),
      token: row.token ?? jsonPayload.token ?? row.id,
      ...(row.telegram_id ? { telegram_id: row.telegram_id } : {}),
      ...(row.phone_number ? { phone_number: row.phone_number } : {}),
      ...(row.full_name ? { full_name: row.full_name } : {}),
      ...(row.username ? { username: row.username } : {}),
      ...(row.expires_at !== undefined && row.expires_at !== null ? { expires_at: Number(row.expires_at) } : {}),
    };
  }

  return {
    ...jsonPayload,
    ...(row.doc_id ? { id: jsonPayload.id ?? String(row.doc_id) } : {}),
  };
}

function docDataToTypedRow(collectionPath: string, docId: string, docData: Record<string, any>): Record<string, any> {
  const nowIso = new Date().toISOString();
  if (collectionPath === 'users') {
    const cleanTg = docData.telegram_id ? String(docData.telegram_id).trim() : null;
    const savedCards = Array.isArray(docData.saved_cards) ? docData.saved_cards : [];
    const role = ['user', 'admin', 'owner'].includes(String(docData.role)) ? String(docData.role) : 'user';
    const kyc = ['pending', 'verified', 'rejected'].includes(String(docData.kyc_status))
      ? String(docData.kyc_status)
      : 'pending';
    return {
      id: docId,
      telegram_id: cleanTg || null,
      phone_number: docData.phone_number ? String(docData.phone_number) : '',
      full_name: String(docData.full_name || 'کاربر میانجی').slice(0, 100),
      username: docData.username ? String(docData.username) : null,
      avatar_url: docData.avatar_url ? String(docData.avatar_url) : null,
      role,
      kyc_status: kyc,
      wallet_balance: Math.max(0, Math.round(Number(docData.wallet_balance || 0))),
      escrow_locked_balance: Math.max(0, Math.round(Number(docData.escrow_locked_balance || 0))),
      saved_cards: savedCards,
      is_blocked: Boolean(docData.is_blocked),
      national_id: docData.national_id ? String(docData.national_id) : null,
      data: { ...docData, id: docId },
      updated_at: nowIso,
    };
  }

  if (collectionPath === 'deals') {
    return {
      id: docId,
      contract_id: String(docData.contract_id || docData.id || docId),
      title: String(docData.title || 'قرارداد میانجی').slice(0, 250),
      amount: Math.max(0, Math.round(Number(docData.amount || 0))),
      status: String(docData.status || 'draft'),
      buyer_id: docData.buyer_id !== undefined && docData.buyer_id !== null ? String(docData.buyer_id) : null,
      seller_id: docData.seller_id !== undefined && docData.seller_id !== null ? String(docData.seller_id) : null,
      creator_id: docData.creator_id !== undefined && docData.creator_id !== null ? String(docData.creator_id) : null,
      escrow_deposit_status: String(docData.escrow_deposit_status || 'unpaid'),
      data: { ...docData, id: String(docData.id || docId), contract_id: String(docData.contract_id || docId) },
      updated_at: nowIso,
    };
  }

  if (collectionPath === 'wallet_requests') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      type: docData.type === 'withdraw' ? 'withdraw' : 'deposit',
      amount: Math.max(1, Math.round(Number(docData.amount || 1))),
      status: ['pending', 'approved', 'rejected', 'cancelled'].includes(String(docData.status))
        ? String(docData.status)
        : 'pending',
      ref_code: docData.ref_code ? String(docData.ref_code) : null,
      data: { ...docData, id: docId },
      updated_at: nowIso,
    };
  }

  if (collectionPath === 'transactions') {
    return {
      id: docId,
      user_id: String(docData.user_id || ''),
      contract_id: docData.contract_id ? String(docData.contract_id) : null,
      amount: Math.round(Number(docData.amount || 0)),
      type: String(docData.type || 'deposit'),
      status: String(docData.status || 'completed'),
      description: docData.description ? String(docData.description) : '',
      data: { ...docData, id: docId },
      updated_at: nowIso,
    };
  }

  if (collectionPath === 'otp_codes') {
    return {
      id: docId,
      phone: docData.phone ? String(docData.phone) : null,
      code: docData.code !== undefined && docData.code !== null ? String(docData.code) : null,
      code_hash: docData.code_hash ? String(docData.code_hash) : null,
      expires: Number(docData.expires || 0),
      attempts: Number(docData.attempts || 0),
      data: { ...docData, id: docId },
      updated_at: nowIso,
    };
  }

  if (collectionPath === 'bot_login_tokens') {
    return {
      id: docId,
      token: String(docData.token || docId),
      telegram_id: docData.telegram_id ? String(docData.telegram_id) : null,
      phone_number: docData.phone_number ? String(docData.phone_number) : null,
      full_name: docData.full_name ? String(docData.full_name) : null,
      username: docData.username ? String(docData.username) : null,
      expires_at: docData.expires_at ? Number(docData.expires_at) : null,
      data: { ...docData, id: docId },
      updated_at: nowIso,
    };
  }

  return {
    collection_path: collectionPath,
    doc_id: docId,
    data: docData,
    updated_at: nowIso,
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
    if (TYPED_TABLES.has(this.collectionPath)) {
      const { data, error } = await this.client
        .from(this.collectionPath)
        .select('*')
        .eq('id', this.id)
        .maybeSingle();
      if (error) throw new Error(`Supabase read ${this.collectionPath}/${this.id}: ${error.message}`);
      if (!data) return { id: this.id, exists: false, data: () => undefined };
      const mapped = rowToDocData(this.collectionPath, data) || undefined;
      return { id: this.id, exists: Boolean(mapped), data: () => mapped };
    }

    const { data, error } = await this.client
      .from('app_documents')
      .select('doc_id, data')
      .eq('collection_path', this.collectionPath)
      .eq('doc_id', this.id)
      .maybeSingle();
    if (error) throw new Error(`Supabase read ${this.collectionPath}/${this.id}: ${error.message}`);
    if (!data) return { id: this.id, exists: false, data: () => undefined };
    const mapped = rowToDocData(this.collectionPath, data) || undefined;
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
    if (TYPED_TABLES.has(this.collectionPath)) {
      const row = docDataToTypedRow(this.collectionPath, this.id, finalDoc);
      const { error } = await this.client.from(this.collectionPath).upsert(row, { onConflict: 'id' });
      if (error) throw new Error(`Supabase write ${this.collectionPath}/${this.id}: ${error.message}`);
      return;
    }

    const row = docDataToTypedRow(this.collectionPath, this.id, finalDoc);
    const { error } = await this.client
      .from('app_documents')
      .upsert(row, { onConflict: 'collection_path,doc_id' });
    if (error) throw new Error(`Supabase write ${this.collectionPath}/${this.id}: ${error.message}`);
  }

  async update(payload: Record<string, any>): Promise<void> {
    await this.set(payload, { merge: true });
  }

  async delete(): Promise<void> {
    if (TYPED_TABLES.has(this.collectionPath)) {
      const { error } = await this.client.from(this.collectionPath).delete().eq('id', this.id);
      if (error) throw new Error(`Supabase delete ${this.collectionPath}/${this.id}: ${error.message}`);
      return;
    }
    const { error } = await this.client
      .from('app_documents')
      .delete()
      .eq('collection_path', this.collectionPath)
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
    let docsList: SupabaseDocSnapshot[] = [];

    if (TYPED_TABLES.has(this.collectionPath)) {
      let query = this.client.from(this.collectionPath).select('*');
      // Push exact indexed column filters down when available
      const pushedIndexes = new Set<number>();
      const typedColumnsByTable: Record<string, Set<string>> = {
        users: new Set(['id', 'telegram_id', 'phone_number', 'role', 'kyc_status', 'national_id', 'is_blocked']),
        deals: new Set(['id', 'contract_id', 'status', 'buyer_id', 'seller_id', 'creator_id', 'escrow_deposit_status']),
        wallet_requests: new Set(['id', 'user_id', 'type', 'status', 'ref_code']),
        transactions: new Set(['id', 'user_id', 'contract_id', 'type', 'status']),
        otp_codes: new Set(['id', 'phone']),
        bot_login_tokens: new Set(['id', 'token', 'telegram_id']),
      };
      const allowedCols = typedColumnsByTable[this.collectionPath] || new Set<string>();
      this.wheres.forEach((w, idx) => {
        if (w.op === '==' && allowedCols.has(w.field) && w.value !== undefined && w.value !== null) {
          query = query.eq(w.field, typeof w.value === 'boolean' ? w.value : String(w.value));
          pushedIndexes.add(idx);
        }
      });

      const { data, error } = await query;
      if (error) throw new Error(`Supabase query ${this.collectionPath}: ${error.message}`);
      docsList = (data || [])
        .map((row: any) => {
          const docData = rowToDocData(this.collectionPath, row);
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
        .eq('collection_path', this.collectionPath);
      if (error) throw new Error(`Supabase query ${this.collectionPath}: ${error.message}`);
      docsList = (data || [])
        .map((row: any) => {
          const docData = rowToDocData(this.collectionPath, row);
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
    // Prepare final resolved writes and preserve rollback snapshots for atomicity
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

    // Check optimistic concurrency for read keys before committing
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

    // Apply writes with compensating rollback on failure
    const appliedCount: number[] = [];
    try {
      for (let i = 0; i < stagedWrites.length; i++) {
        const sw = stagedWrites[i];
        if (sw.kind === 'delete') {
          await sw.ref.delete();
        } else if (sw.finalDoc) {
          await sw.ref.writeRaw(sw.finalDoc);
        }
        appliedCount.push(i);
      }
    } catch (err) {
      // Best-effort rollback of modified documents in reverse order
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
    // Serialize in-process transactions cleanly + retry once on optimistic contention
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
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const serviceKey = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ''
  ).trim();

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
