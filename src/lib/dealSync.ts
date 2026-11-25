export const DEFAULT_PLATFORM_FEE_PERCENT = 2.5;

export type UnifiedCategoryCode =
  | 'DEV'
  | 'DESIGN'
  | 'DS'
  | 'ACADEMIC'
  | 'TEACHING'
  | 'CNS'
  | 'GEN'
  | 'digital'
  | 'account'
  | 'physical'
  | 'other';

export type CanonicalCategoryCode = 'DEV' | 'DESIGN' | 'ACADEMIC' | 'TEACHING' | 'GEN';

export type CommissionPayer = 'freelancer' | 'employer' | 'shared';

export interface CategoryMeta {
  code: CanonicalCategoryCode;
  prefix: string;
  label: string;
  shortLabel: string;
  desc: string;
  sellerTitle: string;
  sellerShort: string;
  sellerDesc: string;
  buyerTitle: string;
  buyerShort: string;
  buyerDesc: string;
  titlePlaceholder: string;
}

export const BOT_CATEGORY_LIST: CategoryMeta[] = [
  {
    code: 'DEV',
    prefix: 'DEV',
    label: 'برنامه‌نویسی و IT',
    shortLabel: 'برنامه‌نویسی و IT',
    desc: 'طراحی سایت، اپلیکیشن، ربات، اسکریپت و خدمات فنی',
    sellerTitle: 'مجری (پیمانکار)',
    sellerShort: 'مجری',
    sellerDesc: 'پروژه فنی را انجام می‌دهم و پس از تایید، دستمزد تضمین‌شده می‌گیرم',
    buyerTitle: 'کارفرما (خریدار)',
    buyerShort: 'کارفرما',
    buyerDesc: 'مبلغ قرارداد را در امانت میانجی قفل می‌کنم تا پس از تحویل آزاد شود',
    titlePlaceholder: 'مثلاً: طراحی وب‌سایت فروشگاهی با پنل مدیریت و درگاه پرداخت',
  },
  {
    code: 'DESIGN',
    prefix: 'DSG',
    label: 'طراحی و گرافیک',
    shortLabel: 'طراحی و گرافیک',
    desc: 'طراحی لوگو، رابط کاربری UI/UX، پوستر، موشن و تدوین',
    sellerTitle: 'مجری (پیمانکار)',
    sellerShort: 'مجری',
    sellerDesc: 'فایل طراحی یا تدوین را تحویل می‌دهم و دستمزد تضمین‌شده می‌گیرم',
    buyerTitle: 'کارفرما (خریدار)',
    buyerShort: 'کارفرما',
    buyerDesc: 'وجه را در امانت می‌گذارم تا بعد از تایید طرح نهایی آزاد شود',
    titlePlaceholder: 'مثلاً: طراحی هویت بصری، لوگو و رابط کاربری اپلیکیشن',
  },
  {
    code: 'ACADEMIC',
    prefix: 'RSH',
    label: 'دانشجویی و پژوهشی',
    shortLabel: 'دانشجویی و پژوهشی',
    desc: 'مقاله، تحقیق، ترجمه تخصصی، شبیه‌سازی و تحلیل داده',
    sellerTitle: 'مجری (پیمانکار)',
    sellerShort: 'مجری',
    sellerDesc: 'پژوهش یا تحلیل تخصصی را در مهلت مقرر تحویل می‌دهم',
    buyerTitle: 'کارفرما (خریدار)',
    buyerShort: 'کارفرما',
    buyerDesc: 'مبلغ پروژه را در صندوق امانت میانجی قفل می‌کنم',
    titlePlaceholder: 'مثلاً: پیاده‌سازی شبیه‌سازی متلب و تحلیل آماری داده‌ها',
  },
  {
    code: 'TEACHING',
    prefix: 'EDU',
    label: 'آموزشی و مشاوره',
    shortLabel: 'آموزشی و مشاوره',
    desc: 'تدریس خصوصی، منتورینگ، مشاوره تخصصی و کوچینگ',
    sellerTitle: 'مجری (پیمانکار)',
    sellerShort: 'مجری',
    sellerDesc: 'جلسات آموزشی یا مشاوره را مطابق برنامه برگزار می‌کنم',
    buyerTitle: 'کارفرما (خریدار)',
    buyerShort: 'کارفرما',
    buyerDesc: 'هزینه دوره یا مشاوره را در امانت می‌گذارم تا پس از اتمام آزاد شود',
    titlePlaceholder: 'مثلاً: ۱۰ جلسه آموزش و منتورینگ تخصصی برنامه‌نویسی',
  },
  {
    code: 'GEN',
    prefix: 'GEN',
    label: 'سایر خدمات و عمومی',
    shortLabel: 'سایر و عمومی',
    desc: 'تولید محتوا، سئو، ادمینی، کالا و سایر توافقات امانی',
    sellerTitle: 'مجری (پیمانکار)',
    sellerShort: 'مجری',
    sellerDesc: 'تعهد قرارداد را انجام می‌دهم و وجه تضمین‌شده دریافت می‌کنم',
    buyerTitle: 'کارفرما (خریدار)',
    buyerShort: 'کارفرما',
    buyerDesc: 'مبلغ توافق را در امانت میانجی نگه می‌دارم تا تحویل کامل شود',
    titlePlaceholder: 'مثلاً: تولید محتوای تخصصی، خدمات سئو یا واگذاری دارایی دیجیتال',
  },
];

