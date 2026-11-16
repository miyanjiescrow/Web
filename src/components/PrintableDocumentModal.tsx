import React from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Printer, X, ShieldCheck, CheckCircle2, FileText, Receipt } from 'lucide-react';
import { format as formatJalali } from 'date-fns-jalali';
import {
  computeCommissionBreakdown,
  DEFAULT_PLATFORM_FEE_PERCENT,
  getCategoryMeta,
  getCommissionPayerLabel,
  getDealStatusMeta,
  getMilestoneStatusMeta,
} from '../lib/dealSync';
import { formatIranianCard, formatShebaDisplay } from '../lib/bankValidation';

export interface PrintableReceiptData {
  id: string;
  title: string;
  subtitle?: string;
  type: string;
  amount: number;
  status: string;
  isPositive?: boolean;
  rawDate?: string | number | null;
  contractId?: string;
  bank_name?: string;
  holder_name?: string;
  ref_code?: string;
  payout_kind?: string;
  user_name?: string;
  user_id?: string | number;
  user_phone?: string | null;
}

interface PrintableDocumentModalProps {
  open: boolean;
  mode: 'contract' | 'receipt';
  contract?: any | null;
  receipt?: PrintableReceiptData | null;
  currentUser?: any | null;
  onClose: () => void;
}

const formatFaDateTime = (raw?: unknown): string => {
  if (!raw) return '—';
  try {
    const ms =
      typeof raw === 'number'
        ? raw
        : typeof (raw as any)?.toDate === 'function'
        ? (raw as any).toDate().getTime()
        : Date.parse(String(raw));
    if (Number.isNaN(ms) || ms <= 0) return String(raw);
    return formatJalali(new Date(ms), 'yyyy/MM/dd - HH:mm');
  } catch {
    return String(raw);
  }
};

const translateReceiptStatus = (status: string, type: string): string => {
  if (type === 'escrow_lock') return 'قفل امن در صندوق امانت';
  if (status === 'completed' || status === 'approved') return 'تایید و انجام‌شده';
  if (status === 'rejected') return 'رد شده';
  if (status === 'cancelled') return 'لغو شده';
  return 'در حال بررسی';
};

