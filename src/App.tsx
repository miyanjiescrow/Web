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
  Target,
  Sun,
  Moon
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  where, 
  orderBy, 
  serverTimestamp,
  doc,
  updateDoc
} from 'firebase/firestore';
import { db } from './lib/firebase';


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
  lastActivity?: any;
  createdAt?: any;
}

interface Transaction {
  id: string;
  type: 'deposit' | 'withdraw';
  amount: number;
  date: any;
  status: 'success' | 'pending';
}


// --- Main App ---
export default function App() {
  const [view, setView] = useState<View>('auth');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  const [deals, setDeals] = useState<Deal[]>([]);
  const [balance, setBalance] = useState(3450000); // Default mock balance for now

  useEffect(() => {
    const isAuth = localStorage.getItem('mianji_auth');
    if (isAuth === 'true') {
      setIsAuthenticated(true);
      setView('dashboard');
    }
    const savedTheme = localStorage.getItem('mianji_theme') as 'light' | 'dark';
    if (savedTheme) {
      setTheme(savedTheme);
    }

    // Real-time Deals Subscription
    const q = query(collection(db, 'deals'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const dealsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Deal[];
      setDeals(dealsData);
    });

    return () => unsubscribe();
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('mianji_theme', newTheme);
  };

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
    <div className={`min-h-screen ${theme} transition-colors duration-500`} dir="rtl">
      <div className={`min-h-screen ${theme === 'dark' ? 'bg-[#08090a] text-slate-200' : 'bg-white text-slate-900'} selection:bg-indigo-500/30 overflow-x-hidden font-sans relative`}>
        
        {/* Dynamic Background Mesh */}
        <div className="fixed inset-0 bg-mesh pointer-events-none z-0" />

        {/* Top Header - Compact Glass Enterprise Style */}
        {isAuthenticated && view !== 'auth' && (
          <header className={`sticky top-0 z-50 ${theme === 'dark' ? 'bg-[#08090a]/40 border-white/5' : 'bg-white/80 border-slate-100'} backdrop-blur-xl border-b h-12 flex items-center justify-between px-5`}>
            <div className="flex items-center gap-2">
               <div className="w-8 h-8 royal-gradient rounded-lg flex items-center justify-center text-white shadow-lg relative overflow-hidden seven-accent">
                  <Shield size={16} strokeWidth={2.5} />
                  <div className="absolute top-0 right-0 w-4 h-4 bg-white/20 -rotate-45 translate-x-2 -translate-y-2" />
               </div>
               <div className="flex flex-col">
                  <span className={`font-black text-base tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'} leading-none`}>میانجی</span>
                  <span className="text-[6px] font-black text-indigo-400 uppercase tracking-[0.2em] mt-0.5">Escrow Network</span>
               </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button onClick={toggleTheme} className={`w-8 h-8 flex items-center justify-center rounded-lg ${theme === 'dark' ? 'bg-white/5 text-slate-400 border-white/10' : 'bg-slate-50 text-slate-600 border-slate-200'} border active:scale-90 transition-all`}>
                {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
              </button>
              <IconButton icon={<Bell size={16} />} dot theme={theme} />
              <button onClick={() => setView('profile')} className={`w-8 h-8 rounded-lg ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'} border flex items-center justify-center active:scale-90 transition-all`}>
                 <User size={16} className={theme === 'dark' ? 'text-slate-400' : 'text-slate-600'} />
              </button>
            </div>
          </header>
        )}

        {/* Main Content Area */}
        <main className={`max-w-md mx-auto min-h-screen relative z-10 ${isAuthenticated ? 'px-4 pt-3 pb-24' : ''}`}>
          <AnimatePresence mode="wait">
            {view === 'auth' && <AuthView key="auth" onLogin={handleLogin} theme={theme} />}
            {view === 'dashboard' && <DashboardView key="dash" setView={setView} deals={deals} balance={balance} theme={theme} onSelect={(d) => { setSelectedDeal(d); setView('detail'); }} />}
            {view === 'deals' && <DealsView key="deals" deals={deals} theme={theme} onSelect={(d) => { setSelectedDeal(d); setView('detail'); }} />}
            {view === 'wallet' && <WalletView key="wallet" balance={balance} setView={setView} theme={theme} />}
            {view === 'create' && <CreateDealView key="create" onCancel={() => setView('dashboard')} onSuccess={() => setView('dashboard')} theme={theme} />}
            {view === 'detail' && selectedDeal && <DealDetailView key="detail" deal={selectedDeal} onBack={() => setView('dashboard')} onDispute={() => setView('dispute')} theme={theme} />}
            {view === 'dispute' && selectedDeal && <DisputeView key="dispute" deal={selectedDeal} onBack={() => setView('detail')} theme={theme} />}
            {view === 'profile' && <ProfileView key="profile" onLogout={handleLogout} theme={theme} />}
          </AnimatePresence>
        </main>


        {/* Glass Navigation System */}
        {isAuthenticated && view !== 'auth' && (
          <nav className={`fixed bottom-3 left-1/2 -translate-x-1/2 w-[90%] max-w-xs z-50 ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border-slate-100 shadow-xl shadow-blue-900/5'} backdrop-blur-2xl border h-14 rounded-2xl flex items-center justify-around px-2`}>
            <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={18} />} label="خانه" theme={theme} />
            <NavButton active={view === 'deals'} onClick={() => setView('deals')} icon={<LayoutGrid size={18} />} label="معاملات" theme={theme} />
            
            <div className="relative -top-6">
              <button 
                onClick={() => setView('create')}
                className={`w-12 h-12 royal-gradient text-white rounded-xl flex items-center justify-center shadow-xl active:scale-90 transition-transform border-4 ${theme === 'dark' ? 'border-[#08090a]' : 'border-white'}`}
              >
                <Plus size={24} strokeWidth={3} />
              </button>
            </div>

            <NavButton active={view === 'wallet'} onClick={() => setView('wallet')} icon={<Wallet size={18} />} label="کیف پول" theme={theme} />
            <NavButton active={view === 'profile'} onClick={() => setView('profile')} icon={<User size={18} />} label="پروفایل" theme={theme} />
          </nav>
        )}
      </div>
    </div>
  );
}

