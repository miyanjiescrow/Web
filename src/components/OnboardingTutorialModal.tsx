import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  QrCode,
  Plus,
  X,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Wallet,
  MessageSquare,
  Menu,
} from 'lucide-react';

interface OnboardingTutorialModalProps {
  open: boolean;
  initialStep?: number;
  userName?: string;
  onClose: () => void;
  onOpenScanAndSign: () => void;
  onCreateDeal: () => void;
}

interface TourStepConfig {
  id: string;
  targetId: string;
  kicker: string;
  title: string;
  description: string;
  radius: number;
  pad: number;
  icon: React.ReactNode;
  iconBg: string;
  checklist?: string[];
  actionLabel?: string;
  onActionType?: 'scan' | 'create';
  preferredPlacement?: 'top' | 'bottom';
}

const STEPS: TourStepConfig[] = [
  {
    id: 'wallet',
    targetId: 'tour-wallet',
    kicker: 'گام ۱ از ۵ · کیف پول و امانت',
    title: 'کیف پول امن میانجی',
    description:
      'موجودی قابل برداشت و مبلغ قفل‌شده «در امانت» اینجا نمایش داده می‌شود. هنگام شروع معامله، وجه نزد میانجی قفل می‌ماند تا هر دو طرف با اطمینان کار کنند.',
    radius: 24,
    pad: 6,
    icon: <Wallet size={17} />,
    iconBg: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    checklist: [
      'واریز و ارسال فیش: شارژ سریع کیف پول برای پرداخت قرارداد',
      'درخواست برداشت: انتقال موجودی آزادشده به حساب بانکی شما',
    ],
    preferredPlacement: 'bottom',
  },
  {
    id: 'scan-sign',
    targetId: 'tour-scan-sign',
    kicker: 'گام ۲ از ۵ · آموزش امضای قرارداد',
    title: 'اسکن و امضای قرارداد',
    description:
      'وقتی طرف مقابل قراردادی ساخته و کد یا QR آن را برایتان می‌فرستد، از این دکمه استفاده کنید تا پیش از هر پرداختی شروط را ببینید و امضا کنید:',
    radius: 16,
    pad: 5,
    icon: <QrCode size={17} />,
    iconBg: 'bg-amber-500/12 text-amber-600 dark:text-amber-400 border-amber-500/20',
    checklist: [
      '۱. اسکن QR با دوربین/گالری یا وارد کردن کد معامله',
      '۲. بررسی مبلغ، سهم کارمزد، مهلت تحویل و نقش شما',
      '۳. زدن «تایید و امضای نهایی» یا «فقط پیوستن به پیش‌نویس»',
    ],
    actionLabel: 'باز کردن اسکن و امضا',
    onActionType: 'scan',
    preferredPlacement: 'bottom',
  },
  {
    id: 'create-deal',
    targetId: 'tour-nav-create',
    kicker: 'گام ۳ از ۵ · ساخت قرارداد جدید',
    title: 'ایجاد معامله با دکمه +',
    description:
      'این دکمه همیشه پایین صفحه در دسترس شماست. با لمس آن قرارداد جدید بسازید و لینک یا کد QR دعوت را برای خریدار یا فروشنده بفرستید.',
    radius: 999,
    pad: 8,
    icon: <Plus size={17} strokeWidth={2.6} />,
    iconBg: 'bg-blue-600/12 text-blue-600 dark:text-blue-400 border-blue-500/20',
    actionLabel: 'ساخت معامله جدید',
    onActionType: 'create',
    preferredPlacement: 'top',
  },
  {
    id: 'messages',
    targetId: 'tour-nav-messages',
    kicker: 'گام ۴ از ۵ · گفتگو و پیگیری',
    title: 'پیام‌ها، تحویل کار و تماس امن',
    description:
      'تمام گفتگوهای قبل از امضا، ارسال فایل‌ها، تماس صوتی/تصویری و هماهنگی مراحل معامله در بخش «پیام‌ها» ثبت و مستند می‌شود.',
    radius: 16,
    pad: 10,
    icon: <MessageSquare size={17} />,
    iconBg: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
    preferredPlacement: 'top',
  },
  {
    id: 'menu',
    targetId: 'tour-header-menu',
    kicker: 'گام ۵ از ۵ · منو و بازپخش راهنما',
    title: 'منوی اصلی، قوانین و داوری',
    description:
      'از این منو به تنظیمات پروفایل، قوانین و راهنما، پشتیبانی آنلاین ۲۴/۷ و همچنین بازپخش دوباره همین راهنما («آموزش میانجی و امضا») دسترسی دارید.',
    radius: 14,
    pad: 6,
    icon: <Menu size={17} />,
    iconBg: 'bg-slate-500/12 text-slate-700 dark:text-slate-300 border-slate-400/25',
    preferredPlacement: 'bottom',
  },
];

