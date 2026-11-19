import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCommissionBreakdown,
  normalizeDealStatus,
  normalizeMilestoneStatus,
  isDisputedStatus,
  isTerminalStatus,
  buildTelegramBotDealLink,
} from '../src/lib/dealSync.ts';
import {
  isValidIranianCard,
  isValidIranianSheba,
  isValidIranianNationalId,
  detectIranianBankName,
  validateIranianPayoutDestination,
} from '../src/lib/bankValidation.ts';
import {
  normalizeAdminPermissions,
  sanitizeAdminPermissionsPatch,
  hasAdminPermission,
  hasAnyAdminPermission,
} from '../src/lib/adminPermissions.ts';
import { buildCsvContent } from '../src/lib/csvExport.ts';

test('computeCommissionBreakdown handles freelancer, employer, shared, and split_50_50 accurately', () => {
  const freelancerPaid = computeCommissionBreakdown(1000000, 2.5, 'freelancer');
  assert.equal(freelancerPaid.totalFee, 25000);
  assert.equal(freelancerPaid.employerFee, 0);
  assert.equal(freelancerPaid.freelancerFee, 25000);
  assert.equal(freelancerPaid.employerTotalPayable, 1000000);
  assert.equal(freelancerPaid.netSellerAmount, 975000);

  const employerPaid = computeCommissionBreakdown(1000000, 2.5, 'employer');
  assert.equal(employerPaid.totalFee, 25000);
  assert.equal(employerPaid.employerFee, 25000);
  assert.equal(employerPaid.freelancerFee, 0);
  assert.equal(employerPaid.employerTotalPayable, 1025000);
  assert.equal(employerPaid.netSellerAmount, 1000000);

  const shared = computeCommissionBreakdown(1000000, 2.5, 'shared');
  const legacySplit = computeCommissionBreakdown(1000000, 2.5, 'split_50_50');
  assert.deepEqual(shared, legacySplit);
  assert.equal(shared.employerFee + shared.freelancerFee, shared.totalFee);
  assert.equal(shared.employerTotalPayable, 1012500);
  assert.equal(shared.netSellerAmount, 987500);

  // Odd fee splitting preserves total fee exact sum
  const oddAmount = computeCommissionBreakdown(1000050, 2.5, 'shared');
  assert.equal(oddAmount.employerFee + oddAmount.freelancerFee, oddAmount.totalFee);
});

test('deal and milestone status normalization covers bot and web variants', () => {
  assert.equal(normalizeDealStatus('pending_party_b'), 'pending_party_b');
  assert.equal(normalizeDealStatus('pending_approval'), 'pending_party_b');
  assert.equal(normalizeDealStatus('paid'), 'active');
  assert.equal(normalizeDealStatus('delivered'), 'work_submitted');
  assert.equal(normalizeDealStatus('disputed'), 'in_dispute');
  assert.equal(normalizeDealStatus('completed'), 'completed');

  assert.equal(normalizeMilestoneStatus('in_progress'), 'active');
  assert.equal(normalizeMilestoneStatus('delivered'), 'work_submitted');
  assert.equal(normalizeMilestoneStatus('paid'), 'completed');
  assert.equal(normalizeMilestoneStatus('completed'), 'completed');

  assert.equal(isDisputedStatus('disputed'), true);
  assert.equal(isDisputedStatus('in_dispute'), true);
  assert.equal(isDisputedStatus('active'), false);

  assert.equal(isTerminalStatus('completed'), true);
  assert.equal(isTerminalStatus('cancelled'), true);
  assert.equal(isTerminalStatus('active'), false);
});

test('buildTelegramBotDealLink formats deep link with c_ prefix cleanly', () => {
  const link = buildTelegramBotDealLink('DEV-1001-9988', '@miyanjiescrow_bot');
  assert.equal(link, 'https://t.me/miyanjiescrow_bot?start=c_DEV-1001-9988');
  const alreadyPrefixed = buildTelegramBotDealLink('c_DEV-1001-9988', 'miyanjiescrow_bot');
  assert.equal(alreadyPrefixed, 'https://t.me/miyanjiescrow_bot?start=c_DEV-1001-9988');
});

