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
  CreditCard,
  Briefcase,
  Package,
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
  RotateCcw,
  Bookmark,
  Link2,
  Save,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch } from '../lib/apiClient';
import {
  DealDraftRecord,
  deleteDealDraft,
  fetchDealDrafts,
  isPendingPartyId,
  readLocalDealDrafts,
  saveDealDraft,
} from '../services/escrowService';
import type { PlatformLimits } from './AdminUserManager';

const normalizeDigits = (val: string) =>
  String(val || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();

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

// Convert integer amount in Toman to readable Persian words for typo prevention
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

const CATEGORY_META: Record<string, { label: string; desc: string }> = {
  digital: { label: 'خدمات دیجیتال', desc: 'طراحی، برنامه‌نویسی، سئو و مشاوره' },
  account: { label: 'اکانت و دارایی دیجیتال', desc: 'کانال، پیج، دامنه و اشتراک' },
  physical: { label: 'کالای فیزیکی', desc: 'تجهیزات، سخت‌افزار و ارسال پستی' },
  other: { label: 'سایر توافقات', desc: 'قراردادهای سفارشی و خاص' },
};

const STATUS_META: Record<
  string,
  {
    label: string;
    stepIndex: number; // 1..4
    toneClass: string;
    barClass: string;
  }
> = {
  draft: {
    label: 'پیش‌نویس',
    stepIndex: 1,
    toneClass: 'text-slate-600 dark:text-slate-300',
    barClass: 'bg-slate-400 dark:bg-slate-300',
  },
  awaiting_payment: {
    label: 'در انتظار پرداخت',
    stepIndex: 2,
    toneClass: 'text-amber-600 dark:text-amber-400',
    barClass: 'bg-amber-500',
  },
  active: {
    label: 'در حال اجرا (وجه قفل)',
    stepIndex: 3,
    toneClass: 'text-blue-600 dark:text-blue-400',
    barClass: 'bg-blue-600',
  },
  work_submitted: {
    label: 'تحویل شده · در انتظار تایید',
    stepIndex: 3,
    toneClass: 'text-purple-600 dark:text-purple-400',
    barClass: 'bg-purple-600',
  },
  completed: {
    label: 'تکمیل و تسویه‌شده',
    stepIndex: 4,
    toneClass: 'text-emerald-600 dark:text-emerald-400',
    barClass: 'bg-emerald-500',
  },
  cancelled: {
    label: 'لغو شده',
    stepIndex: 0,
    toneClass: 'text-rose-600 dark:text-rose-400',
    barClass: 'bg-rose-500',
  },
  disputed: {
    label: 'در حال داوری (اختلاف)',
    stepIndex: 3,
    toneClass: 'text-rose-600 dark:text-rose-400',
    barClass: 'bg-rose-600',
  },
};

function getDealPerspective(contract: any, currentUserId: any) {
  const uid = String(currentUserId || '');
  const isBuyer = uid !== '' && uid === String(contract?.buyer_id || '');
  const isSeller = uid !== '' && uid === String(contract?.seller_id || '');
  const status = String(contract?.status || 'draft');
  const isPendingInvite = Boolean(
    contract?.is_pending_counterparty ||
      isPendingPartyId(contract?.buyer_id) ||
      isPendingPartyId(contract?.seller_id)
  );

  let needsMyAction = false;
  let nextHint = '';

  if (status === 'draft') {
    if (isPendingInvite) {
      nextHint = 'در انتظار پیوستن طرف مقابل (ارسال لینک یا QR)';
    } else if (isBuyer) {
      needsMyAction = true;
      nextHint = 'اقدام شما: تایید پیش‌نویس و انتقال به پرداخت';
    } else {
      nextHint = 'در انتظار تایید پیش‌نویس توسط کارفرما';
    }
  } else if (status === 'awaiting_payment') {
    if (isBuyer) {
      needsMyAction = true;
      nextHint = 'اقدام شما: واریز و قفل امن وجه در امانت';
    } else {
      nextHint = 'در انتظار قفل شدن وجه توسط کارفرما';
    }
  } else if (status === 'active') {
    if (isSeller) {
      needsMyAction = true;
      nextHint = 'اقدام شما: انجام پروژه و ثبت تحویل کار';
    } else {
      nextHint = 'وجه در امانت قفل است · مجری در حال انجام کار';
    }
  } else if (status === 'work_submitted') {
    if (isBuyer) {
      needsMyAction = true;
      nextHint = 'اقدام شما: بررسی کار تحویلی و آزادسازی وجه';
    } else {
      nextHint = 'تحویل ثبت شده · در انتظار تایید نهایی کارفرما';
    }
  } else if (status === 'completed') {
    nextHint = 'قرارداد با موفقیت تکمیل و تسویه شده است';
  } else if (status === 'disputed') {
    needsMyAction = true;
    nextHint = 'پرونده اختلاف فعال · پیگیری و ثبت مدارک در داوری';
  } else if (status === 'cancelled') {
    nextHint = 'این قرارداد لغو شده است';
  }

  return {
    roleLabel: isBuyer ? 'کارفرما (خریدار)' : isSeller ? 'مجری (فروشنده)' : 'مشارکت‌کننده',
    isBuyer,
    isSeller,
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
  setView,
  searchQuery,
  setSearchQuery,
  onOpenQrScanner,
  onOpenDealChat,
}: {
  user: any;
  contracts: any[];
  platformLimits?: PlatformLimits;
  setView: (v: any) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onOpenQrScanner?: () => void;
  onOpenDealChat?: (contract: any) => void;
}) {
  const [filterStatus, setFilterStatus] = useState<'all' | 'needs_action' | 'active' | 'pending' | 'completed' | 'disputed' | 'drafts'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'buyer' | 'seller'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'amount_desc' | 'amount_asc'>('newest');
  const [displayMode, setDisplayMode] = useState<'cards' | 'table'>('cards');
  const [savedDrafts, setSavedDrafts] = useState<DealDraftRecord[]>(() => readLocalDealDrafts());

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
      const st = String(c?.status || 'draft');
      if (['active', 'work_submitted', 'disputed'].includes(st)) {
        escrowVolume += amt;
      }
      if (st === 'completed') {
        completedVolume += amt;
      }
      if (!['completed', 'cancelled'].includes(st)) {
        activeCount += 1;
      }
      if (getDealPerspective(c, user?.id).needsMyAction) {
        actionCount += 1;
      }
    }

    const maxActive = Number(user?.max_active_deals || platformLimits?.default_max_active_deals || 0);
    return { escrowVolume, completedVolume, activeCount, actionCount, maxActive };
  }, [list, user?.id, user?.max_active_deals, platformLimits?.default_max_active_deals]);

  const statusCounts = useMemo(() => {
    const counts = { all: 0, needs_action: 0, active: 0, pending: 0, completed: 0, disputed: 0 };
    for (const c of list) {
      const p = getDealPerspective(c, user?.id);
      if (roleFilter === 'buyer' && !p.isBuyer) continue;
      if (roleFilter === 'seller' && !p.isSeller) continue;

      counts.all += 1;
      if (p.needsMyAction) counts.needs_action += 1;
      if (['active', 'work_submitted'].includes(c.status)) counts.active += 1;
      if (['draft', 'awaiting_payment'].includes(c.status)) counts.pending += 1;
      if (c.status === 'completed') counts.completed += 1;
      if (['disputed', 'cancelled'].includes(c.status)) counts.disputed += 1;
    }
    return counts;
  }, [list, roleFilter, user?.id]);

  const filtered = useMemo(() => {
    const q = normalizeDigits(searchQuery || '').toLowerCase();
    const out = list.filter((c: any) => {
      const p = getDealPerspective(c, user?.id);
      if (roleFilter === 'buyer' && !p.isBuyer) return false;
      if (roleFilter === 'seller' && !p.isSeller) return false;

      if (filterStatus === 'needs_action' && !p.needsMyAction) return false;
      if (filterStatus === 'active' && !['active', 'work_submitted'].includes(c.status)) return false;
      if (filterStatus === 'pending' && !['draft', 'awaiting_payment'].includes(c.status)) return false;
      if (filterStatus === 'completed' && c.status !== 'completed') return false;
      if (filterStatus === 'disputed' && !['disputed', 'cancelled'].includes(c.status)) return false;

      if (!q) return true;
      const catLabel = CATEGORY_META[c.category || 'other']?.label || '';
      return (
        String(c.title || '').toLowerCase().includes(q) ||
        String(c.contract_id || '').toLowerCase().includes(q) ||
        catLabel.toLowerCase().includes(q) ||
        String(c.amount || '').includes(q)
      );
    });

    out.sort((a: any, b: any) => {
      if (sortBy === 'amount_desc') return Number(b.amount || 0) - Number(a.amount || 0);
      if (sortBy === 'amount_asc') return Number(a.amount || 0) - Number(b.amount || 0);
      return toMillis(b.createdAt || b.created_at) - toMillis(a.createdAt || a.created_at);
    });

    return out;
  }, [list, searchQuery, roleFilter, filterStatus, sortBy, user?.id]);

  const openContract = (contract: any) => {
    localStorage.setItem('selected_contract', JSON.stringify(contract));
    setView('detail');
  };

  const statusTabs = [
    { key: 'all', label: 'همه', count: statusCounts.all },
    { key: 'needs_action', label: 'نیازمند اقدام', count: statusCounts.needs_action },
    { key: 'active', label: 'در حال اجرا', count: statusCounts.active },
    { key: 'pending', label: 'در انتظار', count: statusCounts.pending },
    { key: 'completed', label: 'تکمیل‌شده', count: statusCounts.completed },
    { key: 'disputed', label: 'اختلاف / لغو', count: statusCounts.disputed },
    { key: 'drafts', label: 'پیش‌نویس‌ها', count: savedDrafts.length },
  ] as const;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14 }} className="space-y-5 pb-16">
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl md:text-2xl font-black text-slate-900 dark:text-white tracking-tight">معاملات من</h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mt-0.5">
            پیگیری وضعیت قراردادها، پیش‌نویس‌های ذخیره شده و وجوه در امانت
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenQrScanner && (
            <button
              type="button"
              onClick={onOpenQrScanner}
              className="h-10 px-3.5 rounded-xl card-obsidian text-slate-700 dark:text-white text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50 dark:hover:border-white/30 active:scale-95 whitespace-nowrap shrink-0"
            >
              <QrCode size={16} />
              <span>اسکن QR</span>
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

      {/* Deal Lock Warning if Restricted */}
      {user?.is_deal_locked && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/35 flex items-center gap-3 text-xs text-rose-700 dark:text-rose-300 font-bold">
          <Lock size={16} className="shrink-0" />
          <span>ثبت معامله جدید برای حساب شما توسط مدیریت محدود شده است.</span>
        </div>
      )}

      {/* Unfinished Drafts Quick Resume Banner */}
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

      {/* 4-Column Financial Summary Strip (Single Elevation, Tabular Figures) */}
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
          onClick={() => setFilterStatus(metrics.actionCount > 0 ? 'needs_action' : 'all')}
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
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" size={16} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="جستجو بر اساس عنوان، شناسه قرارداد (#M-...) یا مبلغ..."
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
            {/* Role Filter Segmented Control */}
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

            {/* Sort Selector */}
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

            {/* Desktop Card / Table Toggle */}
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

        {/* Interactive Status Segmented Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pt-1 border-t border-slate-100 dark:border-white/10">
          {statusTabs.map((tab) => {
            const active = filterStatus === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilterStatus(tab.key)}
                className={`min-h-[36px] px-3.5 py-1.5 rounded-xl text-[11px] font-black transition-all whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-50 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10'
                }`}
              >
                <span>{tab.label}</span>
                <span className={`text-[10px] tabular-nums ${active ? 'text-blue-100' : 'text-slate-400 dark:text-slate-400'}`}>
                  ({tab.count})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Results View: Saved Drafts, Populated Cards, Compact Ledger Table, or Empty State */}
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
              const catLabel = CATEGORY_META[d.category || 'other']?.label || 'سایر توافقات';
              const amt = Number(normalizeDigits(String(d.amount || '')).replace(/[^0-9]/g, '')) || 0;
              return (
                <div key={d.id} className="p-4 md:p-5 card-obsidian card-obsidian-interactive flex flex-col justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                      <span>
                        {catLabel} · گام {d.step || 1} از ۴
                      </span>
                      <span className="tabular-nums">{formatDateShortFa(d.updated_at)}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h3 className="text-sm md:text-base font-black text-slate-900 dark:text-white line-clamp-2">
                          {d.title?.trim() || 'پیش‌نویس بدون عنوان'}
                        </h3>
                        <p className="text-[11px] text-slate-500 dark:text-slate-300">
                          نقش شما: {d.role === 'buyer' ? 'کارفرما (خریدار)' : 'مجری (فروشنده)'}
                          {d.phone ? ` · طرف مقابل: ${d.phone}` : ' · دعوت با لینک/QR'}
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
                      onClick={() => handleDeleteDraft(d.id)}
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
                ? 'اولین قرارداد امن خود را با قفل تضمین وجه میانجی در کمتر از یک دقیقه بسازید.'
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
                  const st = STATUS_META[c.status] || STATUS_META.draft;
                  const p = getDealPerspective(c, user?.id);
                  const cat = CATEGORY_META[c.category || 'other']?.label || 'قرارداد امن';
                  const counterpartyDisplay = p.isPendingInvite
                    ? 'منتظر پیوستن با لینک/QR'
                    : p.isBuyer
                    ? c.seller_name || 'مجری'
                    : c.buyer_name || 'کارفرما';
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
                        {c.is_milestone && Array.isArray(c.milestones) && c.milestones.length >= 2 && (
                          <span className="block text-[10px] text-blue-600 dark:text-blue-300 font-bold mt-0.5 tabular-nums">
                            مرحله‌ای ({c.milestones.filter((m: any) => m.status === 'completed').length}/{c.milestones.length})
                          </span>
                        )}
                        {p.isPendingInvite && (
                          <span className="block text-[10px] text-blue-600 dark:text-blue-300 font-bold mt-0.5">
                            لینک/QR دعوت آماده
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
                          {onOpenDealChat && (
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
            const st = STATUS_META[c.status] || STATUS_META.draft;
            const p = getDealPerspective(c, user?.id);
            const catLabel = CATEGORY_META[c.category || 'other']?.label || 'سایر توافقات';
            const stages = ['پیش‌نویس', 'قفل وجه', 'اجرا و تحویل', 'تسویه'];
            const counterpartyDisplay = p.isPendingInvite
              ? 'منتظر پیوستن (لینک / QR)'
              : p.isBuyer
              ? c.seller_name || 'مجری'
              : c.buyer_name || 'کارفرما';

            return (
              <div
                key={c.contract_id || c.id}
                onClick={() => openContract(c)}
                className="p-4 md:p-5 card-obsidian card-obsidian-interactive cursor-pointer flex flex-col justify-between gap-4 group"
              >
                {/* Top Metadata Line (Unboxed text separators, Zero-Pill rule) */}
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

                  {/* Primary Title & Amount */}
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

                {/* 4-Stage Visual Progress Track */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-black flex items-center gap-1.5 ${st.toneClass}`}>
                        {c.status === 'completed' ? (
                          <CheckCircle2 size={13} />
                        ) : c.status === 'disputed' ? (
                          <Gavel size={13} />
                        ) : c.status === 'active' || c.status === 'work_submitted' ? (
                          <Lock size={13} />
                        ) : (
                          <Clock size={13} />
                        )}
                        {st.label}
                      </span>
                      {c.is_milestone && Array.isArray(c.milestones) && c.milestones.length >= 2 && (
                        <span className="text-[10px] font-black text-blue-600 dark:text-blue-300 tabular-nums shrink-0 flex items-center gap-1">
                          <Layers size={11} />
                          مرحله {c.milestones.filter((m: any) => m.status === 'completed').length}/{c.milestones.length}
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

                  {c.status !== 'cancelled' && (
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

                {/* Bottom Action Footer */}
                <div className="pt-3 border-t border-slate-100 dark:border-white/10 flex items-center justify-between gap-2">
                  <span
                    className={`text-[11px] font-bold truncate ${
                      p.needsMyAction ? 'text-amber-600 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {p.nextHint}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {onOpenDealChat && (
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
    </motion.div>
  );
}

function ClipboardListIcon() {
  return <FileText size={26} />;
}

// ============================================================================
// CREATE DEAL WIZARD ("ایجاد معامله جدید")
// ============================================================================
export function CreateDealView({
  user,
  contracts,
  platformLimits,
  onBack,
  onSuccess,
  notify,
}: {
  user: any;
  contracts: any[];
  platformLimits?: PlatformLimits;
  onBack: () => void;
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
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [direction, setDirection] = useState(1);
  const [formData, setFormData] = useState({
    title: '',
    amount: '',
    role: 'seller' as 'seller' | 'buyer',
    phone: '',
    deadline: '7',
    revisions: '2',
    inspectionHours: '48',
    description: '',
    category: 'digital' as 'digital' | 'physical' | 'account' | 'other',
  });
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [isMilestone, setIsMilestone] = useState(false);
  const [milestones, setMilestones] = useState<Array<{ title: string; amount: string }>>([
    { title: 'مرحله اول: پیش‌پرداخت و شروع کار', amount: '' },
    { title: 'مرحله دوم: تحویل نهایی و تایید', amount: '' },
  ]);
  const [showTemplatesGuide, setShowTemplatesGuide] = useState(false);
  const [appliedTemplateLabel, setAppliedTemplateLabel] = useState('');
  const [showAdvancedTerms, setShowAdvancedTerms] = useState(false);
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
        setFormData((prev) => ({
          ...prev,
          title: String(d.title || ''),
          amount: String(d.amount || ''),
          role: d.role === 'buyer' ? 'buyer' : 'seller',
          phone: normalizeDigits(String(d.phone || '')),
          deadline: String(d.deadline || '7'),
          revisions: String(d.revisions || '2'),
          inspectionHours: String(d.inspection_hours || '48'),
          description: String(d.description || ''),
          category: ['digital', 'physical', 'account', 'other'].includes(String(d.category)) ? (d.category as any) : 'digital',
        }));
        if (typeof d.is_milestone === 'boolean') setIsMilestone(d.is_milestone);
        if (Array.isArray(d.milestones) && d.milestones.length >= 2) {
          setMilestones(
            d.milestones.map((m) => ({
              title: String(m?.title || ''),
              amount: String(m?.amount || ''),
            }))
          );
        }
        if (d.step && d.step >= 1 && d.step <= 4) {
          setStep(d.step as 1 | 2 | 3 | 4);
        }
        setDraftSavedAt('saved');
      }
    } catch {}

    const prefill = localStorage.getItem('mianji_prefill_phone');
    if (prefill) {
      setFormData((prev) => ({ ...prev, phone: normalizeDigits(prefill) }));
      localStorage.removeItem('mianji_prefill_phone');
    }

    try {
      const tplRaw = localStorage.getItem('mianji_create_template');
      if (tplRaw) {
        const tpl = JSON.parse(tplRaw);
        localStorage.removeItem('mianji_create_template');
        if (tpl && tpl.title) {
          setFormData((prev) => ({
            ...prev,
            title: String(tpl.title || prev.title),
            category: ['digital', 'physical', 'account', 'other'].includes(String(tpl.category)) ? tpl.category : prev.category,
            deadline: String(tpl.deadline || prev.deadline),
            revisions: String(tpl.revisions ?? prev.revisions),
            inspectionHours: String(tpl.inspectionHours || prev.inspectionHours),
            description: String(tpl.description || prev.description),
            ...(tpl.role === 'buyer' || tpl.role === 'seller' ? { role: tpl.role } : {}),
            ...(tpl.suggestedAmount ? { amount: String(tpl.suggestedAmount) } : {}),
          }));
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
      formData.title.trim() ||
        formData.amount.trim() ||
        formData.phone.trim() ||
        formData.description.trim() ||
        step > 1
    );
    if (!hasMeaningfulContent || loading) return;

    setDraftSavedAt('saving');
    const timer = setTimeout(async () => {
      await saveDealDraft({
        id: draftId,
        title: formData.title.trim(),
        amount: formData.amount,
        role: formData.role,
        phone: formData.phone,
        category: formData.category,
        deadline: formData.deadline,
        revisions: formData.revisions,
        inspection_hours: formData.inspectionHours,
        description: formData.description,
        is_milestone: isMilestone,
        milestones,
        step,
        updated_at: new Date().toISOString(),
      });
      setDraftSavedAt('saved');
    }, 850);
    return () => clearTimeout(timer);
  }, [
    draftId,
    formData.title,
    formData.amount,
    formData.role,
    formData.phone,
    formData.category,
    formData.deadline,
    formData.revisions,
    formData.inspectionHours,
    formData.description,
    isMilestone,
    milestones,
    step,
    loading,
  ]);

  useEffect(() => {
    const cleanPhone = normalizeDigits(formData.phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      setLookupState({ status: 'idle' });
      return;
    }
    const timer = setTimeout(async () => {
      setLookupState({ status: 'checking' });
      try {
        const data = await apiFetch<{ success: boolean; user?: any }>(
          `/api/users/lookup?phone=${encodeURIComponent(cleanPhone)}`
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
  }, [formData.phone]);

  const numericAmount = Number(normalizeDigits(formData.amount).replace(/[^0-9]/g, '')) || 0;
  const amountWords = useMemo(() => numberToPersianWords(numericAmount), [numericAmount]);
  const feePercent = Math.max(0, Math.min(15, Number(platformLimits?.platform_fee_percent || 0)));
  const feeAmount = numericAmount > 0 ? Math.floor((numericAmount * feePercent) / 100) : 0;
  const netSellerAmount = Math.max(0, numericAmount - feeAmount);
  const parsedMilestones = useMemo(
    () =>
      milestones.map((m, idx) => ({
        title: m.title.trim(),
        amount: Number(normalizeDigits(m.amount).replace(/[^0-9]/g, '')) || 0,
        order: idx + 1,
      })),
    [milestones]
  );
  const milestoneSum = useMemo(
    () => parsedMilestones.reduce((acc, m) => acc + m.amount, 0),
    [parsedMilestones]
  );
  const milestonesValid =
    !isMilestone ||
    (parsedMilestones.length >= 2 &&
      parsedMilestones.length <= 8 &&
      parsedMilestones.every((m) => m.title.length >= 2 && m.amount >= 1000) &&
      milestoneSum === numericAmount);

  const splitMilestonesEvenly = (targetTotal: number, count = milestones.length) => {
    if (!targetTotal || count < 2) return;
    const base = Math.floor(targetTotal / count);
    const remainder = targetTotal - base * count;
    setMilestones((prev) =>
      prev.map((m, idx) => ({
        ...m,
        amount: String(idx === prev.length - 1 ? base + remainder : base),
      }))
    );
  };

  const cleanCounterpartyPhone = normalizeDigits(formData.phone).replace(/[^0-9]/g, '');
  const ownCleanPhone = normalizeDigits(String(user?.phone_number || '')).replace(/[^0-9]/g, '');
  const isSameAsOwnPhone = Boolean(
    ownCleanPhone && cleanCounterpartyPhone.length >= 10 && ownCleanPhone.slice(-10) === cleanCounterpartyPhone.slice(-10)
  );

  const minDealLimit = Math.max(1000, Number(platformLimits?.min_deal_amount || 10000));
  const maxDealLimit = Number(user?.max_deal_amount || platformLimits?.default_max_deal_amount || 0);
  const maxActiveDealsLimit = Number(user?.max_active_deals || platformLimits?.default_max_active_deals || 0);
  const activeDealsCount = (Array.isArray(contracts) ? contracts : []).filter(
    (c: any) => !['completed', 'cancelled'].includes(String(c?.status || ''))
  ).length;

  const categoryOptions = [
    { id: 'digital', label: 'خدمات و فریلنسری', desc: 'طراحی، برنامه‌نویسی، سئو، محتوا', icon: <Briefcase size={15} /> },
    { id: 'account', label: 'اکانت، کانال و دامنه', desc: 'کانال تلگرام، پیج، اشتراک دیجیتال', icon: <User size={15} /> },
    { id: 'physical', label: 'کالای فیزیکی', desc: 'موبایل، لپ‌تاپ، ارسال پستی', icon: <Package size={15} /> },
    { id: 'other', label: 'سایر توافقات', desc: 'سایر خرید و فروش‌های امن', icon: <SlidersHorizontal size={15} /> },
  ] as const;

  const roleMeta = useMemo(() => {
    if (formData.category === 'physical') {
      return {
        sellerTitle: 'فروشنده (ارسال‌کننده کالا)',
        sellerShort: 'فروشنده',
        sellerDesc: 'کالا را ارسال می‌کنم و بعد از تایید سلامت توسط خریدار پول را می‌گیرم',
        buyerTitle: 'خریدار (پرداخت‌کننده مبلغ)',
        buyerShort: 'خریدار',
        buyerDesc: 'پول را در امانت میانجی می‌گذارم تا بعد از تحویل و تست آزاد شود',
        counterpartyForSeller: 'خریدار (گیرنده کالا)',
        counterpartyForBuyer: 'فروشنده (ارسال‌کننده کالا)',
        titlePlaceholder: 'مثلاً: خرید آیفون ۱۳ پرو ۲۵۶ گیگ، ارسال کارت گرافیک...',
      };
    }
    if (formData.category === 'account') {
      return {
        sellerTitle: 'فروشنده / واگذارکننده',
        sellerShort: 'فروشنده',
        sellerDesc: 'مالکیت کانال، پیج یا اکانت را منتقل می‌کنم و پول تضمین‌شده می‌گیرم',
        buyerTitle: 'خریدار / تحویل‌گیرنده',
        buyerShort: 'خریدار',
        buyerDesc: 'وجه را امانت می‌گذارم تا پس از انتقال کامل دسترسی‌ها آزاد شود',
        counterpartyForSeller: 'خریدار اکانت یا کانال',
        counterpartyForBuyer: 'فروشنده اکانت یا کانال',
        titlePlaceholder: 'مثلاً: انتقال مالکیت کانال تلگرام، واگذاری اکانت اسپاتیفای...',
      };
    }
    return {
      sellerTitle: 'مجری / انجام‌دهنده کار',
      sellerShort: 'مجری',
      sellerDesc: 'پروژه یا خدمات را تحویل می‌دهم و دستمزد تضمین‌شده می‌گیرم',
      buyerTitle: 'کارفرما / سفارش‌دهنده',
      buyerShort: 'کارفرما',
      buyerDesc: 'مبلغ را در امانت میانجی می‌گذارم تا بعد از تحویل کار آزاد شود',
      counterpartyForSeller: 'کارفرما (پرداخت‌کننده)',
      counterpartyForBuyer: 'مجری (انجام‌دهنده کار)',
      titlePlaceholder: 'مثلاً: طراحی فروشگاه اینترنتی، تدوین ویدیو تبلیغاتی...',
    };
  }, [formData.category]);

  const myRoleShort = formData.role === 'seller' ? roleMeta.sellerShort : roleMeta.buyerShort;
  const counterpartyPromptLabel =
    formData.role === 'seller' ? roleMeta.counterpartyForSeller : roleMeta.counterpartyForBuyer;

  const quickTemplates = [
    {
      label: 'طراحی وب‌سایت / اپلیکیشن',
      summary: 'تحویل سورس‌کد، تست روی دامنه کارفرما و ۱۴ روز مهلت',
      title: 'طراحی و پیاده‌سازی وب‌سایت اختصاصی',
      category: 'digital' as const,
      deadline: '14',
      revisions: '3',
      inspectionHours: '72',
      description: '- تحویل سورس‌کد کامل و تست فنی نهایی روی دامنه کارفرما\n- پشتیبانی رفع باگ به مدت ۷ روز پس از تحویل نهایی',
    },
    {
      label: 'انتقال کانال یا پیج',
      summary: 'انتقال مالکیت (Owner) + ۲۴ ساعت بازه بررسی امنیتی',
      title: 'انتقال امن مالکیت کانال / پیج',
      category: 'account' as const,
      deadline: '2',
      revisions: '0',
      inspectionHours: '24',
      description: '- انتقال کامل مالکیت (Owner) و حذف نشست‌های قبلی در حضور خریدار\n- ضمانت عدم بازگردانی و تایید سلامت اکانت پیش از آزادسازی وجه',
    },
    {
      label: 'خرید و فروش اکانت / اشتراک',
      summary: 'تحویل ایمیل اصلی و اطلاعات بازیابی بدون دسترسی ثانویه',
      title: 'واگذاری اکانت و اشتراک دیجیتال',
      category: 'account' as const,
      deadline: '1',
      revisions: '0',
      inspectionHours: '24',
      description: '- تحویل ایمیل اصلی و اطلاعات بازیابی بدون هیچ دسترسی ثانویه\n- بررسی صحت دسترسی‌ها توسط خریدار در بازه ۲۴ ساعته',
    },
    {
      label: 'ارسال کالای فیزیکی',
      summary: 'ارسال با کد رهگیری پستی + ۴۸ ساعت فرصت تست پس از دریافت',
      title: 'خرید و ارسال کالای فیزیکی با ضمانت سلامت',
      category: 'physical' as const,
      deadline: '5',
      revisions: '0',
      inspectionHours: '48',
      description: '- ارسال از طریق پست/تیپاکس با کد رهگیری معتبر داخل چت معامله\n- تطابق کامل مشخصات و سلامت فیزیکی کالا با تصاویر توافق‌شده',
    },
    {
      label: 'تولید محتوا / طراحی گرافیک',
      summary: 'تحویل فایل باکیفیت و ۲ نوبت اصلاحات طبق بریف اولیه',
      title: 'پروژه طراحی گرافیک و تدوین محتوا',
      category: 'digital' as const,
      deadline: '7',
      revisions: '2',
      inspectionHours: '48',
      description: '- تحویل فایل نهایی با کیفیت اصلی و فایل لایه‌باز در صورت توافق\n- اعمال حداکثر ۲ نوبت اصلاحات مطابق بریف اولیه',
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
      title: 'تایید نهایی توسط خریدار/کارفرما',
      text: 'تحویل نهایی پس از بررسی کامل و تایید خریدار در سامانه میانجی نهایی می‌شود.',
    },
    {
      title: 'ارسال مستندات فقط داخل چت میانجی',
      text: 'تمامی فایل‌ها، کد رهگیری و رسیدها صرفاً داخل گفتگوی همین قرارداد در میانجی ثبت شود تا در صورت داوری قابل استناد باشد.',
    },
    {
      title: 'ضمانت سلامت در مهلت تست',
      text: 'ضمانت اصالت و سلامت فنی در بازه بررسی توافق‌شده برقرار است.',
    },
    {
      title: 'تغییرات خارج از توافق اولیه',
      text: 'هرگونه تغییر یا درخواست جدید خارج از توافق اولیه مشمول زمان و هزینه جداگانه است.',
    },
  ];

  const stepsMeta = [
    { num: 1 as const, label: 'موضوع و نقش' },
    { num: 2 as const, label: 'مبلغ و زمان' },
    { num: 3 as const, label: 'طرف مقابل' },
    { num: 4 as const, label: 'بررسی و ثبت' },
  ];

  const goToStep = (target: 1 | 2 | 3 | 4) => {
    setFormError('');
    setDirection(target >= step ? 1 : -1);
    setStep(target);
  };

  const canJumpToStep = (target: 1 | 2 | 3 | 4) => {
    if (target <= step) return true;
    if (target >= 2 && (!formData.title.trim() || formData.title.trim().length < 3)) return false;
    if (
      target >= 3 &&
      (!numericAmount || numericAmount < minDealLimit || (maxDealLimit > 0 && numericAmount > maxDealLimit) || !milestonesValid)
    )
      return false;
    if (target === 4 && ((cleanCounterpartyPhone.length > 0 && cleanCounterpartyPhone.length < 10) || isSameAsOwnPhone))
      return false;
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
      if (!formData.title.trim() || formData.title.trim().length < 3) {
        setFormError('لطفاً یک عنوان کوتاه و مشخص برای معامله (حداقل ۳ کاراکتر) بنویسید.');
        return;
      }
      goToStep(2);
      return;
    }
    if (step === 2) {
      if (!numericAmount || numericAmount < minDealLimit) {
        setFormError(`مبلغ معامله باید حداقل ${minDealLimit.toLocaleString()} تومان باشد.`);
        return;
      }
      if (maxDealLimit > 0 && numericAmount > maxDealLimit) {
        setFormError(`سقف مجاز مبلغ هر معامله برای حساب شما ${maxDealLimit.toLocaleString()} تومان است.`);
        return;
      }
      if (isMilestone) {
        if (parsedMilestones.length < 2 || parsedMilestones.length > 8) {
          setFormError('معامله مرحله‌ای باید بین ۲ تا ۸ مرحله داشته باشد.');
          return;
        }
        if (parsedMilestones.some((m) => m.title.length < 2 || m.amount < 1000)) {
          setFormError('عنوان هر مرحله (حداقل ۲ کاراکتر) و مبلغ هر مرحله (حداقل ۱,۰۰۰ تومان) الزامی است.');
          return;
        }
        if (milestoneSum !== numericAmount) {
          setFormError(
            `مجموع مبالغ مراحل (${milestoneSum.toLocaleString()} تومان) باید دقیقاً برابر با مبلغ کل (${numericAmount.toLocaleString()} تومان) باشد.`
          );
          return;
        }
      }
      goToStep(3);
      return;
    }
    if (step === 3) {
      if (cleanCounterpartyPhone.length > 0 && cleanCounterpartyPhone.length < 10) {
        setFormError('اگر شماره وارد می‌کنید حداقل ۱۰ رقم بنویسید، یا فیلد را خالی بگذارید تا لینک و QR امضا بسازیم.');
        return;
      }
      if (isSameAsOwnPhone) {
        setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد.');
        return;
      }
      goToStep(4);
    }
  };

  const adjustCounter = (field: 'deadline' | 'revisions', delta: number, min: number, max: number) => {
    const current = Number(normalizeDigits(formData[field]).replace(/[^0-9]/g, '')) || 0;
    const next = Math.min(max, Math.max(min, current + delta));
    setFormData((prev) => ({ ...prev, [field]: String(next) }));
  };

  const handleSaveDraftAndExit = async () => {
    setDraftSavedAt('saving');
    await saveDealDraft({
      id: draftId,
      title: formData.title.trim(),
      amount: formData.amount,
      role: formData.role,
      phone: formData.phone,
      category: formData.category,
      deadline: formData.deadline,
      revisions: formData.revisions,
      inspection_hours: formData.inspectionHours,
      description: formData.description,
      is_milestone: isMilestone,
      milestones,
      step,
      updated_at: new Date().toISOString(),
    });
    notify('پیش‌نویس در بخش «پیش‌نویس‌ها» ذخیره شد', 'success');
    onBack();
  };

  const handleSubmit = async () => {
    setFormError('');
    const titleTrim = formData.title.trim();

    if (user?.is_deal_locked) {
      setFormError('امکان ثبت معامله جدید برای حساب شما محدود (قفل) شده است');
      return;
    }
    if (maxActiveDealsLimit > 0 && activeDealsCount >= maxActiveDealsLimit) {
      setFormError(`سقف مجاز معاملات فعال همزمان (${maxActiveDealsLimit} معامله) تکمیل شده است`);
      return;
    }
    if (!titleTrim || !formData.amount) {
      setFormError('لطفاً عنوان و مبلغ معامله را کامل وارد کنید');
      return;
    }
    if (!numericAmount || numericAmount < minDealLimit) {
      setFormError(`مبلغ معامله باید حداقل ${minDealLimit.toLocaleString()} تومان باشد`);
      return;
    }
    if (maxDealLimit > 0 && numericAmount > maxDealLimit) {
      setFormError(`حداکثر مبلغ مجاز هر معامله برای حساب شما ${maxDealLimit.toLocaleString()} تومان است`);
      return;
    }
    if (cleanCounterpartyPhone.length > 0 && cleanCounterpartyPhone.length < 10) {
      setFormError('شماره همراه طرف مقابل معتبر نیست (می‌توانید برای دعوت با لینک و QR آن را خالی بگذارید)');
      return;
    }
    if (isSameAsOwnPhone) {
      setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد');
      return;
    }
    if (isMilestone && !milestonesValid) {
      setFormError('مبالغ و عناوین مراحل پرداخت مرحله‌ای با مبلغ کل معامله مطابقت ندارد');
      return;
    }

    setLoading(true);
    try {
      const contractId = `M-${Math.floor(100000 + Math.random() * 900000)}`;
      const inspectionLine = formData.inspectionHours ? `مهلت بررسی و تست پس از تحویل: ${formData.inspectionHours} ساعت` : '';
      const composedDescription = [formData.description.trim(), inspectionLine].filter(Boolean).join('\n').slice(0, 2000);
      const effectiveRevisions =
        formData.category === 'physical' || formData.category === 'account' ? (showAdvancedTerms ? formData.revisions : '0') : formData.revisions;

      const res = await apiFetch<{ success: boolean; deal: any }>('/api/deals', {
        method: 'POST',
        body: JSON.stringify({
          contract_id: contractId,
          title: titleTrim.slice(0, 200),
          amount: numericAmount,
          role: formData.role,
          ...(cleanCounterpartyPhone ? { phone: cleanCounterpartyPhone } : {}),
          category: formData.category,
          description: composedDescription,
          deadline: String(formData.deadline || '7').slice(0, 20),
          revisions: String(effectiveRevisions || '0').slice(0, 20),
          inspection_hours: String(formData.inspectionHours || '48').slice(0, 10),
          is_milestone: isMilestone,
          ...(isMilestone ? { milestones: parsedMilestones.map((m) => ({ title: m.title, amount: m.amount })) } : {}),
        }),
      });

      await deleteDealDraft(draftId);
      onSuccess(res.deal);
    } catch (err: any) {
      setFormError(err?.message || 'خطا در ثبت معامله');
      notify(err?.message || 'خطا در ثبت معامله', 'error');
    } finally {
      setLoading(false);
    }
  };

  const activeCategoryObj = categoryOptions.find((c) => c.id === formData.category) || categoryOptions[0];
  const isServiceCategory = formData.category === 'digital' || formData.category === 'other';

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14 }} className="space-y-4 md:space-y-5 max-w-5xl mx-auto pb-10">
      {/* Top Wizard Header & Interactive Clickable Stepper */}
      <div className="card-obsidian p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => (step > 1 ? goToStep((step - 1) as 1 | 2 | 3) : onBack())}
              className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-white/[0.08] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-transform shrink-0"
              aria-label="بازگشت"
            >
              <ChevronRight size={18} />
            </button>
            <div className="min-w-0">
              <h2 className="text-base md:text-lg font-black text-slate-900 dark:text-white leading-tight">ایجاد قرارداد امن</h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-300 font-bold mt-0.5 tabular-nums truncate">
                {draftSavedAt === 'saving'
                  ? 'در حال ذخیره خودکار پیش‌نویس...'
                  : draftSavedAt === 'saved'
                  ? '✓ پیش‌نویس خودکار ذخیره شد'
                  : maxActiveDealsLimit > 0
                  ? `ظرفیت فعال شما: ${activeDealsCount} از ${maxActiveDealsLimit} معامله`
                  : 'ابتدا پیش‌نویس ساخته می‌شود؛ پول تا تایید نهایی نزد میانجی امانت می‌ماند'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {(formData.title.trim() || formData.amount.trim()) && (
              <button
                type="button"
                onClick={handleSaveDraftAndExit}
                className="h-8 px-2.5 rounded-lg bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-200 text-[10px] font-black flex items-center gap-1 hover:bg-slate-200 dark:hover:bg-white/15 transition-colors"
                title="ذخیره پیش‌نویس و خروج"
              >
                <Save size={12} />
                <span className="hidden sm:inline">ذخیره پیش‌نویس</span>
              </button>
            )}
            <span className="text-xs font-black text-blue-600 dark:text-blue-300 tabular-nums whitespace-nowrap">
              گام {step} از ۴
            </span>
          </div>
        </div>

        {/* Clickable 4-Step Segmented Breadcrumb */}
        <div className="grid grid-cols-4 gap-1.5">
          {stepsMeta.map((item) => {
            const isActive = step === item.num;
            const isCompleted = step > item.num;
            const clickable = canJumpToStep(item.num);
            return (
              <button
                key={item.num}
                type="button"
                disabled={!clickable}
                onClick={() => clickable && goToStep(item.num)}
                className={`p-2 rounded-xl border text-right transition-all flex items-center gap-2 ${
                  isActive
                    ? 'bg-blue-600 text-white border-blue-500'
                    : isCompleted
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                    : 'bg-slate-50 dark:bg-[#18202e] text-slate-500 dark:text-slate-400 border-slate-200/70 dark:border-white/10 disabled:opacity-60'
                }`}
              >
                <span className="w-5 h-5 rounded-md bg-black/10 dark:bg-white/10 flex items-center justify-center text-[10px] font-black tabular-nums shrink-0">
                  {isCompleted ? <Check size={12} /> : item.num}
                </span>
                <span className="text-[10px] md:text-[11px] font-black truncate">{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Mobile Compact Context Recap on Steps 2-4 */}
        {step >= 2 && (
          <div className="lg:hidden pt-2 border-t border-slate-100 dark:border-white/10 flex items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 min-w-0 text-slate-600 dark:text-slate-300">
              <span className="font-black text-slate-900 dark:text-white truncate">{formData.title.trim() || 'قرارداد جدید'}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 font-bold text-blue-600 dark:text-blue-300">شما {myRoleShort} هستید</span>
            </div>
            {numericAmount > 0 && (
              <span className="font-black text-emerald-600 dark:text-emerald-400 tabular-nums shrink-0">
                {numericAmount.toLocaleString()} ت
              </span>
            )}
          </div>
        )}
      </div>

      {/* Main Two-Column Split: Active Step Form + Sticky Live Contract Blueprint */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-8 card-obsidian rounded-2xl md:rounded-3xl p-4 md:p-6 overflow-hidden">
          <AnimatePresence mode="wait" custom={direction}>
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.15 }}
                className="space-y-5"
              >
                {/* 1. Category 2x2 First: adapts title hint & role wording */}
                <div className="space-y-2">
                  <div>
                    <label className="text-xs font-black text-slate-900 dark:text-white block">۱. این معامله درباره چیست؟</label>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      انتخاب نوع معامله کمک می‌کند عنوان‌ها و نقش‌ها دقیقاً مطابق کار شما تنظیم شوند.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    {categoryOptions.map((cat) => {
                      const active = formData.category === cat.id;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() =>
                            setFormData((prev) => ({
                              ...prev,
                              category: cat.id,
                              revisions: cat.id === 'physical' || cat.id === 'account' ? '0' : prev.revisions === '0' ? '2' : prev.revisions,
                            }))
                          }
                          className={`min-h-[54px] px-3.5 py-2.5 rounded-xl border text-right flex items-center gap-2.5 transition-all active:scale-[0.98] ${
                            active
                              ? 'bg-blue-600/10 dark:bg-blue-500/20 border-blue-600 dark:border-blue-400 text-slate-900 dark:text-white'
                              : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/35'
                          }`}
                        >
                          <span className={`shrink-0 ${active ? 'text-blue-600 dark:text-blue-300' : 'text-slate-500 dark:text-slate-300'}`}>
                            {cat.icon}
                          </span>
                          <div className="flex-1 overflow-hidden">
                            <span className="text-xs font-black block truncate">{cat.label}</span>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 hidden sm:block truncate">{cat.desc}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 2. Title Input */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-black text-slate-900 dark:text-white">۲. عنوان معامله</label>
                    <span className="text-[10px] font-bold text-rose-500 dark:text-rose-300">الزامی</span>
                  </div>
                  <input
                    placeholder={roleMeta.titlePlaceholder}
                    value={formData.title}
                    maxLength={200}
                    onChange={(e) => {
                      setFormData({ ...formData, title: e.target.value });
                      setFormError('');
                    }}
                    className="input-refined !h-12 !px-4"
                  />
                </div>

                {/* 3. Role Selection tailored to selected category */}
                <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-white/[0.08]">
                  <div>
                    <label className="text-xs font-black text-slate-900 dark:text-white block">۳. شما در این معامله کدام طرف هستید؟</label>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      انتخاب کنید پول را دریافت می‌کنید یا پرداخت می‌کنید.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, role: 'seller' })}
                      className={`p-3.5 rounded-xl border text-right transition-all flex items-start justify-between gap-3 active:scale-[0.98] ${
                        formData.role === 'seller'
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <div className="space-y-1 min-w-0">
                        <span className="text-xs font-black block">{roleMeta.sellerTitle}</span>
                        <span className={`text-[10px] block leading-relaxed ${formData.role === 'seller' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                          {roleMeta.sellerDesc}
                        </span>
                      </div>
                      <ArrowUpRight size={16} className="shrink-0 mt-0.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, role: 'buyer' })}
                      className={`p-3.5 rounded-xl border text-right transition-all flex items-start justify-between gap-3 active:scale-[0.98] ${
                        formData.role === 'buyer'
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <div className="space-y-1 min-w-0">
                        <span className="text-xs font-black block">{roleMeta.buyerTitle}</span>
                        <span className={`text-[10px] block leading-relaxed ${formData.role === 'buyer' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                          {roleMeta.buyerDesc}
                        </span>
                      </div>
                      <Lock size={16} className="shrink-0 mt-0.5" />
                    </button>
                  </div>
                </div>

                {/* 4. Clearly Optional Collapsed Quick-Start Guide (NOT a mandatory step) */}
                <div className="pt-2">
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
                            نیاز به راهنمایی یا ایده دارید؟ نمونه‌های آماده (اختیاری)
                          </span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 block truncate">
                            {appliedTemplateLabel
                              ? `نمونه «${appliedTemplateLabel}» اعمال شد — می‌توانید مستقیم ویرایش کنید`
                              : 'اختیاری است؛ صرفاً برای پرشدن سریع‌تر عنوان و شروط استاندارد'}
                          </span>
                        </div>
                      </div>
                      <ChevronDown
                        size={16}
                        className={`text-slate-500 dark:text-slate-300 shrink-0 transition-transform ${showTemplatesGuide ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {showTemplatesGuide && (
                      <div className="px-3.5 pb-3.5 pt-2 border-t border-slate-200/70 dark:border-white/10 space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[10px] text-slate-500 dark:text-slate-300 leading-relaxed">
                            هر مورد را لمس کنید تا عنوان، دسته‌بندی و متن پیشنهادی به‌عنوان نمونه پر شود:
                          </p>
                          {appliedTemplateLabel && (
                            <button
                              type="button"
                              onClick={() => {
                                setAppliedTemplateLabel('');
                                setFormData((prev) => ({ ...prev, title: '', description: '' }));
                              }}
                              className="text-[10px] font-black text-rose-600 dark:text-rose-300 flex items-center gap-1 shrink-0"
                            >
                              <RotateCcw size={11} /> پاک کردن نمونه
                            </button>
                          )}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {quickTemplates.map((tpl) => {
                            const active = appliedTemplateLabel === tpl.label;
                            return (
                              <button
                                key={tpl.label}
                                type="button"
                                onClick={() => {
                                  setFormData((prev) => ({
                                    ...prev,
                                    title: tpl.title,
                                    category: tpl.category,
                                    deadline: tpl.deadline,
                                    revisions: tpl.revisions,
                                    inspectionHours: tpl.inspectionHours,
                                    description: prev.description.trim() ? prev.description : tpl.description,
                                  }));
                                  setAppliedTemplateLabel(tpl.label);
                                  setFormError('');
                                  notify(`نمونه «${tpl.label}» درج شد؛ می‌توانید هر بخش را تغییر دهید`, 'info');
                                }}
                                className={`p-2.5 rounded-xl border text-right transition-all ${
                                  active
                                    ? 'bg-blue-600/10 dark:bg-blue-500/20 border-blue-500 text-slate-900 dark:text-white'
                                    : 'bg-white dark:bg-[#131924] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 hover:border-blue-500/40'
                                }`}
                              >
                                <span className="text-[11px] font-black block">{tpl.label}</span>
                                <span className="text-[10px] text-slate-500 dark:text-slate-400 block mt-0.5 leading-snug">{tpl.summary}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.15 }}
                className="space-y-5"
              >
                {/* Amount Input + Live Persian Words */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-black text-slate-900 dark:text-white">مبلغ کل معامله (تومان)</label>
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 tabular-nums">
                      حداقل {minDealLimit.toLocaleString()} {maxDealLimit > 0 ? `تا سقف ${maxDealLimit.toLocaleString()}` : ''} تومان
                    </span>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="مثلاً 5000000"
                    value={formData.amount}
                    onChange={(e) => {
                      setFormData({ ...formData, amount: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') });
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
                          setFormData({ ...formData, amount: preset.value });
                          setFormError('');
                        }}
                        className={`min-h-[38px] px-2 rounded-xl text-[11px] font-bold border transition-all whitespace-nowrap shrink-0 active:scale-95 ${
                          formData.amount === preset.value
                            ? 'bg-blue-600 text-white border-blue-500'
                            : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 hover:border-blue-500/40'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Fee & Net Payout Summary */}
                <div
                  className={`p-3.5 rounded-xl border flex flex-col justify-center text-xs ${
                    feePercent > 0
                      ? 'bg-blue-500/10 border-blue-500/25'
                      : 'bg-emerald-500/10 border-emerald-500/25'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-700 dark:text-slate-200">کارمزد حفاظت میانجی</span>
                    {feePercent === 0 ? (
                      <span className="font-black text-emerald-600 dark:text-emerald-400">۰٪ (بدون کارمزد)</span>
                    ) : (
                      <span className="font-black text-blue-600 dark:text-blue-300 tabular-nums">
                        {feePercent}٪ {numericAmount > 0 ? `(${feeAmount.toLocaleString()} ت)` : ''}
                      </span>
                    )}
                  </div>
                  {feePercent > 0 && numericAmount > 0 && (
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 mt-1 tabular-nums">
                      خالص دریافتی {roleMeta.sellerShort} پس از تسویه نهایی: {netSellerAmount.toLocaleString()} تومان
                    </span>
                  )}
                </div>

                {/* Delivery Deadline + Inspection Window */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-slate-100 dark:border-white/[0.08]">
                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.08] space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-slate-900 dark:text-white">حداکثر مهلت تحویل (روز)</span>
                      <div className="flex items-center gap-1">
                        {['3', '7', '14', '30'].map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setFormData({ ...formData, deadline: d })}
                            className={`px-2 py-0.5 rounded-md text-[10px] font-black tabular-nums ${
                              formData.deadline === d
                                ? 'bg-blue-600 text-white'
                                : 'bg-white dark:bg-white/10 text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => adjustCounter('deadline', -1, 1, 365)}
                        className="w-10 h-10 rounded-lg bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0"
                        aria-label="کاهش مهلت"
                      >
                        <Minus size={14} />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        value={formData.deadline}
                        onChange={(e) => setFormData({ ...formData, deadline: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') })}
                        className="w-full min-w-0 h-10 bg-transparent text-center text-base font-black font-sans tabular-nums text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => adjustCounter('deadline', 1, 1, 365)}
                        className="w-10 h-10 rounded-lg bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0"
                        aria-label="افزایش مهلت"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      {roleMeta.sellerShort} از زمان قفل‌شدن وجه تا این مدت باید تحویل را ثبت کند.
                    </p>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.08] space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-2">
                      <span className="text-xs font-black text-slate-900 dark:text-white block">فرصت تست و بررسی پس از تحویل</span>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { v: '24', l: '۲۴ ساعت' },
                          { v: '48', l: '۴۸ ساعت' },
                          { v: '72', l: '۷۲ ساعت' },
                        ].map((opt) => (
                          <button
                            key={opt.v}
                            type="button"
                            onClick={() => setFormData({ ...formData, inspectionHours: opt.v })}
                            className={`h-9 rounded-lg text-[11px] font-black transition-colors whitespace-nowrap ${
                              formData.inspectionHours === opt.v
                                ? 'bg-blue-600 text-white'
                                : 'bg-white dark:bg-[#131924] border border-slate-200/70 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {opt.l}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      پس از تحویل، {roleMeta.buyerShort} این مدت فرصت بررسی دارد؛ اگر اعتراضی ثبت نشود وجه خودکار آزاد می‌شود.
                    </p>
                  </div>
                </div>

                {/* Optional & Contextual Controls: Revisions (for services) & Milestone Payment */}
                <div className="pt-3 border-t border-slate-100 dark:border-white/[0.08] space-y-3">
                  {!isServiceCategory && !isMilestone && !showAdvancedTerms ? (
                    <button
                      type="button"
                      onClick={() => setShowAdvancedTerms(true)}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-dashed border-slate-300 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#18202e]/60 flex items-center justify-between gap-2 text-right hover:bg-slate-100/70 dark:hover:bg-white/[0.04] transition-colors"
                    >
                      <div>
                        <span className="text-xs font-black text-slate-800 dark:text-white block">
                          حالت پیش‌فرض: پرداخت یکجا پس از تایید تحویل
                        </span>
                        <span className="text-[10px] text-slate-500 dark:text-slate-400">
                          برای تقسیم مبلغ به چند مرحله (قسط) یا تعریف نوبت اصلاحات کلیک کنید (اختیاری)
                        </span>
                      </div>
                      <ChevronDown size={16} className="text-slate-500 dark:text-slate-300 shrink-0" />
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div>
                          <span className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                            <Layers size={14} className="text-blue-500" />
                            نحوه پرداخت و آزادسازی وجه
                          </span>
                          <span className="text-[10px] text-slate-500 dark:text-slate-400 block mt-0.5">
                            {isMilestone
                              ? 'مبلغ در ۲ تا ۸ مرحله قسط‌بندی و پس از تایید هر مرحله آزاد می‌شود.'
                              : 'پیشنهاد برای اغلب معاملات: کل مبلغ پس از تحویل نهایی یکجا آزاد می‌شود.'}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 bg-slate-100 dark:bg-[#18202e] p-1 rounded-xl border border-slate-200/70 dark:border-white/10">
                          <button
                            type="button"
                            onClick={() => setIsMilestone(false)}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-black transition-all ${
                              !isMilestone ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            یکجا (معمولی)
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setIsMilestone(true);
                              if (numericAmount > 0 && milestones.every((m) => !m.amount)) {
                                splitMilestonesEvenly(numericAmount, milestones.length);
                              }
                            }}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-black transition-all ${
                              isMilestone ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            چندمرحله‌ای
                          </button>
                        </div>
                      </div>

                      {isMilestone && (
                        <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-3">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <span className="text-[11px] font-black text-slate-700 dark:text-slate-200 tabular-nums">
                              مجموع مراحل: {milestoneSum.toLocaleString()} از {numericAmount.toLocaleString()} تومان
                            </span>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => splitMilestonesEvenly(numericAmount, milestones.length)}
                                className="h-7 px-2.5 rounded-lg bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-[10px] font-black text-blue-600 dark:text-blue-300 hover:border-blue-500/40"
                              >
                                تقسیم مساوی
                              </button>
                              {milestones.length < 8 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setMilestones((prev) => [
                                      ...prev,
                                      { title: `مرحله ${prev.length + 1}`, amount: '' },
                                    ])
                                  }
                                  className="h-7 px-2.5 rounded-lg bg-blue-600 text-white text-[10px] font-black flex items-center gap-1"
                                >
                                  <Plus size={12} />
                                  افزودن مرحله
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="space-y-2">
                            {milestones.map((ms, idx) => (
                              <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                                <div className="col-span-12 sm:col-span-6 flex items-center gap-1.5">
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
                                      setMilestones((prev) =>
                                        prev.map((item, i) => (i === idx ? { ...item, title: nextVal } : item))
                                      );
                                    }}
                                    className="input-refined !h-10 !px-3 text-[14px] flex-1"
                                  />
                                </div>
                                <div className="col-span-10 sm:col-span-5">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    dir="ltr"
                                    placeholder="مبلغ (تومان)"
                                    value={ms.amount}
                                    onChange={(e) => {
                                      const cleaned = normalizeDigits(e.target.value).replace(/[^0-9]/g, '');
                                      setMilestones((prev) =>
                                        prev.map((item, i) => (i === idx ? { ...item, amount: cleaned } : item))
                                      );
                                    }}
                                    className="input-refined !h-10 !px-3 text-[14px] tabular-nums text-center"
                                  />
                                </div>
                                <div className="col-span-2 sm:col-span-1 flex justify-end">
                                  {milestones.length > 2 && (
                                    <button
                                      type="button"
                                      onClick={() => setMilestones((prev) => prev.filter((_, i) => i !== idx))}
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

                      {(isServiceCategory || showAdvancedTerms) && (
                        <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.08] flex items-center justify-between gap-3 flex-wrap">
                          <div>
                            <span className="text-xs font-black text-slate-900 dark:text-white block">حداکثر نوبت اصلاحات رایگان (اختیاری)</span>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400">
                              تعداد دفعاتی که {roleMeta.buyerShort} می‌تواند درخواست ویرایش بدهد
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => adjustCounter('revisions', -1, 0, 50)}
                              className="w-9 h-9 rounded-lg bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all"
                              aria-label="کاهش اصلاحات"
                            >
                              <Minus size={14} />
                            </button>
                            <span className="w-10 text-center text-sm font-black font-mono tabular-nums text-slate-900 dark:text-white">
                              {formData.revisions || '0'}
                            </span>
                            <button
                              type="button"
                              onClick={() => adjustCounter('revisions', 1, 0, 50)}
                              className="w-9 h-9 rounded-lg bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all"
                              aria-label="افزایش اصلاحات"
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step-3"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.15 }}
                className="space-y-4"
              >
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-black text-slate-900 dark:text-white block">
                        شماره موبایل {counterpartyPromptLabel} (اختیاری)
                      </label>
                      <span className="text-[10px] font-bold text-blue-600 dark:text-blue-300">یا ارسال لینک و QR</span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                      شماره طرف مقابل را وارد کنید یا این بخش را خالی بگذارید تا پس از ثبت، لینک امضا و کد QR حضوری ساخته شود.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      inputMode="tel"
                      dir="ltr"
                      placeholder="0912... (اختیاری)"
                      value={formData.phone}
                      onChange={(e) => {
                        setFormData({ ...formData, phone: normalizeDigits(e.target.value) });
                        setFormError('');
                      }}
                      className="input-refined !h-12 text-center font-sans tabular-nums tracking-wider flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setShowContactPicker(!showContactPicker)}
                      className={`min-h-[48px] px-4 rounded-xl border flex items-center justify-center gap-1.5 text-xs font-black transition-colors whitespace-nowrap shrink-0 active:scale-95 ${
                        showContactPicker
                          ? 'bg-blue-600 text-white border-blue-500'
                          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-white hover:border-blue-500/40'
                      }`}
                    >
                      <Users size={15} />
                      <span>مخاطبین ({savedContacts.length})</span>
                    </button>
                  </div>

                  {/* Quick Recent Contacts Horizontal Bar */}
                  {savedContacts.length > 0 && !showContactPicker && (
                    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pt-0.5">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 shrink-0">انتخاب سریع:</span>
                      {savedContacts.slice(0, 5).map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setFormData((prev) => ({ ...prev, phone: normalizeDigits(c.phone_number) }));
                            setFormError('');
                          }}
                          className="h-7 px-2.5 rounded-lg bg-slate-100 dark:bg-white/[0.07] hover:bg-blue-600 hover:text-white text-[10px] font-bold text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0"
                        >
                          {c.full_name}
                        </button>
                      ))}
                    </div>
                  )}

                  {cleanCounterpartyPhone.length === 0 && (
                    <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-start gap-2.5 text-right">
                      <Link2 size={16} className="text-blue-600 dark:text-blue-300 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <p className="text-[11px] font-black text-slate-900 dark:text-white">
                          معامله با لینک امضا و کد QR حضوری (بدون نیاز به شماره یا عضویت قبلی)
                        </p>
                        <p className="text-[10px] text-slate-600 dark:text-slate-300 leading-relaxed">
                          با ادامه و ثبت قرارداد، لینک دعوت اختصاصی و کد QR آماده می‌شود؛ طرف مقابل با باز کردن لینک یا اسکن QR به قرارداد می‌پیوندد و آن را امضا می‌کند.
                        </p>
                      </div>
                    </div>
                  )}

                  {lookupState.status === 'checking' && (
                    <p className="text-[11px] text-blue-600 dark:text-blue-300 font-bold">در حال بررسی عضویت در میانجی...</p>
                  )}
                  {isSameAsOwnPhone && (
                    <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/35 flex items-center gap-2 text-right">
                      <AlertCircle size={16} className="text-rose-500 shrink-0" />
                      <p className="text-[11px] font-bold text-rose-600 dark:text-rose-300">
                        این شماره متعلق به حساب خودتان است؛ لطفاً شماره طرف مقابل را وارد کنید یا فیلد را خالی بگذارید.
                      </p>
                    </div>
                  )}
                  {lookupState.status === 'found' && lookupState.user && !isSameAsOwnPhone && (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/35 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <CheckCircle2 size={17} className="text-emerald-500 shrink-0" />
                        <div className="overflow-hidden">
                          <div className="flex items-center gap-2">
                            <p className="text-xs font-black text-slate-900 dark:text-white truncate">{lookupState.user.full_name}</p>
                            {Number(lookupState.user.rating_count || 0) > 0 && (
                              <span className="text-[10px] font-black text-amber-600 dark:text-amber-300 flex items-center gap-0.5 shrink-0 tabular-nums">
                                · <Star size={10} className="fill-amber-400 text-amber-400" />
                                {Number(lookupState.user.rating_avg || 0).toFixed(1)} ({lookupState.user.rating_count})
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">
                            حساب تاییدشده · {lookupState.user.kyc_status === 'verified' ? 'احراز هویت کامل' : 'عضو فعال میانجی'}
                            {Number(lookupState.user.completed_deals_count || 0) > 0
                              ? ` · ${lookupState.user.completed_deals_count} معامله موفق`
                              : ''}
                          </p>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono font-bold text-slate-500 dark:text-slate-300 shrink-0" dir="ltr">
                        {lookupState.user.phone_number}
                      </span>
                    </div>
                  )}
                  {lookupState.status === 'not_found' && cleanCounterpartyPhone.length >= 10 && !isSameAsOwnPhone && (
                    <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-start gap-2.5 text-right">
                      <QrCode size={16} className="text-blue-600 dark:text-blue-300 shrink-0 mt-0.5" />
                      <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200 leading-relaxed">
                        این شماره هنوز در ربات میانجی ثبت‌نام نکرده است — مشکلی نیست! می‌توانید همین الان قرارداد را بسازید و لینک امضا یا کد QR آن را برایش بفرستید تا با یک کلیک عضو و امضا کند.
                      </p>
                    </div>
                  )}

                  {showContactPicker && (
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-2 max-h-48 overflow-y-auto">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[11px] font-black text-slate-700 dark:text-white">انتخاب از لیست مخاطبین</span>
                        <button type="button" onClick={() => setShowContactPicker(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1">
                          <X size={14} />
                        </button>
                      </div>
                      {savedContacts.length > 0 ? (
                        savedContacts.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setFormData((prev) => ({ ...prev, phone: normalizeDigits(c.phone_number) }));
                              setShowContactPicker(false);
                              setFormError('');
                            }}
                            className="w-full min-h-[42px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between hover:border-blue-500/40 transition-all text-right"
                          >
                            <div className="min-w-0">
                              <span className="text-xs font-black text-slate-900 dark:text-white block truncate">{c.full_name}</span>
                              {c.category && (
                                <span className="text-[10px] text-slate-500 dark:text-slate-400">{c.category}</span>
                              )}
                            </div>
                            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-300 shrink-0" dir="ltr">
                              {c.phone_number}
                            </span>
                          </button>
                        ))
                      ) : (
                        <p className="text-[11px] text-slate-500 text-center py-2">هنوز مخاطبی ذخیره نشده است.</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Protective Legal Clauses & Description (Explicitly Optional) */}
                <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-white/[0.08]">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <label className="text-xs font-black text-slate-900 dark:text-white">شرایط و توضیحات توافق (اختیاری)</label>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                        اگر شرط خاصی ندارید می‌توانید خالی بگذارید؛ قوانین ضمانت میانجی خودکار اعمال می‌شوند.
                      </p>
                    </div>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                      {formData.description.length} / ۱۹۰۰
                    </span>
                  </div>

                  <textarea
                    maxLength={1900}
                    placeholder="اگر جزئیات خاصی درباره کالا، فرمت فایل‌ها یا زمان تحویل مدنظرتان است بنویسید (اختیاری)..."
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full h-24 bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] rounded-xl p-3.5 text-[14px] font-medium text-slate-900 dark:text-white focus:border-blue-500/60 outline-none transition-all resize-none leading-relaxed"
                  />

                  <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#18202e]/70 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowClauseHelper((prev) => !prev)}
                      className="w-full px-3 py-2.5 flex items-center justify-between gap-2 text-right"
                    >
                      <span className="text-[11px] font-black text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                        <HelpCircle size={14} className="text-blue-500 shrink-0" />
                        درج جملات حفاظتی آماده داخل توضیحات (اختیاری)
                      </span>
                      <ChevronDown
                        size={15}
                        className={`text-slate-500 dark:text-slate-300 transition-transform ${showClauseHelper ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {showClauseHelper && (
                      <div className="px-3 pb-3 pt-1.5 border-t border-slate-200/70 dark:border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {clauseSnippets.map((clause) => {
                          const alreadyAdded = formData.description.includes(clause.text);
                          return (
                            <button
                              key={clause.title}
                              type="button"
                              disabled={alreadyAdded}
                              onClick={() =>
                                setFormData((prev) => ({
                                  ...prev,
                                  description: prev.description.trim()
                                    ? `${prev.description.trim()}\n- ${clause.text}`
                                    : `- ${clause.text}`,
                                }))
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
              </motion.div>
            )}

            {step === 4 && (
              <motion.div
                key="step-4"
                initial={{ opacity: 0, x: direction * -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 12 }}
                transition={{ duration: 0.15 }}
                className="space-y-4"
              >
                <div className="divide-y divide-slate-200/70 dark:divide-white/10 border border-slate-200/90 dark:border-white/[0.08] rounded-2xl bg-slate-50/70 dark:bg-[#18202e]">
                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">موضوع و نقش شما</span>
                      <p className="text-sm font-black text-slate-900 dark:text-white truncate">{formData.title}</p>
                      <span className="text-[11px] text-blue-600 dark:text-blue-300 font-bold">
                        {activeCategoryObj.label} · شما {myRoleShort} هستید
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(1)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] rounded-lg min-h-[34px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">ارزش مالی و زمان‌بندی</span>
                      <p className="text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {numericAmount.toLocaleString()} تومان{' '}
                        <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300">({amountWords})</span>
                      </p>
                      <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-600 dark:text-slate-300 tabular-nums">
                        <span>مهلت تحویل: {formData.deadline || '7'} روز</span>
                        <span aria-hidden="true">·</span>
                        <span>فرصت تست: {formData.inspectionHours} ساعت</span>
                        {(isServiceCategory || Number(formData.revisions) > 0) && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>اصلاحات: {formData.revisions || '0'} نوبت</span>
                          </>
                        )}
                      </div>
                      <span className="text-[11px] text-blue-600 dark:text-blue-300 font-bold block tabular-nums">
                        {feePercent > 0
                          ? `کارمزد میانجی: ${feePercent}٪ (${feeAmount.toLocaleString()} ت) · خالص ${roleMeta.sellerShort}: ${netSellerAmount.toLocaleString()} ت`
                          : 'کارمزد میانجی: ۰٪ (رایگان)'}
                        {isMilestone ? ` · پرداخت مرحله‌ای (${parsedMilestones.length} مرحله)` : ' · پرداخت یکجا'}
                      </span>
                      {isMilestone && (
                        <div className="mt-1.5 space-y-1">
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
                      onClick={() => goToStep(2)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] rounded-lg min-h-[34px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="flex-1 overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">
                        طرف مقابل ({counterpartyPromptLabel}) و توضیحات
                      </span>
                      <p className="text-xs font-black text-slate-900 dark:text-white truncate">
                        {cleanCounterpartyPhone
                          ? `${formData.phone}${lookupState.user?.full_name ? ` (${lookupState.user.full_name})` : ' (در انتظار عضویت با لینک/QR)'}`
                          : 'دعوت آزاد با لینک امضا و کد QR (پس از ثبت ساخته می‌شود)'}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-300 mt-1 whitespace-pre-line line-clamp-3">
                        {formData.description.trim() || 'شرایط استاندارد ضمانت میانجی'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(3)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] rounded-lg min-h-[34px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>
                </div>

                <div className="p-3.5 rounded-2xl bg-blue-500/10 border border-blue-500/25 space-y-2 text-right">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={17} className="text-blue-600 dark:text-blue-300 shrink-0" />
                    <span className="text-xs font-black text-slate-900 dark:text-white">بعد از ثبت چه اتفاقی می‌افتد؟</span>
                  </div>
                  <div className="space-y-1 text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed pr-1">
                    <p>
                      {!cleanCounterpartyPhone || lookupState.status !== 'found'
                        ? '۱. قرارداد ثبت می‌شود و بلافاصله لینک امضای مستقیم و کد QR حضوری برای ارسال به طرف مقابل می‌گیرید.'
                        : '۱. ابتدا پیش‌نویس بدون کسر وجه ثبت و برای طرف مقابل ارسال می‌شود.'}
                    </p>
                    <p>۲. {roleMeta.buyerShort} مبلغ را در صندوق امن میانجی قفل می‌کند تا {roleMeta.sellerShort} با خیال راحت تحویل بدهد.</p>
                    <p>۳. پس از تحویل و تایید در بازه {formData.inspectionHours} ساعته، مبلغ به حساب {roleMeta.sellerShort} واریز می‌شود.</p>
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
          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-white/[0.08] flex items-center justify-between gap-2.5">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => goToStep((step - 1) as 1 | 2 | 3)}
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

            {step < 4 ? (
              <button
                type="button"
                onClick={validateCurrentAndNext}
                className="min-h-[44px] flex-1 sm:flex-none sm:px-7 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs border border-white/15 flex items-center justify-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
              >
                ادامه به گام {step + 1}
                <ChevronLeft size={15} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="min-h-[44px] flex-1 sm:flex-none sm:px-7 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-xs border border-white/15 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Check size={16} />
                    ثبت پیش‌نویس قرارداد امن
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Sticky Live Contract Blueprint Sidebar (Desktop) */}
        <aside className="hidden lg:block lg:col-span-4 lg:sticky lg:top-24 card-obsidian rounded-3xl p-5 space-y-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-slate-900 dark:text-white">خلاصه زنده قرارداد</span>
            <Shield size={16} className="text-blue-600 dark:text-blue-300" />
          </div>

          <div className="space-y-1">
            <h4 className="text-sm font-black text-slate-900 dark:text-white leading-snug">
              {formData.title.trim() || 'عنوان قرارداد شما'}
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-300">
              {activeCategoryObj.label} · شما {myRoleShort} هستید
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
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{formData.deadline || '7'} روز</span>
            </div>
            {(isServiceCategory || Number(formData.revisions) > 0) && (
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-300">اصلاحات رایگان</span>
                <span className="font-black text-slate-900 dark:text-white tabular-nums">{formData.revisions || '0'} نوبت</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">فرصت تست خریدار</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{formData.inspectionHours} ساعت</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">نوع پرداخت</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">
                {isMilestone ? `${parsedMilestones.length} مرحله‌ای` : 'یکجا'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">کارمزد پلتفرم</span>
              <span className="font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                {feePercent > 0 ? `${feePercent}٪ (${feeAmount.toLocaleString()} ت)` : '۰٪ (رایگان)'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">طرف مقابل</span>
              <span className="font-black text-slate-900 dark:text-white truncate max-w-[160px]">
                {lookupState.user?.full_name || formData.phone || 'دعوت با لینک / QR'}
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-white/[0.08] space-y-1.5 text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
            <p className="font-black text-slate-800 dark:text-white">روند امن میانجی:</p>
            <p>۱. {roleMeta.buyerShort} پیش‌نویس را تایید و مبلغ را قفل می‌کند.</p>
            <p>۲. {roleMeta.sellerShort} در مهلت مقرر تحویل را ثبت می‌کند.</p>
            <p>۳. پس از تایید در بازه تست، وجه تسویه می‌شود.</p>
          </div>
        </aside>
      </div>
    </motion.div>
  );
}