interface RectBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export default function OnboardingTutorialModal({
  open,
  initialStep = 0,
  userName,
  onClose,
  onOpenScanAndSign,
  onCreateDeal,
}: OnboardingTutorialModalProps) {
  const [step, setStep] = useState(initialStep);
  const [targetRect, setTargetRect] = useState<RectBox | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 390,
    h: typeof window !== 'undefined' ? window.innerHeight : 844,
  }));
  const [popoverHeight, setPopoverHeight] = useState(250);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledStepRef = useRef<number>(-1);

  useEffect(() => {
    if (open) {
      setStep(clamp(initialStep, 0, STEPS.length - 1));
      lastScrolledStepRef.current = -1;
    } else {
      setTargetRect(null);
      lastScrolledStepRef.current = -1;
    }
  }, [open, initialStep]);

  const currentStep = STEPS[step] || STEPS[0];

  const measureTarget = useCallback(() => {
    if (!open) return false;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setViewport((prev) => (prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));

    const el = document.querySelector(`[data-tour-id="${currentStep.targetId}"]`) as HTMLElement | null;
    if (!el) {
      setTargetRect(null);
      return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      setTargetRect(null);
      return false;
    }
    setTargetRect({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    });
    return true;
  }, [open, currentStep.targetId]);

  // Scroll element into comfortable view when changing step & track layout smoothly
  useEffect(() => {
    if (!open) return;
    let rafId = 0;
    let active = true;
    const startedAt = performance.now();

    const tryFindAndScroll = () => {
      if (!active) return;
      const el = document.querySelector(`[data-tour-id="${currentStep.targetId}"]`) as HTMLElement | null;
      if (el && lastScrolledStepRef.current !== step) {
        lastScrolledStepRef.current = step;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isFixedOrHeader =
          style.position === 'fixed' ||
          Boolean(el.closest('nav.fixed, header.sticky'));
        if (!isFixedOrHeader && (r.top < 76 || r.bottom > window.innerHeight - 100)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
      }
      measureTarget();

      // Track for ~520ms so smooth scrolling and view transition animations lock cleanly
      if (performance.now() - startedAt < 520) {
        rafId = window.requestAnimationFrame(tryFindAndScroll);
      }
    };

    tryFindAndScroll();

    const onViewportChange = () => {
      measureTarget();
    };

    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        setStep((s) => Math.min(STEPS.length - 1, s + 1));
      } else if (e.key === 'ArrowRight') {
        setStep((s) => Math.max(0, s - 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      active = false;
      if (rafId) window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, step, currentStep.targetId, measureTarget, onClose]);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return;
    const updateSize = () => {
      if (popoverRef.current) {
        const h = popoverRef.current.getBoundingClientRect().height;
        if (h > 0) setPopoverHeight(h);
      }
    };
    updateSize();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateSize);
      ro.observe(popoverRef.current);
      return () => ro.disconnect();
    }
  }, [open, step, targetRect]);

  if (!open) return null;

  const pad = currentStep.pad;
  const spotLeft = targetRect ? Math.max(4, targetRect.left - pad) : 0;
  const spotTop = targetRect ? Math.max(4, targetRect.top - pad) : 0;
  const spotWidth = targetRect ? targetRect.width + pad * 2 : 0;
  const spotHeight = targetRect ? targetRect.height + pad * 2 : 0;
  const spotRadius =
    currentStep.radius >= 999
      ? Math.max(spotWidth, spotHeight) / 2
      : currentStep.radius;

  // Compute coachmark popover position next to the focused element
  const margin = 12;
  const popWidth = Math.min(348, viewport.w - margin * 2);
  const gap = 14;

  let popLeft = (viewport.w - popWidth) / 2;
  let popTop = clamp((viewport.h - popoverHeight) / 2, margin, Math.max(margin, viewport.h - popoverHeight - margin));
  let placement: 'top' | 'bottom' | 'center' = 'center';
  let arrowLeft = popWidth / 2;

  if (targetRect) {
    const targetCenterX = targetRect.left + targetRect.width / 2;
    popLeft = clamp(targetCenterX - popWidth / 2, margin, viewport.w - popWidth - margin);
    arrowLeft = clamp(targetCenterX - popLeft, 24, popWidth - 24);

    const spaceBelow = viewport.h - (spotTop + spotHeight) - margin;
    const spaceAbove = spotTop - margin;

    const preferBottom = currentStep.preferredPlacement !== 'top';

    if (preferBottom && spaceBelow >= popoverHeight + gap) {
      placement = 'bottom';
      popTop = spotTop + spotHeight + gap;
    } else if (!preferBottom && spaceAbove >= popoverHeight + gap) {
      placement = 'top';
      popTop = spotTop - popoverHeight - gap;
    } else if (spaceBelow >= spaceAbove) {
      placement = 'bottom';
      popTop = clamp(
        spotTop + spotHeight + gap,
        margin,
        Math.max(margin, viewport.h - popoverHeight - margin)
      );
    } else {
      placement = 'top';
      popTop = clamp(
        spotTop - popoverHeight - gap,
        margin,
        Math.max(margin, viewport.h - popoverHeight - margin)
      );
    }
  }

  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-[400] pointer-events-none select-none"
      role="dialog"
      aria-modal="true"
      aria-label="تور آموزشی تعاملی میانجی"
    >
      {/* Dimmed Backdrop with crisp cutout around the focused element */}
      <svg
        className="fixed inset-0 w-full h-full pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        aria-hidden="true"
      >
        <defs>
          <mask id="mianji-tour-spotlight-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {targetRect && (
              <rect
                x={spotLeft}
                y={spotTop}
                width={spotWidth}
                height={spotHeight}
                rx={spotRadius}
                ry={spotRadius}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.80)"
          mask="url(#mianji-tour-spotlight-mask)"
        />
      </svg>

      {/* Focused Highlight Ring */}
      {targetRect && (
        <motion.div
          key={`ring-${currentStep.id}`}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          style={{
            left: spotLeft,
            top: spotTop,
            width: spotWidth,
            height: spotHeight,
            borderRadius: spotRadius,
          }}
          className="fixed pointer-events-none border-2 border-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.26),0_0_26px_rgba(37,99,235,0.45)]"
        />
      )}

      {/* Anchored Step-by-Step Coachmark Popover */}
      <AnimatePresence mode="wait">
        <motion.div
          ref={popoverRef}
          key={currentStep.id}
          initial={{ opacity: 0, y: placement === 'top' ? 8 : -8, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          style={{
            left: popLeft,
            top: popTop,
            width: popWidth,
          }}
          dir="rtl"
          className="fixed pointer-events-auto rounded-2xl bg-white dark:bg-[#202126] border border-slate-200/80 dark:border-transparent p-4 shadow-[0_18px_40px_-10px_rgba(15,23,42,0.20)] dark:shadow-[0_18px_44px_-10px_rgba(0,0,0,0.85)] text-right space-y-3"
        >
          {/* Directional Caret Arrow pointing to the focused element */}
          {targetRect && placement === 'bottom' && (
            <div
              style={{ left: arrowLeft - 7 }}
              className="absolute -top-[7px] w-3.5 h-3.5 rotate-45 bg-white dark:bg-[#202126] border-t border-l border-slate-200/80 dark:border-transparent"
            />
          )}
          {targetRect && placement === 'top' && (
            <div
              style={{ left: arrowLeft - 7 }}
              className="absolute -bottom-[7px] w-3.5 h-3.5 rotate-45 bg-white dark:bg-[#202126] border-b border-r border-slate-200/80 dark:border-transparent"
            />
          )}

          {/* Header Row: Kicker + Close */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-blue-600 dark:text-blue-400 tabular-nums">
              {currentStep.kicker}
              {isFirst && userName ? ` · سلام ${userName}` : ''}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="بستن آموزش"
              className="h-8 px-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-600 dark:text-slate-300 text-[11px] font-bold inline-flex items-center gap-1 transition-colors shrink-0"
            >
              <span>بستن</span>
              <X size={13} />
            </button>
          </div>

          {/* Icon + Title + Description */}
          <div className="flex items-start gap-2.5">
            <div
              className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 mt-0.5 ${currentStep.iconBg}`}
            >
              {currentStep.icon}
            </div>
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-black text-slate-900 dark:text-white leading-snug">
                {currentStep.title}
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {currentStep.description}
              </p>
            </div>
          </div>

          {/* Optional Step-by-Step Micro Checklist (e.g. Contract Signing Steps) */}
          {currentStep.checklist && currentStep.checklist.length > 0 && (
            <div className="rounded-xl bg-slate-50 dark:bg-[#0d121b] border border-slate-200/80 dark:border-white/[0.07] p-2.5 space-y-1.5">
              {currentStep.checklist.map((line, i) => (
                <p
                  key={i}
                  className="text-[11px] font-medium text-slate-700 dark:text-slate-200 leading-relaxed"
                >
                  {line}
                </p>
              ))}
            </div>
          )}

          {/* Optional Interactive Quick Try Action */}
          {currentStep.actionLabel && currentStep.onActionType && (
            <button
              type="button"
              onClick={() => {
                if (currentStep.onActionType === 'scan') {
                  onOpenScanAndSign();
                } else {
                  onCreateDeal();
                }
              }}
              className="w-full h-9 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.07] dark:hover:bg-white/[0.12] border border-slate-200/80 dark:border-white/[0.08] text-slate-800 dark:text-slate-100 text-[11px] font-black flex items-center justify-center gap-1.5 transition-colors active:scale-[0.98]"
            >
              {currentStep.onActionType === 'scan' ? <QrCode size={14} /> : <Plus size={14} />}
              <span>{currentStep.actionLabel}</span>
            </button>
          )}

          {/* Progress Dots + Prev/Next Controls */}
          <div className="pt-2 border-t border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between gap-2">
            {/* Step Dots */}
            <div className="flex items-center gap-1.5">
              {STEPS.map((s, idx) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStep(idx)}
                  aria-label={`رفتن به گام ${idx + 1}`}
                  className={`h-1.5 rounded-full transition-all bg-transparent p-0 border-0 shadow-none ${
                    idx === step
                      ? 'w-5 !bg-blue-600'
                      : idx < step
                      ? 'w-2 !bg-emerald-500'
                      : 'w-2 !bg-slate-300 dark:!bg-white/20'
                  }`}
                />
              ))}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {!isFirst && (
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  className="h-9 px-3 rounded-xl bg-slate-100 dark:bg-white/[0.07] hover:bg-slate-200 dark:hover:bg-white/[0.12] text-slate-700 dark:text-slate-200 text-xs font-bold inline-flex items-center gap-1 transition-colors active:scale-95"
                >
                  <ChevronRight size={14} />
                  <span>قبلی</span>
                </button>
              )}

              {!isLast ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
                  className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black inline-flex items-center gap-1 shadow-md shadow-blue-600/25 transition-all active:scale-95"
                >
                  <span>{isFirst ? 'بعدی: امضای قرارداد' : 'بعدی'}</span>
                  <ChevronLeft size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black inline-flex items-center gap-1.5 shadow-md shadow-emerald-600/25 transition-all active:scale-95"
                >
                  <CheckCircle2 size={14} />
                  <span>پایان آموزش</span>
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
