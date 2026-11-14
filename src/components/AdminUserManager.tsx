import React, { useEffect, useMemo, useState } from 'react';
import {
  Search,
  RefreshCw,
  UserPlus,
  Sliders,
  Shield,
  Ban,
  CheckCircle2,
  LogIn,
  Edit3,
  Wallet,
  Lock,
  Unlock,
  X,
  AlertTriangle,
  UserCheck,
  Clock,
  ShieldAlert,
} from 'lucide-react';
import { auth } from '../lib/firebase';

export interface PlatformLimits {
  min_deal_amount: number;
  default_max_deal_amount: number;
  default_daily_withdraw_limit: number;
  default_max_active_deals: number;
  max_admin_balance_adjust: number;
}

export interface AdminUserRecord {
  id: string;
  telegram_id?: string | number;
  full_name: string | null;
  phone_number: string | null;
  username?: string | null;
  role: string | null;
  kyc_status: string;
  wallet_balance: number;
  escrow_locked_balance: number;
  is_blocked?: boolean;
  blocked_reason?: string;
  max_deal_amount?: number;
  daily_withdraw_limit?: number;
  max_active_deals?: number;
  is_withdraw_locked?: boolean;
  is_deal_locked?: boolean;
  admin_note?: string;
}

interface AdminUserManagerProps {
  currentUser: any;
  notify: (message: string, type?: 'info' | 'success' | 'error') => void;
  onImpersonate: (payload: { user: any; customToken?: string | null; sessionToken?: string | null }) => Promise<void>;
  onLimitsUpdated?: (limits: PlatformLimits) => void;
}

