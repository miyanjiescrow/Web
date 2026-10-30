/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  Plus, 
  Home, 
  User, 
  Scale, 
  ChevronLeft,
  CheckCircle2,
  Clock,
  AlertCircle,
  Wallet,
  ClipboardList,
  Bell,
  ArrowUpRight,
  ArrowDownLeft,
  Copy,
  MessageCircle,
  LogOut,
  Settings,
  QrCode,
  Search,
  Filter,
  MoreVertical,
  Zap,
  CreditCard,
  History,
  TrendingUp,
  LayoutGrid,
  HelpCircle,
  Camera,
  Briefcase,
  Layers,
  Activity,
  ChevronRight,
  ScanLine,
  ExternalLink,
  ArrowRightLeft,
  Gem,
  Cpu,
  Target
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// --- Types ---
type View = 'auth' | 'dashboard' | 'deals' | 'create' | 'wallet' | 'profile' | 'detail' | 'dispute';

interface Deal {
  id: string;
  contractId: string;
  title: string;
  amount: number;
  status: 'pending_signatures' | 'active' | 'completed' | 'disputed';
  otherParty: string;
  role: 'buyer' | 'seller';
  lastActivity?: string;
}

// --- Main App ---
export default function App() {
  const [view, setView] = useState<View>('auth');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);

  useEffect(() => {
    const isAuth = localStorage.getItem('mianji_auth');
    if (isAuth === 'true') {
      setIsAuthenticated(true);
      setView('dashboard');
    }
  }, []);

  const handleLogin = () => {
    localStorage.setItem('mianji_auth', 'true');
    setIsAuthenticated(true);
    setView('dashboard');
  };

  const handleLogout = () => {
    localStorage.removeItem('mianji_auth');
    setIsAuthenticated(false);
    setView('auth');
  };

  return (
    <div className="min-h-screen bg-[#08090a] text-slate-200 selection:bg-indigo-500/30 overflow-x-hidden font-sans" dir="rtl">
      
      {/* Dynamic Background Mesh */}
      <div className="fixed inset-0 bg-mesh pointer-events-none z-0" />

      {/* Top Header - Enterprise Style */}
      {isAuthenticated && view !== 'auth' && (
        <header className="sticky top-0 z-50 bg-[#08090a]/80 backdrop-blur-xl border-b border-white/5 h-16 flex items-center justify-between px-6">
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 royal-gradient rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
                <Shield size={20} strokeWidth={2.5} />
             </div>
             <div className="flex flex-col">
                <span className="font-black text-xl tracking-tighter text-white leading-none">میانجی</span>
                <span className="text-[8px] font-black text-indigo-400 uppercase tracking-[0.2em] mt-1">Escrow Network</span>
             </div>
          </div>
          
          <div className="flex items-center gap-3">
            <IconButton icon={<Bell size={20} />} dot />
            <button onClick={() => setView('profile')} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center active:scale-90 transition-all overflow-hidden">
               <div className="w-full h-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center">
                  <User size={20} className="text-slate-400" />
               </div>
            </button>
          </div>
        </header>
      )}

      {/* Main Content Area */}
      <main className={`max-w-md mx-auto min-h-screen relative z-10 ${isAuthenticated ? 'px-5 pt-4 pb-32' : ''}`}>
        <AnimatePresence mode="wait">
          {view === 'auth' && <AuthView key="auth" onLogin={handleLogin} />}
          {view === 'dashboard' && <DashboardView key="dash" setView={setView} onSelect={(d) => { setSelectedDeal(d); setView('detail'); }} />}
          {view === 'deals' && <DealsView key="deals" onSelect={(d) => { setSelectedDeal(d); setView('detail'); }} />}
          {view === 'wallet' && <WalletView key="wallet" setView={setView} />}
          {view === 'create' && <CreateDealView key="create" onCancel={() => setView('dashboard')} />}
          {view === 'detail' && selectedDeal && <DealDetailView key="detail" deal={selectedDeal} onBack={() => setView('dashboard')} onDispute={() => setView('dispute')} />}
          {view === 'dispute' && selectedDeal && <DisputeView key="dispute" deal={selectedDeal} onBack={() => setView('detail')} />}
          {view === 'profile' && <ProfileView key="profile" onLogout={handleLogout} />}
        </AnimatePresence>
      </main>

      {/* Royal Navigation System */}
      {isAuthenticated && view !== 'auth' && (
        <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[92%] max-w-sm z-50 bg-[#121417]/90 backdrop-blur-2xl border border-white/10 h-20 rounded-[2.5rem] flex items-center justify-around px-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
          <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={22} />} label="خانه" />
          <NavButton active={view === 'deals'} onClick={() => setView('deals')} icon={<LayoutGrid size={22} />} label="معاملات" />
          
          <div className="relative -top-10">
            <button 
              onClick={() => setView('create')}
              className="w-16 h-16 royal-gradient text-white rounded-3xl flex items-center justify-center shadow-2xl shadow-indigo-500/40 active:scale-90 transition-transform border-[6px] border-[#08090a]"
            >
              <Plus size={32} strokeWidth={3} />
            </button>
          </div>

          <NavButton active={view === 'wallet'} onClick={() => setView('wallet')} icon={<Wallet size={22} />} label="کیف پول" />
          <NavButton active={view === 'profile'} onClick={() => setView('profile')} icon={<User size={22} />} label="پروفایل" />
        </nav>
      )}
    </div>
  );
}

