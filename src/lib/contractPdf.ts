import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { rtlText, textBidi } from 'bidi-shaper/pdfkit';
import QRCode from 'qrcode';
import { format as formatJalali } from 'date-fns-jalali';
import {
  computeCommissionBreakdown,
  DEFAULT_PLATFORM_FEE_PERCENT,
  getCategoryMeta,
  getCommissionPayerLabel,
  getDealStatusMeta,
  getMilestoneStatusMeta,
} from './dealSync';

export interface ContractPdfOptions {
  verifyUrl?: string;
  issuedAtMs?: number;
}

const FONT_REGULAR_PATH = path.resolve(process.cwd(), 'node_modules/vazirmatn/fonts/ttf/Vazirmatn-Regular.ttf');
const FONT_BOLD_PATH = path.resolve(process.cwd(), 'node_modules/vazirmatn/fonts/ttf/Vazirmatn-Bold.ttf');

const PAGE_W = 595.28; // A4 width in pt
const PAGE_H = 841.89; // A4 height in pt
const MARGIN_X = 38;
const MARGIN_TOP = 38;
const MARGIN_BOTTOM = 44;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

export function toFaDigits(input: unknown): string {
  const s = String(input ?? '');
  return s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

export function formatFaMoney(amount: unknown): string {
  const n = Math.max(0, Math.round(Number(amount || 0)));
  return `${n.toLocaleString('fa-IR')} تومان`;
}

export function formatFaDateTime(raw?: unknown): string {
  if (!raw) return '—';
  try {
    const ms =
      typeof raw === 'number'
        ? raw
        : typeof (raw as any)?.toDate === 'function'
        ? (raw as any).toDate().getTime()
        : Date.parse(String(raw));
    if (Number.isNaN(ms) || ms <= 0) return String(raw);
    return toFaDigits(formatJalali(new Date(ms), 'yyyy/MM/dd - HH:mm'));
  } catch {
    return String(raw);
  }
}

function measureRtlWidth(doc: PDFKit.PDFDocument, text: string): number {
  if (!text) return 0;
  try {
    return doc.widthOfString(rtlText(text, { direction: 'rtl' }), { features: [] } as any);
  } catch {
    return doc.widthOfString(text);
  }
}

function wrapRtlLines(doc: PDFKit.PDFDocument, rawText: string, maxWidth: number): string[] {
  const normalized = String(rawText ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const paragraphs = normalized.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) {
      lines.push('');
      continue;
    }
    const words = trimmedPara.split(/\s+/);
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureRtlWidth(doc, candidate) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
        current = '';
      }

      if (measureRtlWidth(doc, word) <= maxWidth) {
        current = word;
      } else {
        // Hard-split extremely long tokens (hashes/URLs) cleanly
        let chunk = '';
        for (const ch of word) {
          const nextChunk = chunk + ch;
          if (measureRtlWidth(doc, nextChunk) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk = nextChunk;
          }
        }
        current = chunk;
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : ['—'];
}

function drawRtlText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  align: 'right' | 'center' | 'left' = 'right',
  direction: 'rtl' | 'ltr' | 'auto' = 'rtl'
) {
  textBidi(doc as any, String(text ?? ''), x, y, {
    width,
    align,
    lineBreak: false,
    bidi: { direction },
  });
}

function drawWrappedRtlParagraph(
  doc: PDFKit.PDFDocument,
  lines: string[],
  x: number,
  startY: number,
  width: number,
  lineHeight: number,
  align: 'right' | 'center' | 'left' = 'right'
): number {
  let y = startY;
  for (const line of lines) {
    if (line === '') {
      y += lineHeight * 0.55;
      continue;
    }
    drawRtlText(doc, line, x, y, width, align, 'rtl');
    y += lineHeight;
  }
  return y;
}

