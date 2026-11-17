import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck,
  Compass,
  QrCode,
  HelpCircle,
  Search,
  ChevronDown,
  FileText,
  Wallet,
  Gavel,
  Clock,
  Lock,
  CheckCircle2,
  Edit3,
  Scale,
  MessageSquare,
  Sparkles,
  X,
} from 'lucide-react';

interface RulesAndHelpCenterProps {
  onStartTour?: (initialStep?: number) => void;
  onOpenScanAndSign?: () => void;
  onOpenSupport?: () => void;
  botLink: string;
  cleanBotUsername: string;
}

type ModuleTab = 'rules' | 'guide' | 'finance' | 'faq';
type FaqCategory = 'all' | 'signing' | 'finance' | 'dispute' | 'security';

interface RuleModuleItem {
  id: string;
  title: string;
  summary: string;
  details: string[];
  icon: React.ReactNode;
  accent: string;
}

interface FaqItem {
  id: string;
  category: Exclude<FaqCategory, 'all'>;
  categoryLabel: string;
  question: string;
  answer: string;
}

const RULE_MODULES: RuleModuleItem[] = [
  {
    id: 'escrow-lock',
    title: '۱. قفل و امانت وجه در میانجی',
    summary: 'پول معامله تا تایید کامل کارفرما یا پایان مهلت بازرسی قفل می‌ماند.',
    details: [
      'پس از پرداخت خریدار، مبلغ قرارداد از بخش «قابل برداشت» به حساب «در امانت» منتقل می‌شود.',
      'فروشنده با اطمینان از قفل بودن بودجه کار را شروع می‌کند و خریدار مطمئن است پیش از تحویل، وجه آزاد نمی‌شود.',
    ],
    icon: <Lock size={16} />,
    accent: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  },
  {
    id: 'immutable-terms',
    title: '۲. ثبت قطعی شروط پس از امضای دوطرفه',
    summary: 'امکان تغییر یک‌طرفه مبلغ، کارمزد یا مهلت بعد از امضا وجود ندارد.',
    details: [
      'تا زمانی که قرارداد در حالت «پیش‌نویس» است، طرفین می‌توانند در چت گفتگو کرده و بندها را اصلاح کنند.',
      'پس از ثبت امضای دیجیتال طرف دوم، تمامی بندها قفل شده و مرجع رسمی قرارداد می‌شوند.',
    ],
    icon: <FileText size={16} />,
    accent: 'bg-blue-600/12 text-blue-600 dark:text-blue-400 border-blue-500/20',
  },
  {
    id: 'kyc-telegram',
    title: '۳. احراز هویت و مسئولیت حساب کاربری',
    summary: 'تایید شماره همراه از طریق ربات رسمی تلگرام برای امنیت هر دو طرف الزامی است.',
    details: [
      'برای مبالغ بالا یا تسویه بانکی، تطابق کارت بانکی با کد ملی و نام دارنده حساب بررسی می‌شود.',
      'هر کاربر مسئول تمام اقداماتی است که از طریق نشست‌های فعال حساب خود انجام می‌دهد.',
    ],
    icon: <ShieldCheck size={16} />,
    accent: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
  },
  {
    id: 'arbitration-policy',
    title: '۴. ملاک داوری و حل اختلاف',
    summary: 'تمامی گفتگوها، فایل‌های تحویلی و رسیدهای داخل میانجی سند معتبر داوری هستند.',
    details: [
      'توافقات خارج از پلتفرم بدون مستندسازی در چت میانجی قابل استناد نیستند.',
      'در صورت باز شدن پرونده اختلاف، داور بر اساس شروط قرارداد و شواهد بارگذاری‌شده رای صادر می‌کند.',
    ],
    icon: <Gavel size={16} />,
    accent: 'bg-rose-500/12 text-rose-600 dark:text-rose-400 border-rose-500/20',
  },
];

