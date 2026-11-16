export type AdminPermissionKey =
  | 'manage_users'
  | 'manage_kyc'
  | 'manage_support'
  | 'manage_finance'
  | 'manage_disputes';

export type AdminPermissions = Record<AdminPermissionKey, boolean>;

export const DEFAULT_ADMIN_PERMISSIONS: AdminPermissions = {
  manage_users: true,
  manage_kyc: true,
  manage_support: true,
  manage_finance: true,
  manage_disputes: true,
};

export const ADMIN_PERMISSION_META: Array<{
  key: AdminPermissionKey;
  label: string;
  description: string;
}> = [
  {
    key: 'manage_users',
    label: 'مدیریت کاربران و لیمیت‌ها',
    description: 'مشاهده لیست کاربران، ویرایش مشخصات/لیمیت، مسدودسازی و ورود به حساب کاربر',
  },
  {
    key: 'manage_kyc',
    label: 'بررسی و تایید احراز هویت (KYC)',
    description: 'مشاهده مدارک کد ملی و سلفی و تایید یا رد درخواست‌های احراز هویت',
  },
  {
    key: 'manage_support',
    label: 'پشتیبانی و پاسخ به تیکت‌ها',
    description: 'مشاهده و پاسخگویی به تیکت‌های پشتیبانی کاربران',
  },
  {
    key: 'manage_finance',
    label: 'بخش مالی، فیش‌ها و گزارش درآمد',
    description: 'تایید/رد فیش واریزی، تسویه برداشت‌ها، مشاهده و خروجی گزارش کارمزدها',
  },
  {
    key: 'manage_disputes',
    label: 'نظارت معاملات و داوری اختلافات',
    description: 'مشاهده کل قراردادها، صدور رأی داوری و بررسی درخواست‌های تجدیدنظر',
  },
];

export function normalizeAdminPermissions(raw?: unknown): AdminPermissions {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_ADMIN_PERMISSIONS };
  }
  const obj = raw as Record<string, unknown>;
  return {
    manage_users: obj.manage_users !== false,
    manage_kyc: obj.manage_kyc !== false,
    manage_support: obj.manage_support !== false,
    manage_finance: obj.manage_finance !== false,
    manage_disputes: obj.manage_disputes !== false,
  };
}

export function sanitizeAdminPermissionsPatch(raw: unknown, fallback?: AdminPermissions): AdminPermissions {
  const base = fallback ? normalizeAdminPermissions(fallback) : { ...DEFAULT_ADMIN_PERMISSIONS };
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  return {
    manage_users: typeof obj.manage_users === 'boolean' ? obj.manage_users : base.manage_users,
    manage_kyc: typeof obj.manage_kyc === 'boolean' ? obj.manage_kyc : base.manage_kyc,
    manage_support: typeof obj.manage_support === 'boolean' ? obj.manage_support : base.manage_support,
    manage_finance: typeof obj.manage_finance === 'boolean' ? obj.manage_finance : base.manage_finance,
    manage_disputes: typeof obj.manage_disputes === 'boolean' ? obj.manage_disputes : base.manage_disputes,
  };
}

export function getEffectiveActorPermissions(actor?: { role?: string | null; permissions?: unknown } | null): AdminPermissions {
  if (!actor) {
    return {
      manage_users: false,
      manage_kyc: false,
      manage_support: false,
      manage_finance: false,
      manage_disputes: false,
    };
  }
  if (actor.role === 'owner') {
    return {
      manage_users: true,
      manage_kyc: true,
      manage_support: true,
      manage_finance: true,
      manage_disputes: true,
    };
  }
  if (actor.role === 'admin') {
    return normalizeAdminPermissions(actor.permissions);
  }
  return {
    manage_users: false,
    manage_kyc: false,
    manage_support: false,
    manage_finance: false,
    manage_disputes: false,
  };
}

export function hasAdminPermission(
  actor: { role?: string | null; permissions?: unknown } | null | undefined,
  permission: AdminPermissionKey
): boolean {
  if (!actor) return false;
  if (actor.role === 'owner') return true;
  if (actor.role !== 'admin') return false;
  return getEffectiveActorPermissions(actor)[permission];
}

export function hasAnyAdminPermission(
  actor: { role?: string | null; permissions?: unknown } | null | undefined,
  permissions: AdminPermissionKey[]
): boolean {
  return permissions.some((p) => hasAdminPermission(actor, p));
}