// --- Views ---

function AuthView({ onLogin, theme }: { onLogin: () => void, theme: string }) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen flex flex-col justify-center p-6 text-center"
    >
      <div className="mb-8 relative">
        <div className="w-16 h-16 royal-gradient rounded-xl mx-auto flex items-center justify-center text-white shadow-2xl mb-5 border border-white/10 relative overflow-hidden v-accent">
          <Shield size={32} strokeWidth={1.5} />
          <div className="absolute top-0 right-0 w-10 h-10 bg-white/10 -rotate-45 translate-x-5 -translate-y-5" />
        </div>
        <h1 className={`text-2xl font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} mb-1 tracking-tighter`}>میانجی</h1>
        <p className="text-slate-500 text-[10px] font-medium max-w-[180px] mx-auto leading-relaxed">
          واسطه‌گری امن دیجیتال
        </p>
      </div>

      <motion.div layout className="card-refined p-6 space-y-5">
        <div className="text-right space-y-4">
          <div className="space-y-2">
            <label className="label-refined">{step === 'phone' ? 'شماره همراه' : 'کد تایید'}</label>
            <input 
              type={step === 'phone' ? 'tel' : 'text'}
              placeholder={step === 'phone' ? '0912XXXXXXX' : '----'}
              className="input-refined text-center text-lg font-black tracking-widest"
              autoFocus
            />
          </div>
          
          <button onClick={() => step === 'phone' ? setStep('otp') : onLogin()} className="btn-primary w-full h-10 text-xs">
            {step === 'phone' ? 'دریافت کد' : 'ورود به پنل'}
            <ChevronLeft size={14} className="mr-auto" />
          </button>
        </div>
        
        {step === 'otp' && (
          <button onClick={() => setStep('phone')} className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">ویرایش شماره</button>
        )}
      </motion.div>
    </motion.div>
  );
}