// --- Views ---

function AuthView({ onLogin }: { onLogin: () => void }) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="min-h-screen flex flex-col justify-center p-8 text-center"
    >
      <div className="mb-12 relative">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 bg-indigo-500/20 blur-[80px] rounded-full" />
        <div className="w-28 h-28 royal-gradient rounded-[2.5rem] mx-auto flex items-center justify-center text-white shadow-2xl shadow-indigo-500/30 mb-8 relative z-10 border border-white/20">
          <Shield size={56} strokeWidth={1.5} />
        </div>
        <h1 className="text-5xl font-black text-white mb-4 tracking-tighter">میانجی</h1>
        <p className="text-slate-400 text-[15px] font-medium max-w-[240px] mx-auto leading-relaxed">
          سامانه هوشمند تضمین پرداخت <br/> 
          <span className="text-indigo-400">و واسطه‌گری امن دیجیتال</span>
        </p>
      </div>

      <motion.div 
        layout
        className="bg-[#121417]/80 backdrop-blur-xl border border-white/5 p-10 rounded-[3.5rem] shadow-2xl space-y-8 relative overflow-hidden"
      >
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-indigo-500/5 rounded-full blur-3xl" />
        
        <div className="text-right space-y-6">
          <div className="space-y-3">
            <label className="label-refined">{step === 'phone' ? 'شماره تلفن همراه' : 'کد تایید پیامک شده'}</label>
            <input 
              type={step === 'phone' ? 'tel' : 'text'}
              placeholder={step === 'phone' ? '0912XXXXXXX' : '----'}
              className="input-refined text-center text-2xl font-black tracking-[0.2em]"
              autoFocus
            />
          </div>
          
          <button onClick={() => step === 'phone' ? setStep('otp') : onLogin()} className="btn-primary w-full shadow-indigo-500/40">
            {step === 'phone' ? 'دریافت کد ورود' : 'ورود به پنل کاربری'}
            <ChevronLeft size={18} className="mr-auto" />
          </button>
        </div>
        
        {step === 'otp' && (
          <button onClick={() => setStep('phone')} className="text-[11px] font-black text-indigo-400 uppercase tracking-widest hover:text-indigo-300 transition-colors">ویرایش شماره همراه</button>
        )}
      </motion.div>
      
      <div className="mt-16 flex items-center justify-center gap-6 opacity-30 grayscale">
         <Shield size={24} />
         <div className="h-4 w-[1px] bg-white/20" />
         <Scale size={24} />
         <div className="h-4 w-[1px] bg-white/20" />
         <Cpu size={24} />
      </div>
    </motion.div>
  );
}