export default function PrintableDocumentModal({
  open,
  mode,
  contract,
  receipt,
  currentUser,
  onClose,
}: PrintableDocumentModalProps) {
  if (!open) return null;
  if (mode === 'contract' && !contract) return null;
  if (mode === 'receipt' && !receipt) return null;

  const handlePrint = () => {
    window.print();
  };

  const issuedAt = formatFaDateTime(Date.now());

  const contractBreakdown = contract
    ? computeCommissionBreakdown(
        Number(contract.amount || 0),
        Number(contract.fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT),
        contract.commission_payer
      )
    : null;
  const contractStatusMeta = contract ? getDealStatusMeta(contract.status) : null;
  const contractCatMeta = contract ? getCategoryMeta(contract.category) : null;
  const contractMilestones = Array.isArray(contract?.milestones) ? contract.milestones : [];
  const contractTimeline = Array.isArray(contract?.timeline) ? contract.timeline : [];
  const verifyUrl =
    typeof window !== 'undefined' && contract?.contract_id
      ? `${window.location.origin}/?contract_id=${encodeURIComponent(contract.contract_id)}`
      : 'https://mianji.ir';

  const modalContent = (
    <div
      className="fixed inset-0 z-[1400] bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-2 sm:p-5 overflow-y-auto print:static print:inset-auto print:bg-white print:p-0 print:block"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl bg-white text-slate-900 rounded-3xl shadow-2xl border border-slate-200 overflow-hidden my-auto max-h-[94vh] flex flex-col print:max-w-none print:max-h-none print:shadow-none print:border-0 print:rounded-none"
      >
        {/* Top Interactive Toolbar (Hidden in Print) */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 bg-slate-900 text-white print:hidden shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center shrink-0">
              {mode === 'contract' ? <FileText size={16} /> : <Receipt size={16} />}
            </div>
            <div className="min-w-0">
              <h3 className="text-xs sm:text-sm font-black truncate">
                {mode === 'contract' ? 'سند رسمی قرارداد اسکرو میانجی' : 'رسید رسمی تراکنش مالی میانجی'}
              </h3>
              <p className="text-[10px] text-slate-300 truncate">
                برای ذخیره به صورت PDF، در پنجره چاپ گزینه Save as PDF را انتخاب کنید
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handlePrint}
              className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all"
            >
              <Printer size={15} />
              <span>چاپ / ذخیره PDF</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
              title="بستن"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* Printable Paper Area */}
        <div id="mianji-print-sheet" className="flex-1 overflow-y-auto p-6 sm:p-8 space-y-6 bg-white text-slate-900 print:overflow-visible print:p-4" dir="rtl">
          {mode === 'contract' && contract && contractBreakdown && contractStatusMeta && contractCatMeta && (
            <>
              {/* Header */}
              <div className="flex items-start justify-between gap-4 border-b-2 border-slate-900 pb-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-lg bg-slate-900 text-white text-[11px] font-black">
                      پلتفرم ضمانت معامله میانجی
                    </span>
                    <span className="px-2.5 py-1 rounded-lg bg-slate-100 border border-slate-300 text-[11px] font-black">
                      {contractStatusMeta.label}
                    </span>
                  </div>
                  <h1 className="text-lg sm:text-xl font-black text-slate-950 pt-1">{contract.title}</h1>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-600 font-bold">
                    <span>
                      کد قرارداد:{' '}
                      <span dir="ltr" className="font-mono font-black text-slate-950">
                        {contract.contract_id}
                      </span>
                    </span>
                    <span>دسته‌بندی: {contractCatMeta.label}</span>
                    <span>تاریخ ثبت: {formatFaDateTime(contract.created_at || contract.createdAt)}</span>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-1 shrink-0 border border-slate-200 rounded-2xl p-2 bg-slate-50">
                  <QRCodeSVG value={verifyUrl} size={68} />
                  <span className="text-[9px] font-bold text-slate-500">اصالت قرارداد</span>
                </div>
              </div>

              {/* Parties */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 rounded-2xl border border-slate-300 bg-slate-50/70 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black text-blue-700">طرف اول: کارفرما (پرداخت‌کننده)</span>
                    {contract.buyer_signed_at && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700">
                        <CheckCircle2 size={12} /> امضاشده
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-black text-slate-900">
                    {contract.buyer_fullname || contract.buyer_name || 'تعیین‌نشده / در انتظار'}
                  </p>
                  <div className="text-[11px] text-slate-600 space-y-0.5 tabular-nums">
                    <p>شناسه کاربری: {contract.buyer_id || '—'}</p>
                    {contract.buyer_phone && <p dir="ltr" className="text-right">تلفن: {contract.buyer_phone}</p>}
                    {contract.buyer_national_id && <p>کد ملی: {contract.buyer_national_id}</p>}
                    {contract.buyer_signed_at && <p>زمان امضا: {formatFaDateTime(contract.buyer_signed_at)}</p>}
                  </div>
                </div>

                <div className="p-4 rounded-2xl border border-slate-300 bg-slate-50/70 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black text-emerald-700">طرف دوم: مجری (تحویل‌دهنده)</span>
                    {contract.seller_signed_at && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700">
                        <CheckCircle2 size={12} /> امضاشده
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-black text-slate-900">
                    {contract.seller_fullname || contract.seller_name || 'تعیین‌نشده / در انتظار'}
                  </p>
                  <div className="text-[11px] text-slate-600 space-y-0.5 tabular-nums">
                    <p>شناسه کاربری: {contract.seller_id || '—'}</p>
                    {contract.seller_phone && <p dir="ltr" className="text-right">تلفن: {contract.seller_phone}</p>}
                    {contract.seller_national_id && <p>کد ملی: {contract.seller_national_id}</p>}
                    {contract.seller_signed_at && <p>زمان امضا: {formatFaDateTime(contract.seller_signed_at)}</p>}
                  </div>
                </div>
              </div>

              {/* Financial Terms */}
              <div className="rounded-2xl border border-slate-300 overflow-hidden">
                <div className="bg-slate-100 px-4 py-2.5 border-b border-slate-300 text-xs font-black text-slate-900">
                  مشخصات مالی و ضوابط اجرایی قرارداد
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y divide-slate-200 text-xs">
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">مبلغ کل قرارداد</span>
                    <span className="font-black text-slate-950 tabular-nums">
                      {Number(contract.amount || 0).toLocaleString()} تومان
                    </span>
                  </div>
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">کارمزد پلتفرم ({contractBreakdown.feePercent}٪)</span>
                    <span className="font-black text-slate-950 tabular-nums">
                      {Number(contract.fee_amount ?? contractBreakdown.totalFee).toLocaleString()} تومان
                    </span>
                  </div>
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">پرداخت‌کننده کارمزد</span>
                    <span className="font-black text-slate-950">{getCommissionPayerLabel(contract.commission_payer)}</span>
                  </div>
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">خالص دریافتی مجری</span>
                    <span className="font-black text-emerald-700 tabular-nums">
                      {Number(contract.net_seller_amount ?? contractBreakdown.netSellerAmount).toLocaleString()} تومان
                    </span>
                  </div>
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">کل قابل پرداخت کارفرما</span>
                    <span className="font-black text-blue-700 tabular-nums">
                      {Number(contract.employer_total_payable ?? contractBreakdown.employerTotalPayable).toLocaleString()} تومان
                    </span>
                  </div>
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">مهلت تحویل</span>
                    <span className="font-black text-slate-950 tabular-nums">{contract.deadline || 7} روز</span>
                  </div>
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">مهلت بررسی کارفرما</span>
                    <span className="font-black text-slate-950 tabular-nums">{contract.inspection_hours ?? 24} ساعت</span>
                  </div>
                  <div className="p-3">
                    <span className="text-[10px] text-slate-500 block">نوبت ویرایش رایگان</span>
                    <span className="font-black text-slate-950 tabular-nums">
                      {contract.free_edits_left ?? contract.free_edits ?? contract.revisions ?? 0} از{' '}
                      {contract.free_edits_total ?? contract.free_edits ?? contract.revisions ?? 0}
                    </span>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div className="p-4 rounded-2xl border border-slate-300 space-y-2">
                <h4 className="text-xs font-black text-slate-900">شرح تعهدات، مشخصات تحویل و توافقات</h4>
                <p className="text-xs text-slate-700 leading-7 whitespace-pre-wrap">
                  {contract.description || 'شرح مکتوبی ثبت نشده است.'}
                </p>
              </div>

              {/* Milestones */}
              {contractMilestones.length > 0 && (
                <div className="rounded-2xl border border-slate-300 overflow-hidden">
                  <div className="bg-slate-100 px-4 py-2.5 border-b border-slate-300 text-xs font-black text-slate-900">
                    جدول پرداخت مرحله‌ای ({contractMilestones.length} مرحله)
                  </div>
                  <table className="w-full text-xs text-right border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600">
                        <th className="py-2 px-3">#</th>
                        <th className="py-2 px-3">عنوان مرحله</th>
                        <th className="py-2 px-3">مبلغ (تومان)</th>
                        <th className="py-2 px-3">وضعیت</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {contractMilestones.map((m: any, idx: number) => (
                        <tr key={m.id || idx}>
                          <td className="py-2 px-3 font-bold tabular-nums">{idx + 1}</td>
                          <td className="py-2 px-3 font-bold text-slate-900">{m.title}</td>
                          <td className="py-2 px-3 font-black tabular-nums">{Number(m.amount || 0).toLocaleString()}</td>
                          <td className="py-2 px-3 text-[11px] font-bold">{getMilestoneStatusMeta(m.status).label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Dispute Verdict if any */}
              {contract.resolution && (
                <div className="p-4 rounded-2xl border-2 border-slate-800 bg-slate-50 space-y-1.5">
                  <h4 className="text-xs font-black text-slate-900">رأی نهایی هیئت داوری میانجی</h4>
                  <p className="text-xs text-slate-700">
                    سهم مجری: {contract.resolution.seller_percent ?? 0}٪ ({Number(contract.resolution.seller_amount || 0).toLocaleString()} ت) — استرداد به کارفرما:{' '}
                    {Number(contract.resolution.buyer_refund_amount || 0).toLocaleString()} ت
                  </p>
                  {contract.resolution.note && <p className="text-xs text-slate-600">شرح رأی: {contract.resolution.note}</p>}
                  <p className="text-[10px] text-slate-500">
                    صادرکننده: {contract.resolution.arbitrator_name || 'داور میانجی'} · {formatFaDateTime(contract.resolution.decided_at)}
                  </p>
                </div>
              )}

              {/* Timeline */}
              {contractTimeline.length > 0 && (
                <div className="rounded-2xl border border-slate-200 p-4 space-y-2">
                  <h4 className="text-xs font-black text-slate-900">تاریخچه ثبت‌شده رخدادها</h4>
                  <div className="space-y-1.5 text-[11px]">
                    {contractTimeline.slice(-10).map((ev: any, idx: number) => (
                      <div key={ev.id || idx} className="flex items-start justify-between gap-3 border-b border-slate-100 pb-1 last:border-0">
                        <span className="text-slate-700 font-medium">
                          {ev.actor_name ? `${ev.actor_name}: ` : ''}
                          {ev.note || ev.status}
                        </span>
                        <span className="text-slate-500 shrink-0 tabular-nums">{formatFaDateTime(ev.timestamp)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Digital Signature Verification Footer */}
              <div className="border-t border-slate-300 pt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[10px] text-slate-500">
                <div className="space-y-0.5">
                  <p className="font-bold text-slate-700 flex items-center gap-1">
                    <ShieldCheck size={13} className="text-emerald-600" />
                    این سند به صورت سیستمی از دفترکل امن پلتفرم میانجی استخراج شده است.
                  </p>
                  {(contract.buyer_signature_hash || contract.seller_signature_hash) && (
                    <p dir="ltr" className="font-mono text-[9px] text-slate-400">
                      SIG-B: {contract.buyer_signature_hash || '—'} | SIG-S: {contract.seller_signature_hash || '—'}
                    </p>
                  )}
                </div>
                <span className="font-bold tabular-nums shrink-0">تاریخ صدور نسخه: {issuedAt}</span>
              </div>
            </>
          )}

          {mode === 'receipt' && receipt && (
            <div className="max-w-lg mx-auto border-2 border-slate-900 rounded-3xl p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                <div>
                  <span className="px-2.5 py-1 rounded-lg bg-slate-900 text-white text-[10px] font-black">
                    رسید رسمی تراکنش میانجی
                  </span>
                  <h2 className="text-lg font-black text-slate-950 mt-2">{receipt.title}</h2>
                </div>
                <ShieldCheck size={32} className="text-emerald-600 shrink-0" />
              </div>

              <div className="p-4 rounded-2xl bg-slate-100 text-center space-y-1">
                <span className="text-[11px] font-bold text-slate-500 block">مبلغ تراکنش</span>
                <p className="text-2xl font-black text-slate-950 tabular-nums">
                  {Number(receipt.amount || 0).toLocaleString()} تومان
                </p>
                <span className="inline-block px-3 py-0.5 rounded-full bg-white border border-slate-300 text-[11px] font-black text-slate-800">
                  {translateReceiptStatus(receipt.status, receipt.type)}
                </span>
              </div>

              <div className="divide-y divide-slate-200 text-xs">
                <div className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-slate-500 font-bold">شناسه تراکنش</span>
                  <span dir="ltr" className="font-mono font-black text-slate-900">{receipt.id}</span>
                </div>
                <div className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-slate-500 font-bold">صاحب حساب</span>
                  <span className="font-black text-slate-900">
                    {receipt.user_name || currentUser?.full_name || 'کاربر میانجی'}
                  </span>
                </div>
                {(receipt.user_phone || currentUser?.phone_number) && (
                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-bold">شماره همراه</span>
                    <span dir="ltr" className="font-mono font-bold text-slate-800">
                      {receipt.user_phone || currentUser?.phone_number}
                    </span>
                  </div>
                )}
                <div className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-slate-500 font-bold">تاریخ و ساعت</span>
                  <span className="font-bold text-slate-900 tabular-nums">{formatFaDateTime(receipt.rawDate)}</span>
                </div>
                {receipt.contractId && (
                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-bold">قرارداد مرتبط</span>
                    <span dir="ltr" className="font-mono font-black text-blue-700">{receipt.contractId}</span>
                  </div>
                )}
                {receipt.ref_code && (
                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-bold">کد پیگیری / مقصد بانکی</span>
                    <span dir="ltr" className="font-mono font-black text-slate-900">
                      {receipt.payout_kind === 'card'
                        ? formatIranianCard(receipt.ref_code)
                        : receipt.payout_kind === 'sheba'
                        ? formatShebaDisplay(receipt.ref_code)
                        : receipt.ref_code}
                    </span>
                  </div>
                )}
                {receipt.bank_name && (
                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-bold">بانک</span>
                    <span className="font-black text-slate-900">{receipt.bank_name}</span>
                  </div>
                )}
                {receipt.holder_name && (
                  <div className="py-2.5 flex items-center justify-between gap-3">
                    <span className="text-slate-500 font-bold">نام صاحب حساب</span>
                    <span className="font-bold text-slate-900">{receipt.holder_name}</span>
                  </div>
                )}
                {receipt.subtitle && (
                  <div className="py-2.5 flex items-start justify-between gap-3">
                    <span className="text-slate-500 font-bold shrink-0">شرح</span>
                    <span className="font-medium text-slate-800 text-left">{receipt.subtitle}</span>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-200 pt-3 flex items-center justify-between text-[10px] text-slate-500">
                <span>پلتفرم ضمانت معامله میانجی</span>
                <span className="tabular-nums">صدور: {issuedAt}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}