function DashboardView({ setView, onSelect, deals, balance, theme }: { setView: (v: View) => void, onSelect: (d: Deal) => void, deals: Deal[], balance: number, theme: string }) {
  const activeDeals = deals.filter(d => d.status === 'active' || d.status === 'pending_signatures');

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      
      {/* Wallet Master Card - Ultra Compact Royal */}
      <div className={`${theme === 'dark' ? 'bg-royal-wavy' : 'bg-[#0038a8]'} rounded-xl p-4 text-white shadow-xl relative overflow-hidden`}>
        {/* Subtle '7' (V) shape accent */}
        <div className="absolute top-0 right-0 w-20 h-20 bg-white/10 -rotate-[35deg] translate-x-10 -translate-y-10" />
        
        <div className="relative z-10 flex items-center justify-between">
          <div className="space-y-0.5 text-right">
            <span className={`text-[7px] font-black tracking-widest uppercase ${theme === 'dark' ? 'text-indigo-200/50' : 'text-white/60'} block`}>موجودی کیف پول</span>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-black tabular-nums tracking-tighter text-white">{balance.toLocaleString()}</span>
              <span className={`text-[8px] font-black uppercase ${theme === 'dark' ? 'text-indigo-300' : 'text-white/80'}`}>Toman</span>
            </div>
          </div>
          
          <div className="flex gap-1.5">
             <button onClick={() => setView('wallet')} className={`btn-glass h-7 px-3 ${theme === 'dark' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/20 text-white'}`}>
                <ArrowDownLeft size={12} />
                واریز
             </button>
             <button onClick={() => setView('wallet')} className="btn-glass h-7 px-3">
                <ArrowUpRight size={12} />
                برداشت
             </button>
          </div>
        </div>
      </div>

      {/* Grid Menu System - High Density */}
      <div className="grid grid-cols-4 gap-2 px-0.5">
         <IconAction icon={<Target size={16} />} label="معاملات" color="text-indigo-400" bg="bg-indigo-500/10" onClick={() => setView('deals')} />
         <IconAction icon={<ScanLine size={16} />} label="اسکن QR" color="text-emerald-400" bg="bg-emerald-500/10" />
         <IconAction icon={<History size={16} />} label="تاریخچه" color="text-amber-400" bg="bg-amber-500/10" onClick={() => setView('wallet')} />
         <IconAction icon={<HelpCircle size={16} />} label="پشتیبانی" color="text-blue-400" bg="bg-blue-500/10" />
      </div>

      {/* Active Deals List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
             <div className="w-1 h-1 bg-emerald-500 rounded-full animate-pulse" />
             <h2 className={`text-[10px] font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>معاملات فعال</h2>
          </div>
          <button onClick={() => setView('deals')} className={`text-[7px] font-black text-indigo-400 uppercase ${theme === 'dark' ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} px-2 py-0.5 rounded border`}>مشاهده همه</button>
        </div>
        
        <div className="space-y-1.5">
          {activeDeals.length > 0 ? activeDeals.map(deal => (
            <motion.button 
              whileTap={{ scale: 0.98 }}
              key={deal.id}
              onClick={() => onSelect(deal)}
              className="w-full card-refined p-2.5 flex items-center justify-between text-right relative group"
            >
              <div className="absolute top-0 right-0 w-5 h-5 bg-indigo-500/5 -rotate-45 translate-x-2.5 -translate-y-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center border ${deal.role === 'seller' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20'}`}>
                  {deal.role === 'seller' ? <TrendingUp size={16} /> : <Briefcase size={16} />}
                </div>
                <div className="min-w-0 space-y-0">
                  <h3 className={`text-[10px] font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} truncate leading-tight`}>{deal.title}</h3>
                  <div className="flex items-center gap-1">
                     <span className={`text-[6px] font-black uppercase px-1 rounded ${deal.role === 'seller' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-indigo-500/10 text-indigo-400'}`}>{deal.role === 'seller' ? 'مجری' : 'کارفرما'}</span>
                     <span className="text-[7px] font-bold text-slate-400">{deal.otherParty}</span>
                  </div>
                </div>
              </div>
              <div className="text-left shrink-0 space-y-0">
                <div className={`text-[11px] font-black tabular-nums ${theme === 'dark' ? 'text-white' : 'text-slate-900'} leading-none`}>{deal.amount.toLocaleString()}</div>
                <StatusLabel status={deal.status} />
              </div>
            </motion.button>
          )) : (
            <div className="card-refined p-6 text-center text-slate-500 space-y-2">
               <Layers size={24} className="mx-auto opacity-20" />
               <p className="text-[10px] font-bold">معامله فعالی یافت نشد</p>
               <button onClick={() => setView('create')} className="text-indigo-400 text-[9px] font-black uppercase tracking-widest">ایجاد معامله جدید</button>
            </div>
          )}
        </div>
      </div>

      {/* Trust Status - More Geometric */}
      <div className="card-refined p-3 relative overflow-hidden">
         <div className="absolute top-0 left-0 w-full h-full bg-indigo-500/5 skew-x-12 translate-x-20" />
         <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-2">
               <div className="w-6 h-6 bg-indigo-500/10 rounded flex items-center justify-center text-indigo-400">
                  <Shield size={14} />
               </div>
               <span className={`text-[9px] font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>احراز هویت سطح ۲</span>
            </div>
            <button className="h-6 px-3 gold-gradient rounded text-[8px] font-black text-indigo-950 uppercase shadow-lg">ارتقا</button>
         </div>
      </div>
    </motion.div>
  );
}


// --- Component Library ---

function IconButton({ icon, dot, theme }: { icon: React.ReactNode, dot?: boolean, theme?: string }) {
  return (
    <button className={`w-8 h-8 flex items-center justify-center rounded-lg ${theme === 'dark' ? 'bg-white/5 text-slate-400 border-white/10' : 'bg-slate-50 text-slate-600 border-slate-200'} border relative active:scale-90 transition-all`}>
      {icon}
      {dot && (
        <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-rose-500 rounded-full border border-[#08090a]" />
      )}
    </button>
  );
}

function IconAction({ icon, label, color, bg, onClick, theme }: { icon: React.ReactNode, label: string, color: string, bg: string, onClick?: () => void, theme?: string }) {
  const isLight = theme === 'light';
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 group active:scale-95 transition-all">
      <div className={`w-11 h-11 ${isLight ? 'bg-[#0038a8] text-white' : bg + ' ' + color} rounded-xl flex items-center justify-center border ${isLight ? 'border-transparent shadow-lg shadow-blue-900/10' : 'border-white/5'} transition-all relative overflow-hidden seven-accent`}>
        {icon}
        <div className="absolute top-0 right-0 w-4 h-4 bg-white/10 -rotate-45 translate-x-2 -translate-y-2" />
      </div>
      <span className={`text-[8px] font-black ${isLight ? 'text-slate-400 group-hover:text-indigo-600' : 'text-slate-500 group-hover:text-white'} transition-colors`}>{label}</span>
    </button>
  );
}

function NavButton({ active, onClick, icon, label, theme }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string, theme: string }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 transition-all px-2 ${active ? 'text-indigo-500' : theme === 'dark' ? 'text-slate-500' : 'text-slate-400'}`}>
      {icon}
      <span className="text-[8px] font-black uppercase tracking-tighter">{label}</span>
      {active && (
        <div className="w-4 h-0.5 royal-gradient rounded-full" />
      )}
    </button>
  );
}