function DashboardView({ setView, onSelect }: { setView: (v: View) => void, onSelect: (d: Deal) => void }) {
  const mockDeals: Deal[] = [
    { id: '1', contractId: 'ES-9021', title: 'توسعه فرانت‌اند پنل ادمین صرافی', amount: 35000000, status: 'active', otherParty: 'تیم آداک', role: 'seller', lastActivity: '۲ ساعت پیش' },
    { id: '2', contractId: 'ES-9022', title: 'خرید دامین Premium Crypto', amount: 120000000, status: 'pending_signatures', otherParty: 'رضا علوی', role: 'buyer', lastActivity: '۱۰ دقیقه پیش' },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
      
      {/* Wallet Master Card */}
      <div className="bg-royal-wavy rounded-[3rem] p-8 text-white shadow-2xl relative">
        <div className="relative z-10 space-y-10">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <span className="text-[10px] font-black tracking-[0.3em] uppercase text-indigo-200/60 block">Net Balance</span>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-black tabular-nums tracking-tighter">۳,۴۵۰,۰۰۰</span>
                <span className="text-[14px] font-black text-indigo-300 uppercase">Toman</span>
              </div>
            </div>
            <div className="w-14 h-14 rounded-2xl bg-white/10 backdrop-blur-xl border border-white/20 flex items-center justify-center shadow-inner">
               <Gem size={28} className="text-indigo-200 animate-pulse" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
             <button onClick={() => setView('wallet')} className="btn-glass bg-emerald-500/20 border-emerald-500/30">
                <ArrowDownLeft size={18} />
                واریز آنی
             </button>
             <button onClick={() => setView('wallet')} className="btn-glass bg-white/5 border-white/10">
                <ArrowUpRight size={18} />
                برداشت
             </button>
          </div>
        </div>
      </div>

      {/* Grid Menu System */}
      <div className="grid grid-cols-4 gap-4 px-1">
         <IconAction icon={<Target size={24} />} label="قراردادها" color="text-indigo-500" bg="bg-indigo-500/5" onClick={() => setView('deals')} />
         <IconAction icon={<ScanLine size={24} />} label="اسکن QR" color="text-emerald-500" bg="bg-emerald-500/5" />
         <IconAction icon={<History size={24} />} label="تاریخچه" color="text-amber-500" bg="bg-amber-500/5" onClick={() => setView('wallet')} />
         <IconAction icon={<HelpCircle size={24} />} label="پشتیبانی" color="text-blue-500" bg="bg-blue-500/5" />
      </div>

      {/* Section: Active Markets */}
      <div className="space-y-5">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
             <div className="w-3 h-3 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_15px_rgba(16,185,129,0.5)]" />
             <h2 className="text-lg font-black text-white">معاملات فعال</h2>
          </div>
          <button onClick={() => setView('deals')} className="text-[11px] font-black text-indigo-400 uppercase tracking-widest flex items-center gap-1 bg-white/5 px-3 py-1.5 rounded-full border border-white/5 hover:bg-white/10 transition-all">همه <ChevronLeft size={14} /></button>
        </div>
        
        <div className="space-y-4">
          {mockDeals.map(deal => (
            <motion.button 
              whileTap={{ scale: 0.98 }}
              key={deal.id}
              onClick={() => onSelect(deal)}
              className="w-full card-refined p-5 flex items-center justify-between text-right group relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-1 h-full bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center gap-5 min-w-0">
                <div className={`w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center border shadow-inner ${deal.role === 'seller' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20'}`}>
                  {deal.role === 'seller' ? <TrendingUp size={24} /> : <Briefcase size={24} />}
                </div>
                <div className="min-w-0 space-y-1">
                  <h3 className="text-[15px] font-black text-white truncate leading-tight">{deal.title}</h3>
                  <div className="flex items-center gap-2">
                     <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-md ${deal.role === 'seller' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-indigo-500/10 text-indigo-500'}`}>{deal.role === 'seller' ? 'مجری' : 'کارفرما'}</span>
                     <span className="text-[10px] font-bold text-slate-500">{deal.otherParty}</span>
                  </div>
                </div>
              </div>
              <div className="text-left shrink-0 space-y-1.5">
                <div className="text-[15px] font-black tabular-nums text-white leading-none">{deal.amount.toLocaleString()}</div>
                <StatusLabel status={deal.status} />
              </div>
            </motion.button>
          ))}
        </div>
      </div>

      {/* Security Status Bar */}
      <div className="card-refined p-5 bg-[#121417] border-indigo-500/10 relative">
         <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-4">
               <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-500">
                  <Shield size={20} />
               </div>
               <div>
                  <span className="text-[10px] font-black text-slate-500 uppercase block tracking-widest">Trust Score</span>
                  <span className="text-[13px] font-black text-white">احراز هویت سطح ۲ (نقره‌ای)</span>
               </div>
            </div>
            <button className="h-10 px-4 gold-gradient rounded-xl text-[10px] font-black text-indigo-950 uppercase tracking-widest shadow-lg shadow-amber-500/20">ارتقا حساب</button>
         </div>
      </div>
    </motion.div>
  );
}

// --- Component Library ---

function IconButton({ icon, dot }: { icon: React.ReactNode, dot?: boolean }) {
  return (
    <button className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 text-slate-400 border border-white/10 relative active:scale-90 transition-all">
      {icon}
      {dot && (
        <div className="absolute top-2 right-2 w-2 h-2 bg-rose-500 rounded-full ring-4 ring-[#08090a]" />
      )}
    </button>
  );
}

function IconAction({ icon, label, color, bg, onClick }: { icon: React.ReactNode, label: string, color: string, bg: string, onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-3 group active:scale-95 transition-all">
      <div className={`w-16 h-16 ${bg} ${color} rounded-[1.75rem] flex items-center justify-center border border-white/5 shadow-lg group-hover:scale-110 transition-all duration-300`}>
        {icon}
      </div>
      <span className="text-[11px] font-black text-slate-400 group-hover:text-white transition-colors">{label}</span>
    </button>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`flex flex-col items-center gap-2 transition-all relative px-3 py-2 ${active ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
    >
      <div className={`transition-all duration-300 ${active ? 'scale-110 -translate-y-1' : 'scale-100'}`}>
        {icon}
      </div>
      <span className="text-[10px] font-black uppercase tracking-tight">{label}</span>
      {active && (
        <motion.div layoutId="nav-line" className="absolute -bottom-2 w-8 h-1 royal-gradient rounded-full shadow-[0_0_10px_rgba(99,102,241,0.5)]" />
      )}
    </button>
  );
}

function StatusLabel({ status }: { status: Deal['status'] }) {
  const configs = {
    pending_signatures: { label: 'در انتظار امضا', class: 'text-amber-400' },
    active: { label: 'در حال اجرا', class: 'text-emerald-400' },
    completed: { label: 'تسویه شده', class: 'text-indigo-400' },
    disputed: { label: 'اختلاف', class: 'text-rose-400' },
  };
  const config = configs[status];
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-1 h-1 rounded-full ${config.class.replace('text', 'bg')} animate-pulse`} />
      <span className={`text-[10px] font-black ${config.class}`}>
        {config.label}
      </span>
    </div>
  );
}

