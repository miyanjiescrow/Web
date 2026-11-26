import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Check,
  CheckCircle2,
  Clock,
  AlertCircle,
  Lock,
  Shield,
  ShieldCheck,
  ChevronRight,
  ChevronLeft,
  Users,
  User,
  Briefcase,
  FileText,
  X,
  Minus,
  QrCode,
  MessageCircle,
  LayoutGrid,
  List,
  ArrowUpRight,
  Gavel,
  SlidersHorizontal,
  ArrowUpDown,
  Star,
  Layers,
  Trash2,
  ChevronDown,
  Lightbulb,
  HelpCircle,
  Bookmark,
  Link2,
  Save,
  Copy,
  Share2,
  ExternalLink,
  Send,
  Percent,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { apiFetch } from '../lib/apiClient';
import ConfirmDialog from './ConfirmDialog';
import {
  DealDraftRecord,
  buildDealInviteUrl,
  deleteDealDraft,
  fetchDealDrafts,
  isPendingPartyId,
  readLocalDealDrafts,
  saveDealDraft,
} from '../services/escrowService';
import {
  BOT_CATEGORY_LIST,
  CanonicalCategoryCode,
  CommissionPayer,
  DEFAULT_PLATFORM_FEE_PERCENT,
  MILESTONE_TEMPLATES,
  buildTelegramBotDealLink,
  computeCommissionBreakdown,
  getCategoryMeta,
  getCommissionPayerLabel,
  getDealStatusMeta,
  getPhoneCore10,
  isUserDealBuyer,
  isUserDealCreator,
  isUserDealSeller,
  normalizeCategoryCode,
  normalizeCommissionPayer,
  normalizeDealStatus,
  normalizeDigits,
  normalizeIranPhone,
  parseIranMobile,
} from '../lib/dealSync';
import type { PlatformLimits } from './AdminUserManager';

const toMillis = (ts: any): number => {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts?.toMillis === 'function') return ts.toMillis();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts?.seconds === 'number') return ts.seconds * 1000;
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatDateShortFa = (ts: any): string => {
  const ms = toMillis(ts);
  if (!ms) return 'امروز';
  return new Date(ms).toLocaleDateString('fa-IR');
};

export function numberToPersianWords(input: number): string {
  const num = Math.floor(Number(input) || 0);
  if (num <= 0) return '';
  if (num >= 1_000_000_000_000) return `${(num / 1_000_000_000_000).toFixed(2)} تریلیون تومان`;

  const ones = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
  const teens = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
  const tens = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
  const hundreds = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
  const scales = ['', 'هزار', 'میلیون', 'میلیارد'];

  const convertThreeDigits = (n: number): string => {
    const parts: string[] = [];
    const h = Math.floor(n / 100);
    const rem = n % 100;
    if (h > 0) parts.push(hundreds[h]);
    if (rem >= 10 && rem <= 19) {
      parts.push(teens[rem - 10]);
    } else {
      const t = Math.floor(rem / 10);
      const o = rem % 10;
      if (t > 0) parts.push(tens[t]);
      if (o > 0) parts.push(ones[o]);
    }
    return parts.join(' و ');
  };

  const groups: string[] = [];
  let remaining = num;
  let scaleIndex = 0;
  while (remaining > 0 && scaleIndex < scales.length) {
    const chunk = remaining % 1000;
    if (chunk > 0) {
      const chunkWords = convertThreeDigits(chunk);
      groups.unshift(scales[scaleIndex] ? `${chunkWords} ${scales[scaleIndex]}` : chunkWords);
    }
    remaining = Math.floor(remaining / 1000);
    scaleIndex++;
  }
  return `${groups.join(' و ')} تومان`;
}

function getDealPerspective(contract: any, currentUser: any) {
  const isBuyer = isUserDealBuyer(contract, currentUser);
  const isSeller = isUserDealSeller(contract, currentUser);
  const isCreator = isUserDealCreator(contract, currentUser);
  const canonical = normalizeDealStatus(contract?.status);
  const buyerMissing = isPendingPartyId(contract?.buyer_id);
  const sellerMissing = isPendingPartyId(contract?.seller_id);
  const isPendingInvite = Boolean(contract?.is_pending_counterparty || buyerMissing || sellerMissing);

  let needsMyAction = false;
  let nextHint = '';

  if (canonical === 'draft') {
    if (isPendingInvite) {
      nextHint = 'در انتظار پیوستن طرف دوم با لینک ربات یا QR';
    } else if (isBuyer) {
      needsMyAction = true;
      nextHint = 'اقدام شما: تایید پیش‌نویس و انتقال به پرداخت';
    } else {
      nextHint = 'پیش‌نویس ثبت‌شده · آماده تایید کارفرما';
    }
  } else if (canonical === 'pending_party_b') {
    if (isPendingInvite) {
      nextHint = 'لینک دعوت آماده ارسال در ربات تلگرام است';
    } else if (!isCreator && (isBuyer || isSeller)) {
      needsMyAction = true;
      nextHint = 'اقدام شما: بررسی و امضای قرارداد';
    } else {
      nextHint = 'در انتظار تایید و امضای طرف دوم';
    }
  } else if (canonical === 'awaiting_payment' || canonical === 'awaiting_receipt_approval') {
    if (isBuyer) {
      needsMyAction = canonical === 'awaiting_payment';
      nextHint =
        canonical === 'awaiting_receipt_approval'
          ? 'فیش واریزی در حال بررسی ادمین است'
          : 'اقدام شما: واریز و قفل امن وجه در امانت';
    } else {
      nextHint = 'در انتظار پرداخت و قفل وجه توسط کارفرما';
    }
  } else if (canonical === 'active' || canonical === 'revisions_requested') {
    if (isSeller) {
      needsMyAction = true;
      nextHint =
        canonical === 'revisions_requested'
          ? 'اقدام شما: اعمال اصلاحات و ارسال مجدد کار'
          : 'اقدام شما: انجام پروژه و ثبت تحویل کار';
    } else {
      nextHint =
        canonical === 'revisions_requested'
          ? 'درخواست اصلاح ثبت شده · در انتظار ارسال مجدد مجری'
          : 'وجه در امانت قفل است · مجری در حال انجام کار';
    }
  } else if (canonical === 'work_submitted') {
    if (isBuyer) {
      needsMyAction = true;
      nextHint = 'اقدام شما: بررسی کار تحویلی و آزادسازی وجه';
    } else {
      nextHint = 'تحویل ثبت شده · در انتظار تایید نهایی کارفرما';
    }
  } else if (canonical === 'completed') {
    nextHint = 'قرارداد با موفقیت تکمیل و تسویه شده است';
  } else if (canonical === 'in_dispute') {
    needsMyAction = true;
    nextHint = 'پرونده اختلاف فعال · پیگیری و ثبت مدارک در داوری';
  } else if (canonical === 'cancelled') {
    nextHint = 'این قرارداد لغو شده است';
  }

  return {
    roleLabel: isBuyer ? 'کارفرما (خریدار)' : isSeller ? 'مجری (پیمانکار)' : 'مشارکت‌کننده',
    isBuyer,
    isSeller,
    isCreator,
    isPendingInvite,
    needsMyAction,
    nextHint,
  };
}