function StatusLabel({ status }: { status: Deal['status'] }) {
  const configs = {
    pending_signatures: { label: 'امضا', color: 'bg-amber-400' },
    active: { label: 'اجرا', color: 'bg-emerald-400' },
    completed: { label: 'تسویه', color: 'bg-indigo-400' },
    disputed: { label: 'اختلاف', color: 'bg-rose-400' },
  };
  const config = configs[status];
  return (
    <div className="flex items-center gap-1">
      <div className={`w-1 h-1 rounded-full ${config.color} animate-pulse`} />
      <span className={`text-[8px] font-black ${config.color.replace('bg-', 'text-')}`}>
        {config.label}
      </span>
    </div>
  );
}

// --- Views ---

function DealsView({ deals, onSelect, theme }: { deals: Deal[], onSelect: (d: Deal) => void, theme: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      <div className="flex items-center justify-between px-1">
         <h1 className={`text-lg font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tighter`}>معاملات</h1>
         <IconButton icon={<Filter size={12} />} theme={theme} />
      </div>
      
      <div className={`flex gap-1 p-1 ${theme === 'dark' ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-lg border`}>
        <button className={`flex-1 h-7 ${theme === 'dark' ? 'bg-white/10 text-white' : 'bg-white text-indigo-600 shadow-sm border-slate-200'} rounded text-[9px] font-black border border-transparent`}>همه</button>
        <button className="flex-1 h-7 text-[9px] font-black text-slate-500">جاری</button>
        <button className="flex-1 h-7 text-[9px] font-black text-slate-500">بایگانی</button>
      </div>

      <div className="space-y-1.5">
        {deals.map(deal => (
          <button 
            key={deal.id}
            onClick={() => onSelect(deal)}
            className="w-full card-refined p-2.5 flex items-center justify-between text-right"
          >
             <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 bg-white/5 rounded-lg flex items-center justify-center text-slate-500 border border-white/5">
                   <Target size={16} />
                </div>
                <div className="space-y-0">
                   <h3 className="text-[11px] font-black dark:text-white light:text-slate-900">{deal.title}</h3>
                   <span className="text-[7px] font-bold text-slate-500 block uppercase">{deal.contractId}</span>
                </div>
             </div>
             <div className="text-left space-y-0">
                <div className="text-[11px] font-black tabular-nums dark:text-white light:text-slate-900 leading-none">{deal.amount.toLocaleString()}</div>
                <StatusLabel status={deal.status} />
             </div>
          </button>
        ))}
      </div>
    </motion.div>
  );
}