const GUIDE_STEPS = [
  {
    step: 'گام ۱',
    title: 'ایجاد قرارداد یا اسکن دعوت‌نامه',
    desc: 'یکی از طرفین قرارداد را با مبلغ، توضیحات، سهم کارمزد و مهلت بازرسی می‌سازد و لینک یا کد QR را می‌فرستد.',
    icon: <FileText size={16} />,
    accent: 'text-blue-600 dark:text-blue-400 bg-blue-600/10 border-blue-500/20',
  },
  {
    step: 'گام ۲',
    title: 'مشاهده شروط و امضای قرارداد',
    desc: 'طرف دوم با «اسکن و امضا» یا باز کردن لینک دعوت، پیش از عضویت مبلغ و تعهدات را می‌بیند و امضای دیجیتال را ثبت می‌کند (یا اول به پیش‌نویس می‌پیوندد).',
    icon: <QrCode size={16} />,
    accent: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
  },
  {
    step: 'گام ۳',
    title: 'واریز و قفل شدن وجه در امانت',
    desc: 'خریدار مبلغ قرارداد را از کیف پول (یا واریز جدید) تامین می‌کند تا وضعیت قرارداد به «فعال و در حال انجام» تغییر یابد.',
    icon: <Lock size={16} />,
    accent: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  },
  {
    step: 'گام ۴',
    title: 'تحویل کار، بازرسی و آزادسازی',
    desc: 'فروشنده کار یا فایل را تحویل می‌دهد؛ تایمر بازرسی شروع می‌شود و پس از تایید خریدار (یا اتمام مهلت بدون اعتراض)، مبلغ به کیف پول فروشنده واریز می‌گردد.',
    icon: <CheckCircle2 size={16} />,
    accent: 'text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
  },
];

const FINANCE_MODULES = [
  {
    title: 'تفاوت «قابل برداشت» و «در امانت»',
    body: 'مبلغ «قابل برداشت» هر لحظه آماده ثبت درخواست تسویه به کارت بانکی شماست. مبلغ «در امانت» متعلق به قراردادهای جاری است و تا تایید تحویل، قفل می‌ماند.',
    icon: <Wallet size={16} />,
    accent: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  },
  {
    title: 'پرداخت مرحله‌ای (Milestone)',
    body: 'برای پروژه‌های بزرگ می‌توانید مبلغ کل را به چند مرحله تقسیم کنید. با تحویل و تایید هر مرحله، فقط سهم همان بخش آزاد می‌شود.',
    icon: <CheckCircle2 size={16} />,
    accent: 'text-blue-600 dark:text-blue-400 bg-blue-600/10 border-blue-500/20',
  },
  {
    title: 'تقسیم توافقی کارمزد میانجی',
    body: 'هنگام ساخت قرارداد مشخص می‌کنید کارمزد بر عهده خریدار باشد، از دریافتی فروشنده کسر شود یا ۵۰/۵۰ بین دو طرف تقسیم شود.',
    icon: <Scale size={16} />,
    accent: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
  },
  {
    title: 'تایمر بازرسی و درخواست اصلاح',
    body: 'پس از ثبت تحویل توسط فروشنده، خریدار طبق مهلت قرارداد فرصت بررسی دارد و می‌تواند کار را تایید کند، درخواست اصلاح (Revision) بدهد یا در صورت مغایرت اختلاف ثبت کند.',
    icon: <Clock size={16} />,
    accent: 'text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/20',
  },
];