const CATEGORY_ALIAS_MAP: Record<string, CanonicalCategoryCode> = {
  DEV: 'DEV',
  DESIGN: 'DESIGN',
  DS: 'DESIGN',
  DSG: 'DESIGN',
  ACADEMIC: 'ACADEMIC',
  RSH: 'ACADEMIC',
  TEACHING: 'TEACHING',
  CNS: 'TEACHING',
  EDU: 'TEACHING',
  GEN: 'GEN',
  digital: 'DEV',
  account: 'GEN',
  physical: 'GEN',
  other: 'GEN',
};

const LEGACY_CATEGORY_LABELS: Record<string, { label: string; desc: string }> = {
  digital: { label: 'خدمات دیجیتال', desc: 'طراحی، برنامه‌نویسی، سئو و مشاوره' },
  account: { label: 'اکانت و دارایی دیجیتال', desc: 'کانال، پیج، دامنه و اشتراک' },
  physical: { label: 'کالای فیزیکی', desc: 'تجهیزات، سخت‌افزار و ارسال پستی' },
  other: { label: 'سایر توافقات', desc: 'قراردادهای سفارشی و خاص' },
};

export function normalizeCategoryCode(rawCategory?: string | null): CanonicalCategoryCode {
  const raw = String(rawCategory || '').trim();
  if (!raw) return 'GEN';
  const upper = raw.toUpperCase();
  return CATEGORY_ALIAS_MAP[upper] || CATEGORY_ALIAS_MAP[raw] || 'GEN';
}

export function getCategoryMeta(rawCategory?: string | null): CategoryMeta & { rawCode: string } {
  const raw = String(rawCategory || '').trim();
  const canonical = normalizeCategoryCode(raw);
  const found = BOT_CATEGORY_LIST.find((c) => c.code === canonical) || BOT_CATEGORY_LIST[4];
  if (raw && LEGACY_CATEGORY_LABELS[raw]) {
    return {
      ...found,
      label: LEGACY_CATEGORY_LABELS[raw].label,
      desc: LEGACY_CATEGORY_LABELS[raw].desc,
      rawCode: raw,
    };
  }
  return { ...found, rawCode: raw || found.code };
}

export function getCategoryPrefix(rawCategory?: string | null): string {
  const raw = String(rawCategory || '').trim().toUpperCase();
  if (raw === 'DEV') return 'DEV';
  if (raw === 'DS') return 'DS';
  if (raw === 'DESIGN' || raw === 'DSG') return 'DSG';
  if (raw === 'ACADEMIC' || raw === 'RSH') return 'RSH';
  if (raw === 'CNS') return 'CNS';
  if (raw === 'TEACHING' || raw === 'EDU') return 'EDU';
  if (raw === 'GEN') return 'GEN';
  const canonical = normalizeCategoryCode(rawCategory);
  const found = BOT_CATEGORY_LIST.find((c) => c.code === canonical);
  return found?.prefix || 'GEN';
}