test('Iranian bank card, Sheba, and National ID validation enforces checksums', () => {
  // Valid Luhn card with Bank Melli prefix 603799
  assert.equal(isValidIranianCard('6037991111111112').valid, true);
  assert.equal(detectIranianBankName('6037991111111112'), 'بانک ملی ایران');
  assert.equal(isValidIranianCard('6037991111111115').valid, false);

  // Valid Sheba IBAN (mod 97 == 1)
  assert.equal(isValidIranianSheba('IR820540102680020817909002').valid, true);
  assert.equal(detectIranianBankName('IR820540102680020817909002'), 'بانک پارسیان');
  assert.equal(isValidIranianSheba('IR000540102680020817909002').valid, false);

  const payout = validateIranianPayoutDestination('۶۰۳۷-۹۹۱۱-۱۱۱۱-۱۱۱۲');
  assert.equal(payout.valid, true);
  assert.equal(payout.kind, 'card');
  assert.equal(payout.normalized, '6037991111111112');

  // National ID validation
  assert.equal(isValidIranianNationalId('0012345679').valid, true);
  assert.equal(isValidIranianNationalId('1111111111').valid, false);
  assert.equal(isValidIranianNationalId('0012345670').valid, false);
});

test('RBAC permission helpers enforce owner, granular admin, and non-admin restrictions', () => {
  const owner = { role: 'owner', permissions: { manage_finance: false } };
  assert.equal(hasAdminPermission(owner, 'manage_finance'), true);
  assert.equal(hasAdminPermission(owner, 'manage_users'), true);

  const supportOnlyAdmin = {
    role: 'admin',
    permissions: {
      manage_users: false,
      manage_kyc: false,
      manage_support: true,
      manage_finance: false,
      manage_disputes: false,
    },
  };
  assert.equal(hasAdminPermission(supportOnlyAdmin, 'manage_support'), true);
  assert.equal(hasAdminPermission(supportOnlyAdmin, 'manage_finance'), false);
  assert.equal(hasAnyAdminPermission(supportOnlyAdmin, ['manage_finance', 'manage_support']), true);
  assert.equal(hasAnyAdminPermission(supportOnlyAdmin, ['manage_finance', 'manage_users']), false);

  // Legacy admin without permissions object retains full admin defaults
  const legacyAdmin: { role: string; permissions?: any } = { role: 'admin' };
  assert.deepEqual(normalizeAdminPermissions(legacyAdmin.permissions), {
    manage_users: true,
    manage_kyc: true,
    manage_support: true,
    manage_finance: true,
    manage_disputes: true,
  });

  // Regular user never has admin permissions even if spoofed
  const regularUser = { role: 'user', permissions: { manage_finance: true } };
  assert.equal(hasAdminPermission(regularUser, 'manage_finance'), false);

  // Sanitize ignores non-boolean values
  const patched = sanitizeAdminPermissionsPatch(
    { manage_finance: false, manage_users: 'yes', manage_kyc: false },
    normalizeAdminPermissions(undefined)
  );
  assert.equal(patched.manage_finance, false);
  assert.equal(patched.manage_kyc, false);
  assert.equal(patched.manage_users, true);
});

test('buildCsvContent emits UTF-8 BOM, Persian headers, and blocks CSV formula injection', () => {
  const csv = buildCsvContent(
    [
      { name: '=CMD()', note: 'سلام, "تست"', amount: 150000 },
      { name: '+SUM(A1)', note: 'عادی', amount: 250000 },
    ],
    [
      { header: 'نام کاربر', value: (r) => r.name },
      { header: 'توضیح', value: (r) => r.note },
      { header: 'مبلغ', value: (r) => r.amount },
    ]
  );

  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.ok(csv.includes("'=CMD()"));
  assert.ok(csv.includes("'+SUM(A1)"));
  assert.ok(csv.includes('"سلام, ""تست"""'));
});