function WalletView({ setView, balance, theme }: { setView: (v: View) => void, balance: number, theme: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      <h1 className={`text-lg font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tighter`}>کیف پول</h1>

      <div className="card-refined p-5 text-center space-y-3 bg-gradient-to-br from-white/5 to-transparent relative overflow-hidden">
         <div className="absolute top-0 right-0 w-20 h-20 bg-indigo-500/5 -rotate-45 translate-x-5 -translate-y-5" />
         <div className="space-y-0 relative z-10">
            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">موجودی کل (تومان)</span>
            <div className={`text-2xl font-black tabular-nums tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{balance.toLocaleString()}</div>
         </div>
         <div className="flex gap-2 pt-1 relative z-10">
            <button className="btn-primary flex-1 h-9 text-[10px]">واریز</button>
            <button className={`h-9 px-4 ${theme === 'dark' ? 'bg-white/5 border-white/10 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'} border rounded-lg flex-1 text-[10px] font-black`}>برداشت</button>
         </div>
      </div>

      <div className="space-y-2">
         <h3 className="text-[8px] font-black text-slate-500 uppercase px-1 tracking-widest">آخرین تراکنش‌ها</h3>
         <div className={`card-refined p-0 divide-y ${theme === 'dark' ? 'divide-white/5' : 'divide-slate-100'}`}>
            {[1, 2, 3].map(i => (
               <div key={i} className="p-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                     <div className={`w-8 h-8 rounded-lg flex items-center justify-center border ${i % 2 === 0 ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'}`}>
                        {i % 2 === 0 ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                     </div>
                     <div className="space-y-0">
                        <span className={`text-[11px] font-black block ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{i % 2 === 0 ? 'واریز' : 'برداشت'}</span>
                        <span className="text-[7px] font-bold text-slate-500">۱۰ آبان - ۱۴:۲۰</span>
                     </div>
                  </div>
                  <span className={`text-[11px] font-black tabular-nums ${i % 2 === 0 ? 'text-emerald-500' : theme === 'dark' ? 'text-rose-500' : 'text-rose-600'}`}>
                    {i % 2 === 0 ? '+' : '-'}{ (1250000 * i).toLocaleString() }
                  </span>
               </div>
            ))}
         </div>
      </div>
    </motion.div>
  );
}


function CreateDealView({ onCancel, onSuccess, theme }: { onCancel: () => void, onSuccess: () => void, theme: string }) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    amount: '',
    duration: '7',
    description: '',
    otherParty: 'مشتری جدید'
  });

  const handleSubmit = async () => {
    if (!formData.title || !formData.amount) return;
    setLoading(true);
    try {
      await addDoc(collection(db, 'deals'), {
        ...formData,
        amount: Number(formData.amount),
        duration: Number(formData.duration),
        contractId: `ES-${Math.floor(1000 + Math.random() * 9000)}`,
        status: 'pending_signatures',
        role: 'seller', // Default to seller for creation
        createdAt: serverTimestamp(),
      });
      onSuccess();
    } catch (error) {
      console.error('Error adding deal:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <h1 className={`text-lg font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tighter`}>ثبت معامله</h1>

      <div className="card-refined p-5 space-y-3">
        <div className="space-y-3 text-right">
           <div className="space-y-1">
              <label className="label-refined">عنوان قرارداد</label>
              <input 
                type="text" 
                className="input-refined" 
                placeholder="عنوان پروژه..." 
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
              />
           </div>
           <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="label-refined">مبلغ (تومان)</label>
                <input 
                  type="number" 
                  className="input-refined" 
                  placeholder="0" 
                  value={formData.amount}
                  onChange={e => setFormData({ ...formData, amount: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="label-refined">زمان (روز)</label>
                <input 
                  type="number" 
                  className="input-refined" 
                  placeholder="7" 
                  value={formData.duration}
                  onChange={e => setFormData({ ...formData, duration: e.target.value })}
                />
              </div>
           </div>
           <div className="space-y-1">
              <label className="label-refined">توضیحات</label>
              <textarea 
                className="input-refined h-20 py-2 resize-none text-[10px]" 
                placeholder="جزئیات توافق..." 
                value={formData.description}
                onChange={e => setFormData({ ...formData, description: e.target.value })}
              />
           </div>
        </div>
        <div className="pt-1 space-y-1.5">
           <button 
             onClick={handleSubmit}
             disabled={loading}
             className="btn-primary w-full h-10 text-[10px]"
           >
             {loading ? 'در حال ثبت...' : 'ایجاد قرارداد میانجی'}
           </button>
           <button onClick={onCancel} className="w-full h-7 text-[8px] font-black text-slate-500 uppercase tracking-widest">انصراف</button>
        </div>
      </div>
    </motion.div>
  );
}


function DealDetailView({ deal, onBack, onDispute, theme }: { deal: Deal, onBack: () => void, onDispute: () => void, theme: string }) {
  return (
    <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="space-y-5 pb-4">
      <button onClick={onBack} className="flex items-center gap-1 text-slate-500 text-[9px] font-black uppercase tracking-widest px-1">
        <ChevronLeft size={12} className="rotate-180" /> بازگشت
      </button>

      <div className="card-refined p-6 space-y-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 -rotate-45 translate-x-10 -translate-y-10" />
        
        <div className="flex justify-between items-start text-right relative z-10">
           <div className="space-y-1">
              <span className="text-[8px] font-black text-indigo-500 uppercase">{deal.contractId}</span>
              <h1 className={`text-xl font-black leading-tight ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tighter`}>{deal.title}</h1>
              <div className="flex items-center gap-2 mt-2">
                 <div className={`w-6 h-6 rounded ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} border flex items-center justify-center overflow-hidden relative`}>
                    <User size={10} className="text-slate-500" />
                    <div className="absolute top-0 right-0 w-2 h-2 bg-white/20 rotate-45" />
                 </div>
                 <span className={`text-[11px] font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{deal.otherParty}</span>
              </div>
           </div>
           <StatusLabel status={deal.status} />
        </div>

        <div className="grid grid-cols-2 gap-3">
           <div className={`p-4 rounded-xl border ${theme === 'dark' ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} text-right`}>
              <span className="label-refined mb-0.5 text-indigo-500">بودجه</span>
              <div className={`text-sm font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tabular-nums`}>{deal.amount.toLocaleString()} <span className="text-[8px] text-slate-500 uppercase">T</span></div>
           </div>
           <div className={`p-4 rounded-xl border ${theme === 'dark' ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} text-right`}>
              <span className="label-refined mb-0.5">باقیمانده</span>
              <div className={`text-sm font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tabular-nums`}>۱۴ روز</div>
           </div>
        </div>

        <div className="bg-indigo-500/5 p-5 rounded-2xl border border-indigo-500/10 space-y-4 relative overflow-hidden">
           <div className="absolute bottom-0 right-0 w-16 h-16 bg-white/5 -rotate-12 translate-x-6 translate-y-6" />
           <div className="flex items-center justify-between px-1 relative z-10">
              <span className={`text-[9px] font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} uppercase tracking-widest`}>لینک معامله</span>
              <QrCode size={16} className="text-indigo-500" />
           </div>
           <div className="flex gap-2 relative z-10">
              <div className={`flex-1 ${theme === 'dark' ? 'bg-black/40 border-white/5' : 'bg-white border-slate-200'} border rounded-lg px-3 py-2 text-left text-[9px] font-mono text-indigo-500/80 overflow-hidden whitespace-nowrap`}>
                mianji.ir/v/{deal.contractId}
              </div>
              <button className="w-10 h-10 royal-gradient text-white rounded-lg flex items-center justify-center shadow-lg shrink-0">
                <Copy size={16} />
              </button>
           </div>
           <button className={`w-full h-10 ${theme === 'dark' ? 'bg-white/5 text-white border-white/10' : 'bg-white text-slate-900 border-slate-200'} border rounded-lg text-[11px] font-black flex items-center justify-center gap-2 relative z-10 shadow-sm`}>
              <ScanLine size={16} className="text-indigo-500" /> اسکن QR
           </button>
        </div>

        <div className="pt-1 flex flex-col gap-2 relative z-10">
           <button className="btn-primary w-full h-11 text-xs"><MessageCircle size={16} /> چت امن</button>
           <button onClick={onDispute} className="h-8 w-full text-rose-400 text-[9px] font-black uppercase tracking-widest">گزارش و داوری</button>
        </div>
      </div>
    </motion.div>
  );
}

function DisputeView({ deal, onBack, theme }: { deal: Deal, onBack: () => void, theme: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-[70vh] flex flex-col justify-center p-6 text-center space-y-6">
       <div className="w-16 h-16 bg-rose-500/10 rounded-xl flex items-center justify-center mx-auto text-rose-500 border border-rose-500/10 relative overflow-hidden">
          <Scale size={32} />
          <div className="absolute top-0 right-0 w-6 h-6 bg-white/10 -rotate-45" />
       </div>
       <div className="space-y-2">
          <h1 className={`text-xl font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'} tracking-tighter`}>واحد داوری میانجی</h1>
          <p className="text-[10px] font-medium text-slate-500 max-w-[220px] mx-auto leading-relaxed">
             قرارداد <span className={`font-black ${theme === 'dark' ? 'text-white' : 'text-indigo-600'}`}>{deal.contractId}</span> در نوبت بررسی قرار گرفت.
          </p>
       </div>
       <div className={`card-refined p-4 ${theme === 'dark' ? 'bg-rose-500/5 border-rose-500/10 text-rose-200' : 'bg-rose-50 border-rose-100 text-rose-600'}`}>
          <span className="text-[10px] font-bold">تا زمان صدور رای، موجودی معامله مسدود خواهد بود.</span>
       </div>
       <button onClick={onBack} className={`btn-primary w-full ${theme === 'dark' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-900'} h-10 text-xs shadow-none`}>بازگشت</button>
    </motion.div>
  );
}

function ProfileView({ onLogout, theme }: { onLogout: () => void, theme: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 pt-2">
      <div className="text-center space-y-4">
        <div className={`w-24 h-24 rounded-2xl mx-auto flex items-center justify-center relative overflow-hidden border ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border-slate-100 shadow-xl shadow-blue-900/5'}`}>
          <User className={theme === 'dark' ? 'text-slate-800' : 'text-slate-200'} size={50} />
          <div className="absolute inset-0 bg-indigo-500 opacity-5" />
          {/* Subtle '7' accent */}
          <div className="absolute top-0 right-0 w-12 h-12 bg-white/10 -rotate-45 translate-x-6 -translate-y-6" />
        </div>
        <div className="space-y-1">
          <h2 className={`text-xl font-black tracking-tighter ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>سید محمد حسینی</h2>
          <div className="flex items-center justify-center gap-1.5">
             <CheckCircle2 size={12} className="text-emerald-500" />
             <span className="text-[9px] font-black text-indigo-500 uppercase tracking-widest">Verified Merchant</span>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        <MenuBtn icon={<Shield size={16} />} label="امنیت و تایید هویت" status="تایید شده" />
        <MenuBtn icon={<CreditCard size={16} />} label="حساب‌های بانکی" />
        <MenuBtn icon={<Settings size={16} />} label="تنظیمات پلتفرم" />
        
        <button onClick={onLogout} className="w-full card-refined flex items-center justify-between text-rose-400 p-4 mt-6 border-rose-500/10">
          <div className="flex items-center gap-3">
            <LogOut size={18} />
            <span className="text-xs font-black">خروج امن</span>
          </div>
          <ChevronLeft size={14} />
        </button>
      </div>
    </motion.div>
  );
}

function MenuBtn({ icon, label, status, theme }: { icon: React.ReactNode, label: string, status?: string, theme?: string }) {
  return (
    <button className={`w-full card-refined flex items-center justify-between p-4 ${theme === 'dark' ? 'bg-white/[0.02]' : 'bg-white/40'}`}>
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-lg ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-100'} flex items-center justify-center text-slate-500 border relative overflow-hidden`}>
           {icon}
           <div className="absolute top-0 right-0 w-3 h-3 bg-white/5 rotate-45" />
        </div>
        <span className={`text-sm font-black ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{label}</span>
      </div>
      {status ? (
        <span className={`text-[8px] font-black ${theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'} bg-emerald-500/10 px-2 py-1 rounded-md border border-emerald-500/20`}>{status}</span>
      ) : (
        <ChevronLeft size={16} className={theme === 'dark' ? 'text-slate-800' : 'text-slate-300'} />
      )}
    </button>
  );
}