// ============================================================================
// DEALS LIST VIEW ("معاملات من")
// ============================================================================
export function DealsView({
  user,
  contracts,
  platformLimits,
  botUsername,
  setView,
  searchQuery,
  setSearchQuery,
  onOpenQrScanner,
  onOpenDealChat,
  notify,
}: {
  user: any;
  contracts: any[];
  platformLimits?: PlatformLimits;
  botUsername?: string;
  setView: (v: any) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onOpenQrScanner?: () => void;
  onOpenDealChat?: (contract: any) => void;
  notify?: (msg: string, type?: 'info' | 'success' | 'error') => void;
}) {
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'disputed' | 'completed' | 'needs_action' | 'drafts'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'buyer' | 'seller'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'amount_desc' | 'amount_asc'>('newest');
  const [displayMode, setDisplayMode] = useState<'cards' | 'table'>('cards');
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [savedDrafts, setSavedDrafts] = useState<DealDraftRecord[]>(() => readLocalDealDrafts());
  const [pendingDeleteDraft, setPendingDeleteDraft] = useState<DealDraftRecord | null>(null);
  const [deletingDraft, setDeletingDraft] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDealDrafts().then((list) => {
      if (!cancelled) setSavedDrafts(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleResumeDraft = (draft: DealDraftRecord) => {
    try {
      localStorage.setItem('mianji_resume_draft', JSON.stringify(draft));
    } catch {}
    setView('create');
  };

  const handleDeleteDraft = async (draftId: string) => {
    setSavedDrafts((prev) => prev.filter((d) => String(d.id) !== String(draftId)));
    await deleteDealDraft(draftId);
  };

  const list = Array.isArray(contracts) ? contracts : [];

  const metrics = useMemo(() => {
    let escrowVolume = 0;
    let completedVolume = 0;
    let activeCount = 0;
    let actionCount = 0;

    for (const c of list) {
      const amt = Number(c?.amount || 0);
      const st = normalizeDealStatus(c?.status);
      if (['active', 'revisions_requested', 'work_submitted', 'in_dispute'].includes(st)) {
        escrowVolume += amt;
      }
      if (st === 'completed') {
        completedVolume += amt;
      }
      if (!['completed', 'cancelled'].includes(st)) {
        activeCount += 1;
      }
      if (getDealPerspective(c, user).needsMyAction) {
        actionCount += 1;
      }
    }

    const maxActive = Number(user?.max_active_deals || platformLimits?.default_max_active_deals || 0);
    return { escrowVolume, completedVolume, activeCount, actionCount, maxActive };
  }, [list, user, platformLimits?.default_max_active_deals]);

  const statusCounts = useMemo(() => {
    const counts = { all: 0, active: 0, disputed: 0, completed: 0 };
    for (const c of list) {
      const p = getDealPerspective(c, user);
      if (roleFilter === 'buyer' && !p.isBuyer) continue;
      if (roleFilter === 'seller' && !p.isSeller) continue;

      const st = normalizeDealStatus(c?.status);
      counts.all += 1;
      if (!['completed', 'cancelled', 'in_dispute'].includes(st)) counts.active += 1;
      if (st === 'in_dispute') counts.disputed += 1;
      if (st === 'completed') counts.completed += 1;
    }
    return counts;
  }, [list, roleFilter, user]);

  const filtered = useMemo(() => {
    const q = normalizeDigits(searchQuery || '').toLowerCase();
    const out = list.filter((c: any) => {
      const p = getDealPerspective(c, user);
      if (roleFilter === 'buyer' && !p.isBuyer) return false;
      if (roleFilter === 'seller' && !p.isSeller) return false;

      const st = normalizeDealStatus(c?.status);
      if (filterStatus === 'needs_action' && !p.needsMyAction) return false;
      if (filterStatus === 'active' && ['completed', 'cancelled', 'in_dispute'].includes(st)) return false;
      if (filterStatus === 'disputed' && st !== 'in_dispute') return false;
      if (filterStatus === 'completed' && st !== 'completed') return false;

      if (!q) return true;
      const catLabel = getCategoryMeta(c.category).label;
      return (
        String(c.title || '').toLowerCase().includes(q) ||
        String(c.contract_id || '').toLowerCase().includes(q) ||
        catLabel.toLowerCase().includes(q) ||
        String(c.buyer_fullname || c.buyer_name || '').toLowerCase().includes(q) ||
        String(c.seller_fullname || c.seller_name || '').toLowerCase().includes(q) ||
        String(c.amount || '').includes(q)
      );
    });

    out.sort((a: any, b: any) => {
      if (sortBy === 'amount_desc') return Number(b.amount || 0) - Number(a.amount || 0);
      if (sortBy === 'amount_asc') return Number(a.amount || 0) - Number(b.amount || 0);
      return toMillis(b.createdAt || b.created_at) - toMillis(a.createdAt || a.created_at);
    });

    return out;
  }, [list, searchQuery, roleFilter, filterStatus, sortBy, user]);

  const openContract = (contract: any) => {
    localStorage.setItem('selected_contract', JSON.stringify(contract));
    setView('detail');
  };

  const statusSegments = [
    { key: 'all', label: 'همه', count: statusCounts.all, dotClass: 'bg-slate-400 dark:bg-slate-400' },
    { key: 'active', label: 'فعال', count: statusCounts.active, dotClass: 'bg-blue-500' },
    { key: 'disputed', label: 'اختلاف', count: statusCounts.disputed, dotClass: 'bg-rose-500' },
    { key: 'completed', label: 'تکمیل‌شده', count: statusCounts.completed, dotClass: 'bg-emerald-500' },
  ] as const;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14 }} className="space-y-5 pb-16">
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl md:text-2xl font-black text-slate-900 dark:text-white tracking-tight">معاملات من</h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mt-0.5">
            همگام‌سازی زنده با ربات تلگرام میانجی · مدیریت قراردادها و وجوه امانی
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenQrScanner && (
            <button
              type="button"
              onClick={onOpenQrScanner}
              className="h-10 px-3.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-700 dark:text-amber-300 text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
            >
              <QrCode size={16} />
              <span>اسکن QR / ورود کد معامله</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setView('create')}
            className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-white/15 text-xs font-black flex items-center gap-1.5 active:scale-95 transition-transform duration-150 whitespace-nowrap shrink-0"
          >
            <Plus size={16} />
            <span>ایجاد معامله جدید</span>
          </button>
        </div>
      </div>

      {user?.is_deal_locked && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/35 flex items-center gap-3 text-xs text-rose-700 dark:text-rose-300 font-bold">
          <Lock size={16} className="shrink-0" />
          <span>ثبت معامله جدید برای حساب شما توسط مدیریت محدود شده است.</span>
        </div>
      )}

      {savedDrafts.length > 0 && filterStatus !== 'drafts' && (
        <div className="p-3.5 rounded-2xl card-obsidian border-amber-500/30 dark:border-amber-400/25 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-300 flex items-center justify-center shrink-0">
              <Bookmark size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-black text-slate-900 dark:text-white truncate">
                {savedDrafts.length} پیش‌نویس ناتمام برای ادامه ساخت دارید
              </p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                آخرین مورد: {savedDrafts[0]?.title || 'قرارداد بدون عنوان'} · {formatDateShortFa(savedDrafts[0]?.updated_at)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleResumeDraft(savedDrafts[0])}
              className="h-8 px-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-[11px] font-black transition-colors"
            >
              ادامه آخرین پیش‌نویس
            </button>
            {savedDrafts.length > 1 && (
              <button
                type="button"
                onClick={() => setFilterStatus('drafts')}
                className="h-8 px-3 rounded-xl bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-white text-[11px] font-bold"
              >
                همه ({savedDrafts.length})
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4-Column Financial Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 card-obsidian space-y-1">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300 block">ارزش در امانت فعال</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg md:text-xl font-black text-slate-900 dark:text-white tabular-nums">
              {metrics.escrowVolume.toLocaleString()}
            </span>
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">تومان</span>
          </div>
        </div>

        <div className="p-4 card-obsidian space-y-1">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300 block">مجموع تسویه موفق</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg md:text-xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
              {metrics.completedVolume.toLocaleString()}
            </span>
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">تومان</span>
          </div>
        </div>

        <div className="p-4 card-obsidian space-y-1">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300 block">قراردادهای فعال</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg md:text-xl font-black text-slate-900 dark:text-white tabular-nums">
              {metrics.activeCount}
            </span>
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 tabular-nums">
              {metrics.maxActive > 0 ? `از سقف ${metrics.maxActive}` : 'معامله باز'}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() =>
            setFilterStatus((prev) =>
              prev === 'needs_action' ? 'all' : metrics.actionCount > 0 ? 'needs_action' : 'all'
            )
          }
          className={`p-4 rounded-2xl border text-right space-y-1 transition-transform duration-150 active:scale-[0.98] ${
            filterStatus === 'needs_action'
              ? 'bg-blue-600 text-white border-blue-500'
              : 'card-obsidian card-obsidian-interactive'
          }`}
        >
          <span className={`text-[11px] font-bold block ${filterStatus === 'needs_action' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-300'}`}>
            نیازمند اقدام شما
          </span>
          <div className="flex items-baseline justify-between gap-2">
            <span className={`text-lg md:text-xl font-black tabular-nums ${filterStatus === 'needs_action' ? 'text-white' : metrics.actionCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-white'}`}>
              {metrics.actionCount}
            </span>
            <span className={`text-[10px] font-bold ${filterStatus === 'needs_action' ? 'text-blue-100' : 'text-blue-600 dark:text-blue-400'}`}>
              {metrics.actionCount > 0 ? 'مشاهده فوری ←' : 'همه مرتب'}
            </span>
          </div>
        </button>
      </div>

      {/* Unified Search, Role Switcher, Sort & Layout Toolbar */}
      <div className="p-3.5 md:p-4 card-obsidian space-y-3">
        <div className="flex flex-col md:flex-row gap-2.5 items-stretch md:items-center justify-between">
          <div className="relative flex-1">
            <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" size={16} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="جستجو بر اساس عنوان، شناسه قرارداد (DEV-...) یا مبلغ..."
              className="input-refined !h-10 pr-10 pl-8 text-[14px]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-white p-1"
                aria-label="پاک کردن جستجو"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center p-1 rounded-xl bg-slate-100 dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08]">
              {(
                [
                  { id: 'all', label: 'همه نقش‌ها' },
                  { id: 'buyer', label: 'کارفرما' },
                  { id: 'seller', label: 'مجری' },
                ] as const
              ).map((rf) => (
                <button
                  key={rf.id}
                  type="button"
                  onClick={() => setRoleFilter(rf.id)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors whitespace-nowrap shrink-0 ${
                    roleFilter === rf.id
                      ? 'bg-white dark:bg-[#18202e] text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {rf.label}
                </button>
              ))}
            </div>

            <div className="relative flex items-center">
              <ArrowUpDown size={14} className="absolute right-3 text-slate-400 pointer-events-none" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="h-9 pr-8 pl-3 rounded-xl font-sans text-xs font-bold bg-slate-50 dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-white outline-none"
                aria-label="مرتب‌سازی"
              >
                <option value="newest">جدیدترین</option>
                <option value="amount_desc">بیشترین مبلغ</option>
                <option value="amount_asc">کمترین مبلغ</option>
              </select>
            </div>

            <div className="hidden md:flex items-center p-1 rounded-xl bg-slate-100 dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08]">
              <button
                type="button"
                onClick={() => setDisplayMode('cards')}
                className={`p-1.5 rounded-lg transition-colors ${
                  displayMode === 'cards'
                    ? 'bg-white dark:bg-[#18202e] text-blue-600 dark:text-white shadow-sm'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
                title="نمای کارتی"
              >
                <LayoutGrid size={15} />
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode('table')}
                className={`p-1.5 rounded-lg transition-colors ${
                  displayMode === 'table'
                    ? 'bg-white dark:bg-[#18202e] text-blue-600 dark:text-white shadow-sm'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
                title="نمای جدولی"
              >
                <List size={15} />
              </button>
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-slate-100 dark:border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div
            role="tablist"
            aria-label="فیلتر وضعیت معاملات"
            className="grid grid-cols-4 sm:inline-grid w-full sm:w-auto p-1 rounded-2xl bg-slate-100/90 dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] gap-1"
          >
            {statusSegments.map((seg) => {
              const active = filterStatus === seg.key;
              return (
                <button
                  key={seg.key}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => setFilterStatus(seg.key)}
                  className={`relative min-h-[38px] px-2 sm:px-4 py-1.5 rounded-xl text-[11px] sm:text-xs font-black transition-colors whitespace-nowrap flex items-center justify-center gap-1.5 select-none ${
                    active
                      ? 'text-slate-900 dark:text-white'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="deals-status-segment-thumb"
                      transition={{ type: 'spring', stiffness: 460, damping: 36 }}
                      className="absolute inset-0 rounded-xl bg-white dark:bg-[#1a2436] shadow-sm border border-slate-200/70 dark:border-white/10"
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${seg.dotClass}`} />
                    <span>{seg.label}</span>
                    <span
                      className={`text-[10px] tabular-nums ${
                        active ? 'text-slate-500 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'
                      }`}
                    >
                      ({seg.count})
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {(filterStatus === 'needs_action' || filterStatus === 'drafts') && (
            <div className="flex items-center justify-between sm:justify-end gap-2 px-3 py-1.5 rounded-xl bg-blue-500/10 border border-blue-500/25 text-[11px] font-bold text-blue-700 dark:text-blue-300">
              <span>
                {filterStatus === 'needs_action'
                  ? 'نمایش فقط معاملات نیازمند اقدام شما'
                  : `نمایش پیش‌نویس‌های ذخیره شده (${savedDrafts.length})`}
              </span>
              <button
                type="button"
                onClick={() => setFilterStatus('all')}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white/80 dark:bg-white/10 text-slate-700 dark:text-white hover:bg-white dark:hover:bg-white/20 transition-colors"
              >
                <X size={12} />
                <span>همه</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Results View */}
      {filterStatus === 'drafts' ? (
        savedDrafts.length === 0 ? (
          <div className="p-12 text-center card-obsidian rounded-3xl space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-white/10 text-slate-400 dark:text-slate-300 flex items-center justify-center mx-auto">
              <Bookmark size={22} />
            </div>
            <h3 className="text-sm font-black text-slate-900 dark:text-white">هیچ پیش‌نویس ناتمامی ذخیره نشده است</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 max-w-sm mx-auto leading-relaxed">
              هنگام ساخت قرارداد جدید، اطلاعات فرم به صورت خودکار اینجا ذخیره می‌شود تا در صورت بستن صفحه بتوانید ادامه دهید.
            </p>
            <button
              type="button"
              onClick={() => setView('create')}
              className="h-10 px-5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black inline-flex items-center gap-1.5"
            >
              <Plus size={15} />
              <span>شروع قرارداد جدید</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {savedDrafts.map((d) => {
              const catLabel = getCategoryMeta(d.category).label;
              const amt = Number(normalizeDigits(String(d.amount || '')).replace(/[^0-9]/g, '')) || 0;
              return (
                <div key={d.id} className="p-4 md:p-5 card-obsidian card-obsidian-interactive flex flex-col justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                      <span>
                        {catLabel} · گام {d.step || 1} از ۱۰
                      </span>
                      <span className="tabular-nums">{formatDateShortFa(d.updated_at)}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h3 className="text-sm md:text-base font-black text-slate-900 dark:text-white line-clamp-2">
                          {d.title?.trim() || 'پیش‌نویس بدون عنوان'}
                        </h3>
                        <p className="text-[11px] text-slate-500 dark:text-slate-300">
                          نقش شما: {d.role === 'buyer' ? 'کارفرما (خریدار)' : 'مجری (پیمانکار)'}
                          {d.phone ? ` · طرف مقابل: ${d.phone}` : ' · دعوت مستقیم در ربات/لینک'}
                        </p>
                      </div>
                      <div className="text-left shrink-0">
                        <span className="text-base font-black text-slate-900 dark:text-white tabular-nums block">
                          {amt > 0 ? amt.toLocaleString() : '—'}
                        </span>
                        {amt > 0 && <span className="text-[10px] text-slate-500 dark:text-slate-400">تومان</span>}
                      </div>
                    </div>
                  </div>
                  <div className="pt-3 border-t border-slate-100 dark:border-white/10 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setPendingDeleteDraft(d)}
                      className="h-9 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 text-[11px] font-bold flex items-center gap-1 transition-colors"
                    >
                      <Trash2 size={13} />
                      <span>حذف</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResumeDraft(d)}
                      className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center gap-1.5 transition-colors"
                    >
                      <span>ادامه و تکمیل قرارداد</span>
                      <ChevronLeft size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div className="p-12 md:p-16 text-center card-obsidian rounded-3xl space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-white/10 text-slate-400 dark:text-slate-300 flex items-center justify-center mx-auto">
            <ClipboardListIcon />
          </div>
          <div className="space-y-1 max-w-sm mx-auto">
            <h3 className="text-sm font-black text-slate-900 dark:text-white">
              {list.length === 0 ? 'هنوز هیچ قراردادی ثبت نکرده‌اید' : 'معامله‌ای مطابق فیلترهای فعلی پیدا نشد'}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">
              {list.length === 0
                ? 'اولین قرارداد امن خود را بسازید؛ قرارداد بلافاصله با ربات تلگرام همگام می‌شود.'
                : 'فیلتر وضعیت، نقش یا متن جستجو را تغییر دهید تا سایر قراردادها نمایش داده شوند.'}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2.5 pt-1">
            {list.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setFilterStatus('all');
                  setRoleFilter('all');
                  setSearchQuery('');
                }}
                className="h-10 px-4 rounded-xl bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-white text-xs font-bold hover:bg-slate-200 dark:hover:bg-white/15 transition-colors"
              >
                نمایش همه معاملات
              </button>
            )}
            <button
              type="button"
              onClick={() => setView('create')}
              className="h-10 px-5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center gap-1.5"
            >
              <Plus size={15} />
              <span>ایجاد قرارداد امن</span>
            </button>
          </div>
        </div>
      ) : displayMode === 'table' ? (
        <div className="hidden md:block card-obsidian overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200/80 dark:border-white/[0.08] text-[11px] font-black text-slate-500 dark:text-slate-300 bg-slate-50/70 dark:bg-white/[0.03]">
                  <th className="py-3 px-4">شناسه</th>
                  <th className="py-3 px-4">عنوان معامله و دسته</th>
                  <th className="py-3 px-4">نقش شما</th>
                  <th className="py-3 px-4">وضعیت مرحله</th>
                  <th className="py-3 px-4">مبلغ (تومان)</th>
                  <th className="py-3 px-4 text-left">اقدام</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/10 text-xs">
                {filtered.map((c: any) => {
                  const st = getDealStatusMeta(c.status);
                  const p = getDealPerspective(c, user);
                  const cat = getCategoryMeta(c.category).label;
                  const counterpartyDisplay = p.isPendingInvite
                    ? 'منتظر پیوستن (لینک ربات/QR)'
                    : p.isBuyer
                    ? c.seller_fullname || c.seller_name || 'مجری'
                    : c.buyer_fullname || c.buyer_name || 'کارفرما';
                  const hasMilestones = Boolean((c.staged_payment ?? c.is_milestone) && Array.isArray(c.milestones) && c.milestones.length >= 2);
                  return (
                    <tr
                      key={c.contract_id || c.id}
                      onClick={() => openContract(c)}
                      className="hover:bg-slate-50/90 dark:hover:bg-white/[0.04] cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-mono text-[11px] font-bold text-slate-500 dark:text-slate-300" dir="ltr">
                        {c.contract_id}
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-black text-slate-900 dark:text-white truncate max-w-[240px]">{c.title}</p>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400">
                          {cat} · {counterpartyDisplay} · {formatDateShortFa(c.createdAt || c.created_at)}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-slate-700 dark:text-slate-200 font-bold">{p.roleLabel}</td>
                      <td className="py-3 px-4">
                        <span className={`font-black text-[11px] ${st.toneClass}`}>{st.label}</span>
                        {hasMilestones && (
                          <span className="block text-[10px] text-blue-600 dark:text-blue-300 font-bold mt-0.5 tabular-nums">
                            مرحله‌ای ({c.milestones.filter((m: any) => ['completed', 'paid'].includes(String(m.status))).length}/{c.milestones.length})
                          </span>
                        )}
                        {p.isPendingInvite && (
                          <span className="block text-[10px] text-blue-600 dark:text-blue-300 font-bold mt-0.5">
                            لینک دعوت ربات آماده
                          </span>
                        )}
                        {p.needsMyAction && (
                          <span className="block text-[10px] text-amber-600 dark:text-amber-300 font-bold mt-0.5">
                            نیازمند اقدام شما
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-black text-slate-900 dark:text-white tabular-nums">
                        {Number(c.amount || 0).toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-left">
                        <div className="flex items-center justify-end gap-1.5">
                          {onOpenDealChat && !p.isPendingInvite && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenDealChat(c);
                              }}
                              className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-blue-600 hover:text-white text-slate-700 dark:text-white text-[11px] font-black flex items-center gap-1 transition-colors"
                              title="چت قرارداد"
                            >
                              <MessageCircle size={13} />
                              <span>چت</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openContract(c);
                            }}
                            className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-blue-600 hover:text-white text-slate-800 dark:text-white text-[11px] font-black transition-colors whitespace-nowrap"
                          >
                            باز کردن
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filtered.map((c: any) => {
            const st = getDealStatusMeta(c.status);
            const p = getDealPerspective(c, user);
            const catLabel = getCategoryMeta(c.category).label;
            const stages = ['ثبت و امضا', 'قفل وجه', 'اجرا و تحویل', 'تسویه'];
            const counterpartyDisplay = p.isPendingInvite
              ? 'منتظر پیوستن (لینک ربات / QR)'
              : p.isBuyer
              ? c.seller_fullname || c.seller_name || 'مجری'
              : c.buyer_fullname || c.buyer_name || 'کارفرما';
            const hasMilestones = Boolean((c.staged_payment ?? c.is_milestone) && Array.isArray(c.milestones) && c.milestones.length >= 2);
            const botDealLink = c.bot_link || buildTelegramBotDealLink(c.contract_id, botUsername);

            return (
              <div
                key={c.contract_id || c.id}
                onClick={() => openContract(c)}
                className="p-4 md:p-5 card-obsidian card-obsidian-interactive cursor-pointer flex flex-col justify-between gap-4 group"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-300">
                    <div className="flex items-center gap-1.5 min-w-0 truncate">
                      <span className="font-mono font-bold text-slate-600 dark:text-slate-200" dir="ltr">
                        {c.contract_id}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{catLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{p.roleLabel}</span>
                    </div>
                    <span className="tabular-nums shrink-0">{formatDateShortFa(c.createdAt || c.created_at)}</span>
                  </div>

                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h3 className="text-sm md:text-base font-black text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-300 transition-colors leading-snug line-clamp-2">
                        {c.title}
                      </h3>
                      <p className={`text-[11px] font-bold truncate ${p.isPendingInvite ? 'text-blue-600 dark:text-blue-300' : 'text-slate-500 dark:text-slate-300'}`}>
                        طرف مقابل: {counterpartyDisplay}
                      </p>
                    </div>
                    <div className="text-left shrink-0">
                      <span className="text-base md:text-lg font-black text-slate-900 dark:text-white tabular-nums block leading-none">
                        {Number(c.amount || 0).toLocaleString()}
                      </span>
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">تومان</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-black flex items-center gap-1.5 ${st.toneClass}`}>
                        {st.canonical === 'completed' ? (
                          <CheckCircle2 size={13} />
                        ) : st.canonical === 'in_dispute' ? (
                          <Gavel size={13} />
                        ) : ['active', 'work_submitted', 'revisions_requested'].includes(st.canonical) ? (
                          <Lock size={13} />
                        ) : (
                          <Clock size={13} />
                        )}
                        {st.label}
                      </span>
                      {hasMilestones && (
                        <span className="text-[10px] font-black text-blue-600 dark:text-blue-300 tabular-nums shrink-0 flex items-center gap-1">
                          <Layers size={11} />
                          مرحله {c.milestones.filter((m: any) => ['completed', 'paid'].includes(String(m.status))).length}/{c.milestones.length}
                        </span>
                      )}
                      {c.auto_release_at && (
                        <span className="text-[10px] font-bold text-amber-600 dark:text-amber-300 shrink-0">
                          تایمر بازرسی فعال
                        </span>
                      )}
                    </div>
                    {c.deadline && (
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                        مهلت: {c.deadline} روز
                      </span>
                    )}
                  </div>

                  {st.canonical !== 'cancelled' && (
                    <div className="grid grid-cols-4 gap-1.5">
                      {stages.map((stageName, idx) => {
                        const reached = st.stepIndex >= idx + 1;
                        return (
                          <div key={stageName} className="space-y-1">
                            <div
                              className={`h-1.5 rounded-full transition-colors ${
                                reached ? st.barClass : 'bg-slate-100 dark:bg-white/10'
                              }`}
                            />
                            <span
                              className={`text-[10px] block truncate ${
                                reached ? 'font-bold text-slate-700 dark:text-slate-200' : 'text-slate-400 dark:text-slate-500'
                              }`}
                            >
                              {stageName}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 dark:border-white/10 flex items-center justify-between gap-2">
                  <span
                    className={`text-[11px] font-bold truncate ${
                      p.needsMyAction ? 'text-amber-600 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {p.nextHint}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {p.isPendingInvite && (
                      <>
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            const code = String(c.contract_id || '');
                            try {
                              await navigator.clipboard.writeText(code);
                              setCopiedCodeId(code);
                              setTimeout(() => setCopiedCodeId((prev) => (prev === code ? null : prev)), 2000);
                              notify?.(`کد معامله ${code} کپی شد`, 'success');
                            } catch {
                              notify?.(code, 'info');
                            }
                          }}
                          className="h-8 px-2.5 rounded-lg bg-amber-500/15 hover:bg-amber-500 text-amber-700 dark:text-amber-300 hover:text-white text-[11px] font-black flex items-center gap-1 transition-colors whitespace-nowrap"
                          title="کپی کد معامله برای مشاهده یا امضای طرف دوم"
                        >
                          {copiedCodeId === String(c.contract_id || '') ? <Check size={12} /> : <Copy size={12} />}
                          <span>{copiedCodeId === String(c.contract_id || '') ? 'کپی شد' : 'کپی کد'}</span>
                        </button>
                        <a
                          href={botDealLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="h-8 px-2.5 rounded-lg bg-sky-500/15 hover:bg-sky-500 text-sky-600 dark:text-sky-300 hover:text-white text-[11px] font-black flex items-center gap-1 transition-colors whitespace-nowrap"
                          title="مشاهده در ربات تلگرام"
                        >
                          <Send size={12} />
                          <span>ربات</span>
                        </a>
                      </>
                    )}
                    {onOpenDealChat && !p.isPendingInvite && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDealChat(c);
                        }}
                        className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-blue-600 hover:text-white text-slate-700 dark:text-white text-[11px] font-black flex items-center gap-1 transition-colors whitespace-nowrap"
                        title="ورود به چت قرارداد"
                      >
                        <MessageCircle size={13} />
                        {Number(c.unread_count || 0) > 0 && (
                          <span className="font-mono text-[10px] tabular-nums">{c.unread_count}</span>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openContract(c);
                      }}
                      className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-blue-600 hover:text-white text-slate-800 dark:text-white text-[11px] font-black flex items-center gap-1 transition-colors whitespace-nowrap"
                    >
                      <span>{p.needsMyAction ? 'مشاهده و اقدام' : 'جزئیات'}</span>
                      <ChevronLeft size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingDeleteDraft)}
        title="حذف پیش‌نویس قرارداد"
        description="آیا از حذف این پیش‌نویس مطمئن هستید؟ اطلاعات ذخیره‌شده این پیش‌نویس قابل بازیابی نخواهد بود."
        previewText={
          pendingDeleteDraft
            ? `${pendingDeleteDraft.title?.trim() || 'پیش‌نویس بدون عنوان'}${
                Number(pendingDeleteDraft.amount || 0) > 0
                  ? ` — مبلغ: ${Number(pendingDeleteDraft.amount).toLocaleString()} تومان`
                  : ''
              }`
            : undefined
        }
        confirmLabel="بله، حذف پیش‌نویس"
        cancelLabel="انصراف"
        tone="danger"
        busy={deletingDraft}
        onCancel={() => {
          if (!deletingDraft) setPendingDeleteDraft(null);
        }}
        onConfirm={async () => {
          if (!pendingDeleteDraft) return;
          setDeletingDraft(true);
          try {
            await handleDeleteDraft(pendingDeleteDraft.id);
            notify?.('پیش‌نویس قرارداد حذف شد', 'info');
            setPendingDeleteDraft(null);
          } finally {
            setDeletingDraft(false);
          }
        }}
      />
    </motion.div>
  );
}

function ClipboardListIcon() {
  return <FileText size={26} />;
}

// ============================================================================
// CREATE DEAL WIZARD — 10-STEP BOT-SYNCED FLOW ("ساخت قرارداد اسکرو")
// ============================================================================
type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

const WIZARD_STEPS: Array<{ num: WizardStep; label: string }> = [
  { num: 1, label: 'نقش' },
  { num: 2, label: 'دسته' },
  { num: 3, label: 'عنوان' },
  { num: 4, label: 'مبلغ' },
  { num: 5, label: 'مهلت' },
  { num: 6, label: 'ویرایش' },
  { num: 7, label: 'کارمزد' },
  { num: 8, label: 'پرداخت' },
  { num: 9, label: 'شرح و مخاطب' },
  { num: 10, label: 'تایید نهایی' },
];

export function CreateDealView({
  user,
  contracts,
  platformLimits,
  botUsername = 'mianji_ir_bot',
  onBack,
  onCreated,
  onSuccess,
  notify,
}: {
  user: any;
  contracts: any[];
  platformLimits?: PlatformLimits;
  botUsername?: string;
  onBack: () => void;
  onCreated?: (createdContract?: any) => void;
  onSuccess: (createdContract?: any) => void;
  notify: (msg: string, type?: 'info' | 'success' | 'error') => void;
}) {
  const [draftId, setDraftId] = useState<string>(() => {
    try {
      const resumeRaw = localStorage.getItem('mianji_resume_draft');
      if (resumeRaw) {
        const parsed = JSON.parse(resumeRaw);
        if (parsed?.id) return String(parsed.id);
      }
    } catch {}
    return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  });

  const [draftSavedAt, setDraftSavedAt] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [step, setStep] = useState<WizardStep>(1);
  const [direction, setDirection] = useState(1);

  const [role, setRole] = useState<'buyer' | 'seller'>('buyer');
  const [category, setCategory] = useState<CanonicalCategoryCode>('DEV');
  const [title, setTitle] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [deadlineDays, setDeadlineDays] = useState('7');
  const [inspectionHours, setInspectionHours] = useState('48');
  const [freeEdits, setFreeEdits] = useState('2');
  const [commissionPayer, setCommissionPayer] = useState<CommissionPayer>('freelancer');
  const [stagedPayment, setStagedPayment] = useState(false);
  const [milestoneTemplate, setMilestoneTemplate] = useState<'50_50' | '30_70' | '30_30_40' | 'equal' | 'custom'>('50_50');
  const [milestones, setMilestones] = useState<Array<{ title: string; amount: string; percentage?: number; deadline_days?: string }>>([
    { title: 'مرحله اول: پیش‌پرداخت و شروع کار', amount: '', percentage: 50, deadline_days: '' },
    { title: 'مرحله دوم: تحویل نهایی و تسویه', amount: '', percentage: 50, deadline_days: '' },
  ]);
  const [description, setDescription] = useState('');
  const [counterpartyPhone, setCounterpartyPhone] = useState('');
  const [prefillTargetUser, setPrefillTargetUser] = useState<{ id: string; full_name: string } | null>(null);

  const [loading, setLoading] = useState<'pending_party_b' | 'draft' | null>(null);
  const [formError, setFormError] = useState('');
  const [createdContract, setCreatedContract] = useState<any | null>(null);

  const [showTemplatesGuide, setShowTemplatesGuide] = useState(false);
  const [appliedTemplateLabel, setAppliedTemplateLabel] = useState('');
  const [showClauseHelper, setShowClauseHelper] = useState(false);
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [savedContacts, setSavedContacts] = useState<any[]>([]);
  const [lookupState, setLookupState] = useState<{
    status: 'idle' | 'checking' | 'found' | 'not_found';
    user?: {
      id: string;
      full_name: string;
      phone_number: string;
      kyc_status?: string;
      rating_avg?: number;
      rating_count?: number;
      completed_deals_count?: number;
    };
  }>({ status: 'idle' });

  useEffect(() => {
    try {
      const resumeRaw = localStorage.getItem('mianji_resume_draft');
      if (resumeRaw) {
        const d = JSON.parse(resumeRaw) as DealDraftRecord;
        localStorage.removeItem('mianji_resume_draft');
        if (d?.id) setDraftId(String(d.id));
        if (d.role === 'buyer' || d.role === 'seller') setRole(d.role);
        if (d.category) setCategory(normalizeCategoryCode(d.category));
        if (d.title) setTitle(String(d.title));
        if (d.amount) setAmountInput(normalizeDigits(String(d.amount)).replace(/[^0-9]/g, ''));
        if (d.deadline) setDeadlineDays(normalizeDigits(String(d.deadline)).replace(/[^0-9]/g, '') || '7');
        if (d.inspection_hours) setInspectionHours(String(d.inspection_hours));
        if (d.free_edits !== undefined || d.revisions !== undefined) {
          setFreeEdits(String(d.free_edits ?? d.revisions ?? '2'));
        }
        if (d.commission_payer) setCommissionPayer(normalizeCommissionPayer(d.commission_payer));
        if (d.description) setDescription(String(d.description));
        if (d.phone) setCounterpartyPhone(normalizeDigits(String(d.phone)));
        if (typeof (d.staged_payment ?? d.is_milestone) === 'boolean') {
          setStagedPayment(Boolean(d.staged_payment ?? d.is_milestone));
        }
        if (d.milestone_template && ['50_50', '30_70', '30_30_40', 'equal', 'custom'].includes(d.milestone_template)) {
          setMilestoneTemplate(d.milestone_template as any);
        }
        if (Array.isArray(d.milestones) && d.milestones.length >= 2) {
          setMilestones(
            d.milestones.map((m) => ({
              title: String(m?.title || ''),
              amount: normalizeDigits(String(m?.amount || '')).replace(/[^0-9]/g, ''),
              percentage: typeof m?.percentage === 'number' ? m.percentage : undefined,
              deadline_days: m?.deadline_days ? String(m.deadline_days) : '',
            }))
          );
        }
        if (d.step && d.step >= 1 && d.step <= 10) {
          setStep(d.step as WizardStep);
        }
        setDraftSavedAt('saved');
      }
    } catch {}

    const prefill = localStorage.getItem('mianji_prefill_phone');
    if (prefill) {
      setCounterpartyPhone(normalizeDigits(prefill));
      localStorage.removeItem('mianji_prefill_phone');
    }

    try {
      const targetRaw = localStorage.getItem('mianji_prefill_target_user');
      if (targetRaw) {
        const parsedTarget = JSON.parse(targetRaw);
        localStorage.removeItem('mianji_prefill_target_user');
        if (parsedTarget?.id) {
          setPrefillTargetUser({
            id: String(parsedTarget.id),
            full_name: String(parsedTarget.full_name || 'کاربر میانجی'),
          });
        }
      }
    } catch {}

    try {
      const tplRaw = localStorage.getItem('mianji_create_template');
      if (tplRaw) {
        const tpl = JSON.parse(tplRaw);
        localStorage.removeItem('mianji_create_template');
        if (tpl && tpl.title) {
          setTitle(String(tpl.title || ''));
          if (tpl.category) setCategory(normalizeCategoryCode(tpl.category));
          if (tpl.deadline) setDeadlineDays(String(tpl.deadline));
          if (tpl.revisions !== undefined) setFreeEdits(String(tpl.revisions));
          if (tpl.inspectionHours) setInspectionHours(String(tpl.inspectionHours));
          if (tpl.description) setDescription(String(tpl.description));
          if (tpl.role === 'buyer' || tpl.role === 'seller') setRole(tpl.role);
          if (tpl.suggestedAmount) setAmountInput(String(tpl.suggestedAmount));
          if (tpl.label) setAppliedTemplateLabel(String(tpl.label));
        }
      }
    } catch {}

    apiFetch<{ success: boolean; contacts: any[] }>('/api/contacts')
      .then((res) => {
        if (Array.isArray(res.contacts)) {
          setSavedContacts(res.contacts);
          localStorage.setItem('mianji_contacts', JSON.stringify(res.contacts));
        }
      })
      .catch(() => {
        try {
          const contactsRaw = localStorage.getItem('mianji_contacts');
          if (contactsRaw) setSavedContacts(JSON.parse(contactsRaw));
        } catch {}
      });
  }, []);

  useEffect(() => {
    const hasMeaningfulContent = Boolean(
      title.trim() || amountInput.trim() || counterpartyPhone.trim() || description.trim() || step > 1
    );
    if (!hasMeaningfulContent || loading || createdContract) return;

    setDraftSavedAt('saving');
    const timer = setTimeout(async () => {
      await saveDealDraft({
        id: draftId,
        title: title.trim(),
        amount: amountInput,
        role,
        phone: counterpartyPhone,
        category,
        deadline: deadlineDays,
        free_edits: Number(freeEdits || 0),
        revisions: freeEdits,
        inspection_hours: inspectionHours,
        commission_payer: commissionPayer,
        description,
        staged_payment: stagedPayment,
        is_milestone: stagedPayment,
        milestone_template: milestoneTemplate,
        milestones: milestones.map((m) => ({
          title: m.title,
          amount: m.amount,
          ...(m.percentage !== undefined ? { percentage: m.percentage } : {}),
          ...(m.deadline_days ? { deadline_days: Number(m.deadline_days) } : {}),
        })),
        step,
        updated_at: new Date().toISOString(),
      });
      setDraftSavedAt('saved');
    }, 850);
    return () => clearTimeout(timer);
  }, [
    draftId,
    title,
    amountInput,
    role,
    category,
    deadlineDays,
    inspectionHours,
    freeEdits,
    commissionPayer,
    stagedPayment,
    milestoneTemplate,
    milestones,
    description,
    counterpartyPhone,
    step,
    loading,
    createdContract,
  ]);

  useEffect(() => {
    const parsedPhone = parseIranMobile(counterpartyPhone);
    if (!parsedPhone.valid) {
      setLookupState({ status: 'idle' });
      return;
    }
    const timer = setTimeout(async () => {
      setLookupState({ status: 'checking' });
      try {
        const data = await apiFetch<{ success: boolean; user?: any }>(
          `/api/users/lookup?phone=${encodeURIComponent(parsedPhone.local)}`
        );
        if (data.success && data.user) {
          setLookupState({ status: 'found', user: data.user });
        } else {
          setLookupState({ status: 'not_found' });
        }
      } catch {
        setLookupState({ status: 'not_found' });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [counterpartyPhone]);

  const numericAmount = Number(normalizeDigits(amountInput).replace(/[^0-9]/g, '')) || 0;
  const amountWords = useMemo(() => numberToPersianWords(numericAmount), [numericAmount]);
  const feePercent = useMemo(() => {
    const raw = platformLimits?.platform_fee_percent;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(15, parsed)) : DEFAULT_PLATFORM_FEE_PERCENT;
  }, [platformLimits?.platform_fee_percent]);

  const breakdown = useMemo(
    () => computeCommissionBreakdown(numericAmount, feePercent, commissionPayer),
    [numericAmount, feePercent, commissionPayer]
  );

  const parsedMilestones = useMemo(
    () =>
      milestones.map((m, idx) => ({
        title: m.title.trim(),
        amount: Number(normalizeDigits(m.amount).replace(/[^0-9]/g, '')) || 0,
        deadline_days: m.deadline_days ? Math.max(1, Math.min(365, Number(normalizeDigits(m.deadline_days).replace(/[^0-9]/g, '')) || 0)) : undefined,
        order: idx + 1,
      })),
    [milestones]
  );
  const milestoneSum = useMemo(() => parsedMilestones.reduce((acc, m) => acc + m.amount, 0), [parsedMilestones]);
  const milestonesValid =
    !stagedPayment ||
    (parsedMilestones.length >= 2 &&
      parsedMilestones.length <= 8 &&
      parsedMilestones.every((m) => m.title.length >= 2 && m.amount >= 1000) &&
      milestoneSum === numericAmount);

  const applyMilestoneTemplate = (tplId: '50_50' | '30_70' | '30_30_40' | 'equal' | 'custom', customCount?: number) => {
    setMilestoneTemplate(tplId);
    const tpl = MILESTONE_TEMPLATES.find((t) => t.id === tplId);
    if (tpl && tpl.percentages.length >= 2) {
      let running = 0;
      const items = tpl.percentages.map((pct, idx) => {
        const isLast = idx === tpl.percentages.length - 1;
        const amt = numericAmount > 0 ? (isLast ? Math.max(0, numericAmount - running) : Math.floor((numericAmount * pct) / 100)) : 0;
        running += amt;
        return {
          title: tpl.titles[idx] || `مرحله ${idx + 1}`,
          amount: amt > 0 ? String(amt) : '',
          percentage: pct,
          deadline_days: '',
        };
      });
      setMilestones(items);
      return;
    }

    if (tplId === 'equal') {
      const count = Math.max(2, Math.min(8, customCount || milestones.length || 2));
      const base = numericAmount > 0 ? Math.floor(numericAmount / count) : 0;
      const remainder = numericAmount > 0 ? numericAmount - base * count : 0;
      const pct = Math.floor(100 / count);
      setMilestones((prev) =>
        Array.from({ length: count }).map((_, idx) => ({
          title: prev[idx]?.title?.trim() || `مرحله ${idx + 1}`,
          amount: numericAmount > 0 ? String(idx === count - 1 ? base + remainder : base) : '',
          percentage: idx === count - 1 ? 100 - pct * (count - 1) : pct,
          deadline_days: prev[idx]?.deadline_days || '',
        }))
      );
    }
  };

  useEffect(() => {
    if (!stagedPayment || numericAmount <= 0 || milestoneTemplate === 'custom') return;
    if (milestoneTemplate === 'equal') {
      const count = Math.max(2, milestones.length);
      const base = Math.floor(numericAmount / count);
      const remainder = numericAmount - base * count;
      setMilestones((prev) =>
        prev.map((m, idx) => ({
          ...m,
          amount: String(idx === prev.length - 1 ? base + remainder : base),
        }))
      );
    } else {
      const tpl = MILESTONE_TEMPLATES.find((t) => t.id === milestoneTemplate);
      if (tpl && tpl.percentages.length >= 2) {
        let running = 0;
        setMilestones((prev) =>
          tpl.percentages.map((pct, idx) => {
            const isLast = idx === tpl.percentages.length - 1;
            const amt = isLast ? Math.max(0, numericAmount - running) : Math.floor((numericAmount * pct) / 100);
            running += amt;
            return {
              title: prev[idx]?.title || tpl.titles[idx] || `مرحله ${idx + 1}`,
              amount: String(amt),
              percentage: pct,
              deadline_days: prev[idx]?.deadline_days || '',
            };
          })
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericAmount, stagedPayment]);

  const parsedCounterpartyPhone = parseIranMobile(counterpartyPhone);
  const cleanCounterpartyPhone = normalizeDigits(counterpartyPhone).replace(/[^0-9]/g, '');
  const ownCorePhone = getPhoneCore10(String(user?.phone_number || ''));
  const isSameAsOwnPhone = Boolean(
    ownCorePhone && parsedCounterpartyPhone.valid && ownCorePhone === parsedCounterpartyPhone.core10
  );

  const minDealLimit = Math.max(1000, Number(platformLimits?.min_deal_amount || 10000));
  const maxDealLimit = Number(user?.max_deal_amount || platformLimits?.default_max_deal_amount || 0);
  const maxActiveDealsLimit = Number(user?.max_active_deals || platformLimits?.default_max_active_deals || 0);
  const activeDealsCount = (Array.isArray(contracts) ? contracts : []).filter(
    (c: any) => !['completed', 'cancelled'].includes(normalizeDealStatus(c?.status))
  ).length;

  const activeCategoryMeta = getCategoryMeta(category);
  const myRoleShort = role === 'seller' ? activeCategoryMeta.sellerShort : activeCategoryMeta.buyerShort;
  const counterpartyPromptLabel = role === 'seller' ? activeCategoryMeta.buyerTitle : activeCategoryMeta.sellerTitle;

  const quickTemplates = [
    {
      label: 'طراحی وب‌سایت / اپلیکیشن',
      summary: 'تحویل سورس‌کد و تست روی دامنه کارفرما',
      title: 'طراحی و پیاده‌سازی وب‌سایت اختصاصی',
      category: 'DEV' as CanonicalCategoryCode,
      deadline: '14',
      freeEdits: '3',
      inspectionHours: '72',
      description: '- تحویل سورس‌کد کامل و تست فنی نهایی روی دامنه کارفرما\n- پشتیبانی رفع باگ به مدت ۷ روز پس از تحویل نهایی',
    },
    {
      label: 'طراحی لوگو و رابط کاربری (UI/UX)',
      summary: 'فایل لایه‌باز + ۲ نوبت ویرایش رایگان',
      title: 'طراحی لوگو، هویت بصری و رابط کاربری',
      category: 'DESIGN' as CanonicalCategoryCode,
      deadline: '7',
      freeEdits: '2',
      inspectionHours: '48',
      description: '- تحویل فایل نهایی با کیفیت اصلی به همراه فایل لایه‌باز\n- اعمال حداکثر ۲ نوبت اصلاحات مطابق بریف اولیه',
    },
    {
      label: 'تحقیق، مقاله و شبیه‌سازی پژوهشی',
      summary: 'تحویل فایل ورد/کد + اصلاحات طبق نظر استاد',
      title: 'انجام پروژه پژوهشی، ترجمه و تحلیل داده',
      category: 'ACADEMIC' as CanonicalCategoryCode,
      deadline: '7',
      freeEdits: '2',
      inspectionHours: '48',
      description: '- تحویل گزارش کامل به همراه فایل‌های تحلیل و مراجع\n- اعمال اصلاحات مورد نیاز طبق چارچوب توافق‌شده',
    },
    {
      label: 'دوره آموزشی / منتورینگ تخصصی',
      summary: 'برگزاری جلسات آنلاین + جزوه و تمرین',
      title: 'جلسات آموزش و مشاوره تخصصی پروژه محور',
      category: 'TEACHING' as CanonicalCategoryCode,
      deadline: '14',
      freeEdits: '1',
      inspectionHours: '48',
      description: '- برگزاری منظم جلسات در زمان‌های توافق‌شده داخل پلتفرم\n- ارائه فایل ضبط‌شده و جزوه در پایان هر جلسه',
    },
  ];

  const quickAmounts = [
    { label: '۵۰۰ هزار', value: '500000' },
    { label: '۱ میلیون', value: '1000000' },
    { label: '۲ میلیون', value: '2000000' },
    { label: '۵ میلیون', value: '5000000' },
    { label: '۱۰ میلیون', value: '10000000' },
    { label: '۲۵ میلیون', value: '25000000' },
  ];

  const clauseSnippets = [
    {
      title: 'تایید نهایی توسط کارفرما',
      text: 'تحویل نهایی پس از بررسی کامل و تایید کارفرما در سامانه یا ربات میانجی نهایی می‌شود.',
    },
    {
      title: 'ارسال مستندات فقط داخل میانجی',
      text: 'تمامی فایل‌ها، کد رهگیری و مستندات صرفاً داخل گفتگوی همین قرارداد ثبت شود تا در صورت داوری قابل استناد باشد.',
    },
    {
      title: 'ضمانت کیفیت در مهلت بازرسی',
      text: 'ضمانت تطابق خروجی با مشخصات توافق‌شده در بازه بازرسی برقرار است.',
    },
    {
      title: 'تغییرات خارج از توافق اولیه',
      text: 'هرگونه تغییر یا درخواست جدید خارج از شرح تعهدات اولیه مشمول زمان و هزینه جداگانه است.',
    },
  ];

  const goToStep = (target: WizardStep) => {
    setFormError('');
    setDirection(target >= step ? 1 : -1);
    setStep(target);
  };

  const canJumpToStep = (target: WizardStep) => {
    if (target <= step) return true;
    if (target >= 4 && title.trim().length < 3) return false;
    if (target >= 5 && (!numericAmount || numericAmount < minDealLimit || (maxDealLimit > 0 && numericAmount > maxDealLimit))) return false;
    if (target >= 9 && !milestonesValid) return false;
    if (target >= 10 && ((counterpartyPhone.trim().length > 0 && !parsedCounterpartyPhone.valid) || isSameAsOwnPhone)) return false;
    return true;
  };

  const validateCurrentAndNext = () => {
    setFormError('');
    if (user?.is_deal_locked) {
      setFormError('امکان ثبت معامله جدید برای حساب شما محدود (قفل) شده است.');
      return;
    }
    if (step === 1) {
      if (maxActiveDealsLimit > 0 && activeDealsCount >= maxActiveDealsLimit) {
        setFormError(`شما به سقف مجاز معاملات فعال همزمان (${maxActiveDealsLimit} معامله) رسیده‌اید.`);
        return;
      }
      goToStep(2);
      return;
    }
    if (step === 2) {
      goToStep(3);
      return;
    }
    if (step === 3) {
      if (title.trim().length < 3) {
        setFormError('لطفاً یک عنوان کوتاه و مشخص برای قرارداد (حداقل ۳ کاراکتر) بنویسید.');
        return;
      }
      goToStep(4);
      return;
    }
    if (step === 4) {
      if (!numericAmount || numericAmount < minDealLimit) {
        setFormError(`مبلغ معامله باید حداقل ${minDealLimit.toLocaleString()} تومان باشد.`);
        return;
      }
      if (maxDealLimit > 0 && numericAmount > maxDealLimit) {
        setFormError(`سقف مجاز مبلغ هر معامله برای حساب شما ${maxDealLimit.toLocaleString()} تومان است.`);
        return;
      }
      goToStep(5);
      return;
    }
    if (step === 5) {
      const d = Number(normalizeDigits(deadlineDays).replace(/[^0-9]/g, '')) || 0;
      if (d < 1 || d > 365) {
        setFormError('مهلت تحویل باید بین ۱ تا ۳۶۵ روز باشد.');
        return;
      }
      goToStep(6);
      return;
    }
    if (step === 6) {
      goToStep(7);
      return;
    }
    if (step === 7) {
      goToStep(8);
      return;
    }
    if (step === 8) {
      if (stagedPayment) {
        if (parsedMilestones.length < 2 || parsedMilestones.length > 8) {
          setFormError('پرداخت مرحله‌ای باید بین ۲ تا ۸ مرحله داشته باشد.');
          return;
        }
        if (parsedMilestones.some((m) => m.title.length < 2 || m.amount < 1000)) {
          setFormError('عنوان هر مرحله (حداقل ۲ کاراکتر) و مبلغ هر مرحله (حداقل ۱,۰۰۰ تومان) الزامی است.');
          return;
        }
        if (milestoneSum !== numericAmount) {
          setFormError(
            `مجموع مبالغ مراحل (${milestoneSum.toLocaleString()} تومان) باید دقیقاً برابر مبلغ کل (${numericAmount.toLocaleString()} تومان) باشد.`
          );
          return;
        }
      }
      goToStep(9);
      return;
    }
    if (step === 9) {
      if (counterpartyPhone.trim().length > 0 && !parsedCounterpartyPhone.valid) {
        setFormError('شماره همراه طرف مقابل معتبر نیست (مثال: 09123456789، 9123456789 یا +989123456789). اگر نمی‌خواهید وارد کنید فیلد را خالی بگذارید.');
        return;
      }
      if (isSameAsOwnPhone) {
        setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد.');
        return;
      }
      goToStep(10);
    }
  };

  const adjustCounter = (kind: 'deadline' | 'edits', delta: number, min: number, max: number) => {
    const raw = kind === 'deadline' ? deadlineDays : freeEdits;
    const current = Number(normalizeDigits(raw).replace(/[^0-9]/g, '')) || 0;
    const next = Math.min(max, Math.max(min, current + delta));
    if (kind === 'deadline') setDeadlineDays(String(next));
    else setFreeEdits(String(next));
  };

  const handleSaveLocalDraftAndExit = async () => {
    setDraftSavedAt('saving');
    await saveDealDraft({
      id: draftId,
      title: title.trim(),
      amount: amountInput,
      role,
      phone: counterpartyPhone,
      category,
      deadline: deadlineDays,
      free_edits: Number(freeEdits || 0),
      revisions: freeEdits,
      inspection_hours: inspectionHours,
      commission_payer: commissionPayer,
      description,
      staged_payment: stagedPayment,
      is_milestone: stagedPayment,
      milestone_template: milestoneTemplate,
      milestones: milestones.map((m) => ({
        title: m.title,
        amount: m.amount,
        ...(m.percentage !== undefined ? { percentage: m.percentage } : {}),
        ...(m.deadline_days ? { deadline_days: Number(m.deadline_days) } : {}),
      })),
      step,
      updated_at: new Date().toISOString(),
    });
    notify('پیش‌نویس در بخش «پیش‌نویس‌ها» ذخیره شد', 'success');
    onBack();
  };

  const handleSubmit = async (submitStatus: 'pending_party_b' | 'draft') => {
    setFormError('');
    const titleTrim = title.trim();

    if (user?.is_deal_locked) {
      setFormError('امکان ثبت معامله جدید برای حساب شما محدود (قفل) شده است');
      return;
    }
    if (maxActiveDealsLimit > 0 && activeDealsCount >= maxActiveDealsLimit) {
      setFormError(`سقف مجاز معاملات فعال همزمان (${maxActiveDealsLimit} معامله) تکمیل شده است`);
      return;
    }
    if (!titleTrim || !numericAmount) {
      setFormError('لطفاً عنوان و مبلغ معامله را کامل وارد کنید');
      return;
    }
    if (numericAmount < minDealLimit) {
      setFormError(`مبلغ معامله باید حداقل ${minDealLimit.toLocaleString()} تومان باشد`);
      return;
    }
    if (maxDealLimit > 0 && numericAmount > maxDealLimit) {
      setFormError(`حداکثر مبلغ مجاز هر معامله برای حساب شما ${maxDealLimit.toLocaleString()} تومان است`);
      return;
    }
    if (counterpartyPhone.trim().length > 0 && !parsedCounterpartyPhone.valid) {
      setFormError('شماره همراه طرف مقابل معتبر نیست (نمونه: 09123456789). می‌توانید آن را خالی بگذارید');
      return;
    }
    if (isSameAsOwnPhone) {
      setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد');
      return;
    }
    if (stagedPayment && !milestonesValid) {
      setFormError('مبالغ و عناوین مراحل پرداخت با مبلغ کل معامله مطابقت ندارد');
      return;
    }

    setLoading(submitStatus);
    try {
      const deadlineNum = Math.max(1, Math.min(365, Number(normalizeDigits(deadlineDays).replace(/[^0-9]/g, '')) || 7));
      const freeEditsNum = Math.max(0, Math.min(50, Number(normalizeDigits(freeEdits).replace(/[^0-9]/g, '')) || 0));
      const normalizedPhone = parsedCounterpartyPhone.valid ? parsedCounterpartyPhone.local : '';

      const res = await apiFetch<{ success: boolean; deal: any }>('/api/deals', {
        method: 'POST',
        body: JSON.stringify({
          title: titleTrim.slice(0, 200),
          category,
          amount: numericAmount,
          role,
          ...(normalizedPhone ? { phone: normalizedPhone } : {}),
          ...(!normalizedPhone && prefillTargetUser?.id ? { target_user_id: prefillTargetUser.id } : {}),
          description: description.trim().slice(0, 2000),
          deadline: deadlineNum,
          free_edits: freeEditsNum,
          inspection_hours: String(inspectionHours || '48').slice(0, 10),
          commission_payer: commissionPayer,
          staged_payment: stagedPayment,
          is_milestone: stagedPayment,
          save_as_draft: submitStatus === 'draft',
          status: submitStatus,
          ...(stagedPayment
            ? {
                milestones: parsedMilestones.map((m) => ({
                  title: m.title,
                  amount: m.amount,
                  ...(m.deadline_days ? { deadline_days: m.deadline_days } : {}),
                })),
              }
            : {}),
        }),
      });

      await deleteDealDraft(draftId);
      setCreatedContract(res.deal);
      onCreated?.(res.deal);
      notify(
        submitStatus === 'pending_party_b'
          ? `قرارداد ${res.deal.contract_id} با موفقیت ثبت شد و لینک ربات آماده ارسال است`
          : `پیش‌نویس ${res.deal.contract_id} با ربات تلگرام همگام و ذخیره شد`,
        'success'
      );
    } catch (err: any) {
      setFormError(err?.message || 'خطا در ثبت قرارداد');
      notify(err?.message || 'خطا در ثبت قرارداد', 'error');
    } finally {
      setLoading(null);
    }
  };

  const resetWizardForNewContract = () => {
    setCreatedContract(null);
    setDraftId(`draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    setStep(1);
    setDirection(1);
    setTitle('');
    setAmountInput('');
    setDescription('');
    setCounterpartyPhone('');
    setDeadlineDays('7');
    setInspectionHours('48');
    setFreeEdits('2');
    setCommissionPayer('freelancer');
    setStagedPayment(false);
    setMilestoneTemplate('50_50');
    setMilestones([
      { title: 'مرحله اول: پیش‌پرداخت و شروع کار', amount: '', percentage: 50, deadline_days: '' },
      { title: 'مرحله دوم: تحویل نهایی و تسویه', amount: '', percentage: 50, deadline_days: '' },
    ]);
    setAppliedTemplateLabel('');
    setFormError('');
  };

  // POST-SUBMIT IN-PAGE SUCCESS & BOT SYNC INVITE CARD
  if (createdContract) {
    const cid = String(createdContract.contract_id || createdContract.id);
    const botLink = createdContract.bot_link || buildTelegramBotDealLink(cid, botUsername);
    const webInviteLink = buildDealInviteUrl(cid, createdContract.invite_token || `c_${cid}`);
    const shareText = `🤝 دعوت به قرارداد امن میانجی\nعنوان: ${createdContract.title}\nشناسه: ${cid}\nمبلغ: ${Number(createdContract.amount || 0).toLocaleString()} تومان\n\nبرای مشاهده، امضا و پیگیری در ربات تلگرام میانجی لمس کنید:\n${botLink}`;

    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-2xl mx-auto space-y-4 pb-12"
      >
        <div className="card-obsidian rounded-3xl p-5 md:p-7 space-y-5 border border-emerald-500/35">
          <div className="flex flex-col items-center text-center space-y-2.5">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-500 flex items-center justify-center">
              <CheckCircle2 size={30} />
            </div>
            <div>
              <span className="text-[11px] font-black text-emerald-600 dark:text-emerald-400 block">
                {createdContract.status === 'draft'
                  ? 'پیش‌نویس قرارداد در دیتابیس مشترک ذخیره شد'
                  : 'قرارداد با موفقیت ثبت و با ربات تلگرام همگام شد'}
              </span>
              <h2 className="text-lg md:text-xl font-black text-slate-900 dark:text-white mt-1">
                {createdContract.title}
              </h2>
              <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-blue-500/10 border border-blue-500/25">
                <span className="text-xs font-mono font-black text-blue-600 dark:text-blue-300 select-all" dir="ltr">
                  {cid}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(cid);
                      notify('کد معامله کپی شد', 'success');
                    } catch {}
                  }}
                  className="text-[10px] font-black text-blue-700 dark:text-blue-200 hover:underline flex items-center gap-1"
                >
                  <Copy size={11} />
                  <span>کپی کد</span>
                </button>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-300 mt-1.5">
                طرف مقابل می‌تواند پیش از پیوستن، با اسکن QR یا وارد کردن همین کد در اپلیکیشن، قرارداد را مشاهده و امضا کند.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-center">
            <div className="p-3 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08]">
              <span className="text-[10px] text-slate-500 dark:text-slate-400 block">مبلغ کل</span>
              <span className="text-xs font-black text-slate-900 dark:text-white tabular-nums">
                {Number(createdContract.amount || 0).toLocaleString()} تومان
              </span>
            </div>
            <div className="p-3 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08]">
              <span className="text-[10px] text-slate-500 dark:text-slate-400 block">وضعیت فعلی</span>
              <span className="text-xs font-black text-sky-600 dark:text-sky-300">
                {getDealStatusMeta(createdContract.status).shortLabel}
              </span>
            </div>
            <div className="p-3 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] col-span-2 sm:col-span-1">
              <span className="text-[10px] text-slate-500 dark:text-slate-400 block">پرداخت‌کننده کارمزد</span>
              <span className="text-xs font-black text-slate-900 dark:text-white">
                {getCommissionPayerLabel(createdContract.commission_payer)}
              </span>
            </div>
          </div>

          {/* Direct Telegram Bot Deep Link + QR */}
          <div className="p-4 rounded-2xl bg-sky-500/10 border border-sky-500/30 space-y-3.5">
            <div className="flex items-start gap-2.5 text-right">
              <Send size={17} className="text-sky-600 dark:text-sky-300 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <h3 className="text-xs font-black text-slate-900 dark:text-white">
                  لینک دعوت مستقیم در ربات تلگرام میانجی
                </h3>
                <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                  این لینک را برای طرف مقابل بفرستید تا با لمس آن مستقیم وارد همین قرارداد در ربات تلگرام شود و آن را امضا کند:
                </p>
              </div>
            </div>

            <div className="p-2.5 rounded-xl bg-white dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between gap-2">
              <span className="text-[11px] font-mono text-blue-600 dark:text-sky-300 truncate select-all" dir="ltr">
                {botLink}
              </span>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(botLink);
                    notify('لینک دعوت ربات تلگرام کپی شد', 'success');
                  } catch {
                    notify(botLink, 'info');
                  }
                }}
                className="h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black flex items-center gap-1 shrink-0"
              >
                <Copy size={13} />
                <span>کپی</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <a
                href={botLink}
                target="_blank"
                rel="noopener noreferrer"
                className="h-10 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-black flex items-center justify-center gap-1.5 transition-colors"
              >
                <ExternalLink size={14} />
                <span>باز کردن قرارداد در ربات</span>
              </a>
              <a
                href={`https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(shareText)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="h-10 rounded-xl bg-white dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] text-slate-800 dark:text-white text-xs font-black flex items-center justify-center gap-1.5 hover:border-blue-500/40 transition-colors"
              >
                <Share2 size={14} />
                <span>اشتراک‌گذاری در تلگرام</span>
              </a>
            </div>

            <div className="pt-2 border-t border-sky-500/20 flex flex-col sm:flex-row items-center gap-4">
              <div className="p-2.5 bg-white rounded-2xl border border-slate-200 shrink-0">
                <QRCodeSVG value={botLink} size={112} />
              </div>
              <div className="space-y-2 text-right flex-1">
                <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200 leading-relaxed">
                  در دیدار حضوری طرف مقابل می‌تواند این QR کد را با دوربین گوشی یا اسکنر داخل میانجی اسکن کند و فوری قرارداد را امضا نماید.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(webInviteLink);
                      notify('لینک نسخه وب قرارداد کپی شد', 'success');
                    } catch {}
                  }}
                  className="text-[11px] font-black text-blue-600 dark:text-blue-300 inline-flex items-center gap-1 hover:underline"
                >
                  <Link2 size={13} />
                  <span>کپی لینک نسخه وب (بدون نیاز به تلگرام)</span>
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => onSuccess(createdContract)}
              className="h-12 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black flex items-center justify-center gap-2 active:scale-95 transition-all"
            >
              <ShieldCheck size={16} />
              <span>مشاهده و مدیریت قرارداد</span>
            </button>
            <button
              type="button"
              onClick={resetWizardForNewContract}
              className="h-12 rounded-2xl bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-800 dark:text-white text-xs font-black flex items-center justify-center gap-2 active:scale-95 transition-all"
            >
              <Plus size={16} />
              <span>ثبت قرارداد جدید</span>
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14 }} className="space-y-4 md:space-y-5 max-w-5xl mx-auto pb-12">
      {/* Top Wizard Header & 10-Step Progress Bar */}
      <div className="card-obsidian p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => (step > 1 ? goToStep((step - 1) as WizardStep) : onBack())}
              className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-white/[0.08] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-transform shrink-0"
              aria-label="بازگشت"
            >
              <ChevronRight size={18} />
            </button>
            <div className="min-w-0">
              <h2 className="text-base md:text-lg font-black text-slate-900 dark:text-white leading-tight">
                ساخت قرارداد اسکرو (همگام با ربات)
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-300 font-bold mt-0.5 tabular-nums truncate">
                {draftSavedAt === 'saving'
                  ? 'در حال ذخیره خودکار پیش‌نویس...'
                  : draftSavedAt === 'saved'
                  ? '✓ پیش‌نویس خودکار ذخیره شد'
                  : maxActiveDealsLimit > 0
                  ? `ظرفیت فعال شما: ${activeDealsCount} از ${maxActiveDealsLimit} معامله`
                  : 'مطابق استاندارد قراردادهای ربات تلگرام میانجی'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {(title.trim() || amountInput.trim()) && (
              <button
                type="button"
                onClick={handleSaveLocalDraftAndExit}
                className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-200 text-[10px] font-black flex items-center gap-1 hover:bg-slate-200 dark:hover:bg-white/15 transition-colors"
                title="ذخیره پیش‌نویس و خروج"
              >
                <Save size={12} />
                <span className="hidden sm:inline">ذخیره و خروج</span>
              </button>
            )}
            <span className="text-xs font-black text-blue-600 dark:text-blue-300 tabular-nums whitespace-nowrap">
              گام {step} از ۱۰
            </span>
          </div>
        </div>

        {/* Interactive 10-Step Pillless Track */}
        <div className="space-y-1.5">
          <div className="grid grid-cols-5 md:grid-cols-10 gap-1">
            {WIZARD_STEPS.map((item) => {
              const isActive = step === item.num;
              const isCompleted = step > item.num;
              const clickable = canJumpToStep(item.num);
              return (
                <button
                  key={item.num}
                  type="button"
                  disabled={!clickable}
                  onClick={() => clickable && goToStep(item.num)}
                  className={`px-1.5 py-1.5 rounded-lg border text-center transition-all flex flex-col items-center justify-center gap-0.5 ${
                    isActive
                      ? 'bg-blue-600 text-white border-blue-500'
                      : isCompleted
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                      : 'bg-slate-50 dark:bg-[#18202e] text-slate-500 dark:text-slate-400 border-slate-200/70 dark:border-white/10 disabled:opacity-55'
                  }`}
                >
                  <span className="text-[10px] font-black tabular-nums leading-none">
                    {isCompleted ? '✓' : item.num}
                  </span>
                  <span className="text-[9px] font-bold truncate w-full leading-tight">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Split: Active Step + Sticky Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-8 card-obsidian rounded-2xl md:rounded-3xl p-4 md:p-6 overflow-hidden">
          <AnimatePresence mode="wait" custom={direction}>
            {/* STEP 1: CREATOR ROLE */}
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div>
                  <label className="text-sm font-black text-slate-900 dark:text-white block">
                    ۱. نقش شما در این قرارداد چیست؟
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    مشخص کنید به عنوان کارفرما (پرداخت‌کننده) یا مجری (انجام‌دهنده پروژه) قرارداد را می‌سازید.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setRole('buyer')}
                    className={`p-4 rounded-2xl border text-right transition-all flex items-start justify-between gap-3 active:scale-[0.98] ${
                      role === 'buyer'
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <div className="space-y-1.5 min-w-0">
                      <span className="text-sm font-black block">کارفرما (خریدار)</span>
                      <span className={`text-[11px] block leading-relaxed ${role === 'buyer' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                        مبلغ پروژه را در صندوق امانت میانجی قفل می‌کنم تا پس از تحویل تاییدشده برای مجری آزاد شود.
                      </span>
                    </div>
                    <Lock size={18} className="shrink-0 mt-0.5" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setRole('seller')}
                    className={`p-4 rounded-2xl border text-right transition-all flex items-start justify-between gap-3 active:scale-[0.98] ${
                      role === 'seller'
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <div className="space-y-1.5 min-w-0">
                      <span className="text-sm font-black block">مجری (پیمانکار)</span>
                      <span className={`text-[11px] block leading-relaxed ${role === 'seller' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                        پروژه یا خدمات را در مهلت مقرر تحویل می‌دهم و دستمزد تضمین‌شده دریافت می‌کنم.
                      </span>
                    </div>
                    <ArrowUpRight size={18} className="shrink-0 mt-0.5" />
                  </button>
                </div>
              </motion.div>
            )}

            {/* STEP 2: CATEGORY */}
            {step === 2 && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div>
                  <label className="text-sm font-black text-slate-900 dark:text-white block">
                    ۲. دسته‌بندی قرارداد را انتخاب کنید
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    شناسه قرارداد یکسان با ربات تلگرام (مثلاً DEV-... یا DSG-...) بر اساس دسته شما ساخته می‌شود.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {BOT_CATEGORY_LIST.map((cat) => {
                    const active = category === cat.code;
                    return (
                      <button
                        key={cat.code}
                        type="button"
                        onClick={() => setCategory(cat.code)}
                        className={`p-3.5 rounded-2xl border text-right flex items-start justify-between gap-3 transition-all active:scale-[0.98] ${
                          active
                            ? 'bg-blue-600/15 dark:bg-blue-500/20 border-blue-600 dark:border-blue-400 text-slate-900 dark:text-white'
                            : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 hover:border-blue-500/40'
                        }`}
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black">{cat.label}</span>
                          </div>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed">{cat.desc}</p>
                        </div>
                        <span
                          dir="ltr"
                          className={`text-[10px] font-mono font-black px-2 py-0.5 rounded-md shrink-0 ${
                            active
                              ? 'bg-blue-600 text-white'
                              : 'bg-white dark:bg-[#131924] text-slate-500 dark:text-slate-300 border border-slate-200/70 dark:border-white/10'
                          }`}
                        >
                          {cat.prefix}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {/* STEP 3: CONTRACT TITLE */}
            {step === 3 && (
              <motion.div
                key="step-3"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-sm font-black text-slate-900 dark:text-white">۳. عنوان پروژه / معامله</label>
                    <span className="text-[10px] font-bold text-rose-500 dark:text-rose-300">الزامی (حداقل ۳ کاراکتر)</span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    یک عنوان شفاف بنویسید تا هر دو طرف و ربات تلگرام به‌راحتی آن را بشناسند.
                  </p>
                  <input
                    placeholder={activeCategoryMeta.titlePlaceholder}
                    value={title}
                    maxLength={200}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setFormError('');
                    }}
                    className="input-refined !h-12 !px-4"
                  />
                </div>

                {/* Optional Ready Templates */}
                <div className="rounded-2xl border border-dashed border-slate-300 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#18202e]/70 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowTemplatesGuide((prev) => !prev)}
                    className="w-full px-3.5 py-3 flex items-center justify-between gap-2 text-right hover:bg-slate-100/70 dark:hover:bg-white/[0.04] transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-300 flex items-center justify-center shrink-0">
                        <Lightbulb size={15} />
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-black text-slate-800 dark:text-white block truncate">
                          قالب‌های آماده برای پرکردن سریع (اختیاری)
                        </span>
                        <span className="text-[10px] text-slate-500 dark:text-slate-400 block truncate">
                          {appliedTemplateLabel
                            ? `نمونه «${appliedTemplateLabel}» اعمال شد`
                            : 'عنوان، مهلت، ویرایش و توضیحات استاندارد را خودکار تنظیم می‌کند'}
                        </span>
                      </div>
                    </div>
                    <ChevronDown
                      size={16}
                      className={`text-slate-500 dark:text-slate-300 shrink-0 transition-transform ${showTemplatesGuide ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {showTemplatesGuide && (
                    <div className="px-3.5 pb-3.5 pt-2 border-t border-slate-200/70 dark:border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {quickTemplates.map((tpl) => (
                        <button
                          key={tpl.label}
                          type="button"
                          onClick={() => {
                            setTitle(tpl.title);
                            setCategory(tpl.category);
                            setDeadlineDays(tpl.deadline);
                            setFreeEdits(tpl.freeEdits);
                            setInspectionHours(tpl.inspectionHours);
                            setDescription(tpl.description);
                            setAppliedTemplateLabel(tpl.label);
                            setShowTemplatesGuide(false);
                            setFormError('');
                          }}
                          className="p-2.5 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] hover:border-blue-500/50 text-right transition-colors"
                        >
                          <span className="text-[11px] font-black text-slate-900 dark:text-white block">{tpl.label}</span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 block mt-0.5">{tpl.summary}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {/* STEP 4: TOTAL AMOUNT */}
            {step === 4 && (
              <motion.div
                key="step-4"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-sm font-black text-slate-900 dark:text-white">۴. مبلغ کل قرارداد (تومان)</label>
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 tabular-nums">
                      حداقل {minDealLimit.toLocaleString()} {maxDealLimit > 0 ? `تا ${maxDealLimit.toLocaleString()}` : ''} تومان
                    </span>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="مثلاً 5000000"
                    value={amountInput}
                    onChange={(e) => {
                      setAmountInput(normalizeDigits(e.target.value).replace(/[^0-9]/g, ''));
                      setFormError('');
                    }}
                    className="input-refined !h-13 text-center text-xl font-black font-sans tracking-wider tabular-nums"
                  />
                  {numericAmount > 0 && (
                    <div className="flex items-center justify-between px-1 text-[11px]">
                      <span className="font-black text-emerald-600 dark:text-emerald-400">{amountWords}</span>
                      <span className="font-mono font-bold text-slate-500 dark:text-slate-300 tabular-nums">
                        {numericAmount.toLocaleString()} تومان
                      </span>
                    </div>
                  )}

                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 pt-1">
                    {quickAmounts.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => {
                          setAmountInput(preset.value);
                          setFormError('');
                        }}
                        className={`min-h-[38px] px-2 rounded-xl text-[11px] font-bold border transition-all whitespace-nowrap shrink-0 active:scale-95 ${
                          amountInput === preset.value
                            ? 'bg-blue-600 text-white border-blue-500'
                            : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 hover:border-blue-500/40'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Live 2.5% Platform Fee Preview */}
                <div className="p-3.5 rounded-2xl bg-blue-500/10 border border-blue-500/25 space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-700 dark:text-slate-200">کارمزد پلتفرم میانجی</span>
                    <span className="font-black text-blue-600 dark:text-blue-300 tabular-nums">
                      {feePercent}٪ {numericAmount > 0 ? `(${breakdown.totalFee.toLocaleString()} تومان)` : ''}
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-300">
                    در گام ۷ می‌توانید مشخص کنید چه کسی این کارمزد را بپردازد (مجری، کارفرما یا مشترک ۵۰/۵۰).
                  </p>
                </div>
              </motion.div>
            )}

            {/* STEP 5: DELIVERY DEADLINE & INSPECTION */}
            {step === 5 && (
              <motion.div
                key="step-5"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div>
                  <label className="text-sm font-black text-slate-900 dark:text-white block">
                    ۵. مهلت تحویل پروژه (به روز)
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {activeCategoryMeta.sellerShort} از زمان قفل‌شدن وجه در امانت تا پایان این مهلت باید پروژه را تحویل دهد.
                  </p>
                </div>

                <div className="grid grid-cols-5 gap-2">
                  {['1', '3', '7', '14', '30'].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDeadlineDays(d)}
                      className={`h-11 rounded-xl text-xs font-black tabular-nums border transition-all ${
                        deadlineDays === d
                          ? 'bg-blue-600 text-white border-blue-500'
                          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      {d} روز
                    </button>
                  ))}
                </div>

                <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between gap-3">
                  <span className="text-xs font-black text-slate-800 dark:text-white">تنظیم عدد دلخواه (روز)</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => adjustCounter('deadline', -1, 1, 365)}
                      className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
                      aria-label="کاهش مهلت"
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      value={deadlineDays}
                      onChange={(e) => setDeadlineDays(normalizeDigits(e.target.value).replace(/[^0-9]/g, ''))}
                      className="w-20 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] text-center text-base font-black font-sans tabular-nums text-slate-900 dark:text-white outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => adjustCounter('deadline', 1, 1, 365)}
                      className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
                      aria-label="افزایش مهلت"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>

                {/* Inspection Window */}
                <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-2.5">
                  <span className="text-xs font-black text-slate-900 dark:text-white block">
                    مهلت بازرسی و تایید پس از تحویل (خودکار)
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { v: '24', l: '۲۴ ساعت' },
                      { v: '48', l: '۴۸ ساعت' },
                      { v: '72', l: '۷۲ ساعت' },
                    ].map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => setInspectionHours(opt.v)}
                        className={`h-9 rounded-xl text-[11px] font-black transition-colors ${
                          inspectionHours === opt.v
                            ? 'bg-blue-600 text-white'
                            : 'bg-white dark:bg-[#131924] border border-slate-200/70 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {/* STEP 6: FREE EDITS COUNT */}
            {step === 6 && (
              <motion.div
                key="step-6"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div>
                  <label className="text-sm font-black text-slate-900 dark:text-white block">
                    ۶. تعداد ویرایش رایگان مجاز
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    مشخص کنید کارفرما پس از تحویل کار تا چند بار می‌تواند بدون هزینه اضافه درخواست اصلاح ثبت کند.
                  </p>
                </div>

                <div className="grid grid-cols-5 gap-2">
                  {[
                    { v: '0', l: '۰ (بدون ویرایش)' },
                    { v: '1', l: '۱ بار' },
                    { v: '2', l: '۲ بار' },
                    { v: '3', l: '۳ بار' },
                    { v: '5', l: '۵ بار' },
                  ].map((opt) => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => setFreeEdits(opt.v)}
                      className={`h-11 px-1 rounded-xl text-[11px] font-black tabular-nums border transition-all ${
                        freeEdits === opt.v
                          ? 'bg-blue-600 text-white border-blue-500'
                          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      {opt.l}
                    </button>
                  ))}
                </div>

                <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between gap-3">
                  <span className="text-xs font-black text-slate-800 dark:text-white">تعداد دلخواه ویرایش رایگان</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => adjustCounter('edits', -1, 0, 50)}
                      className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
                      aria-label="کاهش ویرایش"
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      value={freeEdits}
                      onChange={(e) => setFreeEdits(normalizeDigits(e.target.value).replace(/[^0-9]/g, ''))}
                      className="w-20 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] text-center text-base font-black font-sans tabular-nums text-slate-900 dark:text-white outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => adjustCounter('edits', 1, 0, 50)}
                      className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
                      aria-label="افزایش ویرایش"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* STEP 7: COMMISSION PAYER */}
            {step === 7 && (
              <motion.div
                key="step-7"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div>
                  <label className="text-sm font-black text-slate-900 dark:text-white block">
                    ۷. پرداخت‌کننده کارمزد پلتفرم ({feePercent}٪)
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    مشخص کنید کارمزد نگهداری امن وجه از سهم مجری کسر شود، به مبلغ کارفرما اضافه شود یا بین هر دو تقسیم گردد.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  {(
                    [
                      {
                        id: 'freelancer' as CommissionPayer,
                        title: 'مجری (پیمانکار)',
                        desc: 'کارمزد از دستمزد نهایی مجری کسر می‌شود',
                      },
                      {
                        id: 'employer' as CommissionPayer,
                        title: 'کارفرما (خریدار)',
                        desc: 'کارمزد به مبلغ پرداختی کارفرما اضافه می‌شود',
                      },
                      {
                        id: 'shared' as CommissionPayer,
                        title: 'مشترک (۵۰٪ / ۵۰٪)',
                        desc: 'نصف کارمزد کارفرما و نصف آن مجری می‌پردازد',
                      },
                    ] as const
                  ).map((opt) => {
                    const active = commissionPayer === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setCommissionPayer(opt.id)}
                        className={`p-3.5 rounded-2xl border text-right space-y-1 transition-all ${
                          active
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-800 dark:text-slate-200'
                        }`}
                      >
                        <span className="text-xs font-black block">{opt.title}</span>
                        <span className={`text-[10px] block leading-relaxed ${active ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                          {opt.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Live Exact Breakdown Card */}
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-2 text-xs tabular-nums">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">مبلغ پایه قرارداد:</span>
                    <span className="font-black text-slate-900 dark:text-white">{numericAmount.toLocaleString()} تومان</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">کل کارمزد پلتفرم ({feePercent}٪):</span>
                    <span className="font-black text-blue-600 dark:text-blue-300">{breakdown.totalFee.toLocaleString()} تومان</span>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-slate-200/70 dark:border-white/10">
                    <span className="text-slate-600 dark:text-slate-300">مجموع پرداختی کارفرما:</span>
                    <span className="font-black text-amber-600 dark:text-amber-300">
                      {breakdown.employerTotalPayable.toLocaleString()} تومان
                      {breakdown.employerFee > 0 ? ` (شامل ${breakdown.employerFee.toLocaleString()} ت کارمزد)` : ''}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600 dark:text-slate-300">خالص دریافتی مجری:</span>
                    <span className="font-black text-emerald-600 dark:text-emerald-400">
                      {breakdown.netSellerAmount.toLocaleString()} تومان
                      {breakdown.freelancerFee > 0 ? ` (کسر ${breakdown.freelancerFee.toLocaleString()} ت کارمزد)` : ''}
                    </span>
                  </div>
                </div>
              </motion.div>
            )}

            {/* STEP 8: PAYMENT TYPE (SINGLE OR MILESTONES) */}
            {step === 8 && (
              <motion.div
                key="step-8"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <label className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                      <Layers size={16} className="text-blue-500" />
                      ۸. نحوه پرداخت و آزادسازی وجه
                    </label>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      پرداخت یکجا در پایان پروژه یا پرداخت مرحله‌ای با قالب‌های استاندارد ربات
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setStagedPayment(false)}
                    className={`p-3.5 rounded-2xl border text-right space-y-1 transition-all ${
                      !stagedPayment
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <span className="text-xs font-black block">پرداخت یکجا (کامل)</span>
                    <span className={`text-[10px] block ${!stagedPayment ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                      کل مبلغ یکجا قفل شده و پس از تحویل نهایی پروژه آزاد می‌شود.
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setStagedPayment(true);
                      if (numericAmount > 0 && milestones.every((m) => !m.amount)) {
                        applyMilestoneTemplate(milestoneTemplate);
                      }
                    }}
                    className={`p-3.5 rounded-2xl border text-right space-y-1 transition-all ${
                      stagedPayment
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <span className="text-xs font-black block">پرداخت مرحله‌ای (Milestones)</span>
                    <span className={`text-[10px] block ${stagedPayment ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                      مبلغ به ۲ تا ۸ مرحله تقسیم می‌شود و همگام با ربات گام‌به‌گام آزاد می‌گردد.
                    </span>
                  </button>
                </div>

                {stagedPayment && (
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-3.5">
                    {/* Preset Milestone Templates matching Telegram Bot */}
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-black text-slate-700 dark:text-slate-200 block">
                        الگوی تقسیم مراحل:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {MILESTONE_TEMPLATES.map((tpl) => {
                          const active = milestoneTemplate === tpl.id;
                          return (
                            <button
                              key={tpl.id}
                              type="button"
                              onClick={() => applyMilestoneTemplate(tpl.id)}
                              className={`h-8 px-3 rounded-xl text-[11px] font-black border transition-colors ${
                                active
                                  ? 'bg-blue-600 text-white border-blue-500'
                                  : 'bg-white dark:bg-[#131924] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                              }`}
                            >
                              {tpl.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 flex-wrap pt-1 border-t border-slate-200/70 dark:border-white/10">
                      <span className="text-[11px] font-black text-slate-700 dark:text-slate-200 tabular-nums">
                        مجموع مراحل: {milestoneSum.toLocaleString()} از {numericAmount.toLocaleString()} تومان
                      </span>
                      {milestones.length < 8 && (
                        <button
                          type="button"
                          onClick={() => {
                            setMilestoneTemplate('custom');
                            setMilestones((prev) => [
                              ...prev,
                              { title: `مرحله ${prev.length + 1}`, amount: '', percentage: undefined, deadline_days: '' },
                            ]);
                          }}
                          className="h-7 px-2.5 rounded-lg bg-blue-600 text-white text-[10px] font-black flex items-center gap-1"
                        >
                          <Plus size={12} />
                          افزودن مرحله
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      {milestones.map((ms, idx) => (
                        <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                          <div className="col-span-12 sm:col-span-5 flex items-center gap-1.5">
                            <span className="w-6 h-6 rounded-lg bg-blue-600/15 text-blue-600 dark:text-blue-300 text-[10px] font-black flex items-center justify-center shrink-0 tabular-nums">
                              {idx + 1}
                            </span>
                            <input
                              type="text"
                              placeholder={`عنوان مرحله ${idx + 1}`}
                              value={ms.title}
                              maxLength={120}
                              onChange={(e) => {
                                const nextVal = e.target.value;
                                setMilestones((prev) => prev.map((item, i) => (i === idx ? { ...item, title: nextVal } : item)));
                              }}
                              className="input-refined !h-10 !px-3 text-[13px] flex-1"
                            />
                          </div>

                          <div className="col-span-4 sm:col-span-2 relative">
                            <input
                              type="text"
                              inputMode="numeric"
                              dir="ltr"
                              placeholder="٪"
                              value={ms.percentage ?? (numericAmount > 0 && ms.amount ? Math.round((Number(ms.amount) / numericAmount) * 100) : '')}
                              onChange={(e) => {
                                const pct = Math.max(0, Math.min(100, Number(normalizeDigits(e.target.value).replace(/[^0-9]/g, '')) || 0));
                                setMilestoneTemplate('custom');
                                setMilestones((prev) =>
                                  prev.map((item, i) =>
                                    i === idx
                                      ? {
                                          ...item,
                                          percentage: pct,
                                          amount: numericAmount > 0 ? String(Math.floor((numericAmount * pct) / 100)) : item.amount,
                                        }
                                      : item
                                  )
                                );
                              }}
                              className="input-refined !h-10 !px-2 text-[13px] tabular-nums text-center"
                            />
                            <Percent size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                          </div>

                          <div className="col-span-6 sm:col-span-4">
                            <input
                              type="text"
                              inputMode="numeric"
                              dir="ltr"
                              placeholder="مبلغ (تومان)"
                              value={ms.amount}
                              onChange={(e) => {
                                const cleaned = normalizeDigits(e.target.value).replace(/[^0-9]/g, '');
                                setMilestoneTemplate('custom');
                                setMilestones((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, amount: cleaned, percentage: undefined } : item))
                                );
                              }}
                              className="input-refined !h-10 !px-3 text-[13px] tabular-nums text-center"
                            />
                          </div>

                          <div className="col-span-2 sm:col-span-1 flex justify-end">
                            {milestones.length > 2 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setMilestoneTemplate('custom');
                                  setMilestones((prev) => prev.filter((_, i) => i !== idx));
                                }}
                                className="w-9 h-9 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center hover:bg-rose-500/20"
                                aria-label="حذف مرحله"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {numericAmount > 0 && milestoneSum !== numericAmount && (
                      <p className="text-[11px] font-bold text-rose-600 dark:text-rose-300">
                        اختلاف مجموع مراحل با مبلغ کل: {Math.abs(numericAmount - milestoneSum).toLocaleString()} تومان (باید برابر مبلغ کل باشد)
                      </p>
                    )}
                  </div>
                )}
              </motion.div>
            )}

            {/* STEP 9: FULL DESCRIPTION & OPTIONAL COUNTERPARTY PHONE */}
            {step === 9 && (
              <motion.div
                key="step-9"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <label className="text-sm font-black text-slate-900 dark:text-white">۹. شرح کامل تعهدات و ضوابط قرارداد</label>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        این متن عیناً در ربات تلگرام و صفحه قرارداد نمایش داده می‌شود و ملاک داوری است.
                      </p>
                    </div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                      {description.length} / ۱۹۰۰
                    </span>
                  </div>

                  <textarea
                    maxLength={1900}
                    placeholder="جزئیات تحویل، فرمت فایل‌ها، استانداردهای کیفی و شرایط توافق را بنویسید (اختیاری)..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full h-28 bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] rounded-xl p-3.5 text-[14px] font-medium text-slate-900 dark:text-white focus:border-blue-500/60 outline-none transition-all resize-none leading-relaxed"
                  />

                  <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#18202e]/70 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowClauseHelper((prev) => !prev)}
                      className="w-full px-3 py-2.5 flex items-center justify-between gap-2 text-right"
                    >
                      <span className="text-[11px] font-black text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                        <HelpCircle size={14} className="text-blue-500 shrink-0" />
                        درج بندهای حقوقی آماده داخل شرح قرارداد (اختیاری)
                      </span>
                      <ChevronDown
                        size={15}
                        className={`text-slate-500 dark:text-slate-300 transition-transform ${showClauseHelper ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {showClauseHelper && (
                      <div className="px-3 pb-3 pt-1.5 border-t border-slate-200/70 dark:border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {clauseSnippets.map((clause) => {
                          const alreadyAdded = description.includes(clause.text);
                          return (
                            <button
                              key={clause.title}
                              type="button"
                              disabled={alreadyAdded}
                              onClick={() =>
                                setDescription((prev) =>
                                  prev.trim() ? `${prev.trim()}\n- ${clause.text}` : `- ${clause.text}`
                                )
                              }
                              className={`p-2.5 rounded-xl border text-right transition-all ${
                                alreadyAdded
                                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                                  : 'bg-white dark:bg-[#131924] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 hover:border-blue-500/40'
                              }`}
                            >
                              <span className="text-[11px] font-black block">
                                {alreadyAdded ? '✓ درج شد: ' : '+ '}
                                {clause.title}
                              </span>
                              <span className="text-[10px] text-slate-500 dark:text-slate-400 block mt-0.5 leading-snug">
                                {clause.text}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Optional Counterparty Phone */}
                <div className="space-y-2.5 pt-3 border-t border-slate-100 dark:border-white/[0.08]">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-black text-slate-900 dark:text-white">
                      شماره موبایل {counterpartyPromptLabel} (اختیاری)
                    </label>
                    <span className="text-[10px] font-bold text-blue-600 dark:text-blue-300">یا ارسال لینک ربات</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      inputMode="tel"
                      dir="ltr"
                      placeholder="0912... (اختیاری)"
                      value={counterpartyPhone}
                      onChange={(e) => {
                        setCounterpartyPhone(normalizeDigits(e.target.value));
                        setFormError('');
                      }}
                      className="input-refined !h-11 text-center font-sans tabular-nums tracking-wider flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setShowContactPicker(!showContactPicker)}
                      className={`min-h-[44px] px-3.5 rounded-xl border flex items-center justify-center gap-1.5 text-xs font-black transition-colors whitespace-nowrap shrink-0 ${
                        showContactPicker
                          ? 'bg-blue-600 text-white border-blue-500'
                          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-white hover:border-blue-500/40'
                      }`}
                    >
                      <Users size={15} />
                      <span>مخاطبین ({savedContacts.length})</span>
                    </button>
                  </div>

                  {counterpartyPhone.trim().length > 0 && parsedCounterpartyPhone.valid && !isSameAsOwnPhone && (
                    <p className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center justify-between px-1">
                      <span>فرمت استاندارد شناسایی شد</span>
                      <span dir="ltr" className="font-mono tabular-nums">{parsedCounterpartyPhone.local}</span>
                    </p>
                  )}

                  {cleanCounterpartyPhone.length === 0 && prefillTargetUser ? (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between gap-2 text-right">
                      <div className="min-w-0">
                        <p className="text-xs font-black text-slate-900 dark:text-white truncate">
                          طرف معامله: {prefillTargetUser.full_name}
                        </p>
                        <p className="text-[10px] text-emerald-700 dark:text-emerald-300 font-bold mt-0.5">
                          متصل از پیام‌رسان میانجی (شماره تماس برای حفظ حریم خصوصی مخفی است)
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPrefillTargetUser(null)}
                        className="text-slate-400 hover:text-rose-500 p-1 shrink-0"
                        title="حذف انتخاب"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ) : cleanCounterpartyPhone.length === 0 ? (
                    <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/25 flex items-start gap-2 text-right">
                      <Send size={15} className="text-blue-600 dark:text-blue-300 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed">
                        اگر شماره وارد نکنید، پس از ثبت بلافاصله لینک مستقیم ربات تلگرام (<span dir="ltr">?start=c_...</span>) و QR ساخته می‌شود تا برای طرف مقابل بفرستید.
                      </p>
                    </div>
                  ) : null}

                  {lookupState.status === 'checking' && (
                    <p className="text-[11px] text-blue-600 dark:text-blue-300 font-bold">در حال بررسی عضویت در میانجی...</p>
                  )}
                  {isSameAsOwnPhone && (
                    <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/35 flex items-center gap-2 text-right">
                      <AlertCircle size={16} className="text-rose-500 shrink-0" />
                      <p className="text-[11px] font-bold text-rose-600 dark:text-rose-300">
                        این شماره متعلق به حساب خودتان است؛ شماره طرف مقابل را وارد کنید یا خالی بگذارید.
                      </p>
                    </div>
                  )}
                  {lookupState.status === 'found' && lookupState.user && !isSameAsOwnPhone && (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/35 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <CheckCircle2 size={17} className="text-emerald-500 shrink-0" />
                        <div className="overflow-hidden">
                          <p className="text-xs font-black text-slate-900 dark:text-white truncate">{lookupState.user.full_name}</p>
                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">
                            {lookupState.user.kyc_status === 'verified' ? 'حساب احرازشده' : 'عضو میانجی'}
                          </p>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono font-bold text-slate-500 dark:text-slate-300 shrink-0" dir="ltr">
                        {lookupState.user.phone_number}
                      </span>
                    </div>
                  )}
                  {showContactPicker && (
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-2 max-h-44 overflow-y-auto">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[11px] font-black text-slate-700 dark:text-white">انتخاب از مخاطبین</span>
                        <button type="button" onClick={() => setShowContactPicker(false)} className="text-slate-400 p-1">
                          <X size={14} />
                        </button>
                      </div>
                      {savedContacts.length > 0 ? (
                        savedContacts.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setCounterpartyPhone(normalizeDigits(c.phone_number));
                              setShowContactPicker(false);
                            }}
                            className="w-full min-h-[40px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between text-right"
                          >
                            <span className="text-xs font-black text-slate-900 dark:text-white truncate">{c.full_name}</span>
                            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-300" dir="ltr">
                              {c.phone_number}
                            </span>
                          </button>
                        ))
                      ) : (
                        <p className="text-[11px] text-slate-500 text-center py-2">مخاطبی ثبت نشده است.</p>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {/* STEP 10: FINAL PREVIEW & SUBMIT */}
            {step === 10 && (
              <motion.div
                key="step-10"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.14 }}
                className="space-y-4"
              >
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white">۱۰. پیش‌نمایش نهایی قرارداد اسکرو</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    تمامی بندها دقیقاً با فرمت مشترک ربات تلگرام میانجی در دیتابیس ذخیره می‌شوند.
                  </p>
                </div>

                <div className="divide-y divide-slate-200/70 dark:divide-white/10 border border-slate-200/90 dark:border-white/[0.08] rounded-2xl bg-slate-50/70 dark:bg-[#18202e]">
                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">عنوان، دسته و نقش شما</span>
                      <p className="text-sm font-black text-slate-900 dark:text-white truncate">{title}</p>
                      <span className="text-[11px] text-blue-600 dark:text-blue-300 font-bold">
                        {activeCategoryMeta.label} ({activeCategoryMeta.prefix}) · شما {myRoleShort} هستید
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(3)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] rounded-lg min-h-[32px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">جزئیات مالی و کارمزد</span>
                      <p className="text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {numericAmount.toLocaleString()} تومان{' '}
                        <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300">({amountWords})</span>
                      </p>
                      <div className="text-[11px] text-slate-600 dark:text-slate-300 space-y-0.5 tabular-nums">
                        <p>
                          کارمزد ({feePercent}٪): {breakdown.totalFee.toLocaleString()} ت · پرداخت‌کننده: {getCommissionPayerLabel(commissionPayer)}
                        </p>
                        <p>
                          پرداختی کارفرما: {breakdown.employerTotalPayable.toLocaleString()} ت · دریافتی مجری: {breakdown.netSellerAmount.toLocaleString()} ت
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(7)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] rounded-lg min-h-[32px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">زمان‌بندی، ویرایش و پرداخت</span>
                      <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-700 dark:text-slate-200 tabular-nums">
                        <span>مهلت تحویل: {deadlineDays || '7'} روز</span>
                        <span>·</span>
                        <span>فرصت بازرسی: {inspectionHours} ساعت</span>
                        <span>·</span>
                        <span>ویرایش رایگان: {freeEdits || '0'} نوبت</span>
                      </div>
                      <span className="text-[11px] font-bold text-blue-600 dark:text-blue-300 block">
                        {stagedPayment ? `پرداخت مرحله‌ای (${parsedMilestones.length} مرحله)` : 'پرداخت یکجا پس از تایید نهایی'}
                      </span>
                      {stagedPayment && (
                        <div className="mt-1 space-y-0.5">
                          {parsedMilestones.map((m) => (
                            <p key={m.order} className="text-[10px] text-slate-500 dark:text-slate-300 tabular-nums">
                              {m.order}. {m.title}: {m.amount.toLocaleString()} تومان
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(8)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] rounded-lg min-h-[32px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="flex-1 overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">طرف مقابل و شرح تعهدات</span>
                      <p className="text-xs font-black text-slate-900 dark:text-white truncate">
                        {cleanCounterpartyPhone
                          ? `${counterpartyPhone}${lookupState.user?.full_name ? ` (${lookupState.user.full_name})` : ' (دعوت مستقیم با لینک ربات)'}`
                          : prefillTargetUser
                          ? `${prefillTargetUser.full_name} (انتخاب‌شده از گفتگو)`
                          : 'دعوت آزاد با لینک اختصاصی ربات تلگرام و QR'}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-300 mt-1 whitespace-pre-line line-clamp-3">
                        {description.trim() || 'مطابق ضوابط استاندارد امانت میانجی'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(9)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] rounded-lg min-h-[32px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {formError && (
            <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/35 rounded-xl flex items-center gap-2 text-right">
              <AlertCircle size={16} className="text-rose-500 shrink-0" />
              <p className="text-xs font-bold text-rose-600 dark:text-rose-300">{formError}</p>
            </div>
          )}

          {/* Wizard Footer Actions */}
          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-white/[0.08] flex flex-wrap items-center justify-between gap-2.5">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => goToStep((step - 1) as WizardStep)}
                className="min-h-[44px] px-4 rounded-xl bg-slate-50 dark:bg-white/[0.07] border border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
              >
                <ChevronRight size={15} />
                مرحله قبل
              </button>
            ) : (
              <button
                type="button"
                onClick={onBack}
                className="min-h-[44px] px-4 rounded-xl bg-slate-50 dark:bg-white/[0.07] border border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 text-xs font-bold active:scale-95 transition-all whitespace-nowrap shrink-0"
              >
                انصراف
              </button>
            )}

            {step < 10 ? (
              <button
                type="button"
                onClick={validateCurrentAndNext}
                className="min-h-[44px] flex-1 sm:flex-none sm:px-7 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs border border-white/15 flex items-center justify-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
              >
                ادامه به گام {step + 1}
                <ChevronLeft size={15} />
              </button>
            ) : (
              <div className="flex flex-1 sm:flex-none items-center gap-2 flex-wrap justify-end">
                <button
                  type="button"
                  onClick={() => handleSubmit('draft')}
                  disabled={loading !== null}
                  className="min-h-[44px] px-4 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-800 dark:text-white rounded-xl font-black text-xs active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Save size={14} />
                  {loading === 'draft' ? 'در حال ذخیره...' : 'ذخیره پیش‌نویس'}
                </button>
                <button
                  type="button"
                  onClick={() => handleSubmit('pending_party_b')}
                  disabled={loading !== null}
                  className="min-h-[44px] flex-1 sm:flex-none sm:px-6 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-xs border border-white/15 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  {loading === 'pending_party_b' ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <>
                      <Check size={16} />
                      ثبت نهایی و دریافت لینک ربات
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Sticky Live Contract Blueprint Sidebar */}
        <aside className="hidden lg:block lg:col-span-4 lg:sticky lg:top-24 card-obsidian rounded-3xl p-5 space-y-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-slate-900 dark:text-white">خلاصه زنده قرارداد</span>
            <Shield size={16} className="text-blue-600 dark:text-blue-300" />
          </div>

          <div className="space-y-1">
            <h4 className="text-sm font-black text-slate-900 dark:text-white leading-snug">
              {title.trim() || 'عنوان قرارداد شما'}
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-300">
              {activeCategoryMeta.label} ({activeCategoryMeta.prefix}) · شما {myRoleShort} هستید
            </p>
          </div>

          <div className="py-3.5 border-y border-slate-100 dark:border-white/[0.08] space-y-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-500 dark:text-slate-300 font-bold">مبلغ معامله</span>
              <span className="text-xl font-black text-slate-900 dark:text-white tabular-nums">
                {numericAmount > 0 ? numericAmount.toLocaleString() : '—'}{' '}
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">تومان</span>
              </span>
            </div>
            {numericAmount > 0 && (
              <p className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 text-left">{amountWords}</p>
            )}
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">مهلت تحویل</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{deadlineDays || '7'} روز</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">ویرایش رایگان</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{freeEdits || '0'} نوبت</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">فرصت بازرسی</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{inspectionHours} ساعت</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">نوع پرداخت</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">
                {stagedPayment ? `${parsedMilestones.length} مرحله‌ای` : 'یکجا'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">کارمزد پلتفرم</span>
              <span className="font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                {feePercent}٪ ({breakdown.totalFee.toLocaleString()} ت)
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">پرداخت‌کننده کارمزد</span>
              <span className="font-black text-slate-900 dark:text-white truncate max-w-[160px]">
                {getCommissionPayerLabel(commissionPayer)}
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-white/[0.08] space-y-1.5 text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
            <p className="font-black text-slate-800 dark:text-white">همگام‌سازی ۱۰۰٪ با ربات:</p>
            <p>۱. با ثبت نهایی، لینک دعوت مستقیم ربات با شناسه <span dir="ltr">{activeCategoryMeta.prefix}-...</span> تولید می‌شود.</p>
            <p>۲. طرف مقابل می‌تواند در ربات تلگرام یا سایت قرارداد را امضا و پیگیری کند.</p>
          </div>
        </aside>
      </div>
    </motion.div>
  );
}