const FAQ_ITEMS: FaqItem[] = [
  {
    id: 'faq-join-sign',
    category: 'signing',
    categoryLabel: 'قرارداد و امضا',
    question: 'چطور قراردادی که طرف مقابل ساخته را ببینم و امضا کنم؟',
    answer:
      'در صفحه اصلی روی دکمه «اسکن و امضا» بزنید، سپس QR کد را با دوربین یا عکس گالری اسکن کنید یا کد معامله (مثلاً DEV-0508-4821) را وارد کنید. پیش از تایید نهایی، تمام شروط و مبلغ به شما نمایش داده می‌شود.',
  },
  {
    id: 'faq-draft-vs-final',
    category: 'signing',
    categoryLabel: 'قرارداد و امضا',
    question: 'تفاوت «امضای نهایی» با «فقط پیوستن به پیش‌نویس» چیست؟',
    answer:
      'اگر همه شروط و مبلغ مورد تاییدتان است، با «تایید و امضای نهایی» قرارداد رسمی می‌شود و وارد مرحله پرداخت می‌گردد. اگر می‌خواهید ابتدا درباره مبلغ یا جزئیات مذاکره کنید، گزینه «فقط پیوستن به پیش‌نویس» را بزنید تا چت قرارداد باز بماند.',
  },
  {
    id: 'faq-edit-after-sign',
    category: 'signing',
    categoryLabel: 'قرارداد و امضا',
    question: 'آیا بعد از امضای دوطرفه می‌توان مبلغ یا شرایط قرارداد را تغییر داد؟',
    answer:
      'خیر؛ پس از امضای نهایی دو طرف، امکان تغییر یک‌طرفه وجود ندارد. برای تغییر اساسی قبل از واریز، می‌توانید با توافق طرفین قرارداد را لغو کرده و قرارداد جدید بسازید.',
  },
  {
    id: 'faq-milestone',
    category: 'signing',
    categoryLabel: 'قرارداد و امضا',
    question: 'قرارداد مرحله‌ای (Milestone) چه کاربردی دارد؟',
    answer:
      'در پروژه‌های طراحی، برنامه‌نویسی یا خدمات بلندمدت می‌توانید کار را به چند فاز با مبالغ مجزا تقسیم کنید تا خریدار با خیال راحت کل بودجه را قفل کند و فروشنده پس از تحویل هر فاز، دستمزد همان مرحله را دریافت نماید.',
  },
  {
    id: 'faq-wallet-types',
    category: 'finance',
    categoryLabel: 'مالی و برداشت',
    question: 'فرق موجودی «قابل برداشت» و «در امانت» در کیف پول چیست؟',
    answer:
      'موجودی قابل برداشت پولی است که آزاد است و می‌توانید برای معامله جدید استفاده کنید یا به کارت بانکی برداشت بزنید. موجودی در امانت وجهی است که برای یک قرارداد فعال قفل شده است.',
  },
  {
    id: 'faq-fee',
    category: 'finance',
    categoryLabel: 'مالی و برداشت',
    question: 'کارمزد میانجی چگونه محاسبه و توسط چه کسی پرداخت می‌شود؟',
    answer:
      'نرخ کارمزد به صورت شفاف پیش از ساخت و امضای قرارداد نمایش داده می‌شود و سازنده می‌تواند مشخص کند پرداخت کارمزد بر عهده خریدار، فروشنده یا به‌صورت مساوی بین دو طرف باشد.',
  },
  {
    id: 'faq-deposit',
    category: 'finance',
    categoryLabel: 'مالی و برداشت',
    question: 'چگونه کیف پول را شارژ کنم و واریز چقدر طول می‌کشد؟',
    answer:
      'در کارت کیف پول روی «واریز و ارسال فیش» بزنید. در صورت فعال بودن درگاه آنلاین شارژ آنی است و در روش کارت‌به‌کارت پس از آپلود فیش و کد رهگیری، تیم مالی پس از بررسی تایید می‌کند.',
  },
  {
    id: 'faq-withdraw',
    category: 'finance',
    categoryLabel: 'مالی و برداشت',
    question: 'برداشت موجودی به کارت بانکی چطور انجام می‌شود؟',
    answer:
      'پس از آزادسازی وجه معامله، از بخش «درخواست برداشت» شماره کارت یا شبا به نام خودتان را ثبت کنید. مبلغ از موجودی آزاد کسر و به صف تسویه بانکی منتقل می‌شود.',
  },
  {
    id: 'faq-inspection',
    category: 'dispute',
    categoryLabel: 'تحویل و داوری',
    question: 'اگر فروشنده کار را تحویل دهد و خریدار پاسخ ندهد چه می‌شود؟',
    answer:
      'با ثبت تحویل کار توسط فروشنده، تایمر بازرسی طبق مهلت تعیین‌شده در قرارداد شروع به کار می‌کند. اگر خریدار تا پایان مهلت تایید یا اعتراض نکند، وجه به‌صورت خودکار آزاد می‌شود.',
  },
  {
    id: 'faq-revision',
    category: 'dispute',
    categoryLabel: 'تحویل و داوری',
    question: 'اگر کار تحویلی ایراد داشت یا نیاز به اصلاح داشت چکار کنم؟',
    answer:
      'در مهلت بازرسی روی گزینه «درخواست اصلاح» بزنید و موارد مورد نظر را دقیق بنویسید تا فروشنده اصلاحات را در چارچوب تعداد دفعات مجاز قرارداد انجام دهد.',
  },
  {
    id: 'faq-dispute-flow',
    category: 'dispute',
    categoryLabel: 'تحویل و داوری',
    question: 'روند داوری در صورت اختلاف خریدار و فروشنده چگونه است؟',
    answer:
      'هر یک از طرفین می‌تواند گزینه «ثبت اختلاف / داوری» را بزند. وجه همچنان قفل می‌ماند و هر دو طرف فایل‌ها، اسکرین‌شات‌ها و توضیحات خود را ثبت می‌کنند تا داور میانجی رأی عادلانه (آزادسازی، بازگشت وجه یا تقسیم درصدی) صادر کند.',
  },
  {
    id: 'faq-chat-evidence',
    category: 'dispute',
    categoryLabel: 'تحویل و داوری',
    question: 'آیا تمام پیام‌ها و فایل‌های داخل چت معامله قابل استناد هستند؟',
    answer:
      'بله؛ تمامی گفتگوها، توافقات و فایل‌های ردوبدل‌شده در اتاق گفتگوی هر قرارداد برای شفافیت کامل و بررسی داوری نگهداری می‌شوند. همیشه هماهنگی اصلی را داخل چت میانجی انجام دهید.',
  },
  {
    id: 'faq-kyc',
    category: 'security',
    categoryLabel: 'حساب و امنیت',
    question: 'آیا احراز هویت (KYC) برای همه کاربران ضروری است؟',
    answer:
      'ورود و تایید شماره با ربات تلگرام برای همه الزامی است. تکمیل احراز هویت با کد ملی و کارت بانکی نیز سقف معاملات و اطمینان طرف مقابل هنگام کار با شما را بالا می‌برد.',
  },
  {
    id: 'faq-sessions',
    category: 'security',
    categoryLabel: 'حساب و امنیت',
    question: 'چطور دستگاه‌های متصل به حسابم را ببینم یا خارج کنم؟',
    answer:
      'از منوی پنل وارد بخش «امنیت و نشست‌های فعال» شوید. می‌توانید تمام دستگاه‌های لاگین‌شده را ببینید و هر نشست مشکوک یا سایر نشست‌ها را با یک کلیک ببندید.',
  },
];

