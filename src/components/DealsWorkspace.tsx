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
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch } from '../lib/apiClient';
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

  let needsMyAction = false;
  let nextHint = '';

  if (status === 'draft') {
    if (isBuyer) {
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
}: {
  user: any;
  contracts: any[];
  platformLimits?: PlatformLimits;
  setView: (v: any) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onOpenQrScanner?: () => void;
}) {
  const [filterStatus, setFilterStatus] = useState<'all' | 'needs_action' | 'active' | 'pending' | 'completed' | 'disputed'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'buyer' | 'seller'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'amount_desc' | 'amount_asc'>('newest');
  const [displayMode, setDisplayMode] = useState<'cards' | 'table'>('cards');

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
  ] as const;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="space-y-5 pb-16">
      {/* Top Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl md:text-2xl font-black text-slate-900 dark:text-white tracking-tight">معاملات من</h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mt-0.5">
            پیگیری وضعیت قراردادها، وجوه در امانت و اقدامات پیش‌رو
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenQrScanner && (
            <button
              type="button"
              onClick={onOpenQrScanner}
              className="h-10 px-3.5 rounded-xl bg-white dark:bg-[#141923] border border-slate-200 dark:border-white/20 text-slate-700 dark:text-white text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-white/10 active:scale-95 transition-all whitespace-nowrap shrink-0"
            >
              <QrCode size={16} />
              <span>اسکن QR</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setView('create')}
            className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-white/15 text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
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

      {/* 4-Column Financial Summary Strip (Single Elevation, Tabular Figures) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-2xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 space-y-1">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300 block">ارزش در امانت فعال</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg md:text-xl font-black text-slate-900 dark:text-white tabular-nums">
              {metrics.escrowVolume.toLocaleString()}
            </span>
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">تومان</span>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 space-y-1">
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300 block">مجموع تسویه موفق</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg md:text-xl font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
              {metrics.completedVolume.toLocaleString()}
            </span>
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">تومان</span>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 space-y-1">
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
          className={`p-4 rounded-2xl border text-right space-y-1 transition-all ${
            filterStatus === 'needs_action'
              ? 'bg-blue-600 text-white border-blue-500'
              : 'bg-white dark:bg-[#141923] border-slate-200/90 dark:border-white/20 hover:border-blue-500/40'
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
      <div className="p-3.5 md:p-4 rounded-2xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 space-y-3">
        <div className="flex flex-col md:flex-row gap-2.5 items-stretch md:items-center justify-between">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" size={16} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="جستجو بر اساس عنوان، شناسه قرارداد (#M-...) یا مبلغ..."
              className="input-refined !h-10 pr-10 pl-8 text-xs"
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
            <div className="flex items-center p-1 rounded-xl bg-slate-100 dark:bg-[#0e131c] border border-slate-200/80 dark:border-white/15">
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
                      ? 'bg-white dark:bg-[#1b2230] text-slate-900 dark:text-white shadow-sm'
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
                className="h-9 pr-8 pl-3 rounded-xl text-[11px] font-bold bg-slate-50 dark:bg-[#0e131c] border border-slate-200 dark:border-white/20 text-slate-700 dark:text-white outline-none"
                aria-label="مرتب‌سازی"
              >
                <option value="newest">جدیدترین</option>
                <option value="amount_desc">بیشترین مبلغ</option>
                <option value="amount_asc">کمترین مبلغ</option>
              </select>
            </div>

            {/* Desktop Card / Table Toggle */}
            <div className="hidden md:flex items-center p-1 rounded-xl bg-slate-100 dark:bg-[#0e131c] border border-slate-200/80 dark:border-white/15">
              <button
                type="button"
                onClick={() => setDisplayMode('cards')}
                className={`p-1.5 rounded-lg transition-colors ${
                  displayMode === 'cards'
                    ? 'bg-white dark:bg-[#1b2230] text-blue-600 dark:text-white shadow-sm'
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
                    ? 'bg-white dark:bg-[#1b2230] text-blue-600 dark:text-white shadow-sm'
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

      {/* Results View: Populated Cards, Compact Ledger Table, or Empty State */}
      {filtered.length === 0 ? (
        <div className="p-12 md:p-16 text-center bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 rounded-3xl space-y-4">
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
        <div className="hidden md:block bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200/80 dark:border-white/15 text-[11px] font-black text-slate-500 dark:text-slate-300 bg-slate-50/70 dark:bg-white/[0.03]">
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
                          {cat} · {formatDateShortFa(c.createdAt || c.created_at)}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-slate-700 dark:text-slate-200 font-bold">{p.roleLabel}</td>
                      <td className="py-3 px-4">
                        <span className={`font-black text-[11px] ${st.toneClass}`}>{st.label}</span>
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

            return (
              <div
                key={c.contract_id || c.id}
                onClick={() => openContract(c)}
                className="p-4 md:p-5 rounded-2xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 hover:border-blue-500/50 dark:hover:border-white/40 transition-all cursor-pointer flex flex-col justify-between gap-4 group"
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
                    <h3 className="text-sm md:text-base font-black text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-300 transition-colors leading-snug line-clamp-2">
                      {c.title}
                    </h3>
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
                  <div className="flex items-center justify-between text-[11px]">
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
                    {c.deadline && (
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 tabular-nums">
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
                              className={`text-[9px] block truncate ${
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
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [savedContacts, setSavedContacts] = useState<any[]>([]);
  const [lookupState, setLookupState] = useState<{
    status: 'idle' | 'checking' | 'found' | 'not_found';
    user?: { id: string; full_name: string; phone_number: string; kyc_status?: string };
  }>({ status: 'idle' });

  useEffect(() => {
    const prefill = localStorage.getItem('mianji_prefill_phone');
    if (prefill) {
      setFormData((prev) => ({ ...prev, phone: normalizeDigits(prefill) }));
      localStorage.removeItem('mianji_prefill_phone');
    }
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
    const cleanPhone = normalizeDigits(formData.phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      setLookupState({ status: 'idle' });
      return;
    }
    const timer = setTimeout(async () => {
      setLookupState({ status: 'checking' });
      try {
        const res = await fetch(`/api/users/lookup?phone=${encodeURIComponent(cleanPhone)}`);
        const data = await res.json();
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
    { id: 'digital', label: 'خدمات دیجیتال', desc: 'طراحی، برنامه‌نویسی و سئو', icon: <Briefcase size={15} /> },
    { id: 'account', label: 'اکانت و دارایی', desc: 'کانال، پیج، دامنه و سرویس', icon: <User size={15} /> },
    { id: 'physical', label: 'کالای فیزیکی', desc: 'سخت‌افزار و ارسال پستی', icon: <Package size={15} /> },
    { id: 'other', label: 'سایر معاملات', desc: 'توافقات اختصاصی', icon: <SlidersHorizontal size={15} /> },
  ] as const;

  const quickTemplates = [
    {
      label: 'طراحی وب‌سایت / اپلیکیشن',
      title: 'طراحی و پیاده‌سازی وب‌سایت اختصاصی',
      category: 'digital' as const,
      deadline: '14',
      revisions: '3',
      inspectionHours: '72',
      description: '- تحویل سورس‌کد کامل و تست فنی نهایی روی دامنه کارفرما\n- پشتیبانی رفع باگ به مدت ۷ روز پس از تحویل نهایی',
    },
    {
      label: 'انتقال کانال یا پیج',
      title: 'انتقال امن مالکیت کانال / پیج',
      category: 'account' as const,
      deadline: '2',
      revisions: '0',
      inspectionHours: '24',
      description: '- انتقال کامل مالکیت (Owner) و حذف نشست‌های قبلی در حضور کارفرما\n- ضمانت عدم بازگردانی و تایید سلامت اکانت پیش از آزادسازی وجه',
    },
    {
      label: 'خرید و فروش اکانت / اشتراک',
      title: 'واگذاری اکانت و اشتراک دیجیتال',
      category: 'account' as const,
      deadline: '1',
      revisions: '1',
      inspectionHours: '24',
      description: '- تحویل ایمیل اصلی و اطلاعات بازیابی بدون هیچ دسترسی ثانویه\n- بررسی صحت دسترسی‌ها توسط خریدار در بازه ۲۴ ساعته',
    },
    {
      label: 'ارسال کالای فیزیکی',
      title: 'خرید و ارسال کالای فیزیکی با ضمانت سلامت',
      category: 'physical' as const,
      deadline: '5',
      revisions: '0',
      inspectionHours: '48',
      description: '- ارسال از طریق پست/تیپاکس با کد رهگیری معتبر داخل چت معامله\n- تطابق کامل مشخصات و سلامت فیزیکی کالا با تصاویر توافق‌شده',
    },
    {
      label: 'تولید محتوا / طراحی گرافیک',
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
    'تحویل نهایی پس از بررسی کامل کارفرما تایید می‌شود.',
    'تمامی مستندات و فایل‌ها صرفاً داخل گفتگوی میانجی ارسال شود.',
    'ضمانت اصالت و سلامت فنی در بازه بازرسی توافق‌شده برقرار است.',
    'هرگونه تغییر خارج از توافق اولیه مشمول زمان و هزینه جداگانه است.',
  ];

  const stepsMeta = [
    { num: 1 as const, label: 'هویت و قالب' },
    { num: 2 as const, label: 'مبلغ و مهلت' },
    { num: 3 as const, label: 'طرف مقابل و شروط' },
    { num: 4 as const, label: 'بازبینی و ثبت' },
  ];

  const goToStep = (target: 1 | 2 | 3 | 4) => {
    setFormError('');
    setDirection(target >= step ? 1 : -1);
    setStep(target);
  };

  const canJumpToStep = (target: 1 | 2 | 3 | 4) => {
    if (target <= step) return true;
    if (target >= 2 && (!formData.title.trim() || formData.title.trim().length < 3)) return false;
    if (target >= 3 && (!numericAmount || numericAmount < minDealLimit || (maxDealLimit > 0 && numericAmount > maxDealLimit)))
      return false;
    if (target === 4 && (cleanCounterpartyPhone.length < 10 || isSameAsOwnPhone)) return false;
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
        setFormError('لطفاً عنوان شفاف معامله (حداقل ۳ کاراکتر) را وارد کنید.');
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
      goToStep(3);
      return;
    }
    if (step === 3) {
      if (cleanCounterpartyPhone.length < 10) {
        setFormError('لطفاً شماره همراه معتبر طرف مقابل (حداقل ۱۰ رقم) را وارد کنید.');
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
    if (!titleTrim || !formData.amount || !cleanCounterpartyPhone) {
      setFormError('لطفاً عنوان، مبلغ و شماره همراه طرف مقابل را کامل وارد کنید');
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
    if (cleanCounterpartyPhone.length < 10) {
      setFormError('شماره همراه طرف مقابل معتبر نیست');
      return;
    }
    if (isSameAsOwnPhone) {
      setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد');
      return;
    }

    setLoading(true);
    try {
      const contractId = `M-${Math.floor(100000 + Math.random() * 900000)}`;
      const isExplicitDemo = localStorage.getItem('mianji_demo_mode') === 'true';
      const inspectionLine = formData.inspectionHours ? `مهلت بررسی و تست پس از تحویل: ${formData.inspectionHours} ساعت` : '';
      const composedDescription = [formData.description.trim(), inspectionLine].filter(Boolean).join('\n').slice(0, 2000);

      if (isExplicitDemo) {
        const otherId = lookupState.user?.id || `u_${cleanCounterpartyPhone.slice(-10)}`;
        const newContract = {
          id: contractId,
          contract_id: contractId,
          title: titleTrim.slice(0, 200),
          amount: numericAmount,
          buyer_id: formData.role === 'buyer' ? String(user.id) : String(otherId),
          seller_id: formData.role === 'seller' ? String(user.id) : String(otherId),
          status: 'draft',
          category: formData.category,
          description: composedDescription,
          deadline: String(formData.deadline || '7').slice(0, 20),
          revisions: String(formData.revisions || '2').slice(0, 20),
          created_at: new Date().toISOString(),
        };
        const saved = localStorage.getItem('mianji_mock_contracts');
        const existing = saved ? JSON.parse(saved) : [];
        localStorage.setItem('mianji_mock_contracts', JSON.stringify([newContract, ...existing]));
        onSuccess(newContract);
        return;
      }

      const res = await apiFetch<{ success: boolean; deal: any }>('/api/deals', {
        method: 'POST',
        body: JSON.stringify({
          contract_id: contractId,
          title: titleTrim.slice(0, 200),
          amount: numericAmount,
          role: formData.role,
          phone: cleanCounterpartyPhone,
          category: formData.category,
          description: composedDescription,
          deadline: String(formData.deadline || '7').slice(0, 20),
          revisions: String(formData.revisions || '2').slice(0, 20),
        }),
      });

      onSuccess(res.deal);
    } catch (err: any) {
      setFormError(err?.message || 'خطا در ثبت معامله');
      notify(err?.message || 'خطا در ثبت معامله', 'error');
    } finally {
      setLoading(false);
    }
  };

  const activeCategoryObj = categoryOptions.find((c) => c.id === formData.category) || categoryOptions[0];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="space-y-4 md:space-y-5 max-w-5xl mx-auto pb-10">
      {/* Top Wizard Header & Interactive Clickable Stepper */}
      <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 rounded-2xl p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => (step > 1 ? goToStep((step - 1) as 1 | 2 | 3) : onBack())}
              className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-white/[0.08] border border-slate-200/80 dark:border-white/20 flex items-center justify-center text-slate-700 dark:text-white active:scale-95 transition-all shrink-0"
              aria-label="بازگشت"
            >
              <ChevronRight size={18} />
            </button>
            <div>
              <h2 className="text-base md:text-lg font-black text-slate-900 dark:text-white leading-tight">ایجاد قرارداد امن</h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-300 font-bold mt-0.5 tabular-nums">
                {maxActiveDealsLimit > 0
                  ? `ظرفیت فعال شما: ${activeDealsCount} از ${maxActiveDealsLimit} معامله`
                  : 'قفل تضمین وجه میانجی تا تحویل کامل'}
              </p>
            </div>
          </div>
          <span className="text-xs font-black text-blue-600 dark:text-blue-300 tabular-nums">
            مرحله {step} از ۴
          </span>
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
                    : 'bg-slate-50 dark:bg-[#1b2230] text-slate-500 dark:text-slate-400 border-slate-200/70 dark:border-white/10 disabled:opacity-60'
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
      </div>

      {/* Main Two-Column Split: Active Step Form + Sticky Live Contract Blueprint */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-8 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 rounded-2xl md:rounded-3xl p-4 md:p-6 overflow-hidden">
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
                {/* One-Tap Smart Templates */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black text-slate-900 dark:text-white">الگوهای آماده قرارداد</span>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400">پرکردن خودکار عنوان، مهلت و شرایط</span>
                  </div>
                  <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1">
                    {quickTemplates.map((tpl) => {
                      const active = formData.title === tpl.title;
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
                            setFormError('');
                          }}
                          className={`min-h-[38px] px-3.5 py-1.5 rounded-xl text-[11px] font-bold border transition-all whitespace-nowrap shrink-0 active:scale-95 ${
                            active
                              ? 'bg-blue-600 text-white border-blue-500'
                              : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200 dark:border-white/20 text-slate-700 dark:text-slate-200 hover:border-blue-500/40'
                          }`}
                        >
                          {tpl.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Title Input */}
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">عنوان دقیق معامله</label>
                  <input
                    placeholder="مثلاً: طراحی فروشگاه اینترنتی، واگذاری کانال تلگرام..."
                    value={formData.title}
                    maxLength={200}
                    onChange={(e) => {
                      setFormData({ ...formData, title: e.target.value });
                      setFormError('');
                    }}
                    className="input-refined !h-12 !px-4"
                  />
                </div>

                {/* Category 2x2 */}
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">دسته‌بندی موضوع قرارداد</label>
                  <div className="grid grid-cols-2 gap-2.5">
                    {categoryOptions.map((cat) => {
                      const active = formData.category === cat.id;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setFormData({ ...formData, category: cat.id })}
                          className={`min-h-[54px] px-3.5 py-2.5 rounded-xl border text-right flex items-center gap-2.5 transition-all active:scale-[0.98] ${
                            active
                              ? 'bg-blue-600/10 dark:bg-blue-500/20 border-blue-600 dark:border-blue-400 text-slate-900 dark:text-white'
                              : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/20 text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/35'
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

                {/* Role Selection */}
                <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-white/15">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">نقش شما در این قرارداد چیست؟</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, role: 'seller' })}
                      className={`p-3.5 rounded-xl border text-right transition-all flex items-center justify-between gap-3 active:scale-[0.98] ${
                        formData.role === 'seller'
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/20 text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <span className="text-xs font-black block truncate">مجری / فروشنده</span>
                        <span className={`text-[10px] block truncate mt-0.5 ${formData.role === 'seller' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                          کار را تحویل می‌دهم و وجه تضمین‌شده می‌گیرم
                        </span>
                      </div>
                      <ArrowUpRight size={16} className="shrink-0" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, role: 'buyer' })}
                      className={`p-3.5 rounded-xl border text-right transition-all flex items-center justify-between gap-3 active:scale-[0.98] ${
                        formData.role === 'buyer'
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/20 text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <span className="text-xs font-black block truncate">کارفرما / خریدار</span>
                        <span className={`text-[10px] block truncate mt-0.5 ${formData.role === 'buyer' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>
                          وجه را امانت می‌گذارم تا بعد از تحویل آزاد شود
                        </span>
                      </div>
                      <Lock size={16} className="shrink-0" />
                    </button>
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
                    <label className="text-xs font-black text-slate-900 dark:text-white">مبلغ کل قرارداد (تومان)</label>
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 tabular-nums">
                      مجاز: {minDealLimit.toLocaleString()} تا {maxDealLimit > 0 ? maxDealLimit.toLocaleString() : 'نامحدود'} تومان
                    </span>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="5000000"
                    value={formData.amount}
                    onChange={(e) => {
                      setFormData({ ...formData, amount: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') });
                      setFormError('');
                    }}
                    className="input-refined !h-13 text-center text-xl font-black font-mono tracking-wider tabular-nums"
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
                            : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/20 text-slate-700 dark:text-slate-200 hover:border-blue-500/40'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Deadline + Revisions + Inspection */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-slate-100 dark:border-white/15">
                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/15 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-slate-900 dark:text-white">مهلت تحویل (روز)</span>
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
                        className="w-10 h-10 rounded-lg bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/20 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0"
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
                        className="w-full min-w-0 h-10 bg-transparent text-center text-base font-black font-mono tabular-nums text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => adjustCounter('deadline', 1, 1, 365)}
                        className="w-10 h-10 rounded-lg bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/20 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0"
                        aria-label="افزایش مهلت"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/15 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-slate-900 dark:text-white">اصلاحات رایگان</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">نوبت ویرایش</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => adjustCounter('revisions', -1, 0, 50)}
                        className="w-10 h-10 rounded-lg bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/20 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0"
                        aria-label="کاهش اصلاحات"
                      >
                        <Minus size={14} />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        value={formData.revisions}
                        onChange={(e) => setFormData({ ...formData, revisions: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') })}
                        className="w-full min-w-0 h-10 bg-transparent text-center text-base font-black font-mono tabular-nums text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => adjustCounter('revisions', 1, 0, 50)}
                        className="w-10 h-10 rounded-lg bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/20 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0"
                        aria-label="افزایش اصلاحات"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Inspection Window + Fee Breakdown */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/15 flex items-center justify-between gap-2">
                    <span className="text-xs font-black text-slate-900 dark:text-white">بازه تست پس از تحویل</span>
                    <div className="flex items-center gap-1">
                      {[
                        { v: '24', l: '۲۴ ساعت' },
                        { v: '48', l: '۴۸ ساعت' },
                        { v: '72', l: '۷۲ ساعت' },
                      ].map((opt) => (
                        <button
                          key={opt.v}
                          type="button"
                          onClick={() => setFormData({ ...formData, inspectionHours: opt.v })}
                          className={`px-2.5 py-1.5 rounded-lg text-[10px] font-black transition-colors whitespace-nowrap ${
                            formData.inspectionHours === opt.v
                              ? 'bg-blue-600 text-white'
                              : 'bg-white dark:bg-[#141923] text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {opt.l}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-700 dark:text-slate-200">کارمزد حفاظت وجه</span>
                    <span className="font-black text-emerald-600 dark:text-emerald-400">۰٪ (رایگان)</span>
                  </div>
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
                <div className="space-y-2">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">
                    شماره همراه {formData.role === 'seller' ? 'کارفرما (خریدار)' : 'مجری (فروشنده)'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      inputMode="tel"
                      dir="ltr"
                      placeholder="0912..."
                      value={formData.phone}
                      onChange={(e) => {
                        setFormData({ ...formData, phone: normalizeDigits(e.target.value) });
                        setFormError('');
                      }}
                      className="input-refined !h-12 text-center font-mono tracking-wider flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setShowContactPicker(!showContactPicker)}
                      className={`min-h-[48px] px-4 rounded-xl border flex items-center justify-center gap-1.5 text-xs font-black transition-all whitespace-nowrap shrink-0 active:scale-95 ${
                        showContactPicker
                          ? 'bg-blue-600 text-white border-blue-500'
                          : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/20 text-slate-700 dark:text-white hover:border-blue-500/40'
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

                  {lookupState.status === 'checking' && (
                    <p className="text-[11px] text-blue-600 dark:text-blue-300 font-bold">در حال بررسی عضویت در میانجی...</p>
                  )}
                  {lookupState.status === 'found' && lookupState.user && !isSameAsOwnPhone && (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/35 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        <CheckCircle2 size={17} className="text-emerald-500 shrink-0" />
                        <div className="overflow-hidden">
                          <p className="text-xs font-black text-slate-900 dark:text-white truncate">{lookupState.user.full_name}</p>
                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">
                            حساب تاییدشده · {lookupState.user.kyc_status === 'verified' ? 'احراز هویت کامل' : 'عضو فعال میانجی'}
                          </p>
                        </div>
                      </div>
                      <span className="text-[11px] font-mono font-bold text-slate-500 dark:text-slate-300 shrink-0" dir="ltr">
                        {lookupState.user.phone_number}
                      </span>
                    </div>
                  )}
                  {lookupState.status === 'not_found' && cleanCounterpartyPhone.length >= 10 && !isSameAsOwnPhone && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/35 flex items-center gap-2 text-right">
                      <AlertCircle size={16} className="text-amber-500 shrink-0" />
                      <p className="text-[11px] font-bold text-amber-700 dark:text-amber-300 leading-relaxed">
                        این شماره هنوز در ربات میانجی ثبت نشده است؛ برای ثبت قرارداد واقعی، طرف مقابل باید ابتدا ربات را استارت کند.
                      </p>
                    </div>
                  )}

                  {showContactPicker && (
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/20 space-y-2 max-h-48 overflow-y-auto">
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
                            className="w-full min-h-[42px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/15 flex items-center justify-between hover:border-blue-500/40 transition-all text-right"
                          >
                            <span className="text-xs font-black text-slate-900 dark:text-white">{c.full_name}</span>
                            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-300" dir="ltr">
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

                {/* Protective Legal Clauses & Description */}
                <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-white/15">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-black text-slate-900 dark:text-white">بندها و شرایط تحویل</label>
                    <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">
                      {formData.description.length} / ۱۹۰۰ کاراکتر
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
                    {clauseSnippets.map((clause, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() =>
                          setFormData((prev) => ({
                            ...prev,
                            description: prev.description ? `${prev.description}\n- ${clause}` : `- ${clause}`,
                          }))
                        }
                        className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/20 text-[10px] font-bold text-slate-700 dark:text-slate-200 hover:border-blue-500/40 transition-all whitespace-nowrap shrink-0"
                      >
                        + {clause.slice(0, 32)}...
                      </button>
                    ))}
                  </div>
                  <textarea
                    maxLength={1900}
                    placeholder="جزئیات فنی، موارد قابل تحویل، فرمت فایل‌ها و تعهدات طرفین..."
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full h-28 bg-white dark:bg-[#0e131c] border border-slate-200/80 dark:border-white/20 rounded-xl p-3.5 text-xs text-slate-900 dark:text-white focus:border-blue-500/60 outline-none transition-all resize-none leading-relaxed"
                  />
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
                <div className="divide-y divide-slate-200/70 dark:divide-white/10 border border-slate-200/90 dark:border-white/20 rounded-2xl bg-slate-50/70 dark:bg-[#1b2230]">
                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">موضوع و نقش قرارداد</span>
                      <p className="text-sm font-black text-slate-900 dark:text-white truncate">{formData.title}</p>
                      <span className="text-[11px] text-blue-600 dark:text-blue-300 font-bold">
                        {activeCategoryObj.label} · نقش شما: {formData.role === 'seller' ? 'مجری (فروشنده)' : 'کارفرما (خریدار)'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(1)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/20 rounded-lg min-h-[34px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div>
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">ارزش مالی و زمان‌بندی</span>
                      <p className="text-base font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {numericAmount.toLocaleString()} تومان
                      </p>
                      <span className="text-[11px] text-slate-600 dark:text-slate-300 block">
                        {amountWords} · مهلت: {formData.deadline || '7'} روز · اصلاحات: {formData.revisions || '0'} نوبت · بازرسی: {formData.inspectionHours} ساعت
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(2)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/20 rounded-lg min-h-[34px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3.5 flex items-center justify-between gap-3">
                    <div className="flex-1 overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">طرف مقابل و تعهدات</span>
                      <p className="text-xs font-black text-slate-900 dark:text-white font-mono truncate" dir="ltr">
                        {formData.phone} {lookupState.user?.full_name ? `(${lookupState.user.full_name})` : ''}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-300 mt-1 whitespace-pre-line line-clamp-3">
                        {formData.description.trim() || 'شرایط استاندارد ضمانت میانجی'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => goToStep(3)}
                      className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/20 rounded-lg min-h-[34px] px-3 shrink-0"
                    >
                      ویرایش
                    </button>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/25 flex items-center gap-3 text-right">
                  <ShieldCheck size={18} className="text-blue-600 dark:text-blue-300 shrink-0" />
                  <p className="text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed">
                    پس از ثبت پیش‌نویس، قرارداد فوراً در لیست معاملات هر دو طرف ثبت می‌شود و مبلغ معامله تا زمان تایید تحویل توسط کارفرما در امانت امن میانجی محفوظ می‌ماند.
                  </p>
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
          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-white/15 flex items-center justify-between gap-2.5">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => goToStep((step - 1) as 1 | 2 | 3)}
                className="min-h-[44px] px-4 rounded-xl bg-slate-50 dark:bg-white/[0.07] border border-slate-200/80 dark:border-white/20 text-slate-700 dark:text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
              >
                <ChevronRight size={15} />
                مرحله قبل
              </button>
            ) : (
              <button
                type="button"
                onClick={onBack}
                className="min-h-[44px] px-4 rounded-xl bg-slate-50 dark:bg-white/[0.07] border border-slate-200/80 dark:border-white/20 text-slate-700 dark:text-slate-200 text-xs font-bold active:scale-95 transition-all whitespace-nowrap shrink-0"
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
                ادامه به مرحله {step + 1}
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
                    ثبت و ایجاد قرارداد امن
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Sticky Live Contract Blueprint Sidebar (Desktop) */}
        <aside className="hidden lg:block lg:col-span-4 lg:sticky lg:top-24 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/20 rounded-3xl p-5 space-y-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-slate-900 dark:text-white">سند زنده قرارداد</span>
            <Shield size={16} className="text-blue-600 dark:text-blue-300" />
          </div>

          <div className="space-y-1">
            <h4 className="text-sm font-black text-slate-900 dark:text-white leading-snug">
              {formData.title.trim() || 'عنوان قرارداد شما'}
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-300">
              {activeCategoryObj.label} · {formData.role === 'seller' ? 'شما مجری هستید' : 'شما کارفرما هستید'}
            </p>
          </div>

          <div className="py-3.5 border-y border-slate-100 dark:border-white/15 space-y-1">
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
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">اصلاحات رایگان</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{formData.revisions || '0'} نوبت</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">مهلت بررسی پس از تحویل</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{formData.inspectionHours} ساعت</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">طرف مقابل</span>
              <span className="font-black text-slate-900 dark:text-white font-mono truncate max-w-[160px]" dir="ltr">
                {lookupState.user?.full_name || formData.phone || '—'}
              </span>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-white/15 space-y-1.5 text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
            <p className="font-black text-slate-800 dark:text-white">روند امن میانجی:</p>
            <p>۱. کارفرما پیش‌نویس را تایید و مبلغ را قفل می‌کند.</p>
            <p>۲. مجری در مهلت مقرر کار را تحویل می‌دهد.</p>
            <p>۳. پس از تایید در بازه تست، وجه تسویه می‌شود.</p>
          </div>
        </aside>
      </div>
    </motion.div>
  );
}