const normalizeDigits = (val: string) =>
  String(val || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();

export default function AdminUserManager({
  currentUser,
  notify,
  onImpersonate,
  onLimitsUpdated,
}: AdminUserManagerProps) {
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [globalLimits, setGlobalLimits] = useState<PlatformLimits>({
    min_deal_amount: 10000,
    default_max_deal_amount: 100000000,
    default_daily_withdraw_limit: 50000000,
    default_max_active_deals: 10,
    max_admin_balance_adjust: 20000000,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'blocked' | 'verified' | 'pending' | 'staff'>('all');

  const [selectedUser, setSelectedUser] = useState<AdminUserRecord | null>(null);
  const [editForm, setEditForm] = useState<any>(null);

  const [showLimitsModal, setShowLimitsModal] = useState(false);
  const [limitsForm, setLimitsForm] = useState<PlatformLimits>(globalLimits);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    full_name: '',
    phone_number: '',
    username: '',
    wallet_balance: '0',
    role: 'user',
    kyc_status: 'verified',
    max_deal_amount: '',
    daily_withdraw_limit: '',
    max_active_deals: '',
  });

  const isOwner = currentUser?.role === 'owner';

  const getAuthHeaders = async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const sessionToken = localStorage.getItem('mianji_session_token');
    if (sessionToken) {
      headers['x-session-token'] = sessionToken;
    }
    if (auth.currentUser) {
      try {
        const idToken = await auth.currentUser.getIdToken();
        if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
      } catch {}
    }
    if (currentUser?.id) {
      headers['x-preview-admin-id'] = String(currentUser.id);
    }
    return headers;
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/admin/users', { headers });
      const data = await res.json();
      if (data.success) {
        setUsers(data.users || []);
        if (data.globalLimits) {
          setGlobalLimits(data.globalLimits);
          setLimitsForm(data.globalLimits);
        }
      } else {
        notify(data.error || 'خطا در دریافت لیست کاربران', 'error');
      }
    } catch {
      notify('خطا در ارتباط با سرور برای دریافت لیست کاربران', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const filteredUsers = useMemo(() => {
    const q = normalizeDigits(searchQuery).toLowerCase();
    return users.filter((u) => {
      if (filterTab === 'blocked' && !u.is_blocked) return false;
      if (filterTab === 'verified' && u.kyc_status !== 'verified') return false;
      if (filterTab === 'pending' && u.kyc_status !== 'pending') return false;
      if (filterTab === 'staff' && u.role !== 'owner' && u.role !== 'admin') return false;

      if (!q) return true;
      const name = String(u.full_name || '').toLowerCase();
      const phone = normalizeDigits(String(u.phone_number || '')).replace(/[^0-9]/g, '');
      const qDigits = q.replace(/[^0-9]/g, '');
      const username = String(u.username || '').toLowerCase();
      const id = String(u.id || '').toLowerCase();
      return (
        name.includes(q) ||
        (qDigits ? phone.includes(qDigits) : false) ||
        username.includes(q) ||
        id.includes(q)
      );
    });
  }, [users, searchQuery, filterTab]);

  const openEditor = (u: AdminUserRecord) => {
    setSelectedUser(u);
    setEditForm({
      full_name: u.full_name || '',
      phone_number: u.phone_number || '',
      username: u.username || '',
      role: u.role || 'user',
      kyc_status: u.kyc_status || 'pending',
      wallet_balance: String(Number(u.wallet_balance || 0)),
      escrow_locked_balance: String(Number(u.escrow_locked_balance || 0)),
      is_blocked: Boolean(u.is_blocked),
      blocked_reason: u.blocked_reason || '',
      max_deal_amount: u.max_deal_amount ? String(u.max_deal_amount) : '',
      daily_withdraw_limit: u.daily_withdraw_limit ? String(u.daily_withdraw_limit) : '',
      max_active_deals: u.max_active_deals ? String(u.max_active_deals) : '',
      is_withdraw_locked: Boolean(u.is_withdraw_locked),
      is_deal_locked: Boolean(u.is_deal_locked),
      admin_note: u.admin_note || '',
    });
  };

  const handleSaveUser = async () => {
    if (!selectedUser || !editForm) return;
    setSaving(true);
    try {
      const headers = await getAuthHeaders();
      const payload = {
        full_name: editForm.full_name.trim(),
        phone_number: normalizeDigits(editForm.phone_number).replace(/[^0-9]/g, ''),
        username: editForm.username.trim(),
        role: editForm.role,
        kyc_status: editForm.kyc_status,
        wallet_balance: Number(normalizeDigits(editForm.wallet_balance).replace(/[^0-9]/g, '') || 0),
        escrow_locked_balance: Number(normalizeDigits(editForm.escrow_locked_balance).replace(/[^0-9]/g, '') || 0),
        is_blocked: Boolean(editForm.is_blocked),
        blocked_reason: editForm.blocked_reason.trim(),
        max_deal_amount: Number(normalizeDigits(editForm.max_deal_amount).replace(/[^0-9]/g, '') || 0),
        daily_withdraw_limit: Number(normalizeDigits(editForm.daily_withdraw_limit).replace(/[^0-9]/g, '') || 0),
        max_active_deals: Number(normalizeDigits(editForm.max_active_deals).replace(/[^0-9]/g, '') || 0),
        is_withdraw_locked: Boolean(editForm.is_withdraw_locked),
        is_deal_locked: Boolean(editForm.is_deal_locked),
        admin_note: editForm.admin_note.trim(),
      };

      const res = await fetch(`/api/admin/users/${encodeURIComponent(selectedUser.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success && data.user) {
        setUsers((prev) => prev.map((u) => (u.id === selectedUser.id ? data.user : u)));
        setSelectedUser(null);
        setEditForm(null);
        notify('تغییرات کاربر با موفقیت ذخیره شد', 'success');
      } else {
        notify(data.error || 'خطا در ذخیره تغییرات کاربر', 'error');
      }
    } catch {
      notify('خطا در ارتباط با سرور هنگام ذخیره', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickBlockToggle = async (u: AdminUserRecord) => {
    const nextBlocked = !u.is_blocked;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          is_blocked: nextBlocked,
          blocked_reason: nextBlocked ? u.blocked_reason || 'مسدود شده توسط مدیریت' : '',
        }),
      });
      const data = await res.json();
      if (data.success && data.user) {
        setUsers((prev) => prev.map((item) => (item.id === u.id ? data.user : item)));
        notify(nextBlocked ? `حساب ${u.full_name || u.id} مسدود شد` : `مسدودیت ${u.full_name || u.id} رفع شد`, 'info');
      } else {
        notify(data.error || 'خطا در تغییر وضعیت مسدودی', 'error');
      }
    } catch {
      notify('خطا در ارتباط با سرور', 'error');
    }
  };

  const handleEnterAccount = async (u: AdminUserRecord) => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/admin/users/${encodeURIComponent(u.id)}/impersonate`, {
        method: 'POST',
        headers,
      });
      const data = await res.json();
      if (data.success && data.user) {
        await onImpersonate({
          user: data.user,
          customToken: data.customToken,
          sessionToken: data.sessionToken,
        });
      } else {
        notify(data.error || 'امکان ورود به این حساب وجود ندارد', 'error');
      }
    } catch {
      notify('خطا در ورود به حساب کاربر', 'error');
    }
  };

  const handleSaveGlobalLimits = async () => {
    setSaving(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/admin/limits', {
        method: 'PUT',
        headers,
        body: JSON.stringify(limitsForm),
      });
      const data = await res.json();
      if (data.success && data.limits) {
        setGlobalLimits(data.limits);
        setLimitsForm(data.limits);
        onLimitsUpdated?.(data.limits);
        setShowLimitsModal(false);
        notify('محدودیت‌های پایه سیستم (لیمیت‌ها) ذخیره شد', 'success');
      } else {
        notify(data.error || 'خطا در ذخیره محدودیت‌های پایه', 'error');
      }
    } catch {
      notify('خطا در ارتباط با سرور', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateUser = async () => {
    setSaving(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          full_name: createForm.full_name,
          phone_number: normalizeDigits(createForm.phone_number).replace(/[^0-9]/g, ''),
          username: createForm.username,
          wallet_balance: Number(normalizeDigits(createForm.wallet_balance).replace(/[^0-9]/g, '') || 0),
          role: createForm.role,
          kyc_status: createForm.kyc_status,
          max_deal_amount: Number(normalizeDigits(createForm.max_deal_amount).replace(/[^0-9]/g, '') || 0),
          daily_withdraw_limit: Number(normalizeDigits(createForm.daily_withdraw_limit).replace(/[^0-9]/g, '') || 0),
          max_active_deals: Number(normalizeDigits(createForm.max_active_deals).replace(/[^0-9]/g, '') || 0),
        }),
      });
      const data = await res.json();
      if (data.success && data.user) {
        setUsers((prev) => [data.user, ...prev]);
        setShowCreateModal(false);
        setCreateForm({
          full_name: '',
          phone_number: '',
          username: '',
          wallet_balance: '0',
          role: 'user',
          kyc_status: 'verified',
          max_deal_amount: '',
          daily_withdraw_limit: '',
          max_active_deals: '',
        });
        notify('کاربر جدید با موفقیت ثبت شد', 'success');
      } else {
        notify(data.error || 'خطا در ثبت کاربر جدید', 'error');
      }
    } catch {
      notify('خطا در ارتباط با سرور', 'error');
    } finally {
      setSaving(false);
    }
  };

  const adjustBalanceQuick = (delta: number) => {
    if (!editForm) return;
    const current = Number(normalizeDigits(editForm.wallet_balance).replace(/[^0-9]/g, '') || 0);
    const next = Math.max(0, current + delta);
    setEditForm((p: any) => ({ ...p, wallet_balance: String(next) }));
  };

  return (
    <div className="space-y-4">
      {/* Top Toolbar */}
      <div className="card-refined p-4 space-y-3">
        <div className="flex flex-col md:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="جستجو با نام، شماره همراه، یوزرنیم یا شناسه کاربر..."
              className="input-refined h-11 pr-10 pl-4 text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchUsers}
              className="h-11 px-3.5 rounded-xl bg-slate-100 dark:bg-white/[0.08] border border-slate-200 dark:border-white/20 text-slate-700 dark:text-white text-xs font-bold flex items-center gap-1.5 active:scale-95 transition-all"
              title="بروزرسانی لیست"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
              بروزرسانی
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="h-11 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all"
            >
              <UserPlus size={15} />
              کاربر جدید
            </button>
            {isOwner && (
              <button
                onClick={() => {
                  setLimitsForm(globalLimits);
                  setShowLimitsModal(true);
                }}
                className="h-11 px-3.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-600 dark:text-amber-300 text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all"
              >
                <Sliders size={15} />
                تنظیمات لیمیت کل
              </button>
            )}
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-0.5">
          {[
            { id: 'all', label: `همه (${users.length})` },
            { id: 'blocked', label: `مسدودها (${users.filter((u) => u.is_blocked).length})` },
            { id: 'verified', label: `تایید شده (${users.filter((u) => u.kyc_status === 'verified').length})` },
            { id: 'pending', label: `در انتظار احراز (${users.filter((u) => u.kyc_status === 'pending').length})` },
            { id: 'staff', label: `مدیران (${users.filter((u) => u.role === 'owner' || u.role === 'admin').length})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilterTab(tab.id as any)}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-bold shrink-0 border transition-all ${
                filterTab === tab.id
                  ? 'bg-blue-600 text-white border-blue-500'
                  : 'bg-slate-50 dark:bg-[#0e131c] text-slate-600 dark:text-slate-300 border-slate-200/80 dark:border-white/15'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Global Limits Summary Strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1 text-[10px]">
          <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#0e131c] border border-slate-200/70 dark:border-white/10">
            <span className="text-slate-400 block">سقف پیش‌فرض معامله</span>
            <span className="font-black text-slate-800 dark:text-white">{globalLimits.default_max_deal_amount.toLocaleString()} ت</span>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#0e131c] border border-slate-200/70 dark:border-white/10">
            <span className="text-slate-400 block">سقف برداشت روزانه</span>
            <span className="font-black text-slate-800 dark:text-white">{globalLimits.default_daily_withdraw_limit.toLocaleString()} ت</span>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#0e131c] border border-slate-200/70 dark:border-white/10">
            <span className="text-slate-400 block">سقف معاملات فعال</span>
            <span className="font-black text-slate-800 dark:text-white">{globalLimits.default_max_active_deals} قرارداد</span>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#0e131c] border border-slate-200/70 dark:border-white/10">
            <span className="text-slate-400 block">لیمیت تغییر موجودی ادمین</span>
            <span className="font-black text-slate-800 dark:text-white">{globalLimits.max_admin_balance_adjust.toLocaleString()} ت</span>
          </div>
        </div>
      </div>

      {/* Users List */}
      {loading ? (
        <div className="card-refined p-10 text-center text-xs font-bold text-slate-400">در حال بارگذاری لیست کاربران...</div>
      ) : filteredUsers.length === 0 ? (
        <div className="card-refined p-10 text-center text-xs font-bold text-slate-400">کاربری با این مشخصات یافت نشد</div>
      ) : (
        <div className="space-y-2.5">
          {filteredUsers.map((u) => {
            const canModify = isOwner || u.role !== 'owner';
            const canImpersonate = isOwner || (u.role !== 'owner' && u.role !== 'admin');
            return (
              <div
                key={u.id}
                className={`card-refined p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
                  u.is_blocked ? 'border-rose-500/45 dark:border-rose-500/40' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`w-11 h-11 rounded-2xl flex items-center justify-center font-black text-sm shrink-0 ${
                      u.is_blocked
                        ? 'bg-rose-500/15 text-rose-500'
                        : u.role === 'owner'
                        ? 'bg-amber-500/15 text-amber-500'
                        : u.role === 'admin'
                        ? 'bg-blue-500/15 text-blue-500'
                        : 'bg-slate-100 dark:bg-white/[0.08] text-slate-700 dark:text-white'
                    }`}
                  >
                    {(u.full_name || 'ک')[0]}
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">{u.full_name || 'کاربر بدون نام'}</h4>
                      {u.role === 'owner' && (
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-300 text-[10px] font-black">
                          مالک کل
                        </span>
                      )}
                      {u.role === 'admin' && (
                        <span className="px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-300 text-[10px] font-black">
                          ادمین
                        </span>
                      )}
                      {u.kyc_status === 'verified' ? (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 text-[10px] font-bold flex items-center gap-1">
                          <UserCheck size={11} /> تایید شده
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md bg-slate-500/15 text-slate-500 dark:text-slate-300 text-[10px] font-bold flex items-center gap-1">
                          <Clock size={11} /> {u.kyc_status === 'rejected' ? 'رد شده' : 'در انتظار'}
                        </span>
                      )}
                      {u.is_blocked && (
                        <span className="px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-500 text-[10px] font-black flex items-center gap-1">
                          <Ban size={11} /> مسدود
                        </span>
                      )}
                      {(u.is_withdraw_locked || u.is_deal_locked) && (
                        <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-500 text-[10px] font-bold flex items-center gap-1">
                          <Lock size={11} /> لیمیت قفل
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-300 font-mono">
                      <span>{u.phone_number || 'بدون شماره'}</span>
                      <span>ID: {u.id}</span>
                      {u.username && <span>@{u.username}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">
                        موجودی: {Number(u.wallet_balance || 0).toLocaleString()} ت
                      </span>
                      <span className="font-bold text-blue-600 dark:text-blue-300">
                        قفل امانی: {Number(u.escrow_locked_balance || 0).toLocaleString()} ت
                      </span>
                      <span className="text-slate-400">
                        سقف معامله: {(u.max_deal_amount || globalLimits.default_max_deal_amount).toLocaleString()} ت
                      </span>
                    </div>
                  </div>
                </div>

                {/* Row Actions */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {canModify && (
                    <button
                      onClick={() => openEditor(u)}
                      className="h-9 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all"
                    >
                      <Edit3 size={14} />
                      ویرایش و لیمیت
                    </button>
                  )}
                  {canImpersonate && String(u.id) !== String(currentUser?.id) && (
                    <button
                      onClick={() => handleEnterAccount(u)}
                      className="h-9 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all"
                    >
                      <LogIn size={14} />
                      ورود به اکانت
                    </button>
                  )}
                  {u.role !== 'owner' && String(u.id) !== String(currentUser?.id) && (
                    <button
                      onClick={() => handleQuickBlockToggle(u)}
                      className={`h-9 px-3 rounded-xl text-xs font-black flex items-center gap-1.5 border active:scale-95 transition-all ${
                        u.is_blocked
                          ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-600 dark:text-emerald-300'
                          : 'bg-rose-500/15 border-rose-500/35 text-rose-500'
                      }`}
                    >
                      {u.is_blocked ? <Unlock size={14} /> : <Ban size={14} />}
                      {u.is_blocked ? 'رفع بلاک' : 'بلاک'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Full User Edit + Balance + Limits Modal */}
      {selectedUser && editForm && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[1200] flex items-center justify-center p-3 md:p-6 overflow-y-auto">
          <div className="w-full max-w-2xl bg-white dark:bg-[#141923] border border-slate-200 dark:border-white/20 rounded-3xl p-5 md:p-7 space-y-5 my-auto max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200/80 dark:border-white/10 pb-4">
              <div>
                <h3 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                  <Shield size={18} className="text-blue-500" />
                  مدیریت کامل کاربر: {selectedUser.full_name || selectedUser.id}
                </h3>
                <p className="text-[11px] text-slate-400 font-mono mt-0.5">ID: {selectedUser.id}</p>
              </div>
              <button
                onClick={() => {
                  setSelectedUser(null);
                  setEditForm(null);
                }}
                className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-white/[0.08] flex items-center justify-center text-slate-600 dark:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Identity & Role */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-right">
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">نام کامل</label>
                <input
                  type="text"
                  value={editForm.full_name}
                  onChange={(e) => setEditForm((p: any) => ({ ...p, full_name: e.target.value }))}
                  className="input-refined h-11 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">شماره همراه</label>
                <input
                  type="tel"
                  dir="ltr"
                  value={editForm.phone_number}
                  onChange={(e) => setEditForm((p: any) => ({ ...p, phone_number: normalizeDigits(e.target.value) }))}
                  className="input-refined h-11 text-xs font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">نام کاربری تلگرام</label>
                <input
                  type="text"
                  dir="ltr"
                  value={editForm.username}
                  onChange={(e) => setEditForm((p: any) => ({ ...p, username: e.target.value }))}
                  className="input-refined h-11 text-xs font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">وضعیت احراز هویت</label>
                  <select
                    value={editForm.kyc_status}
                    onChange={(e) => setEditForm((p: any) => ({ ...p, kyc_status: e.target.value }))}
                    className="input-refined h-11 text-xs px-3"
                  >
                    <option value="verified">تایید شده</option>
                    <option value="pending">در انتظار</option>
                    <option value="rejected">رد شده</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">نقش</label>
                  <select
                    value={editForm.role}
                    disabled={!isOwner}
                    onChange={(e) => setEditForm((p: any) => ({ ...p, role: e.target.value }))}
                    className="input-refined h-11 text-xs px-3 disabled:opacity-50"
                  >
                    <option value="user">کاربر</option>
                    <option value="admin">ادمین</option>
                    <option value="owner">مالک کل</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Wallets */}
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#0e131c] border border-slate-200/80 dark:border-white/15 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Wallet size={15} className="text-emerald-500" />
                  مدیریت موجودی کیف پول و امانی (تومان)
                </h4>
                {!isOwner && (
                  <span className="text-[10px] text-amber-500 font-bold">
                    لیمیت ادمین: ±{globalLimits.max_admin_balance_adjust.toLocaleString()} ت
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">موجودی کیف پول (تومان)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={editForm.wallet_balance}
                    onChange={(e) =>
                      setEditForm((p: any) => ({
                        ...p,
                        wallet_balance: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                      }))
                    }
                    className="input-refined h-11 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">موجودی قفل امانی (تومان)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={editForm.escrow_locked_balance}
                    onChange={(e) =>
                      setEditForm((p: any) => ({
                        ...p,
                        escrow_locked_balance: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                      }))
                    }
                    className="input-refined h-11 text-xs font-mono"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: '+۵۰۰ هزار', delta: 500000 },
                  { label: '+۱ میلیون', delta: 1000000 },
                  { label: '+۵ میلیون', delta: 5000000 },
                  { label: '-۱ میلیون', delta: -1000000 },
                ].map((btn) => (
                  <button
                    key={btn.label}
                    type="button"
                    onClick={() => adjustBalanceQuick(btn.delta)}
                    className="px-2.5 py-1 rounded-lg bg-white dark:bg-[#141923] border border-slate-200 dark:border-white/15 text-[10px] font-black text-slate-700 dark:text-slate-200 hover:border-blue-500/50 active:scale-95 transition-all"
                  >
                    {btn.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setEditForm((p: any) => ({ ...p, wallet_balance: '0' }))}
                  className="px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/25 text-[10px] font-black text-rose-500 active:scale-95 transition-all"
                >
                  صفر کردن کیف پول
                </button>
              </div>
            </div>

            {/* Per-User Limits (لیمیت اختصاصی) */}
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#0e131c] border border-slate-200/80 dark:border-white/15 space-y-3">
              <h4 className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                <Sliders size={15} className="text-blue-500" />
                لیمیت‌ها و محدودیت‌های اختصاصی این کاربر (خالی یا ۰ = پیش‌فرض سیستم)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">سقف مبلغ معامله (تومان)</label>
                  <input
                    type="text"
                    dir="ltr"
                    placeholder={String(globalLimits.default_max_deal_amount)}
                    value={editForm.max_deal_amount}
                    onChange={(e) =>
                      setEditForm((p: any) => ({
                        ...p,
                        max_deal_amount: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                      }))
                    }
                    className="input-refined h-10 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">سقف برداشت روزانه (تومان)</label>
                  <input
                    type="text"
                    dir="ltr"
                    placeholder={String(globalLimits.default_daily_withdraw_limit)}
                    value={editForm.daily_withdraw_limit}
                    onChange={(e) =>
                      setEditForm((p: any) => ({
                        ...p,
                        daily_withdraw_limit: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                      }))
                    }
                    className="input-refined h-10 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">حداکثر معاملات فعال</label>
                  <input
                    type="text"
                    dir="ltr"
                    placeholder={String(globalLimits.default_max_active_deals)}
                    value={editForm.max_active_deals}
                    onChange={(e) =>
                      setEditForm((p: any) => ({
                        ...p,
                        max_active_deals: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                      }))
                    }
                    className="input-refined h-10 text-xs font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">
                <label className="p-3 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/15 flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200">قفل برداشت وجه (Withdraw Lock)</span>
                  <input
                    type="checkbox"
                    checked={editForm.is_withdraw_locked}
                    onChange={(e) => setEditForm((p: any) => ({ ...p, is_withdraw_locked: e.target.checked }))}
                    className="w-4 h-4 accent-amber-500"
                  />
                </label>
                <label className="p-3 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/15 flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200">قفل ایجاد معامله جدید (Deal Lock)</span>
                  <input
                    type="checkbox"
                    checked={editForm.is_deal_locked}
                    onChange={(e) => setEditForm((p: any) => ({ ...p, is_deal_locked: e.target.checked }))}
                    className="w-4 h-4 accent-amber-500"
                  />
                </label>
              </div>
            </div>

            {/* Block & Admin Note */}
            <div className="p-4 rounded-2xl bg-rose-500/5 border border-rose-500/25 space-y-3">
              <label className="flex items-center justify-between cursor-pointer">
                <div className="flex items-center gap-2">
                  <ShieldAlert size={16} className="text-rose-500" />
                  <span className="text-xs font-black text-rose-500">مسدودسازی کامل حساب (Block User)</span>
                </div>
                <input
                  type="checkbox"
                  disabled={selectedUser.role === 'owner' || String(selectedUser.id) === String(currentUser?.id)}
                  checked={editForm.is_blocked}
                  onChange={(e) => setEditForm((p: any) => ({ ...p, is_blocked: e.target.checked }))}
                  className="w-5 h-5 accent-rose-600"
                />
              </label>
              {editForm.is_blocked && (
                <input
                  type="text"
                  value={editForm.blocked_reason}
                  onChange={(e) => setEditForm((p: any) => ({ ...p, blocked_reason: e.target.value }))}
                  placeholder="دلیل مسدودی (به کاربر نمایش داده می‌شود)..."
                  className="input-refined h-10 text-xs"
                />
              )}
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">یادداشت محرمانه مدیریت</label>
                <input
                  type="text"
                  value={editForm.admin_note}
                  onChange={(e) => setEditForm((p: any) => ({ ...p, admin_note: e.target.value }))}
                  placeholder="یادداشت داخلی برای تیم مدیریت..."
                  className="input-refined h-10 text-xs"
                />
              </div>
            </div>

            {/* Footer Actions */}
            <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveUser}
                className="flex-1 h-12 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
              >
                <CheckCircle2 size={16} />
                {saving ? 'در حال ذخیره...' : 'ذخیره تمام تغییرات'}
              </button>
              {(isOwner || (selectedUser.role !== 'owner' && selectedUser.role !== 'admin')) &&
                String(selectedUser.id) !== String(currentUser?.id) && (
                  <button
                    type="button"
                    onClick={() => handleEnterAccount(selectedUser)}
                    className="h-12 px-5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs flex items-center justify-center gap-2 active:scale-95 transition-all"
                  >
                    <LogIn size={16} />
                    ورود به اکانت کاربر
                  </button>
                )}
            </div>
          </div>
        </div>
      )}

      {/* Global Platform Limits Modal (Owner Only) */}
      {showLimitsModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[1200] flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#141923] border border-slate-200 dark:border-white/20 rounded-3xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Sliders size={18} className="text-amber-500" />
                تنظیمات لیمیت‌های پایه پلتفرم
              </h3>
              <button
                onClick={() => setShowLimitsModal(false)}
                className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/[0.08] flex items-center justify-center text-slate-600 dark:text-white"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 text-right">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">حداقل مبلغ معامله (تومان)</label>
                <input
                  type="text"
                  dir="ltr"
                  value={limitsForm.min_deal_amount}
                  onChange={(e) =>
                    setLimitsForm((p) => ({
                      ...p,
                      min_deal_amount: Number(normalizeDigits(e.target.value).replace(/[^0-9]/g, '') || 0),
                    }))
                  }
                  className="input-refined h-11 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">سقف پیش‌فرض مبلغ معامله (تومان)</label>
                <input
                  type="text"
                  dir="ltr"
                  value={limitsForm.default_max_deal_amount}
                  onChange={(e) =>
                    setLimitsForm((p) => ({
                      ...p,
                      default_max_deal_amount: Number(normalizeDigits(e.target.value).replace(/[^0-9]/g, '') || 0),
                    }))
                  }
                  className="input-refined h-11 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">سقف پیش‌فرض برداشت روزانه (تومان)</label>
                <input
                  type="text"
                  dir="ltr"
                  value={limitsForm.default_daily_withdraw_limit}
                  onChange={(e) =>
                    setLimitsForm((p) => ({
                      ...p,
                      default_daily_withdraw_limit: Number(normalizeDigits(e.target.value).replace(/[^0-9]/g, '') || 0),
                    }))
                  }
                  className="input-refined h-11 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">سقف معاملات فعال همزمان</label>
                <input
                  type="text"
                  dir="ltr"
                  value={limitsForm.default_max_active_deals}
                  onChange={(e) =>
                    setLimitsForm((p) => ({
                      ...p,
                      default_max_active_deals: Number(normalizeDigits(e.target.value).replace(/[^0-9]/g, '') || 0),
                    }))
                  }
                  className="input-refined h-11 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">
                  سقف تغییر موجودی توسط ادمین عادی در هر بار (تومان)
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={limitsForm.max_admin_balance_adjust}
                  onChange={(e) =>
                    setLimitsForm((p) => ({
                      ...p,
                      max_admin_balance_adjust: Number(normalizeDigits(e.target.value).replace(/[^0-9]/g, '') || 0),
                    }))
                  }
                  className="input-refined h-11 text-xs font-mono"
                />
              </div>
            </div>

            <button
              type="button"
              disabled={saving}
              onClick={handleSaveGlobalLimits}
              className="w-full h-12 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs active:scale-95 transition-all disabled:opacity-50"
            >
              {saving ? 'در حال ذخیره...' : 'ذخیره محدودیت‌های کل'}
            </button>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[1200] flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#141923] border border-slate-200 dark:border-white/20 rounded-3xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-2">
                <UserPlus size={18} className="text-blue-500" />
                ثبت کاربر جدید
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/[0.08] flex items-center justify-center text-slate-600 dark:text-white"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-3 text-right">
              <input
                type="text"
                placeholder="نام و نام خانوادگی"
                value={createForm.full_name}
                onChange={(e) => setCreateForm((p) => ({ ...p, full_name: e.target.value }))}
                className="input-refined h-11 text-xs"
              />
              <input
                type="tel"
                dir="ltr"
                placeholder="09123456789"
                value={createForm.phone_number}
                onChange={(e) => setCreateForm((p) => ({ ...p, phone_number: normalizeDigits(e.target.value) }))}
                className="input-refined h-11 text-xs font-mono"
              />
              <input
                type="text"
                dir="ltr"
                placeholder="موجودی اولیه (تومان)"
                value={createForm.wallet_balance}
                onChange={(e) =>
                  setCreateForm((p) => ({
                    ...p,
                    wallet_balance: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                  }))
                }
                className="input-refined h-11 text-xs font-mono"
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={createForm.kyc_status}
                  onChange={(e) => setCreateForm((p) => ({ ...p, kyc_status: e.target.value }))}
                  className="input-refined h-11 text-xs px-3"
                >
                  <option value="verified">احراز تاییدشده</option>
                  <option value="pending">در انتظار</option>
                </select>
                <select
                  value={createForm.role}
                  disabled={!isOwner}
                  onChange={(e) => setCreateForm((p) => ({ ...p, role: e.target.value }))}
                  className="input-refined h-11 text-xs px-3 disabled:opacity-50"
                >
                  <option value="user">کاربر عادی</option>
                  <option value="admin">ادمین</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  dir="ltr"
                  placeholder="سقف معامله (اختیاری)"
                  value={createForm.max_deal_amount}
                  onChange={(e) =>
                    setCreateForm((p) => ({
                      ...p,
                      max_deal_amount: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                    }))
                  }
                  className="input-refined h-10 text-xs font-mono"
                />
                <input
                  type="text"
                  dir="ltr"
                  placeholder="سقف برداشت روزانه (اختیاری)"
                  value={createForm.daily_withdraw_limit}
                  onChange={(e) =>
                    setCreateForm((p) => ({
                      ...p,
                      daily_withdraw_limit: normalizeDigits(e.target.value).replace(/[^0-9]/g, ''),
                    }))
                  }
                  className="input-refined h-10 text-xs font-mono"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={handleCreateUser}
              className="w-full h-12 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs active:scale-95 transition-all disabled:opacity-50"
            >
              {saving ? 'در حال ثبت...' : 'ایجاد کاربر'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