export async function buildContractPdfBuffer(contract: any, opts: ContractPdfOptions = {}): Promise<Buffer> {
  const cid = String(contract?.contract_id || contract?.id || 'CONTRACT');
  const title = String(contract?.title || `قرارداد ${cid}`);
  const statusMeta = getDealStatusMeta(contract?.status);
  const catMeta = getCategoryMeta(contract?.category);
  const breakdown = computeCommissionBreakdown(
    Number(contract?.amount || 0),
    Number(contract?.fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT),
    contract?.commission_payer
  );
  const milestones = Array.isArray(contract?.milestones) ? contract.milestones : [];
  const timeline = Array.isArray(contract?.timeline) ? contract.timeline : [];
  const verifyUrl =
    opts.verifyUrl || `https://mianji.ir/?contract_id=${encodeURIComponent(cid)}`;
  const issuedAt = formatFaDateTime(opts.issuedAtMs || Date.now());

  let qrBuffer: Buffer | null = null;
  try {
    qrBuffer = await QRCode.toBuffer(verifyUrl, {
      width: 150,
      margin: 1,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  } catch {
    qrBuffer = null;
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: {
        Title: `قرارداد امانی میانجی - ${cid}`,
        Author: 'پلتفرم ضمانت معامله میانجی',
        Subject: title,
        Creator: 'Mianji Escrow Platform',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const hasRegularFont = fs.existsSync(FONT_REGULAR_PATH);
    const hasBoldFont = fs.existsSync(FONT_BOLD_PATH);
    if (hasRegularFont) doc.registerFont('Vazir', FONT_REGULAR_PATH);
    if (hasBoldFont) doc.registerFont('VazirBold', FONT_BOLD_PATH);

    const setFont = (bold = false, size = 10, color = '#0f172a') => {
      if (bold && hasBoldFont) doc.font('VazirBold');
      else if (hasRegularFont) doc.font('Vazir');
      doc.fontSize(size).fillColor(color);
    };

    let y = MARGIN_TOP;
    let pageNum = 1;

    const drawPageChrome = (isContinuation = false) => {
      doc.save();
      doc.strokeColor('#e2e8f0').lineWidth(0.75);
      doc.roundedRect(24, 24, PAGE_W - 48, PAGE_H - 48, 10).stroke();
      doc.restore();

      if (isContinuation) {
        setFont(true, 8.5, '#64748b');
        drawRtlText(
          doc,
          `ادامه سند رسمی قرارداد ${cid} — پلتفرم میانجی`,
          MARGIN_X,
          30,
          CONTENT_W,
          'right'
        );
        y = 52;
      }

      setFont(false, 8, '#94a3b8');
      drawRtlText(
        doc,
        `صفحه ${toFaDigits(pageNum)} · صدور سیستمی: ${issuedAt}`,
        MARGIN_X,
        PAGE_H - 36,
        CONTENT_W,
        'center'
      );
    };

    const ensureSpace = (neededHeight: number) => {
      if (y + neededHeight > PAGE_H - MARGIN_BOTTOM) {
        doc.addPage();
        pageNum += 1;
        drawPageChrome(true);
      }
    };

    drawPageChrome(false);

    // -------------------------------------------------------------------------
    // 1. Header Banner Card (Dark Slate with QR Code on Left, Title on Right)
    // -------------------------------------------------------------------------
    const headerHeight = 112;
    doc.save();
    doc.fillColor('#0f172a').roundedRect(MARGIN_X, y, CONTENT_W, headerHeight, 12).fill();
    doc.restore();

    const qrBoxSize = 84;
    const qrX = MARGIN_X + 14;
    const qrY = y + 14;
    doc.save();
    doc.fillColor('#ffffff').roundedRect(qrX, qrY, qrBoxSize, qrBoxSize, 8).fill();
    doc.restore();
    if (qrBuffer) {
      doc.image(qrBuffer, qrX + 5, qrY + 5, { width: qrBoxSize - 10, height: qrBoxSize - 10 });
    }
    setFont(false, 6.8, '#cbd5e1');
    drawRtlText(doc, 'اسکن جهت تایید اصالت', qrX - 4, qrY + qrBoxSize + 3, qrBoxSize + 8, 'center');

    const headerTextX = qrX + qrBoxSize + 16;
    const headerTextW = CONTENT_W - (qrBoxSize + 44);

    // Brand badge + Status badge
    setFont(true, 8.5, '#93c5fd');
    drawRtlText(
      doc,
      `پلتفرم ضمانت معامله امانی میانجی  |  وضعیت: ${statusMeta.label}`,
      headerTextX,
      y + 15,
      headerTextW,
      'right'
    );

    setFont(true, 13.5, '#ffffff');
    const titleLines = wrapRtlLines(doc, title, headerTextW).slice(0, 2);
    let ty = drawWrappedRtlParagraph(doc, titleLines, headerTextX, y + 34, headerTextW, 19, 'right');

    setFont(false, 8.5, '#e2e8f0');
    const metaLine = `کد قرارداد: ${cid}  ·  دسته‌بندی: ${catMeta.label}`;
    drawRtlText(doc, metaLine, headerTextX, Math.max(ty + 2, y + 73), headerTextW, 'right');

    setFont(false, 8, '#cbd5e1');
    drawRtlText(
      doc,
      `تاریخ ثبت قرارداد: ${formatFaDateTime(contract?.created_at || contract?.createdAt)}`,
      headerTextX,
      y + 90,
      headerTextW,
      'right'
    );

    y += headerHeight + 14;

    // -------------------------------------------------------------------------
    // 2. Parties Section (Two Side-by-Side Cards: Buyer on Right, Seller on Left)
    // -------------------------------------------------------------------------
    const cardGap = 12;
    const cardW = (CONTENT_W - cardGap) / 2;
    const buyerCardX = MARGIN_X + cardW + cardGap;
    const sellerCardX = MARGIN_X;
    const partyCardH = 112;

    const drawPartyCard = (
      x: number,
      roleTitle: string,
      accentColor: string,
      name: string,
      userId: string,
      phone: string,
      nationalId: string,
      signedAt: unknown
    ) => {
      doc.save();
      doc.fillColor('#f8fafc').strokeColor('#cbd5e1').lineWidth(0.9);
      doc.roundedRect(x, y, cardW, partyCardH, 10).fillAndStroke();
      doc.fillColor(accentColor).roundedRect(x + cardW - 4, y + 10, 4, partyCardH - 20, 2).fill();
      doc.restore();

      const innerX = x + 12;
      const innerW = cardW - 26;
      setFont(true, 9, accentColor);
      drawRtlText(doc, roleTitle, innerX, y + 11, innerW, 'right');

      setFont(true, 10.5, '#0f172a');
      drawRtlText(doc, name || 'تعیین‌نشده / در انتظار', innerX, y + 29, innerW, 'right');

      setFont(false, 8.5, '#475569');
      drawRtlText(doc, `شناسه کاربری: ${userId || '—'}`, innerX, y + 48, innerW, 'right');
      drawRtlText(doc, `تلفن همراه: ${phone ? toFaDigits(phone) : '—'}`, innerX, y + 63, innerW, 'right');
      drawRtlText(doc, `کد ملی: ${nationalId ? toFaDigits(nationalId) : '—'}`, innerX, y + 78, innerW, 'right');

      setFont(true, 8, signedAt ? '#047857' : '#b45309');
      drawRtlText(
        doc,
        signedAt ? `امضا و تایید دیجیتال: ${formatFaDateTime(signedAt)}` : 'وضعیت امضا: در انتظار امضا',
        innerX,
        y + 94,
        innerW,
        'right'
      );
    };

    drawPartyCard(
      buyerCardX,
      'طرف اول: کارفرما (پرداخت‌کننده)',
      '#1d4ed8',
      String(contract?.buyer_fullname || contract?.buyer_name || 'تعیین‌نشده / در انتظار'),
      String(contract?.buyer_id || '—'),
      String(contract?.buyer_phone || ''),
      String(contract?.buyer_national_id || ''),
      contract?.buyer_signed_at
    );

    drawPartyCard(
      sellerCardX,
      'طرف دوم: مجری (تحویل‌دهنده)',
      '#047857',
      String(contract?.seller_fullname || contract?.seller_name || 'تعیین‌نشده / در انتظار'),
      String(contract?.seller_id || '—'),
      String(contract?.seller_phone || ''),
      String(contract?.seller_national_id || ''),
      contract?.seller_signed_at
    );

    y += partyCardH + 14;

    // -------------------------------------------------------------------------
    // 3. Financial Terms Grid (4 columns x 2 rows)
    // -------------------------------------------------------------------------
    const finItems = [
      { label: 'مبلغ کل قرارداد', value: formatFaMoney(contract?.amount || 0), color: '#0f172a' },
      {
        label: `کارمزد پلتفرم (${toFaDigits(breakdown.feePercent)}٪)`,
        value: formatFaMoney(contract?.fee_amount ?? breakdown.totalFee),
        color: '#0f172a',
      },
      { label: 'پرداخت‌کننده کارمزد', value: getCommissionPayerLabel(contract?.commission_payer), color: '#0f172a' },
      {
        label: 'خالص دریافتی مجری',
        value: formatFaMoney(contract?.net_seller_amount ?? breakdown.netSellerAmount),
        color: '#047857',
      },
      {
        label: 'کل قابل پرداخت کارفرما',
        value: formatFaMoney(contract?.employer_total_payable ?? breakdown.employerTotalPayable),
        color: '#1d4ed8',
      },
      { label: 'مهلت تحویل کار', value: `${toFaDigits(contract?.deadline || 7)} روز`, color: '#0f172a' },
      { label: 'مهلت بررسی کارفرما', value: `${toFaDigits(contract?.inspection_hours ?? 24)} ساعت`, color: '#0f172a' },
      {
        label: 'نوبت ویرایش رایگان',
        value: `${toFaDigits(contract?.free_edits_left ?? contract?.free_edits ?? contract?.revisions ?? 0)} از ${toFaDigits(
          contract?.free_edits_total ?? contract?.free_edits ?? contract?.revisions ?? 0
        )}`,
        color: '#0f172a',
      },
    ];

    const finHeaderH = 26;
    const finRowH = 40;
    const finBoxH = finHeaderH + finRowH * 2;
    ensureSpace(finBoxH + 12);

    doc.save();
    doc.fillColor('#ffffff').strokeColor('#cbd5e1').lineWidth(0.9);
    doc.roundedRect(MARGIN_X, y, CONTENT_W, finBoxH, 10).fillAndStroke();
    doc.fillColor('#f1f5f9').rect(MARGIN_X + 0.5, y + 0.5, CONTENT_W - 1, finHeaderH).fill();
    doc.strokeColor('#cbd5e1').moveTo(MARGIN_X, y + finHeaderH).lineTo(MARGIN_X + CONTENT_W, y + finHeaderH).stroke();
    doc.restore();

    setFont(true, 9.5, '#0f172a');
    drawRtlText(doc, 'مشخصات مالی و ضوابط اجرایی قرارداد', MARGIN_X + 12, y + 7, CONTENT_W - 24, 'right');

    const colW = CONTENT_W / 4;
    for (let i = 0; i < finItems.length; i++) {
      const row = Math.floor(i / 4);
      const colFromRight = i % 4;
      const cellX = MARGIN_X + (3 - colFromRight) * colW;
      const cellY = y + finHeaderH + row * finRowH;

      doc.save();
      doc.strokeColor('#e2e8f0').lineWidth(0.6);
      if (colFromRight < 3) {
        doc.moveTo(cellX, cellY).lineTo(cellX, cellY + finRowH).stroke();
      }
      if (row === 0) {
        doc.moveTo(cellX, cellY + finRowH).lineTo(cellX + colW, cellY + finRowH).stroke();
      }
      doc.restore();

      const item = finItems[i];
      setFont(false, 7.8, '#64748b');
      drawRtlText(doc, item.label, cellX + 8, cellY + 7, colW - 16, 'right');
      setFont(true, 9, item.color);
      drawRtlText(doc, item.value, cellX + 8, cellY + 21, colW - 16, 'right');
    }

    y += finBoxH + 14;

    // -------------------------------------------------------------------------
    // 4. Contract Description / Commitments (Paginated cleanly if long)
    // -------------------------------------------------------------------------
    const descText = String(contract?.description || 'شرح مکتوبی ثبت نشده است.');
    setFont(false, 9.2, '#334155');
    const descLines = wrapRtlLines(doc, descText, CONTENT_W - 28);
    const lineH = 16;
    let descIdx = 0;
    let isFirstDescChunk = true;

    while (descIdx < descLines.length) {
      const availableH = PAGE_H - MARGIN_BOTTOM - y - 16;
      const overhead = isFirstDescChunk ? 38 : 26;
      let maxFitLines = Math.floor((availableH - overhead) / lineH);
      if (maxFitLines < 2) {
        doc.addPage();
        pageNum += 1;
        drawPageChrome(true);
        maxFitLines = Math.floor((PAGE_H - MARGIN_BOTTOM - y - overhead - 16) / lineH);
      }
      const chunk = descLines.slice(descIdx, descIdx + Math.max(1, maxFitLines));
      const boxH = overhead + chunk.length * lineH + 10;

      doc.save();
      doc.fillColor('#ffffff').strokeColor('#cbd5e1').lineWidth(0.9);
      doc.roundedRect(MARGIN_X, y, CONTENT_W, boxH, 10).fillAndStroke();
      doc.restore();

      setFont(true, 9.5, '#0f172a');
      drawRtlText(
        doc,
        isFirstDescChunk ? 'شرح تعهدات، مشخصات تحویل و توافقات' : 'ادامه شرح تعهدات قرارداد',
        MARGIN_X + 14,
        y + 11,
        CONTENT_W - 28,
        'right'
      );

      setFont(false, 9.2, '#334155');
      drawWrappedRtlParagraph(doc, chunk, MARGIN_X + 14, y + (isFirstDescChunk ? 32 : 28), CONTENT_W - 28, lineH, 'right');

      y += boxH + 12;
      descIdx += chunk.length;
      isFirstDescChunk = false;
    }

    // -------------------------------------------------------------------------
    // 5. Milestones Table (if staged/milestone deal)
    // -------------------------------------------------------------------------
    if (milestones.length > 0) {
      const msHeaderH = 26;
      const msColHeaderH = 22;
      const msRowH = 24;
      const totalMsH = msHeaderH + msColHeaderH + milestones.length * msRowH;
      ensureSpace(Math.min(totalMsH, 140) + 12);

      const renderMsHeader = (boxH: number) => {
        doc.save();
        doc.fillColor('#ffffff').strokeColor('#cbd5e1').lineWidth(0.9);
        doc.roundedRect(MARGIN_X, y, CONTENT_W, boxH, 10).fillAndStroke();
        doc.fillColor('#f1f5f9').rect(MARGIN_X + 0.5, y + 0.5, CONTENT_W - 1, msHeaderH).fill();
        doc.fillColor('#f8fafc').rect(MARGIN_X + 0.5, y + msHeaderH, CONTENT_W - 1, msColHeaderH).fill();
        doc.strokeColor('#cbd5e1')
          .moveTo(MARGIN_X, y + msHeaderH)
          .lineTo(MARGIN_X + CONTENT_W, y + msHeaderH)
          .moveTo(MARGIN_X, y + msHeaderH + msColHeaderH)
          .lineTo(MARGIN_X + CONTENT_W, y + msHeaderH + msColHeaderH)
          .stroke();
        doc.restore();

        setFont(true, 9.5, '#0f172a');
        drawRtlText(
          doc,
          `جدول پرداخت مرحله‌ای (${toFaDigits(milestones.length)} مرحله)`,
          MARGIN_X + 12,
          y + 7,
          CONTENT_W - 24,
          'right'
        );

        // Columns right-to-left: [Status 140] [Amount 115] [Title flex] [# 34]
        const wNum = 34;
        const wStatus = 140;
        const wAmt = 115;
        const wTitle = CONTENT_W - wNum - wStatus - wAmt;
        const xNum = MARGIN_X + CONTENT_W - wNum;
        const xTitle = xNum - wTitle;
        const xAmt = xTitle - wAmt;
        const xStatus = MARGIN_X;

        setFont(true, 8, '#475569');
        drawRtlText(doc, 'ردیف', xNum + 4, y + msHeaderH + 6, wNum - 8, 'center');
        drawRtlText(doc, 'عنوان مرحله', xTitle + 8, y + msHeaderH + 6, wTitle - 16, 'right');
        drawRtlText(doc, 'مبلغ (تومان)', xAmt + 8, y + msHeaderH + 6, wAmt - 16, 'right');
        drawRtlText(doc, 'وضعیت', xStatus + 8, y + msHeaderH + 6, wStatus - 16, 'right');
      };

      let msStartIdx = 0;
      while (msStartIdx < milestones.length) {
        const avail = PAGE_H - MARGIN_BOTTOM - y - msHeaderH - msColHeaderH - 12;
        let fit = Math.floor(avail / msRowH);
        if (fit < 1) {
          doc.addPage();
          pageNum += 1;
          drawPageChrome(true);
          fit = Math.floor((PAGE_H - MARGIN_BOTTOM - y - msHeaderH - msColHeaderH - 12) / msRowH);
        }
        const chunk = milestones.slice(msStartIdx, msStartIdx + Math.max(1, fit));
        const boxH = msHeaderH + msColHeaderH + chunk.length * msRowH;
        renderMsHeader(boxH);

        const wNum = 34;
        const wStatus = 140;
        const wAmt = 115;
        const wTitle = CONTENT_W - wNum - wStatus - wAmt;
        const xNum = MARGIN_X + CONTENT_W - wNum;
        const xTitle = xNum - wTitle;
        const xAmt = xTitle - wAmt;
        const xStatus = MARGIN_X;

        chunk.forEach((m: any, i: number) => {
          const rowY = y + msHeaderH + msColHeaderH + i * msRowH;
          if (i > 0) {
            doc.save();
            doc.strokeColor('#e2e8f0').lineWidth(0.6).moveTo(MARGIN_X, rowY).lineTo(MARGIN_X + CONTENT_W, rowY).stroke();
            doc.restore();
          }
          setFont(true, 8.5, '#0f172a');
          drawRtlText(doc, toFaDigits(msStartIdx + i + 1), xNum + 4, rowY + 6, wNum - 8, 'center');
          drawRtlText(doc, String(m?.title || `مرحله ${toFaDigits(msStartIdx + i + 1)}`), xTitle + 8, rowY + 6, wTitle - 16, 'right');
          drawRtlText(doc, toFaDigits(Number(m?.amount || 0).toLocaleString('fa-IR')), xAmt + 8, rowY + 6, wAmt - 16, 'right');
          setFont(false, 8, '#334155');
          drawRtlText(doc, getMilestoneStatusMeta(m?.status).label, xStatus + 8, rowY + 6, wStatus - 16, 'right');
        });

        y += boxH + 12;
        msStartIdx += chunk.length;
      }
    }

    // -------------------------------------------------------------------------
    // 6. Dispute Ruling (if resolved)
    // -------------------------------------------------------------------------
    if (contract?.resolution) {
      const res = contract.resolution;
      const rulingText = `سهم مجری: ${toFaDigits(res.seller_percent ?? 0)}٪ (${formatFaMoney(
        res.seller_amount || 0
      )}) — استرداد به کارفرما: ${formatFaMoney(res.buyer_refund_amount || 0)}`;
      const noteText = res.note ? `شرح رأی: ${String(res.note)}` : '';
      setFont(false, 8.8, '#334155');
      const noteLines = noteText ? wrapRtlLines(doc, noteText, CONTENT_W - 28) : [];
      const rulingBoxH = 62 + noteLines.length * 15;
      ensureSpace(rulingBoxH + 12);

      doc.save();
      doc.fillColor('#f8fafc').strokeColor('#1e293b').lineWidth(1.2);
      doc.roundedRect(MARGIN_X, y, CONTENT_W, rulingBoxH, 10).fillAndStroke();
      doc.restore();

      setFont(true, 9.5, '#0f172a');
      drawRtlText(doc, 'رأی نهایی هیئت داوری میانجی', MARGIN_X + 14, y + 10, CONTENT_W - 28, 'right');

      setFont(false, 8.8, '#1e293b');
      drawRtlText(doc, rulingText, MARGIN_X + 14, y + 28, CONTENT_W - 28, 'right');
      let ry = y + 45;
      if (noteLines.length > 0) {
        ry = drawWrappedRtlParagraph(doc, noteLines, MARGIN_X + 14, ry, CONTENT_W - 28, 15, 'right');
      }
      setFont(false, 7.8, '#64748b');
      drawRtlText(
        doc,
        `صادرکننده: ${res.arbitrator_name || 'داور میانجی'} · ${formatFaDateTime(res.decided_at)}`,
        MARGIN_X + 14,
        ry + 2,
        CONTENT_W - 28,
        'right'
      );

      y += rulingBoxH + 12;
    }

    // -------------------------------------------------------------------------
    // 7. Recent Timeline Events (last 8)
    // -------------------------------------------------------------------------
    if (timeline.length > 0) {
      const recentEvents = timeline.slice(-8);
      const tlHeaderH = 28;
      const tlRowH = 18;
      const tlBoxH = tlHeaderH + recentEvents.length * tlRowH + 8;
      ensureSpace(tlBoxH + 12);

      doc.save();
      doc.fillColor('#ffffff').strokeColor('#e2e8f0').lineWidth(0.8);
      doc.roundedRect(MARGIN_X, y, CONTENT_W, tlBoxH, 10).fillAndStroke();
      doc.restore();

      setFont(true, 9.2, '#0f172a');
      drawRtlText(doc, 'تاریخچه ثبت‌شده رخدادها', MARGIN_X + 14, y + 9, CONTENT_W - 28, 'right');

      let tyRow = y + tlHeaderH;
      for (const ev of recentEvents) {
        const noteStr = `${ev?.actor_name ? `${ev.actor_name}: ` : ''}${ev?.note || ev?.status || 'رویداد قرارداد'}`;
        const timeStr = formatFaDateTime(ev?.timestamp);
        setFont(false, 8, '#64748b');
        drawRtlText(doc, timeStr, MARGIN_X + 14, tyRow, 115, 'left');
        setFont(false, 8.2, '#334155');
        drawRtlText(doc, noteStr.slice(0, 95), MARGIN_X + 135, tyRow, CONTENT_W - 149, 'right');
        tyRow += tlRowH;
      }

      y += tlBoxH + 12;
    }

    // -------------------------------------------------------------------------
    // 8. Cryptographic Signature & Verification Footer
    // -------------------------------------------------------------------------
    ensureSpace(64);
    doc.save();
    doc.strokeColor('#cbd5e1').lineWidth(0.8).moveTo(MARGIN_X, y).lineTo(MARGIN_X + CONTENT_W, y).stroke();
    doc.restore();

    setFont(true, 8.5, '#047857');
    drawRtlText(
      doc,
      'این سند به صورت سیستمی و رمزنگاری‌شده از دفترکل امن پلتفرم میانجی استخراج شده است.',
      MARGIN_X,
      y + 10,
      CONTENT_W,
      'right'
    );

    if (contract?.buyer_signature_hash || contract?.seller_signature_hash) {
      setFont(false, 7.5, '#64748b');
      const sigLine = `SIG-B: ${contract.buyer_signature_hash || '—'}  |  SIG-S: ${contract.seller_signature_hash || '—'}`;
      drawRtlText(doc, sigLine, MARGIN_X, y + 26, CONTENT_W, 'left', 'ltr');
    }

    setFont(false, 7.8, '#64748b');
    drawRtlText(doc, `نشانی استعلام اصالت: ${verifyUrl}`, MARGIN_X, y + 40, CONTENT_W, 'left', 'ltr');

    doc.end();
  });
}
