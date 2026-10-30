/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  MessageCircle, 
  Plus, 
  Home, 
  User, 
  Scale, 
  ChevronLeft,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// --- Types ---
type View = 'auth' | 'dashboard' | 'create' | 'detail' | 'profile' | 'dispute' | 'admin';

interface Deal {
  id: string;
  contractId: string;
  title: string;
  amount: number;
  status: 'pending_signatures' | 'active' | 'completed' | 'disputed';
  otherParty: string;
  creatorId: string;
  buyerId: string;
  sellerId: string;
  arbitratorId?: string;
}

export default function App() {
  const [view, setView] = useState<View>('auth');
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Auto-redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated && view !== 'auth') {
      setView('auth');
    }
  }, [isAuthenticated, view]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100" dir="rtl">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200 px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-blue-200">
            <Shield size={18} />
          </div>
          <span className="font-bold text-lg tracking-tight">میانجی</span>
        </div>
        <div className="flex items-center gap-2">
          {isAuthenticated && (
            <button 
              onClick={() => setView('admin')}
              className="px-3 py-1 text-[10px] font-bold bg-slate-900 text-white rounded-full"
            >
              مدیریت
            </button>
          )}
          <button 
            onClick={() => setView('profile')}
            className="w-10 h-10 flex items-center justify-center rounded-full bg-slate-100 text-slate-600"
          >
            <User size={20} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="pb-24 max-w-lg mx-auto min-h-[calc(100vh-3.5rem)]">
        <AnimatePresence mode="wait">
          {view === 'auth' && <AuthView key="auth" onLogin={() => { setIsAuthenticated(true); setView('dashboard'); }} />}
          {view === 'dashboard' && <Dashboard key="dash" onSelect={(e) => { setSelectedDeal(e); setView('detail'); }} />}
          {view === 'create' && <CreateDeal key="create" onCancel={() => setView('dashboard')} />}
          {view === 'detail' && selectedDeal && (
            <DealDetail 
              key="detail" 
              deal={selectedDeal} 
              onBack={() => setView('dashboard')} 
              onDispute={() => setView('dispute')}
            />
          )}
          {view === 'dispute' && selectedDeal && <DisputeRoom key="dispute" deal={selectedDeal} onBack={() => setView('detail')} />}
          {view === 'admin' && <AdminPanel key="admin" onBack={() => setView('dashboard')} />}
          {view === 'profile' && <ProfileView key="profile" onLogout={() => { setIsAuthenticated(false); setView('auth'); }} />}
        </AnimatePresence>
      </main>

      {/* Bottom Nav */}
      {isAuthenticated && view !== 'admin' && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-200 px-6 h-16 flex items-center justify-around pb-safe">
          <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={22} />} label="پیشخوان" />
          <NavButton active={view === 'create'} onClick={() => setView('create')} icon={<Plus size={22} />} label="معامله جدید" />
          <NavButton active={view === 'profile'} onClick={() => setView('profile')} icon={<User size={22} />} label="پروفایل" />
        </nav>
      )}
    </div>
  );
}

// --- Components ---

function AuthView({ onLogin }: { onLogin: () => void }) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="p-6 pt-12 text-center"
    >
      <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl shadow-blue-100">
        <Shield size={40} />
      </div>
      <h1 className="text-2xl font-bold mb-2">ورود به میانجی</h1>
      <p className="text-slate-500 text-sm mb-8">برای امنیت معاملات شما، نیاز به تایید شماره همراه است.</p>

      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm text-right space-y-4">
        {step === 'phone' ? (
          <>
            <div>
              <label className="text-xs font-bold text-slate-500 block mb-2 mr-1">شماره موبایل</label>
              <input 
                type="tel" 
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0912xxxxxxx" 
                className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-center font-mono text-lg outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              />
            </div>
            <button 
              onClick={() => setStep('otp')}
              className="w-full h-12 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-200 active:scale-[0.98] transition-transform"
            >
              ارسال کد تایید
            </button>
          </>
        ) : (
          <>
            <div>
              <label className="text-xs font-bold text-slate-500 block mb-2 mr-1">کد تایید (۱۲۳۴۵۶)</label>
              <input 
                type="text" 
                maxLength={6}
                placeholder="------" 
                className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-center font-mono text-2xl tracking-[0.5em] outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              />
            </div>
            <button 
              onClick={onLogin}
              className="w-full h-12 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-200"
            >
              تایید و ورود
            </button>
            <button onClick={() => setStep('phone')} className="w-full text-xs text-slate-400 font-medium pt-2">ویرایش شماره</button>
          </>
        )}
      </div>
    </motion.div>
  );
}

