import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, CheckCircle2, LogOut, ShieldAlert, X } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  previewText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning' | 'primary';
  icon?: 'danger' | 'warning' | 'logout' | 'confirm';
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  previewText,
  confirmLabel = 'تایید و ادامه',
  cancelLabel = 'انصراف',
  tone = 'danger',
  icon,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  const resolvedIcon =
    icon || (tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'confirm');

  const iconBgClass =
    tone === 'danger'
      ? 'bg-rose-500/15 text-rose-500 border-rose-500/25'
      : tone === 'warning'
      ? 'bg-amber-500/15 text-amber-500 border-amber-500/25'
      : 'bg-blue-600/15 text-blue-600 dark:text-blue-400 border-blue-500/25';

  const confirmBtnClass =
    tone === 'danger'
      ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/25'
      : tone === 'warning'
      ? 'bg-amber-500 hover:bg-amber-600 text-slate-950 shadow-amber-500/25'
      : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-600/25';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onClick={() => !busy && onCancel()}
          className="fixed inset-0 bg-black/75 backdrop-blur-md z-[1300] flex items-center justify-center p-5"
          dir="rtl"
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            className="w-full max-w-sm bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-6 space-y-4 relative shadow-2xl dark:shadow-[0_16px_40px_-10px_rgba(0,0,0,0.65)]"
          >
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              aria-label="بستن"
              className="absolute top-4 left-4 w-8 h-8 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-white/15 transition-colors disabled:opacity-40"
            >
              <X size={16} />
            </button>

            <div className="flex flex-col items-center text-center space-y-3 pt-1">
              <div
                className={`w-13 h-13 rounded-2xl border flex items-center justify-center ${iconBgClass}`}
              >
                {resolvedIcon === 'logout' ? (
                  <LogOut size={24} />
                ) : resolvedIcon === 'warning' ? (
                  <AlertTriangle size={24} />
                ) : resolvedIcon === 'confirm' ? (
                  <CheckCircle2 size={24} />
                ) : (
                  <ShieldAlert size={24} />
                )}
              </div>

              <div className="space-y-1.5">
                <h3
                  id="confirm-dialog-title"
                  className="text-base font-black text-slate-900 dark:text-white leading-snug"
                >
                  {title}
                </h3>
                {description && (
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    {description}
                  </p>
                )}
              </div>
            </div>

            {previewText && (
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-slate-200 text-right leading-relaxed break-words max-h-28 overflow-y-auto">
                {previewText}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                className="h-11 rounded-xl bg-slate-100 dark:bg-white/[0.08] hover:bg-slate-200 dark:hover:bg-white/[0.14] border border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-slate-200 text-xs font-black transition-all active:scale-95 disabled:opacity-50"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onConfirm}
                className={`h-11 rounded-xl text-xs font-black shadow-md transition-all active:scale-95 disabled:opacity-50 ${confirmBtnClass}`}
              >
                {busy ? 'در حال انجام...' : confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