export default function RulesAndHelpCenter({
  onStartTour,
  onOpenScanAndSign,
  onOpenSupport,
  botLink,
  cleanBotUsername,
}: RulesAndHelpCenterProps) {
  const [activeTab, setActiveTab] = useState<ModuleTab>('rules');
  const [faqCategory, setFaqCategory] = useState<FaqCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [openFaqId, setOpenFaqId] = useState<string | null>('faq-join-sign');
  const [openRuleId, setOpenRuleId] = useState<string | null>('escrow-lock');

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const searchResults = useMemo(() => {
    if (!normalizedQuery) return null;
    const matchedRules = RULE_MODULES.filter(
      (r) =>
        r.title.toLowerCase().includes(normalizedQuery) ||
        r.summary.toLowerCase().includes(normalizedQuery) ||
        r.details.some((d) => d.toLowerCase().includes(normalizedQuery))
    );
    const matchedFaqs = FAQ_ITEMS.filter(
      (f) =>
        f.question.toLowerCase().includes(normalizedQuery) ||
        f.answer.toLowerCase().includes(normalizedQuery) ||
        f.categoryLabel.toLowerCase().includes(normalizedQuery)
    );
    return { matchedRules, matchedFaqs };
  }, [normalizedQuery]);

  const filteredFaqs = useMemo(() => {
    return FAQ_ITEMS.filter((item) => faqCategory === 'all' || item.category === faqCategory);
  }, [faqCategory]);

  const tabs: { id: ModuleTab; label: string; count?: number }[] = [
    { id: 'rules', label: 'قوانین' },
    { id: 'guide', label: 'مراحل و امضا' },
    { id: 'finance', label: 'مالی و داوری' },
    { id: 'faq', label: 'سوالات متداول', count: FAQ_ITEMS.length },
  ];

  const faqCategories: { id: FaqCategory; label: string }[] = [
    { id: 'all', label: 'همه' },
    { id: 'signing', label: 'قرارداد و امضا' },
    { id: 'finance', label: 'مالی و برداشت' },
    { id: 'dispute', label: 'تحویل و داوری' },
    { id: 'security', label: 'حساب و امنیت' },
  ];

  return (
    <div className="space-y-4 text-right pt-1">
      {/* Header Title */}
      <div className="space-y-1 pl-10">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/12 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <ShieldCheck size={18} />
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-white leading-tight">
              قوانین و راهنمای میانجی
            </h3>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              آموزش تعاملی، قوانین امانت‌داری و پاسخ کامل پرسش‌های متداول
            </p>
          </div>
        </div>
      </div>

      {/* Modular Interactive Tour Quick-Access Card */}
      {onStartTour && (
        <div className="rounded-2xl bg-[#3390EC]/10 dark:bg-[#253749]/65 p-3.5 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#3390EC] text-white flex items-center justify-center shrink-0">
              <Compass size={17} />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-xs font-black text-slate-900 dark:text-white">
                تور تعاملی راهنمای صفحه اصلی
              </h4>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed mt-0.5">
                با فوکوس مرحله‌به‌مرحله روی هر بخش برنامه، کار با کیف پول، ساخت معامله و امضای قرارداد را ببینید.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onStartTour(0)}
              className="h-10 px-3 rounded-xl bg-[#3390EC] hover:bg-[#2A82DB] text-white text-[11px] font-black flex items-center justify-center gap-1.5 transition-all active:scale-95"
            >
              <Sparkles size={14} />
              <span>شروع تور تعاملی کامل</span>
            </button>
            <button
              type="button"
              onClick={() => onStartTour(1)}
              className="h-10 px-3 rounded-xl bg-white dark:bg-[#2A2C32] hover:bg-slate-50 dark:hover:bg-[#32343B] text-slate-800 dark:text-slate-100 text-[11px] font-black flex items-center justify-center gap-1.5 transition-all active:scale-95"
            >
              <QrCode size={14} className="text-amber-500" />
              <span>تور ویژه آموزش امضا</span>
            </button>
          </div>
        </div>
      )}

      {/* Search Across Rules & FAQ */}
      <div className="relative">
        <Search
          size={15}
          className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="جستجو در قوانین، امضا، کارمزد، برداشت، داوری..."
          className="w-full h-10 pr-9 pl-9 rounded-full bg-slate-100 dark:bg-[#17181C] border border-slate-200/70 dark:border-transparent text-xs font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:border-[#3390EC]/60"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            aria-label="پاک کردن جستجو"
            className="bg-transparent shadow-none absolute left-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Live Search Mode OR Modular Tabbed Interface */}
      {searchResults ? (
        <div className="space-y-3">
          <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400 tabular-nums">
            نتایج جستجو: {searchResults.matchedRules.length} قانون · {searchResults.matchedFaqs.length} سوال متداول
          </p>

          {searchResults.matchedRules.length === 0 && searchResults.matchedFaqs.length === 0 ? (
            <div className="p-6 rounded-2xl bg-slate-50 dark:bg-[#0d1016] border border-slate-200/80 dark:border-white/[0.07] text-center space-y-2">
              <HelpCircle size={24} className="mx-auto text-slate-400" />
              <p className="text-xs font-bold text-slate-600 dark:text-slate-300">
                موردی با این عبارت پیدا نشد.
              </p>
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-[11px] font-black text-blue-600 dark:text-blue-400 bg-transparent shadow-none hover:underline"
              >
                نمایش همه بخش‌ها
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {searchResults.matchedRules.map((rule) => (
                <div
                  key={rule.id}
                  className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#0d1016] border border-slate-200/80 dark:border-white/[0.07] space-y-1.5"
                >
                  <h4 className="text-xs font-black text-slate-900 dark:text-white">{rule.title}</h4>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                    {rule.summary}
                  </p>
                  {rule.details.map((d, idx) => (
                    <p key={idx} className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                      • {d}
                    </p>
                  ))}
                </div>
              ))}
              {searchResults.matchedFaqs.map((faq) => (
                <div
                  key={faq.id}
                  className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#0d1016] border border-slate-200/80 dark:border-white/[0.07] space-y-1.5"
                >
                  <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 block">
                    {faq.categoryLabel}
                  </span>
                  <h4 className="text-xs font-black text-slate-900 dark:text-white">{faq.question}</h4>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                    {faq.answer}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Segmented Module Tabs */}
          <div className="grid grid-cols-4 gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-[#17181C]">
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-2 px-1.5 rounded-xl text-[11px] font-black transition-all whitespace-nowrap flex items-center justify-center gap-1 ${
                    active
                      ? 'bg-white dark:bg-[#253749] text-[#3390EC] dark:text-[#4FA8F8] shadow-sm'
                      : 'bg-transparent shadow-none text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  <span>{tab.label}</span>
                  {typeof tab.count === 'number' && (
                    <span className="text-[9px] font-bold text-[#3390EC] dark:text-[#4FA8F8] tabular-nums">
                      ({tab.count})
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Active Module Body */}
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="space-y-2.5"
            >
              {/* Module 1: Rules & Safety */}
              {activeTab === 'rules' && (
                <div className="space-y-2">
                  {RULE_MODULES.map((rule) => {
                    const isOpen = openRuleId === rule.id;
                    return (
                      <div
                        key={rule.id}
                        className="rounded-2xl bg-slate-50 dark:bg-[#0d1016] border border-slate-200/80 dark:border-white/[0.07] overflow-hidden"
                      >
                        <button
                          type="button"
                          onClick={() => setOpenRuleId(isOpen ? null : rule.id)}
                          className="w-full p-3.5 bg-transparent shadow-none flex items-center justify-between gap-2.5 text-right"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div
                              className={`w-8 h-8 rounded-xl border flex items-center justify-center shrink-0 ${rule.accent}`}
                            >
                              {rule.icon}
                            </div>
                            <div className="min-w-0">
                              <h4 className="text-xs font-black text-slate-900 dark:text-white leading-snug">
                                {rule.title}
                              </h4>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">
                                {rule.summary}
                              </p>
                            </div>
                          </div>
                          <ChevronDown
                            size={15}
                            className={`text-slate-400 shrink-0 transition-transform duration-200 ${
                              isOpen ? 'rotate-180 text-blue-500' : ''
                            }`}
                          />
                        </button>
                        {isOpen && (
                          <div className="px-3.5 pb-3.5 pt-1 border-t border-slate-200/60 dark:border-white/[0.06] space-y-1.5">
                            {rule.details.map((detail, idx) => (
                              <p
                                key={idx}
                                className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed"
                              >
                                • {detail}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => setActiveTab('faq')}
                    className="w-full h-10 rounded-xl bg-slate-100 dark:bg-[#171a22] hover:bg-slate-200 dark:hover:bg-[#1d212b] border border-slate-200/80 dark:border-white/[0.07] text-slate-800 dark:text-slate-200 text-xs font-black flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <HelpCircle size={15} className="text-blue-500" />
                    <span>مشاهده سوالات متداول ({FAQ_ITEMS.length} پرسش و پاسخ)</span>
                  </button>
                </div>
              )}

              {/* Module 2: Step-by-Step Guide & Contract Signing */}
              {activeTab === 'guide' && (
                <div className="space-y-2.5">
                  {GUIDE_STEPS.map((g, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#0d1016] border border-slate-200/80 dark:border-white/[0.07] flex items-start gap-2.5"
                    >
                      <div
                        className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 mt-0.5 ${g.accent}`}
                      >
                        {g.icon}
                      </div>
                      <div className="min-w-0 space-y-0.5">
                        <span className="text-[10px] font-black text-slate-400 dark:text-slate-400 block">
                          {g.step}
                        </span>
                        <h4 className="text-xs font-black text-slate-900 dark:text-white">
                          {g.title}
                        </h4>
                        <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                          {g.desc}
                        </p>
                      </div>
                    </div>
                  ))}

                  {/* Signing Highlight Card */}
                  <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/20 space-y-2">
                    <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 text-xs font-black">
                      <Edit3 size={15} />
                      <span>نکته مهم هنگام امضای قرارداد</span>
                    </div>
                    <p className="text-[11px] text-slate-700 dark:text-slate-200 leading-relaxed">
                      در پنجره دعوت‌نامه دو گزینه دارید: <strong>«تایید و امضای نهایی»</strong> برای رسمی کردن فوری قرارداد، و <strong>«فقط پیوستن به پیش‌نویس»</strong> برای وقتی که می‌خواهید ابتدا در چت گفتگو و توافق کنید.
                    </p>
                    {onOpenScanAndSign && (
                      <button
                        type="button"
                        onClick={onOpenScanAndSign}
                        className="w-full h-9 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-[11px] font-black flex items-center justify-center gap-1.5 transition-all active:scale-95"
                      >
                        <QrCode size={14} />
                        <span>باز کردن پنجره اسکن و امضا</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Module 3: Finance, Fees & Arbitration */}
              {activeTab === 'finance' && (
                <div className="space-y-2.5">
                  {FINANCE_MODULES.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#0d1016] border border-slate-200/80 dark:border-white/[0.07] flex items-start gap-2.5"
                    >
                      <div
                        className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 mt-0.5 ${item.accent}`}
                      >
                        {item.icon}
                      </div>
                      <div className="min-w-0 space-y-0.5">
                        <h4 className="text-xs font-black text-slate-900 dark:text-white">
                          {item.title}
                        </h4>
                        <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                          {item.body}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Module 4: Comprehensive Modular FAQ */}
              {activeTab === 'faq' && (
                <div className="space-y-2.5">
                  {/* Category Filter Bar */}
                  <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
                    {faqCategories.map((cat) => {
                      const active = faqCategory === cat.id;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setFaqCategory(cat.id)}
                          className={`h-8 px-3 rounded-full text-[11px] font-bold whitespace-nowrap shrink-0 transition-all ${
                            active
                              ? 'bg-[#253749] text-[#4FA8F8] dark:bg-[#253749] dark:text-[#4FA8F8] shadow-none'
                              : 'bg-slate-100 dark:bg-[#282A30] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-[#32343B]'
                          }`}
                        >
                          {cat.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Accordion FAQ List */}
                  <div className="space-y-2">
                    {filteredFaqs.map((faq) => {
                      const isOpen = openFaqId === faq.id;
                      return (
                        <div
                          key={faq.id}
                          className="rounded-2xl bg-slate-50 dark:bg-[#0d1016] border border-slate-200/80 dark:border-white/[0.07] overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => setOpenFaqId(isOpen ? null : faq.id)}
                            className="w-full p-3.5 bg-transparent shadow-none flex items-center justify-between gap-2 text-right"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 block">
                                {faq.categoryLabel}
                              </span>
                              <h4 className="text-xs font-black text-slate-900 dark:text-white leading-snug">
                                {faq.question}
                              </h4>
                            </div>
                            <ChevronDown
                              size={15}
                              className={`text-slate-400 shrink-0 transition-transform duration-200 ${
                                isOpen ? 'rotate-180 text-blue-500' : ''
                              }`}
                            />
                          </button>
                          {isOpen && (
                            <div className="px-3.5 pb-3.5 pt-2 border-t border-slate-200/60 dark:border-white/[0.06] text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                              {faq.answer}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </>
      )}

      {/* Footer Quick Support Link */}
      <div className="pt-2 border-t border-slate-200/80 dark:border-white/[0.07] flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          نیاز به راهنمایی بیشتر دارید؟
        </span>
        {onOpenSupport ? (
          <button
            type="button"
            onClick={onOpenSupport}
            className="h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-[#171a22] hover:bg-slate-200 dark:hover:bg-[#1f2430] border border-slate-200/80 dark:border-white/[0.07] text-slate-800 dark:text-slate-100 text-[11px] font-black inline-flex items-center gap-1.5 transition-all"
          >
            <MessageSquare size={14} className="text-emerald-500" />
            <span>گفتگو با پشتیبانی</span>
          </button>
        ) : (
          <a
            href={botLink}
            target="_blank"
            rel="noopener noreferrer"
            className="h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-[#171a22] hover:bg-slate-200 dark:hover:bg-[#1f2430] border border-slate-200/80 dark:border-white/[0.07] text-slate-800 dark:text-slate-100 text-[11px] font-black inline-flex items-center gap-1.5 transition-all"
          >
            <MessageSquare size={14} className="text-emerald-500" />
            <span>ربات @{cleanBotUsername}</span>
          </a>
        )}
      </div>
    </div>
  );
}