function AdminPanel({ onBack }: { onBack: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-4 space-y-6"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">پنل مدیریت میانجی</h1>
        <button onClick={onBack} className="text-sm text-blue-600 font-bold">بازگشت</button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white p-4 rounded-2xl border border-slate-200">
          <span className="text-[10px] text-slate-500 font-bold block mb-1">کل معاملات</span>
          <span className="text-xl font-bold">۱,۲۸۴</span>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-rose-200 bg-rose-50/20">
          <span className="text-[10px] text-rose-500 font-bold block mb-1">اختلافات باز</span>
          <span className="text-xl font-bold text-rose-600">۱۲</span>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-bold text-slate-500 mb-3">مدیریت اختلافات</h2>
        <div className="space-y-3">
          {[
            { id: '1', title: 'خرید اکانت بازی', amount: '۵,۰۰۰,۰۰۰', status: 'در حال بررسی' },
            { id: '2', title: 'خدمات سئو', amount: '۱۲,۰۰۰,۰۰۰', status: 'منتظر پاسخ' },
          ].map(d => (
            <div key={d.id} className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm">{d.title}</h3>
                <span className="text-xs text-slate-500">{d.amount} تومان</span>
              </div>
              <button className="px-4 py-1.5 bg-slate-900 text-white text-[10px] font-bold rounded-lg">داوری</button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-sm font-bold text-slate-500 mb-3">کاربران مشکوک</h2>
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {[
            { name: 'رضا کلاهی', phone: '۰۹۳۵۰۰۰۱۱۱۱', score: '۳۴' },
            { name: 'جعفر تقلب', phone: '۰۹۱۲۰۱۲۰۱۲۰', score: '۱۲' },
          ].map((u, i) => (
            <div key={i} className="p-3 border-b border-slate-100 flex items-center justify-between last:border-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center text-slate-400">
                  <User size={16} />
                </div>
                <div>
                  <div className="text-xs font-bold">{u.name}</div>
                  <div className="text-[10px] text-slate-400">{u.phone}</div>
                </div>
              </div>
              <span className="text-xs font-bold text-rose-600">امتیاز: {u.score}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function ProfileView({ onLogout }: { onLogout: () => void }) {
  const mockTransactions = [
    { id: '1', type: 'deposit', amount: 5000000, date: '۱۴۰۲/۰۷/۱۰' },
    { id: '2', type: 'escrow_hold', amount: -2000000, date: '۱۴۰۲/۰۷/۱۲' },
  ];

  return (
    <motion.div 
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="p-6 space-y-6"
    >
      <div className="text-center">
        <div className="w-24 h-24 bg-white border-4 border-white shadow-xl rounded-full mx-auto mb-4 overflow-hidden">
          <div className="w-full h-full bg-slate-100 flex items-center justify-center text-slate-400">
            <User size={48} />
          </div>
        </div>
        <h2 className="text-xl font-bold">نام کاربر</h2>
        <p className="text-sm text-slate-500">۰۹۱۲۰۱۲۰۱۲۰</p>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-medium">موجودی کیف پول</span>
          <span className="text-lg font-bold text-blue-600">۳,۰۰۰,۰۰۰ تومان</span>
        </div>
        
        <div className="p-4">
          <h3 className="text-xs font-bold text-slate-400 mb-3">تراکنش‌های اخیر</h3>
          <div className="space-y-3">
            {mockTransactions.map(tx => (
              <div key={tx.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${tx.type === 'deposit' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                  <span className="text-slate-600">{tx.type === 'deposit' ? 'واریز به کیف پول' : 'مسدودی برای معامله'}</span>
                </div>
                <div className="text-left">
                  <div className={`font-bold ${tx.amount > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {tx.amount.toLocaleString()}
                  </div>
                  <div className="text-[10px] text-slate-400">{tx.date}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden">
        <button className="w-full p-4 text-right flex items-center justify-between border-b border-slate-100">
          <span className="text-sm font-medium">احراز هویت کد ملی</span>
          <CheckCircle2 size={18} className="text-emerald-500" />
        </button>
        <button onClick={onLogout} className="w-full p-4 text-right text-rose-600 text-sm font-bold">
          خروج از حساب
        </button>
      </div>
    </motion.div>
  );
}

function Dashboard({ onSelect }: { onSelect: (d: Deal) => void }) {
  const mockDeals: Deal[] = [
    { id: '1', contractId: 'DEAL-101', title: 'خرید لپ‌تاپ مک‌بوک', amount: 85000000, status: 'active', otherParty: 'علی محمدی', creatorId: 'user1', buyerId: 'me', sellerId: 'user1' },
    { id: '2', contractId: 'DEAL-102', title: 'پروژه طراحی سایت', amount: 15000000, status: 'pending_signatures', otherParty: 'سارا رضایی', creatorId: 'me', buyerId: 'user2', sellerId: 'me' },
    { id: '3', contractId: 'DEAL-103', title: 'فروش کنسول PS5', amount: 28000000, status: 'completed', otherParty: 'رضا حسینی', creatorId: 'user3', buyerId: 'user3', sellerId: 'me' },
  ];

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="p-4 space-y-6"
    >
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
        <input 
          type="text" 
          placeholder="جستجو در معاملات..." 
          className="w-full bg-white border border-slate-200 rounded-xl py-3 pr-10 pl-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 block mb-1">امتیاز اعتبار</span>
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold">۹۸</span>
            <span className="text-[10px] text-emerald-600 font-medium">از ۱۰۰</span>
          </div>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <span className="text-xs text-slate-500 block mb-1">معاملات فعال</span>
          <span className="text-2xl font-bold">۲</span>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-bold text-slate-500 mb-3 px-1">آخرین معاملات</h2>
        <div className="space-y-3">
          {mockDeals.map((deal) => (
            <button 
              key={deal.id}
              onClick={() => onSelect(deal)}
              className="w-full bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between active:scale-[0.98] transition-transform text-right"
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  deal.status === 'completed' ? 'bg-emerald-50 text-emerald-600' : 
                  deal.status === 'active' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'
                }`}>
                  {deal.status === 'completed' ? <CheckCircle2 size={20} /> : <Clock size={20} />}
                </div>
                <div>
                  <h3 className="font-bold text-sm">{deal.title}</h3>
                  <span className="text-xs text-slate-500">{deal.otherParty}</span>
                </div>
              </div>
              <div className="text-left">
                <div className="font-bold text-sm text-blue-600">{deal.amount.toLocaleString()} تومان</div>
                <StatusBadge status={deal.status} />
              </div>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function DealDetail({ deal, onBack, onDispute }: { deal: Deal, onBack: () => void, onDispute: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="p-4 space-y-4"
    >
      <button onClick={onBack} className="flex items-center gap-1 text-slate-500 text-sm mb-4">
        <ChevronLeft size={18} className="rotate-180" />
        <span>بازگشت به پیشخوان</span>
      </button>

      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-6">
        <div className="flex justify-between items-start">
          <div>
            <div className="text-[10px] text-slate-400 font-mono mb-1">{deal.contractId}</div>
            <h1 className="text-xl font-bold mb-1">{deal.title}</h1>
            <p className="text-sm text-slate-500">طرف معامله: {deal.otherParty}</p>
          </div>
          <StatusBadge status={deal.status} />
        </div>

        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex justify-between items-center">
          <span className="text-sm text-slate-500">مبلغ قرارداد</span>
          <span className="text-lg font-bold text-blue-600">{deal.amount.toLocaleString()} تومان</span>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-bold">شرایط و تعهدات</h3>
          <p className="text-sm text-slate-600 leading-relaxed bg-slate-50/50 p-4 rounded-xl">
            لورم ایپسوم متن ساختگی با تولید سادگی نامفهوم از صنعت چاپ و با استفاده از طراحان گرافیک است.
          </p>
        </div>

        <div className="pt-4 flex flex-col gap-3">
          <button className="w-full h-12 bg-blue-600 text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-blue-200">
            <MessageCircle size={18} />
            چت و گفتگو
          </button>
          <button 
            onClick={onDispute}
            className="w-full h-12 bg-white text-rose-600 border border-rose-100 font-bold rounded-xl flex items-center justify-center gap-2"
          >
            <AlertCircle size={18} />
            درخواست داوری
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function CreateDeal({ onCancel }: { onCancel: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="p-4"
    >
      <h1 className="text-xl font-bold mb-6">ایجاد معامله جدید</h1>
      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm space-y-4">
        <div>
          <label className="text-sm font-bold block mb-2">عنوان معامله</label>
          <input type="text" className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-blue-500" placeholder="مثلاً: خرید گوشی" />
        </div>
        <div>
          <label className="text-sm font-bold block mb-2">مبلغ (تومان)</label>
          <input type="number" className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-blue-500" placeholder="0" />
        </div>
        <div>
          <label className="text-sm font-bold block mb-2">شرایط و جزئیات</label>
          <textarea className="w-full border border-slate-200 rounded-xl p-3 outline-none focus:ring-2 focus:ring-blue-500 h-32" placeholder="شرایط تحویل و تسویه را بنویسید..."></textarea>
        </div>
        <div className="pt-4 flex gap-3">
          <button className="flex-1 h-12 bg-blue-600 text-white font-bold rounded-xl">ثبت و ارسال دعوت</button>
          <button onClick={onCancel} className="flex-1 h-12 bg-slate-100 text-slate-600 font-bold rounded-xl">انصراف</button>
        </div>
      </div>
    </motion.div>
  );
}

function DisputeRoom({ deal, onBack }: { deal: Deal, onBack: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="p-4"
    >
       <button onClick={onBack} className="flex items-center gap-1 text-slate-500 text-sm mb-4">
        <ChevronLeft size={18} className="rotate-180" />
        <span>بازگشت به جزئیات</span>
      </button>
      <div className="bg-white p-6 rounded-3xl border border-rose-200 shadow-xl shadow-rose-50 space-y-6">
        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-full flex items-center justify-center mx-auto mb-4 border border-rose-100">
            <Scale size={32} />
          </div>
          <h1 className="text-xl font-bold text-rose-700">اتاق داوری و حل اختلاف</h1>
          <p className="text-sm text-slate-500">داور متخصص میانجی در حال بررسی مدارک است.</p>
        </div>

        <div className="bg-rose-50/50 p-4 rounded-2xl border border-rose-100 border-dashed">
          <h3 className="text-xs font-bold text-rose-700 mb-2">مدارک ارسالی</h3>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {[1, 2].map(i => (
              <div key={i} className="w-20 h-20 bg-white border border-rose-200 rounded-lg flex-shrink-0 flex items-center justify-center text-rose-300">
                تصویر {i}
              </div>
            ))}
            <button className="w-20 h-20 bg-rose-100 border-2 border-dashed border-rose-300 rounded-lg flex-shrink-0 flex items-center justify-center text-rose-600">
              <Plus size={24} />
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="bg-slate-50 p-3 rounded-xl rounded-br-none text-sm ml-8">
            خریدار: کالا مطابق توضیحات نبود.
          </div>
          <div className="bg-blue-50 p-3 rounded-xl rounded-bl-none text-sm mr-8 text-left">
            فروشنده: تمام عکس‌ها دقیق هستند.
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center gap-1 transition-colors ${active ? 'text-blue-600' : 'text-slate-400'}`}
    >
      {icon}
      <span className="text-[10px] font-bold">{label}</span>
      {active && <motion.div layoutId="nav-dot" className="w-1 h-1 bg-blue-600 rounded-full mt-0.5" />}
    </button>
  );
}

function StatusBadge({ status }: { status: Deal['status'] }) {
  const configs = {
    pending_signatures: { label: 'در انتظار امضا', class: 'bg-amber-100 text-amber-700' },
    active: { label: 'فعال', class: 'bg-blue-100 text-blue-700' },
    completed: { label: 'تکمیل شده', class: 'bg-emerald-100 text-emerald-700' },
    disputed: { label: 'در حال داوری', class: 'bg-rose-100 text-rose-700' },
  };
  const config = configs[status];
  return (
    <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${config.class}`}>
      {config.label}
    </span>
  );
}

