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

export function formatCardInputLive(raw: string): string {
  const norm = normalizeDigits(raw).trimStart();
  if (/^[a-zA-Z]/.test(norm)) {
    const cleaned = norm.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    return cleaned.slice(0, 26);
  }
  const digits = norm.replace(/[^0-9]/g, '');
  if (digits.length > 16) {
    return digits.slice(0, 24);
  }
  return digits.replace(/(\d{4})(?=\d)/g, '$1-');
}

export function formatShebaDisplay(raw: string): string {
  const cleaned = normalizeDigits(raw).replace(/[\s\-_]/g, '').toUpperCase();
  if (!cleaned.startsWith('IR')) return cleaned;
  return cleaned.replace(/^IR/, 'IR ').replace(/(\d{4})(?=\d)/g, '$1 ');
}

export function maskCardNumber(raw: string): string {
  const cleaned = normalizeDigits(raw).replace(/[\s\-_]/g, '').toUpperCase();
  if (cleaned.startsWith('IR') && cleaned.length >= 10) {
    return `${cleaned.slice(0, 6)}••••${cleaned.slice(-4)}`;
  }
  const digits = cleaned.replace(/[^0-9]/g, '');
  if (digits.length === 16) {
    return `${digits.slice(0, 4)}-••••-••••-${digits.slice(12)}`;
  }
  return cleaned;
}

const IRANIAN_BANK_BINS: Record<string, string> = {
  '603799': 'بانک ملی ایران',
  '589210': 'بانک سپه',
  '627648': 'بانک توسعه صادرات',
  '627961': 'بانک صنعت و معدن',
  '603770': 'بانک کشاورزی',
  '639217': 'بانک کشاورزی',
  '628023': 'بانک مسکن',
  '627760': 'پست بانک ایران',
  '502908': 'بانک توسعه تعاون',
  '627412': 'بانک اقتصاد نوین',
  '622106': 'بانک پارسیان',
  '639194': 'بانک پارسیان',
  '627884': 'بانک پارسیان',
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
  '639370': 'بانک مهر اقتصاد',
  '636949': 'بانک حکمت ایرانیان',
  '639599': 'بانک قوامین',
  '505416': 'بانک گردشگری',
  '505785': 'بانک ایران زمین',
  '504172': 'بانک قرض‌الحسنه رسالت',
  '606373': 'بانک قرض‌الحسنه مهر ایران',
  '585947': 'بانک خاورمیانه',
  '505809': 'بانک خاورمیانه',
  '505801': 'موسسه اعتباری کوثر',
  '606256': 'موسسه اعتباری ملل',
  '628157': 'موسسه اعتباری توسعه',
  '507677': 'موسسه اعتباری نور',
  '636795': 'بانک مرکزی',
};

const IRANIAN_SHEBA_BANK_CODES: Record<string, string> = {
  '010': 'بانک مرکزی',
  '011': 'بانک صنعت و معدن',
  '012': 'بانک ملت',
  '013': 'بانک رفاه کارگران',
  '014': 'بانک مسکن',
  '015': 'بانک سپه',
  '016': 'بانک کشاورزی',
  '017': 'بانک ملی ایران',
  '018': 'بانک تجارت',
  '019': 'بانک صادرات',
  '020': 'بانک توسعه صادرات',
  '021': 'پست بانک ایران',
  '022': 'بانک توسعه تعاون',
  '051': 'موسسه اعتباری توسعه',
  '052': 'بانک قوامین',
  '053': 'بانک کارآفرین',
  '054': 'بانک پارسیان',
  '055': 'بانک اقتصاد نوین',
  '056': 'بانک سامان',
  '057': 'بانک پاسارگاد',
  '058': 'بانک سرمایه',
  '059': 'بانک سینا',
  '060': 'بانک قرض‌الحسنه مهر ایران',
  '061': 'بانک شهر',
  '062': 'بانک آینده',
  '063': 'بانک انصار',
  '064': 'بانک گردشگری',
  '065': 'بانک حکمت ایرانیان',
  '066': 'بانک دی',
  '069': 'بانک ایران زمین',
  '070': 'بانک قرض‌الحسنه رسالت',
  '073': 'موسسه اعتباری کوثر',
  '075': 'موسسه اعتباری ملل',
  '078': 'بانک خاورمیانه',
  '080': 'موسسه اعتباری نور',
};

export function detectIranianBankName(raw: string): string | null {
  const cleaned = normalizeDigits(raw).replace(/[\s\-_]/g, '').toUpperCase();
  if (cleaned.startsWith('IR') && cleaned.length >= 7) {
    const bankCode = cleaned.slice(4, 7);
    return IRANIAN_SHEBA_BANK_CODES[bankCode] || null;
  }
  const digits = cleaned.replace(/[^0-9]/g, '');
  if (digits.length === 24) {
    const bankCode = digits.slice(2, 5);
    return IRANIAN_SHEBA_BANK_CODES[bankCode] || null;
  }
  if (digits.length < 6) return null;
  return IRANIAN_BANK_BINS[digits.slice(0, 6)] || null;
}