test('SupabaseFirestoreAdapter supports typed tables, app_documents subcollections, transactions, and batch writes', async () => {
  const { SupabaseFirestoreAdapter, DbSentinel } = await import('../src/lib/supabaseDb.ts');

  // Lightweight in-memory mock of SupabaseClient supporting from().select/upsert/delete/eq
  const tables: Record<string, any[]> = {
    users: [],
    deals: [],
    wallet_requests: [],
    transactions: [],
    otp_codes: [],
    bot_login_tokens: [],
    app_documents: [],
  };

  const makeMockClient = () => ({
    from(tableName: string) {
      const rows = (tables[tableName] = tables[tableName] || []);
      const filters: Array<{ col: string; val: any }> = [];
      const builder: any = {
        select() {
          return builder;
        },
        eq(col: string, val: any) {
          filters.push({ col, val });
          return builder;
        },
        limit(n: number) {
          return builder;
        },
        async maybeSingle() {
          const match = rows.find((r) => filters.every((f) => r[f.col] === f.val));
          return { data: match ? structuredClone(match) : null, error: null };
        },
        then(resolve: any) {
          const matched = rows.filter((r) => filters.every((f) => r[f.col] === f.val));
          return Promise.resolve({ data: structuredClone(matched), error: null }).then(resolve);
        },
        async upsert(payload: any, opts?: { onConflict?: string }) {
          const conflictCols = String(opts?.onConflict || 'id').split(',');
          const idx = rows.findIndex((r) => conflictCols.every((c) => r[c] === payload[c]));
          const now = new Date().toISOString();
          const stored = { created_at: now, ...payload, updated_at: payload.updated_at || now };
          if (idx >= 0) {
            rows[idx] = { ...rows[idx], ...stored };
          } else {
            rows.push(stored);
          }
          return { error: null };
        },
        delete() {
          const delFilters: Array<{ col: string; val: any }> = [];
          const delBuilder: any = {
            eq(col: string, val: any) {
              delFilters.push({ col, val });
              return delBuilder;
            },
            then(resolve: any) {
              tables[tableName] = rows.filter((r) => !delFilters.every((f) => r[f.col] === f.val));
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return delBuilder;
        },
      };
      return builder;
    },
  });

  const adapter = new SupabaseFirestoreAdapter(makeMockClient() as any);

  // 1. Typed table set/get & increment sentinel
  await adapter.collection('users').doc('u_buyer').set({
    id: 'u_buyer',
    full_name: 'خریدار تست',
    phone_number: '09121111111',
    wallet_balance: 1000000,
    escrow_locked_balance: 0,
    role: 'user',
    kyc_status: 'verified',
  });
  await adapter.collection('users').doc('u_buyer').set(
    { completed_deals_count: DbSentinel.increment(1) },
    { merge: true }
  );
  const buyerSnap = await adapter.collection('users').doc('u_buyer').get();
  assert.equal(buyerSnap.exists, true);
  assert.equal(buyerSnap.data()?.wallet_balance, 1000000);
  assert.equal(buyerSnap.data()?.completed_deals_count, 1);

  // 2. Subcollection query & ordering on app_documents
  const contactsCol = adapter.collection('users').doc('u_buyer').collection('contacts');
  await contactsCol.doc('c1').set({ id: 'c1', name: 'علی', phone_number: '09122222222', created_at: '2026-01-01T00:00:00.000Z' });
  await contactsCol.doc('c2').set({ id: 'c2', name: 'رضا', phone_number: '09123333333', created_at: '2026-01-02T00:00:00.000Z' });
  const cQuery = await contactsCol.orderBy('created_at', 'desc').limit(1).get();
  assert.equal(cQuery.size, 1);
  assert.equal(cQuery.docs[0].id, 'c2');

  // 3. Transaction atomicity
  await adapter.runTransaction(async (tx) => {
    const ref = adapter.collection('users').doc('u_buyer');
    const snap = await tx.get(ref);
    const curWallet = Number(snap.data()?.wallet_balance || 0);
    tx.set(ref, { wallet_balance: curWallet - 250000, escrow_locked_balance: 250000 }, { merge: true });
  });
  const afterTx = await adapter.collection('users').doc('u_buyer').get();
  assert.equal(afterTx.data()?.wallet_balance, 750000);
  assert.equal(afterTx.data()?.escrow_locked_balance, 250000);

  // 4. Batch compatibility (used for session revocation)
  const sessCol = adapter.collection('user_sessions');
  await sessCol.doc('s1').set({ id: 's1', user_id: 'u_buyer' });
  await sessCol.doc('s2').set({ id: 's2', user_id: 'u_buyer' });
  const batch = adapter.batch();
  batch.set(sessCol.doc('s1'), { revoked_at: 12345 }, { merge: true });
  batch.update(sessCol.doc('s2'), { revoked_at: 67890 });
  await batch.commit();
  assert.equal((await sessCol.doc('s1').get()).data()?.revoked_at, 12345);
  assert.equal((await sessCol.doc('s2').get()).data()?.revoked_at, 67890);
});

