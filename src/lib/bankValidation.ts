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

export function formatIranianCard(raw: string): string {
  const digits = normalizeDigits(raw).replace(/[^0-9]/g, '').slice(0, 16);
  return digits.replace(/(\d{4})(?=\d)/g, '$1-');
}

const IRANIAN_BANK_BINS: Record<string, string> = {
  '603799': 'بانک ملی ایران',
  '589210': 'بانک سپه',
  '627648': 'بانک توسعه صادرات',
  '627961': 'بانک صنعت و معدن',
  '603770': 'بانک کشاورزی',
  '628023': 'بانک مسکن',
  '627760': 'پست بانک ایران',
  '502908': 'بانک توسعه تعاون',
  '627412': 'بانک اقتصاد نوین',
  '622106': 'بانک پارسیان',
  '502229': 'بانک پاسارگاد',
  '639347': 'بانک پاسارگاد',
  '627488': 'بانک کارآفرین',
  '621986': 'بانک سامان',
  '639346': 'بانک سینا',
  '639607': 'بانک سرمایه',
  '636214': 'بانک آینده',
  '502806': 'بانک شهر',
  '504706': 'بانک شهر',
  '502938': 'بانک دی',
  '603769': 'بانک صادرات',
  '610433': 'بانک ملت',
  '991975': 'بانک ملت',
  '627353': 'بانک تجارت',
  '585983': 'بانک تجارت',
  '589463': 'بانک رفاه کارگران',
  '627381': 'بانک انصار',
  '639599': 'بانک قوامین',
  '505416': 'بانک گردشگری',
  '505785': 'بانک ایران زمین',
  '504172': 'بانک قرض‌الحسنه رسالت',
  '606373': 'بانک قرض‌الحسنه مهر ایران',
  '585947': 'بانک خاورمیانه',
  '507677': 'موسسه اعتباری نور',
};

export function detectIranianBankName(raw: string): string | null {
  const digits = normalizeDigits(raw).replace(/[^0-9]/g, '');
  if (digits.length < 6) return null;
  return IRANIAN_BANK_BINS[digits.slice(0, 6)] || null;
}

