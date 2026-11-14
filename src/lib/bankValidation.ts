const normalizeDigits = (val: string): string =>
  String(val || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();

export interface BankDestinationValidation {
  valid: boolean;
  kind?: 'sheba' | 'card';
  normalized?: string;
  error?: string;
}

export function isValidIranianSheba(raw: string): { valid: boolean; normalized: string } {
  const cleaned = normalizeDigits(raw).replace(/[\s\-_]/g, '').toUpperCase();
  const sheba = /^\d{24}$/.test(cleaned) ? `IR${cleaned}` : cleaned;
  if (!/^IR\d{24}$/.test(sheba)) {
    return { valid: false, normalized: sheba };
  }
  // ISO 7064 Mod 97-10: move 'IR' + 2 check digits to end -> I=18, R=27
  const rearranged = `${sheba.slice(4)}1827${sheba.slice(2, 4)}`;
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i += 1) {
    remainder = (remainder * 10 + Number(rearranged[i])) % 97;
  }
  return { valid: remainder === 1, normalized: sheba };
}

export function isValidIranianCard(raw: string): { valid: boolean; normalized: string } {
  const digits = normalizeDigits(raw).replace(/[^0-9]/g, '');
  if (!/^\d{16}$/.test(digits)) {
    return { valid: false, normalized: digits };
  }
  let sum = 0;
  for (let i = 0; i < 16; i += 1) {
    let n = Number(digits[i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return { valid: sum % 10 === 0, normalized: digits };
}

export function validateIranianPayoutDestination(raw: string): BankDestinationValidation {
  const cleaned = normalizeDigits(raw).replace(/[\s\-_]/g, '').toUpperCase();
  if (!cleaned) {
    return { valid: false, error: 'لطفاً شماره شبا (IR و ۲۴ رقم) یا شماره کارت ۱۶ رقمی معتبر وارد کنید.' };
  }

  if (cleaned.startsWith('IR') || /^\d{24}$/.test(cleaned)) {
    const res = isValidIranianSheba(cleaned);
    if (!res.valid) {
      return { valid: false, error: 'شماره شبا نامعتبر است (رقم کنترل شبا همخوانی ندارد). لطفاً ۲۴ رقم بعد از IR را بررسی کنید.' };
    }
    return { valid: true, kind: 'sheba', normalized: res.normalized };
  }

  if (/^\d{16}$/.test(cleaned)) {
    const res = isValidIranianCard(cleaned);
    if (!res.valid) {
      return { valid: false, error: 'شماره کارت ۱۶ رقمی نامعتبر است. لطفاً ارقام کارت را بررسی کنید.' };
    }
    return { valid: true, kind: 'card', normalized: res.normalized };
  }

  return { valid: false, error: 'مقصد تسویه باید یک شماره شبا (IR + ۲۴ رقم) یا شماره کارت ۱۶ رقمی معتبر باشد.' };
}

export function isValidIranianNationalId(raw: string): { valid: boolean; normalized: string; error?: string } {
  const digits = normalizeDigits(raw).replace(/[^0-9]/g, '');
  if (!/^\d{10}$/.test(digits)) {
    return { valid: false, normalized: digits, error: 'کد ملی باید دقیقاً ۱۰ رقم باشد.' };
  }
  if (/^(\d)\1{9}$/.test(digits)) {
    return { valid: false, normalized: digits, error: 'کد ملی واردشده معتبر نیست.' };
  }
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(digits[i]) * (10 - i);
  }
  const rem = sum % 11;
  const check = Number(digits[9]);
  const isOk = rem < 2 ? check === rem : check === 11 - rem;
  if (!isOk) {
    return { valid: false, normalized: digits, error: 'رقم کنترل کد ملی همخوانی ندارد. لطفاً کد ملی را بررسی کنید.' };
  }
  return { valid: true, normalized: digits };
}