export function generateContractId(rawCategory?: string | null): string {
  const prefix = getCategoryPrefix(rawCategory);
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const code = `${mm}${dd}`;
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}-${code}-${rand}`;
}

export function normalizeDigits(val: unknown): string {
  return String(val ?? '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();
}

export function extractCleanPhone(val: unknown): string {
  return normalizeDigits(val).replace(/[^0-9]/g, '');
}

export interface ParsedIranMobile {
  valid: boolean;
  core10: string;
  local: string;
  e164: string;
  international: string;
  rawDigits: string;
}

export function parseIranMobile(val: unknown): ParsedIranMobile {
  const clean = extractCleanPhone(val);
  if (!clean) {
    return { valid: false, core10: '', local: '', e164: '', international: '', rawDigits: '' };
  }

  let candidate = '';
  if (clean.startsWith('009809') && clean.length === 15) {
    candidate = clean.slice(5);
  } else if (clean.startsWith('00989') && clean.length === 14) {
    candidate = clean.slice(4);
  } else if (clean.startsWith('09809') && clean.length === 14) {
    candidate = clean.slice(4);
  } else if (clean.startsWith('0989') && clean.length === 13) {
    candidate = clean.slice(3);
  } else if (clean.startsWith('9809') && clean.length === 13) {
    candidate = clean.slice(3);
  } else if (clean.startsWith('989') && clean.length === 12) {
    candidate = clean.slice(2);
  } else if (clean.startsWith('009') && clean.length === 12) {
    candidate = clean.slice(2);
  } else if (clean.startsWith('09') && clean.length === 11) {
    candidate = clean.slice(1);
  } else if (clean.startsWith('9') && clean.length === 10) {
    candidate = clean;
  }

  if (/^9\d{9}$/.test(candidate)) {
    return {
      valid: true,
      core10: candidate,
      local: `0${candidate}`,
      e164: `+98${candidate}`,
      international: `98${candidate}`,
      rawDigits: clean,
    };
  }

  return { valid: false, core10: '', local: '', e164: '', international: '', rawDigits: clean };
}

export function isValidIranMobile(val: unknown): boolean {
  return parseIranMobile(val).valid;
}

export function getPhoneCore10(val: unknown): string {
  const parsed = parseIranMobile(val);
  if (parsed.valid) return parsed.core10;
  const clean = extractCleanPhone(val);
  return clean.length >= 10 ? clean.slice(-10) : '';
}

export function normalizeIranPhone(val: unknown): string {
  const parsed = parseIranMobile(val);
  if (parsed.valid) return parsed.local;
  const clean = extractCleanPhone(val);
  if (!clean) return '';
  if (clean.startsWith('00980') && clean.length >= 15) {
    return clean.slice(4, 15);
  }
  if (clean.startsWith('0098') && clean.length >= 14) {
    return `0${clean.slice(4, 14)}`;
  }
  if (clean.startsWith('980') && clean.length >= 13) {
    return clean.slice(2, 13);
  }
  if (clean.startsWith('98') && clean.length >= 12) {
    return `0${clean.slice(2, 12)}`;
  }
  if (clean.length === 10 && clean.startsWith('9')) {
    return `0${clean}`;
  }
  return clean;
}

export function formatIranMobileDisplay(val: unknown): string {
  const parsed = parseIranMobile(val);
  if (!parsed.valid) return normalizeDigits(val);
  return `${parsed.local.slice(0, 4)} ${parsed.local.slice(4, 7)} ${parsed.local.slice(7)}`;
}

export function isPendingPartyId(id: unknown): boolean {
  if (id === null || id === undefined) return true;
  const s = String(id).trim();
  if (!s) return true;
  const low = s.toLowerCase();
  return (
    low === 'null' ||
    low === 'undefined' ||
    low === 'none' ||
    low === 'pending' ||
    low.startsWith('pending_')
  );
}

export function getUserIdentityTokens(user: any): string[] {
  if (!user) return [];
  const rawTokens = [
    user.id,
    user.uid,
    user.telegram_id,
    user.telegramId,
    user.tg_id,
    user.chat_id,
    user.chatId,
  ];
  const out = new Set<string>();
  for (const raw of rawTokens) {
    if (raw === null || raw === undefined) continue;
    const s = String(raw).trim();
    if (!s) continue;
    out.add(s);
    if (s.startsWith('u_') && s.length > 2) {
      out.add(s.slice(2));
    } else if (/^\d+$/.test(s)) {
      out.add(`u_${s}`);
    }
  }
  return Array.from(out);
}

export function matchesParty(user: any, partyId?: unknown, partyPhone?: unknown): boolean {
  if (!user) return false;
  if (!isPendingPartyId(partyId)) {
    const pid = String(partyId).trim();
    const tokens = getUserIdentityTokens(user);
    if (tokens.includes(pid)) return true;
    if (pid.startsWith('u_') && tokens.includes(pid.slice(2))) return true;
  }
  const userCore = getPhoneCore10(user.phone_number || user.phone);
  const partyCore = getPhoneCore10(partyPhone);
  if (userCore && partyCore && userCore === partyCore) return true;
  return false;
}

export function isUserDealBuyer(deal: any, user: any): boolean {
  if (!deal || !user) return false;
  if (typeof user === 'string' || typeof user === 'number') {
    const uid = String(user).trim();
    if (!uid || isPendingPartyId(deal.buyer_id)) return false;
    const bid = String(deal.buyer_id).trim();
    return bid === uid || (bid.startsWith('u_') && bid.slice(2) === uid) || (uid.startsWith('u_') && uid.slice(2) === bid);
  }
  return matchesParty(user, deal.buyer_id, deal.buyer_phone);
}

export function isUserDealSeller(deal: any, user: any): boolean {
  if (!deal || !user) return false;
  if (typeof user === 'string' || typeof user === 'number') {
    const uid = String(user).trim();
    if (!uid || isPendingPartyId(deal.seller_id)) return false;
    const sid = String(deal.seller_id).trim();
    return sid === uid || (sid.startsWith('u_') && sid.slice(2) === uid) || (uid.startsWith('u_') && uid.slice(2) === sid);
  }
  return matchesParty(user, deal.seller_id, deal.seller_phone);
}

export function isUserDealCreator(deal: any, user: any): boolean {
  if (!deal || !user) return false;
  if (typeof user === 'string' || typeof user === 'number') {
    const uid = String(user).trim();
    const cid = String(deal.creator_id ?? deal.created_by ?? '').trim();
    return Boolean(uid && cid && (cid === uid || (cid.startsWith('u_') && cid.slice(2) === uid) || (uid.startsWith('u_') && uid.slice(2) === cid)));
  }
  return matchesParty(user, deal.creator_id ?? deal.created_by);
}

export function normalizeCommissionPayer(raw?: unknown): CommissionPayer {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'employer' || s === 'buyer') return 'employer';
  if (s === 'shared' || s === 'split_50_50' || s === 'split') return 'shared';
  return 'freelancer';
}

export function getCommissionPayerLabel(raw?: unknown): string {
  const payer = normalizeCommissionPayer(raw);
  if (payer === 'employer') return 'کارفرما (خریدار)';
  if (payer === 'shared') return 'مشترک (۵۰٪ / ۵۰٪)';
  return 'مجری (پیمانکار)';
}

export interface CommissionBreakdown {
  amount: number;
  feePercent: number;
  commissionPayer: CommissionPayer;
  totalFee: number;
  employerFee: number;
  freelancerFee: number;
  employerTotalPayable: number;
  netSellerAmount: number;
}

export function computeCommissionBreakdown(
  amountRaw: number,
  feePercentRaw: number = DEFAULT_PLATFORM_FEE_PERCENT,
  payerRaw?: unknown
): CommissionBreakdown {
  const amount = Math.max(0, Math.floor(Number(amountRaw || 0)));
  const feePercent = Math.max(0, Math.min(15, Number(feePercentRaw ?? DEFAULT_PLATFORM_FEE_PERCENT)));
  const commissionPayer = normalizeCommissionPayer(payerRaw);
  const totalFee = amount > 0 && feePercent > 0 ? Math.floor((amount * feePercent) / 100) : 0;

  let employerFee = 0;
  let freelancerFee = totalFee;

  if (commissionPayer === 'employer') {
    employerFee = totalFee;
    freelancerFee = 0;
  } else if (commissionPayer === 'shared') {
    employerFee = Math.floor(totalFee / 2);
    freelancerFee = Math.max(0, totalFee - employerFee);
  }

  return {
    amount,
    feePercent,
    commissionPayer,
    totalFee,
    employerFee,
    freelancerFee,
    employerTotalPayable: amount + employerFee,
    netSellerAmount: Math.max(0, amount - freelancerFee),
  };
}

export type CanonicalDealStatus =
  | 'draft'
  | 'pending_party_b'
  | 'awaiting_payment'
  | 'awaiting_receipt_approval'
  | 'active'
  | 'work_submitted'
  | 'revisions_requested'
  | 'completed'
  | 'cancelled'
  | 'in_dispute';

export function normalizeDealStatus(rawStatus?: unknown): CanonicalDealStatus {
  const s = String(rawStatus || 'draft').trim().toLowerCase();
  if (s === 'draft') return 'draft';
  if (s === 'pending_party_b' || s === 'pending_approval') return 'pending_party_b';
  if (s === 'awaiting_payment' || s === 'pending_payment' || s === 'awaiting_escrow_deposit') return 'awaiting_payment';
  if (s === 'awaiting_receipt_approval') return 'awaiting_receipt_approval';
  if (s === 'active' || s === 'in_progress' || s === 'paid') return 'active';
  if (s === 'work_submitted' || s === 'delivered' || s === 'in_inspection') return 'work_submitted';
  if (s === 'revisions_requested') return 'revisions_requested';
  if (s === 'completed') return 'completed';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'in_dispute' || s === 'disputed') return 'in_dispute';
  return 'draft';
}

export function isDisputedStatus(rawStatus?: unknown): boolean {
  return normalizeDealStatus(rawStatus) === 'in_dispute';
}

export function isTerminalStatus(rawStatus?: unknown): boolean {
  const n = normalizeDealStatus(rawStatus);
  return n === 'completed' || n === 'cancelled';
}

export function isPendingSignStatus(rawStatus?: unknown): boolean {
  return normalizeDealStatus(rawStatus) === 'pending_party_b';
}

export function isAwaitingPaymentStatus(rawStatus?: unknown): boolean {
  const n = normalizeDealStatus(rawStatus);
  return n === 'awaiting_payment' || n === 'awaiting_receipt_approval';
}

export function isActiveExecutionStatus(rawStatus?: unknown): boolean {
  const n = normalizeDealStatus(rawStatus);
  return n === 'active' || n === 'revisions_requested';
}

export interface DealStatusMeta {
  canonical: CanonicalDealStatus;
  label: string;
  shortLabel: string;
  stepIndex: number; // 1..4 (0 for cancelled)
  progressPercent: string;
  toneClass: string;
  badgeClass: string;
  barClass: string;
}

export function getDealStatusMeta(rawStatus?: unknown): DealStatusMeta {
  const canonical = normalizeDealStatus(rawStatus);
  switch (canonical) {
    case 'draft':
      return {
        canonical,
        label: 'پیش‌نویس',
        shortLabel: 'پیش‌نویس',
        stepIndex: 1,
        progressPercent: '12%',
        toneClass: 'text-slate-600 dark:text-slate-300',
        badgeClass: 'bg-slate-500/10 text-slate-500 dark:text-slate-300',
        barClass: 'bg-slate-400 dark:bg-slate-300',
      };
    case 'pending_party_b':
      return {
        canonical,
        label: 'در انتظار تایید و امضای طرف دوم',
        shortLabel: 'انتظار امضا',
        stepIndex: 1,
        progressPercent: '20%',
        toneClass: 'text-sky-600 dark:text-sky-300',
        badgeClass: 'bg-sky-500/10 text-sky-600 dark:text-sky-300',
        barClass: 'bg-sky-500',
      };
    case 'awaiting_payment':
      return {
        canonical,
        label: 'در انتظار پرداخت وجه امانی',
        shortLabel: 'در انتظار واریز',
        stepIndex: 2,
        progressPercent: '35%',
        toneClass: 'text-amber-600 dark:text-amber-400',
        badgeClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        barClass: 'bg-amber-500',
      };
    case 'awaiting_receipt_approval':
      return {
        canonical,
        label: 'در انتظار تایید فیش واریزی',
        shortLabel: 'تایید فیش',
        stepIndex: 2,
        progressPercent: '40%',
        toneClass: 'text-amber-600 dark:text-amber-300',
        badgeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
        barClass: 'bg-amber-500',
      };
    case 'active':
      return {
        canonical,
        label: 'در حال اجرا (وجه قفل)',
        shortLabel: 'در حال اجرا',
        stepIndex: 3,
        progressPercent: '58%',
        toneClass: 'text-blue-600 dark:text-blue-400',
        badgeClass: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
        barClass: 'bg-blue-600',
      };
    case 'revisions_requested':
      return {
        canonical,
        label: 'درخواست اصلاح',
        shortLabel: 'نیاز به اصلاح',
        stepIndex: 3,
        progressPercent: '65%',
        toneClass: 'text-orange-600 dark:text-orange-400',
        badgeClass: 'bg-orange-500/10 text-orange-600 dark:text-orange-300',
        barClass: 'bg-orange-500',
      };
    case 'work_submitted':
      return {
        canonical,
        label: 'تحویل شده · در حال بررسی',
        shortLabel: 'تحویل کار',
        stepIndex: 3,
        progressPercent: '80%',
        toneClass: 'text-purple-600 dark:text-purple-400',
        badgeClass: 'bg-purple-500/10 text-purple-600 dark:text-purple-300',
        barClass: 'bg-purple-600',
      };
    case 'completed':
      return {
        canonical,
        label: 'تکمیل و تسویه شده',
        shortLabel: 'تسویه شده',
        stepIndex: 4,
        progressPercent: '100%',
        toneClass: 'text-emerald-600 dark:text-emerald-400',
        badgeClass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        barClass: 'bg-emerald-500',
      };
    case 'cancelled':
      return {
        canonical,
        label: 'لغو شده',
        shortLabel: 'لغو شده',
        stepIndex: 0,
        progressPercent: '10%',
        toneClass: 'text-rose-600 dark:text-rose-400',
        badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
        barClass: 'bg-rose-500',
      };
    case 'in_dispute':
      return {
        canonical,
        label: 'در حال داوری (اختلاف)',
        shortLabel: 'در حال داوری',
        stepIndex: 3,
        progressPercent: '70%',
        toneClass: 'text-rose-600 dark:text-rose-400',
        badgeClass: 'bg-rose-600/15 text-rose-600 dark:text-rose-300',
        barClass: 'bg-rose-600',
      };
  }
}

export function normalizeMilestoneStatus(
  rawStatus?: unknown
): 'pending' | 'active' | 'work_submitted' | 'completed' | 'cancelled' {
  const s = String(rawStatus || 'pending').trim().toLowerCase();
  if (s === 'completed' || s === 'paid') return 'completed';
  if (s === 'work_submitted' || s === 'delivered') return 'work_submitted';
  if (s === 'active' || s === 'in_progress') return 'active';
  if (s === 'cancelled') return 'cancelled';
  return 'pending';
}

export function getMilestoneStatusMeta(rawStatus?: unknown): { label: string; tone: string } {
  const s = String(rawStatus || 'pending').trim().toLowerCase();
  if (s === 'completed' || s === 'paid') {
    return { label: s === 'paid' ? 'پرداخت و تسویه شده' : 'آزاد و تکمیل شده', tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' };
  }
  if (s === 'work_submitted' || s === 'delivered') {
    return { label: 'تحویل شده · در انتظار تایید', tone: 'bg-purple-500/15 text-purple-600 dark:text-purple-300' };
  }
  if (s === 'active' || s === 'in_progress') {
    return { label: 'در حال انجام (مرحله فعال)', tone: 'bg-blue-500/15 text-blue-600 dark:text-blue-300' };
  }
  if (s === 'awaiting_payment') {
    return { label: 'در انتظار پرداخت', tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-300' };
  }
  if (s === 'locked') {
    return { label: 'قفل‌شده تا تکمیل مرحله قبل', tone: 'bg-slate-500/10 text-slate-500 dark:text-slate-400' };
  }
  if (s === 'cancelled') {
    return { label: 'لغو شده', tone: 'bg-rose-500/15 text-rose-600 dark:text-rose-300' };
  }
  return { label: 'در انتظار مرحله قبل', tone: 'bg-slate-500/10 text-slate-500 dark:text-slate-400' };
}

export function buildTelegramBotDealLink(contractId: string, botUsername: string = 'mianji_ir_bot'): string {
  const cleanBot = String(botUsername || 'mianji_ir_bot').trim().replace(/^@+/, '') || 'mianji_ir_bot';
  const cid = String(contractId || '').trim();
  const token = cid.startsWith('c_') ? cid : `c_${cid}`;
  return `https://t.me/${cleanBot}?start=${encodeURIComponent(token)}`;
}

export const MILESTONE_TEMPLATES = [
  { id: '50_50', label: '۵۰٪ / ۵۰٪', percentages: [50, 50], titles: ['مرحله اول: پیش‌پرداخت و شروع کار', 'مرحله دوم: تحویل نهایی و تسویه'] },
  { id: '30_70', label: '۳۰٪ / ۷۰٪', percentages: [30, 70], titles: ['مرحله اول: شروع و نمونه اولیه (۳۰٪)', 'مرحله دوم: تحویل نهایی پروژه (۷۰٪)'] },
  {
    id: '30_30_40',
    label: '۳۰٪ / ۳۰٪ / ۴۰٪',
    percentages: [30, 30, 40],
    titles: ['فاز اول: طراحی و زیرساخت (۳۰٪)', 'فاز دوم: پیاده‌سازی اصلی (۳۰٪)', 'فاز سوم: تست و تحویل نهایی (۴۰٪)'],
  },
  { id: 'equal', label: 'تقسیم مساوی', percentages: [], titles: [] },
  { id: 'custom', label: 'درصد دلخواه', percentages: [], titles: [] },
] as const;