// --- View Implementations ---

function DealsView({ onSelect }: { onSelect: (d: Deal) => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8">
      <div className="flex items-center justify-between px-1">
         <div className="space-y-1">
            <h1 className="text-3xl font-black text-white tracking-tighter">معاملات من</h1>
            <p className="text-[11px] font-black text-indigo-400 uppercase tracking-[0.2em]">Escrow Registry</p>
         </div>
         <IconButton icon={<Filter size={18} />} />
      </div>
      
      <div className="flex gap-3 p-1.5 bg-white/5 rounded-2xl border border-white/5">
        <button className="flex-1 h-11 bg-[#121417] border border-white/10 rounded-xl text-xs font-black text-white shadow-xl">همه</button>
        <button className="flex-1 h-11 text-xs font-black text-slate-500">جاری</button>
        <button className="flex-1 h-11 text-xs font-black text-slate-500">بایگانی</button>
      </div>

      <div className="space-y-4">
        {[1, 2, 3, 4].map(i => (
          <button 
            key={i}
            onClick={() => onSelect({ id: String(i), contractId: 'ES-202'+i, title: 'پروژه طراحی آیکون اختصاصی ' + i, amount: 8500000, status: i === 1 ? 'active' : 'completed', otherParty: 'سارا کریمی', role: 'seller' })}
            className="w-full card-refined p-5 flex items-center justify-between text-right"
          >
             <div className="flex items-center gap-5">
                <div className="w-14 h-14 bg-white/5 rounded-2xl flex items-center justify-center text-slate-500 border border-white/5 shadow-inner">
                   <Target size={26} />
                </div>
                <div className="space-y-1">
                   <h3 className="text-[15px] font-black text-white">پروژه گرافیک دیزاین</h3>
                   <span className="text-[10px] font-bold text-slate-500 block uppercase tracking-widest">ES-1049-X{i}</span>
                </div>
             </div>
             <div className="text-left space-y-1.5">
                <div className="text-[15px] font-black tabular-nums text-white">۸,۵۰۰,۰۰۰</div>
                <StatusLabel status={i === 1 ? 'active' : 'completed'} />
             </div>
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function WalletView({ setView }: { setView: (v: View) => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-3xl font-black text-white tracking-tighter">دارایی و کیف پول</h1>
        <p className="text-[11px] font-black text-emerald-400 uppercase tracking-[0.2em]">Financial Core</p>
      </div>

      <div className="card-refined p-12 text-center space-y-8 relative overflow-hidden bg-gradient-to-br from-[#121417] to-[#08090a]">
         <div className="absolute top-0 right-0 w-48 h-48 bg-indigo-500 opacity-5 rounded-full blur-[80px]" />
         <div className="space-y-3">
            <span className="text-[11px] font-black text-slate-500 uppercase tracking-[0.2em]">موجودی کل حساب (تومان)</span>
            <div className="text-5xl font-black tabular-nums tracking-tighter text-white">۳,۴۵۰,۰۰۰</div>
         </div>
         <div className="flex gap-4 pt-4">
            <button className="btn-primary flex-1 shadow-indigo-500/20">واریز وجه</button>
            <button className="h-14 px-8 bg-white/5 border border-white/10 rounded-2xl flex-1 text-sm font-black text-white hover:bg-white/10 transition-all">برداشت</button>
         </div>
      </div>

      <div className="space-y-5">
         <div className="flex items-center justify-between px-2">
            <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.2em]">تراکنش‌های اخیر</h3>
            <button className="text-[10px] font-black text-indigo-400 uppercase">مشاهده همه</button>
         </div>
         <div className="card-refined p-0 divide-y divide-white/5">
            {[1, 2, 3, 5].map(i => (
               <div key={i} className="p-5 flex items-center justify-between hover:bg-white/[0.02] transition-all">
                  <div className="flex items-center gap-4">
                     <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border shadow-inner ${i % 2 === 0 ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'}`}>
                        {i % 2 === 0 ? <ArrowDownLeft size={22} /> : <ArrowUpRight size={22} />}
                     </div>
                     <div>
                        <span className="text-sm font-black block text-white">{i % 2 === 0 ? 'واریز از درگاه بانکی' : 'برداشت از موجودی'}</span>
                        <span className="text-[10px] font-bold text-slate-500">۱۰ آبان ۱۴۰۵ - ساعت ۱۴:۲۰</span>
                     </div>
                  </div>
                  <span className={`text-[15px] font-black tabular-nums ${i % 2 === 0 ? 'text-emerald-500' : 'text-slate-400'}`}>
                    {i % 2 === 0 ? '+' : '-'}{ (1250000 * i).toLocaleString() }
                  </span>
               </div>
            ))}
         </div>
      </div>
    </motion.div>
  );
}

function CreateDealView({ onCancel }: { onCancel: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
      <div className="px-1 space-y-1">
        <h1 className="text-3xl font-black text-white tracking-tighter">ثبت معامله جدید</h1>
        <p className="text-[11px] font-black text-indigo-400 uppercase tracking-[0.2em]">Smart Contract Setup</p>
      </div>

      <div className="card-refined p-10 space-y-8 bg-[#121417]/80 backdrop-blur-xl">
        <div className="space-y-6 text-right">
           <div className="space-y-2">
              <label className="label-refined">عنوان قرارداد (Title)</label>
              <input type="text" className="input-refined" placeholder="مثلاً: طراحی اپلیکیشن میانجی" />
           </div>
           <div className="grid grid-cols-2 gap-5">
              <div className="space-y-2">
                <label className="label-refined">مبلغ کل (تومان)</label>
                <input type="number" className="input-refined" placeholder="0" />
              </div>
              <div className="space-y-2">
                <label className="label-refined">مدت زمان (روز)</label>
                <input type="number" className="input-refined" placeholder="7" />
              </div>
           </div>
           <div className="space-y-2">
              <label className="label-refined">جزئیات و تعهدات (Terms)</label>
              <textarea className="input-refined h-40 py-5 resize-none" placeholder="شرایط تحویل و خروجی‌های نهایی را بنویسید..." />
           </div>
        </div>
        <div className="pt-4 space-y-4">
           <button className="btn-primary w-full h-16 shadow-indigo-500/30">ایجاد و صدور قرارداد امن</button>
           <button onClick={onCancel} className="w-full h-12 text-[11px] font-black text-slate-600 uppercase tracking-widest hover:text-slate-400 transition-colors">انصراف از ثبت</button>
        </div>
      </div>
    </motion.div>
  );
}

function DealDetailView({ deal, onBack, onDispute }: { deal: Deal, onBack: () => void, onDispute: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-8 pb-10">
      <button onClick={onBack} className="flex items-center gap-2 text-slate-500 text-[11px] font-black uppercase tracking-widest px-2 group">
        <ChevronLeft size={16} className="rotate-180 group-hover:-translate-x-1 transition-transform" /> بازگشت به داشبورد
      </button>

      <div className="card-refined p-10 space-y-10 relative overflow-hidden bg-gradient-to-br from-[#121417] to-[#08090a]">
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500 opacity-5 rounded-full -translate-y-1/2 translate-x-1/2 blur-[100px]" />
        
        <div className="flex justify-between items-start text-right relative z-10">
           <div className="space-y-2">
              <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse" />
                 <span className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.3em]">{deal.contractId}</span>
              </div>
              <h1 className="text-3xl font-black leading-tight text-white tracking-tighter">{deal.title}</h1>
              <div className="flex items-center gap-3 mt-4">
                 <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                    <User size={14} className="text-slate-500" />
                 </div>
                 <div className="flex flex-col">
                    <span className="text-[9px] font-black text-slate-500 uppercase">طرف معامله</span>
                    <span className="text-[13px] font-black text-white">{deal.otherParty}</span>
                 </div>
              </div>
           </div>
           <StatusLabel status={deal.status} />
        </div>

        <div className="grid grid-cols-2 gap-5">
           <div className="bg-white/5 p-6 rounded-[2rem] border border-white/5 text-right shadow-inner">
              <span className="label-refined mb-1 text-indigo-400">بودجه نهایی</span>
              <div className="text-lg font-black text-white tabular-nums">{deal.amount.toLocaleString()} <span className="text-[10px] text-slate-500 uppercase">Toman</span></div>
           </div>
           <div className="bg-white/5 p-6 rounded-[2rem] border border-white/5 text-right shadow-inner">
              <span className="label-refined mb-1">زمان باقیمانده</span>
              <div className="text-lg font-black text-white tabular-nums">۱۴ روز <span className="text-[10px] text-slate-500 uppercase">Left</span></div>
           </div>
        </div>

        <div className="bg-indigo-500/5 p-8 rounded-[2.5rem] border border-indigo-500/10 space-y-6">
           <div className="flex items-center justify-between">
              <div className="space-y-1">
                 <span className="text-[11px] font-black text-white uppercase tracking-widest block">لینک اختصاصی معامله</span>
                 <span className="text-[9px] font-bold text-indigo-400">اشتراک‌گذاری جهت تایید و امضای طرف دوم</span>
              </div>
              <QrCode size={24} className="text-indigo-400" />
           </div>
           <div className="flex gap-3">
              <div className="flex-1 bg-[#08090a] border border-white/10 rounded-2xl px-5 py-4 text-left text-[12px] font-mono text-indigo-400/80 flex items-center overflow-hidden">
                mianji.ir/v/{deal.contractId}
              </div>
              <button className="w-14 h-14 royal-gradient text-white rounded-2xl flex items-center justify-center shadow-lg active:scale-90 transition-transform">
                <Copy size={22} />
              </button>
           </div>
           <button className="w-full h-16 bg-white/5 text-white border border-white/10 rounded-2xl text-[14px] font-black flex items-center justify-center gap-3 hover:bg-white/10 transition-all">
              <ScanLine size={20} className="text-indigo-400" /> مشاهده و اسکن QR Code
           </button>
        </div>

        <div className="pt-4 flex flex-col gap-4">
           <button className="btn-primary w-full h-16"><MessageCircle size={20} /> ورود به اتاق گفتگوی امن</button>
           <button onClick={onDispute} className="h-12 w-full text-rose-400 text-[11px] font-black uppercase tracking-[0.2em] hover:text-rose-300 transition-colors">گزارش نقض قرارداد و داوری</button>
        </div>
      </div>
    </motion.div>
  );
}

function DisputeView({ deal, onBack }: { deal: Deal, onBack: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="min-h-screen flex flex-col justify-center p-10 text-center space-y-10">
       <div className="w-24 h-24 bg-rose-500/10 rounded-[3rem] flex items-center justify-center mx-auto text-rose-500 shadow-2xl shadow-rose-500/10 border border-rose-500/20">
          <Scale size={48} />
       </div>
       <div className="space-y-4">
          <h1 className="text-3xl font-black text-white tracking-tighter">واحد داوری و حل اختلاف</h1>
          <p className="text-[15px] font-medium text-slate-400 leading-relaxed max-w-[280px] mx-auto">
             پرونده مربوط به قرارداد <span className="text-white font-black">{deal.contractId}</span> در نوبت بررسی کارشناسان قرار گرفت.
          </p>
       </div>
       <div className="card-refined p-6 bg-rose-500/5 border-rose-500/10">
          <div className="flex items-center gap-4 text-right">
             <AlertCircle className="text-rose-400 shrink-0" size={24} />
             <span className="text-[12px] font-bold text-rose-200">تا زمان صدور رای نهایی توسط داور، موجودی قرارداد مسدود خواهد بود.</span>
          </div>
       </div>
       <button onClick={onBack} className="btn-primary w-full bg-slate-800 hover:bg-slate-700 shadow-none">بازگشت به جزئیات معامله</button>
    </motion.div>
  );
}

function ProfileView({ onLogout }: { onLogout: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="space-y-10 pt-4">
      <div className="text-center space-y-6">
        <div className="w-36 h-36 bg-[#121417] border-[12px] border-[#08090a] shadow-2xl rounded-[4rem] mx-auto flex items-center justify-center relative overflow-hidden group">
          <User className="text-slate-800 group-hover:scale-110 transition-transform duration-500" size={80} />
          <div className="absolute inset-0 bg-indigo-500 opacity-5" />
          <div className="absolute bottom-0 inset-x-0 h-1/3 bg-gradient-to-t from-indigo-500/20 to-transparent" />
        </div>
        <div className="space-y-2">
          <h2 className="text-3xl font-black tracking-tighter text-white">سید محمد حسینی</h2>
          <div className="flex items-center justify-center gap-2">
             <CheckCircle2 size={16} className="text-emerald-500" />
             <span className="text-[11px] font-black text-indigo-400 uppercase tracking-[0.2em]">Tier 2 Verified Merchant</span>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <MenuBtn icon={<Shield size={20} />} label="امنیت و تایید هویت" status="تایید شده" />
        <MenuBtn icon={<CreditCard size={20} />} label="مدیریت حساب‌های بانکی" />
        <MenuBtn icon={<Settings size={20} />} label="تنظیمات پلتفرم" />
        <MenuBtn icon={<History size={20} />} label="نشست‌های فعال" />
        
        <button onClick={onLogout} className="w-full card-refined flex items-center justify-between text-rose-400 active:bg-rose-500/10 transition-all p-6 mt-10 border-rose-500/10">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 flex items-center justify-center">
               <LogOut size={22} />
            </div>
            <span className="text-[15px] font-black">خروج امن از حساب</span>
          </div>
          <ChevronLeft size={18} />
        </button>
      </div>

      <div className="text-center pb-10 opacity-20">
         <span className="text-[9px] font-black uppercase tracking-[0.5em]">Miyanji v2.4.0 High-Security</span>
      </div>
    </motion.div>
  );
}

function MenuBtn({ icon, label, status }: { icon: React.ReactNode, label: string, status?: string }) {
  return (
    <button className="w-full card-refined flex items-center justify-between active:bg-white/5 transition-all p-6">
      <div className="flex items-center gap-5">
        <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-slate-400 border border-white/5 shadow-inner">
           {icon}
        </div>
        <span className="text-[16px] font-black text-white">{label}</span>
      </div>
      {status ? (
        <span className="text-[10px] font-black text-emerald-400 bg-emerald-500/10 px-4 py-2 rounded-xl border border-emerald-500/20">{status}</span>
      ) : (
        <ChevronLeft size={20} className="text-slate-700" />
      )}
    </button>
  );
}
