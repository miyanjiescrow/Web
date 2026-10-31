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
  Moon,
  Palette,
  Code2,
  GraduationCap,
  PenTool,
  FileText,
  MessageSquare,
  Users,
  Radio,
  Send,
  PlusCircle,
  Hash,
  Store
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
import { db, auth } from './lib/firebase';
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'firebase/auth';

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}


// --- Types ---
type View = 'auth' | 'dashboard' | 'deals' | 'create' | 'wallet' | 'profile' | 'detail' | 'dispute' | 'chat' | 'marketplace' | 'create-ad';

interface Deal {
  id: string;
  contractId: string;
  title: string;
  amount: number;
  status: 'pending_signatures' | 'active' | 'completed' | 'disputed';
  otherParty: string;
  role: 'buyer' | 'seller';
  category?: string;
  description?: string;
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

interface Ad {
  id: string;
  title: string;
  price: number;
  category: string;
  description: string;
  imageUrl: string;
  sellerId: string;
  sellerName: string;
  createdAt: any;
}


// --- Main App ---
export default function App() {
  const [view, setView] = useState<View>('chat');
  const [isAuthenticated, setIsAuthenticated] = useState(true);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  const [deals, setDeals] = useState<Deal[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [balance, setBalance] = useState(3450000); 
  const [selectedAd, setSelectedAd] = useState<Ad | null>(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem('mianji_theme') as 'light' | 'dark';
    if (savedTheme) {
      setTheme(savedTheme);
    }

    let unsubscribeDeals: () => void = () => {};
    let unsubscribeAds: () => void = () => {};

    const setupListeners = () => {
      // Cleanup previous listeners if any
      unsubscribeDeals();
      unsubscribeAds();

      // Real-time Deals Subscription
      const q = query(collection(db, 'deals'), orderBy('createdAt', 'desc'));
      unsubscribeDeals = onSnapshot(q, (snapshot) => {
        const dealsData = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Deal[];
        setDeals(dealsData);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'deals');
      });

      // Real-time Ads Subscription
      const qAds = query(collection(db, 'ads'), orderBy('createdAt', 'desc'));
      unsubscribeAds = onSnapshot(qAds, (snapshot) => {
        const adsData = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Ad[];
        setAds(adsData);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'ads');
      });
    };

    // Auth state listener
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (user) {
        setIsAuthenticated(true);
        if (view === 'auth') setView('dashboard');
        setupListeners();
      } else {
        // Even if Firebase auth is out, we check local storage for session persistency UX
        // But actual data won't load without Firebase Auth due to rules
        const isAuthFlag = localStorage.getItem('mianji_auth');
        if (isAuthFlag !== 'true') {
          setIsAuthenticated(false);
          setView('auth');
        } else {
          // If we have local flag but no Firebase user, we should try to restore or show login
          // For now, we allow the UI but listeners will stay empty or error (which handleFirestoreError catches)
        }
      }
    });

    return () => {
      unsubscribeAuth();
      unsubscribeDeals();
      unsubscribeAds();
    };
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('mianji_theme', newTheme);
  };

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      localStorage.setItem('mianji_auth', 'true');
      setIsAuthenticated(true);
      setView('dashboard');
    } catch (error) {
      console.error("Login error:", error);
    }
  };

  const handleLogout = async () => {
    try {
      await auth.signOut();
      localStorage.removeItem('mianji_auth');
      setIsAuthenticated(false);
      setView('auth');
    } catch (error) {
      console.error("Logout error:", error);
    }
  };


  return (
    <div className={`min-h-screen ${theme} transition-colors duration-500`} dir="rtl">
      <div className={`min-h-screen ${theme === 'dark' ? 'bg-[#08090a] text-slate-200' : 'bg-white text-slate-900'} selection:bg-blue-500/30 overflow-x-hidden font-sans relative`}>
        
        {/* Mock Status Bar */}
        <div className="fixed top-0 left-0 right-0 h-6 z-[100] flex items-center justify-between px-6 text-[10px] font-bold text-slate-400 pointer-events-none">
           <div className="flex items-center gap-1">
              <span>9:22:02</span>
           </div>
           <div className="flex items-center gap-1.5">
              <Activity size={10} />
              <Radio size={10} />
              <Shield size={10} />
           </div>
        </div>

        {/* Dynamic Background Mesh */}
        <div className="fixed inset-0 bg-mesh pointer-events-none z-0" />

        {/* Main Header - Clean Professional */}
        {isAuthenticated && view !== 'auth' && (
          <header className={`sticky top-0 z-50 ${theme === 'dark' ? 'bg-[#08090a]/80 border-white/5' : 'bg-white/80 border-slate-100'} backdrop-blur-md border-b h-16 flex items-center justify-between px-6`}>
            <div className="flex items-center gap-3">
               <div className={`w-9 h-9 ${theme === 'dark' ? 'bg-blue-600' : 'bg-blue-600'} rounded-lg flex items-center justify-center text-white shadow-sm`}>
                  <Shield size={20} strokeWidth={2.5} />
               </div>
               <div className="flex flex-col">
                  <span className={`font-bold text-lg tracking-tight ${theme === 'dark' ? 'text-white' : 'text-slate-900'} leading-none`}>میانجی</span>
                  <span className={`text-[9px] font-medium ${theme === 'dark' ? 'text-slate-500' : 'text-slate-400'} uppercase tracking-wider`}>Escrow Network</span>
               </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button 
                onClick={toggleTheme} 
                className={`w-10 h-10 rounded-xl ${theme === 'dark' ? 'bg-white/5 border-white/10 text-blue-400' : 'bg-white border-slate-200 text-slate-600 shadow-sm'} border flex items-center justify-center active:scale-90 transition-all`}
              >
                {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
              </button>
              <IconButton icon={<Bell size={20} />} dot theme={theme} />
              <button 
                onClick={() => setView('profile')} 
                className={`w-10 h-10 rounded-xl ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border-slate-200 shadow-sm'} border flex items-center justify-center active:scale-90 transition-all`}
              >
                 <User size={20} className={theme === 'dark' ? 'text-slate-400' : 'text-slate-600'} />
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
            {view === 'chat' && <ChatHubView key="chat" theme={theme} setView={setView} selectedAd={selectedAd} />}
            {view === 'marketplace' && <MarketplaceView key="market" theme={theme} setView={setView} ads={ads} onSelectAd={(ad) => { setSelectedAd(ad); setView('chat'); }} />}
            {view === 'create-ad' && <CreateAdView key="create-ad" theme={theme} onCancel={() => setView('marketplace')} onSuccess={() => setView('marketplace')} />}
          </AnimatePresence>
        </main>


        {/* Navigation Menu - Clean Standard Bottom Bar */}
        {isAuthenticated && view !== 'auth' && (
          <nav className="nav-capsule">
            <NavButton active={view === 'chat'} onClick={() => setView('chat')} icon={<MessageSquare size={22} />} label="گفتگو" theme={theme} />
            <NavButton active={view === 'wallet'} onClick={() => setView('wallet')} icon={<Wallet size={22} />} label="کیف پول" theme={theme} />
            
            <div className="flex flex-col items-center -translate-y-4">
              <button 
                onClick={() => setView('marketplace')}
                className={`w-14 h-14 bg-blue-600 text-white rounded-full flex items-center justify-center active:scale-90 transition-all shadow-xl shadow-blue-600/30 border-[4px] ${theme === 'dark' ? 'border-[#08090a]' : 'border-white'}`}
              >
                <Store size={28} strokeWidth={3} />
              </button>
              <span className={`text-[10px] font-bold mt-1 ${theme === 'dark' ? 'text-slate-500' : 'text-slate-400'}`}>بازارچه</span>
            </div>

            <NavButton active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={22} />} label="معاملات من" theme={theme} />
            <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={22} />} label="خانه" theme={theme} />
          </nav>
        )}
      </div>
    </div>
  );
}

// --- Views ---

function AuthView({ onLogin, theme }: { onLogin: () => void, theme: string }) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const isLight = theme === 'light';
  
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="min-h-[80vh] flex flex-col justify-center p-8 text-center"
    >
      <div className="mb-12">
        <div className="w-16 h-16 bg-blue-600 rounded-2xl mx-auto flex items-center justify-center text-white shadow-lg mb-6">
          <Shield size={32} strokeWidth={2} />
        </div>
        <h1 className={`text-3xl font-bold ${isLight ? 'text-slate-900' : 'text-white'} mb-3 tracking-tight`}>میانجی</h1>
        <p className="text-slate-400 text-[13px] font-medium leading-relaxed">
           سامانه هوشمند واسطه‌گری امن <br/> برای معاملات فریلنسری و پروژه‌ای
        </p>
      </div>

      <motion.div layout className="card-granite p-8 space-y-6 glow-royal">
        <div className="text-right space-y-5 relative z-10">
          <div className="space-y-3">
            <label className="text-[11px] font-bold text-blue-400/80 uppercase tracking-wider block px-1">
              {step === 'phone' ? 'شماره همراه' : 'کد تایید'}
            </label>
            <input 
              type={step === 'phone' ? 'tel' : 'text'}
              placeholder={step === 'phone' ? '0912XXXXXXX' : '----'}
              className="w-full bg-white/5 border border-white/10 rounded-xl h-12 px-6 text-[13px] font-medium outline-none focus:bg-white/10 focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all text-white text-center text-lg font-bold tracking-widest placeholder:tracking-normal placeholder:text-slate-500"
              autoFocus
            />
          </div>
          
          <button onClick={handleLogin} className="btn-primary w-full shadow-lg shadow-blue-600/20">
            <div className="flex items-center gap-3">
              <img src="https://www.gstatic.com/firebase/anonymous-scan.png" className="w-5 h-5 brightness-0 invert" alt="" />
              <span>ورود با حساب گوگل</span>
            </div>
          </button>
        </div>
        
        <div className="relative z-10 text-center">
          {step === 'otp' ? (
            <button onClick={() => setStep('phone')} className="text-[11px] font-bold text-blue-400 hover:text-blue-300 transition-colors">ویرایش شماره همراه</button>
          ) : (
            <p className="text-[10px] text-slate-500 font-medium">با ورود، <span className="text-blue-400">قوانین و مقررات</span> را می‌پذیرم.</p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function DashboardView({ setView, onSelect, deals, balance, theme }: { setView: (v: View) => void, onSelect: (d: Deal) => void, deals: Deal[], balance: number, theme: string }) {
  const activeDeals = deals.filter(d => d.status === 'active' || d.status === 'pending_signatures');
  const isLight = theme === 'light';

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      
      {/* Wallet Balance - Integrated Granite */}
      <div className={`card-granite p-5 flex items-center justify-between glow-royal`}>
        <div className="flex items-center gap-3 relative z-10">
          <div className={`w-11 h-11 bg-blue-600 text-white rounded-xl flex items-center justify-center border border-white/10 shadow-lg`}>
             <Wallet size={20} />
          </div>
          <div className="text-right">
             <span className="text-[11px] font-bold text-blue-400/80 uppercase tracking-wider block">موجودی کیف پول</span>
             <div className="flex items-baseline gap-1.5">
                <span className={`text-xl font-bold tabular-nums tracking-tight text-white`}>{balance.toLocaleString()}</span>
                <span className="text-[10px] font-bold text-slate-400">تومان</span>
             </div>
          </div>
        </div>
        <button onClick={() => setView('wallet')} className="text-[11px] font-bold text-blue-400 hover:text-blue-300 transition-colors relative z-10">مشاهده جزئیات</button>
      </div>

      {/* Required Attention - Granite Alert */}
      <div className={`card-granite p-4 flex items-center justify-between border-l-4 border-l-blue-600`}>
        <div className="flex items-center gap-3 relative z-10">
          <div className={`w-10 h-10 bg-white/10 text-blue-400 rounded-xl flex items-center justify-center border border-white/5 shadow-sm`}>
             <Bell size={20} />
          </div>
          <div className="text-right">
             <h3 className={`text-[13px] font-bold text-white leading-tight`}>اطلاعیه مهم</h3>
             <p className="text-[11px] font-medium text-slate-400">نیاز به احراز هویت برای ادامه فعالیت...</p>
          </div>
        </div>
        <button className="text-[11px] font-bold text-blue-400 hover:text-blue-300 relative z-10">مشاهده</button>
      </div>

      {/* Grid Menu System - High Density */}
      <div className="grid grid-cols-5 gap-2 px-0.5">
         <IconAction icon={<LayoutGrid size={24} />} label="راهنما" color="text-orange-600" bg="bg-orange-50/50" theme={theme} />
         <IconAction icon={<ScanLine size={24} />} label="اسکنر QR" color="text-blue-600" bg="bg-blue-50/50" theme={theme} />
         <IconAction icon={<Wallet size={24} />} label="کیف پول" color="text-emerald-600" bg="bg-emerald-50/50" onClick={() => setView('wallet')} theme={theme} />
         <IconAction icon={<ClipboardList size={24} />} label="معاملات" color="text-slate-900" bg="bg-slate-100/50" onClick={() => setView('deals')} theme={theme} />
         <IconAction icon={<Store size={24} />} label="بازارچه" color="text-blue-700" bg="bg-blue-100/50" onClick={() => setView('marketplace')} theme={theme} />
      </div>

      {/* Active Deals List */}
      <div className="space-y-4 pt-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
             <div className="w-2 h-2 bg-emerald-500 rounded-full" />
             <h2 className={`text-[13px] font-bold ${isLight ? 'text-slate-900' : 'text-white'} tracking-tight`}>معاملات فعال</h2>
          </div>
          <button onClick={() => setView('deals')} className={`text-[11px] font-bold text-slate-400 hover:text-blue-600 transition-colors`}>مشاهده همه</button>
        </div>
        
        <div className="space-y-2">
          {activeDeals.length > 0 ? activeDeals.map(deal => (
            <motion.button 
              whileTap={{ scale: 0.98 }}
              key={deal.id}
              onClick={() => onSelect(deal)}
              className="w-full card-granite p-3.5 flex items-center justify-between text-right relative group hover:border-blue-500/30"
            >
              <div className="flex items-center gap-3.5 min-w-0 relative z-10">
                <div className={`w-11 h-11 shrink-0 rounded-2xl flex items-center justify-center border ${deal.role === 'seller' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-blue-500/10 text-blue-400 border-blue-500/20'}`}>
                  {deal.role === 'seller' ? <TrendingUp size={20} /> : <Briefcase size={20} />}
                </div>
                <div className="min-w-0 space-y-0.5">
                  <h3 className={`text-[12px] font-black text-white truncate leading-tight`}>{deal.title}</h3>
                  <div className="flex items-center gap-1.5">
                     <span className={`text-[7px] font-black uppercase px-1.5 py-0.5 rounded-md ${deal.role === 'seller' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/10 text-blue-400'}`}>{deal.role === 'seller' ? 'مجری' : 'کارفرما'}</span>
                     <span className="text-[8px] font-bold text-slate-500">{deal.otherParty}</span>
                  </div>
                </div>
              </div>
              <div className="text-left shrink-0 space-y-0.5 relative z-10">
                <div className={`text-[13px] font-black tabular-nums text-white leading-none`}>{deal.amount.toLocaleString()}</div>
                <StatusLabel status={deal.status} />
              </div>
            </motion.button>
          )) : (
            <div className="card-refined p-8 text-center text-slate-500 space-y-3">
               <Layers size={32} className="mx-auto opacity-20" />
               <p className="text-[11px] font-bold">معامله فعالی یافت نشد</p>
               <button onClick={() => setView('create')} className="text-blue-500 text-[10px] font-black uppercase tracking-[0.2em] hover:opacity-80 transition-opacity">ایجاد معامله جدید</button>
            </div>
          )}
        </div>
      </div>

      {/* Marketplace Hub Shortcut */}
      <div className="card-granite p-5 glow-royal space-y-4">
        <div className="flex items-center justify-between relative z-10">
          <div className="flex items-center gap-2">
            <Gem size={20} className="text-blue-400" />
            <h2 className="text-[13px] font-black text-white">بازارچه میانجی (دیوار و فریلنسر امن)</h2>
          </div>
          <button onClick={() => setView('marketplace')} className="text-[10px] font-bold text-blue-400 hover:text-blue-300 transition-colors">مشاهده همه</button>
        </div>
        
        <div className="grid grid-cols-2 gap-3 relative z-10">
           <button onClick={() => setView('marketplace')} className="flex flex-col items-center gap-2 p-3 bg-white/5 rounded-xl border border-white/5 hover:bg-white/10 transition-all">
              <Briefcase size={20} className="text-emerald-400" />
              <span className="text-[10px] font-bold text-slate-300">خدمات فریلنسری</span>
           </button>
           <button onClick={() => setView('marketplace')} className="flex flex-col items-center gap-2 p-3 bg-white/5 rounded-xl border border-white/5 hover:bg-white/10 transition-all">
              <Cpu size={20} className="text-blue-400" />
              <span className="text-[10px] font-bold text-slate-300">کالای دیجیتال</span>
           </button>
        </div>

        <button 
          onClick={() => setView('create-ad')}
          className="w-full h-11 bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 border border-blue-500/20 rounded-xl text-[11px] font-black uppercase tracking-wider flex items-center justify-center gap-2 relative z-10 transition-all"
        >
          <PlusCircle size={18} />
          ثبت آگهی جدید
        </button>
      </div>

      {/* Trust Status - More Geometric */}
      <div className="card-refined p-4 relative overflow-hidden">
         <div className="absolute top-0 left-0 w-full h-full bg-blue-500/5 skew-x-12 translate-x-24" />
         <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-3">
               <div className={`w-9 h-9 ${isLight ? 'bg-blue-600 text-white shadow-lg' : 'bg-blue-500/10 text-blue-400'} rounded-full flex items-center justify-center shadow-inner`}>
                  <Shield size={18} />
               </div>
               <div className="flex flex-col text-right">
                 <span className={`text-[11px] font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>احراز هویت سطح ۲</span>
                 <span className="text-[8px] font-bold text-slate-500">حساب نقره‌ای فعال</span>
               </div>
            </div>
            <button className="h-9 px-5 gold-gradient rounded-full text-[10px] font-black text-blue-950 uppercase shadow-lg shadow-amber-500/20 transition-all active:scale-95">ارتقا حساب</button>
         </div>
      </div>
    </motion.div>
  );
}


// --- Component Library ---

function IconButton({ icon, dot, theme }: { icon: React.ReactNode, dot?: boolean, theme?: string }) {
  return (
    <button className={`w-8 h-8 flex items-center justify-center rounded-lg ${theme === 'dark' ? 'bg-white/5 text-slate-400 border-white/10' : 'bg-white text-slate-600 border-slate-200'} border relative active:scale-90 transition-all`}>
      {icon}
      {dot && (
        <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-rose-500 rounded-full border border-[#08090a]" />
      )}
    </button>
  );
}

function IconAction({ icon, label, onClick, theme }: { icon: React.ReactNode, label: string, color?: string, bg?: string, onClick?: () => void, theme?: string }) {
  const isLight = theme === 'light';
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 group active:scale-95 transition-all w-full">
      <div className={`w-full aspect-square ${isLight ? 'bg-white border-slate-100 shadow-sm' : 'bg-white/[0.03] border-white/5'} rounded-2xl flex items-center justify-center transition-all group-hover:border-blue-500/30 group-hover:shadow-lg group-hover:shadow-blue-500/5`}>
        <div className={`text-slate-400 group-hover:text-blue-500 transition-colors`}>
          {icon}
        </div>
      </div>
      <span className={`text-[11px] font-bold ${isLight ? 'text-slate-500' : 'text-slate-400'} group-hover:text-blue-500 transition-colors`}>{label}</span>
    </button>
  );
}

function NavButton({ active, onClick, icon, label, theme }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string, theme: string }) {
  const isLight = theme === 'light';
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 transition-all px-4 py-2 rounded-xl ${active ? (isLight ? 'text-blue-600 bg-blue-50' : 'text-blue-400 bg-white/5') : theme === 'dark' ? 'text-slate-500' : 'text-slate-400'}`}>
      {icon}
      <span className="text-[10px] font-bold tracking-tight">{label}</span>
    </button>
  );
}

function StatusLabel({ status }: { status: Deal['status'] }) {
  const configs = {
    pending_signatures: { label: 'در انتظار امضا', color: 'text-amber-500', bg: 'bg-amber-500/10' },
    active: { label: 'درحال اجرا', color: 'text-blue-500', bg: 'bg-blue-500/10' },
    completed: { label: 'تکمیل شده', color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    disputed: { label: 'اختلاف', color: 'text-rose-500', bg: 'bg-rose-500/10' },
  };
  const config = configs[status];
  return (
    <div className={`px-2 py-0.5 rounded-md ${config.bg} ${config.color} text-[9px] font-bold inline-flex items-center`}>
      {config.label}
    </div>
  );
}

// --- Views ---

function DealsView({ deals, onSelect, theme }: { deals: Deal[], onSelect: (d: Deal) => void, theme: string }) {
  const [filter, setFilter] = useState<'all' | 'active' | 'archive'>('all');

  const filteredDeals = deals.filter(deal => {
    if (filter === 'all') return true;
    if (filter === 'active') return deal.status === 'active' || deal.status === 'pending_signatures';
    if (filter === 'archive') return deal.status === 'completed' || deal.status === 'disputed';
    return true;
  });

  const isLight = theme === 'light';

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      <div className="flex items-center justify-between px-1">
         <h1 className={`text-xl font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tighter`}>معاملات</h1>
         <IconButton icon={<Filter size={14} />} theme={theme} />
      </div>
      
      <div className={`flex p-1 ${isLight ? 'bg-slate-50' : 'bg-white/5'} rounded-xl`}>
        {(['all', 'active', 'archive'] as const).map((t) => (
          <button 
            key={t}
            onClick={() => setFilter(t)}
            className={`flex-1 h-9 rounded-lg text-[11px] font-bold transition-all ${filter === t ? (isLight ? 'bg-white text-blue-600 shadow-sm' : 'bg-white/10 text-white') : 'text-slate-400 hover:text-slate-600'}`}
          >
            {t === 'all' ? 'همه' : t === 'active' ? 'جاری' : 'بایگانی'}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        {filteredDeals.length > 0 ? filteredDeals.map(deal => (
          <button 
            key={deal.id}
            onClick={() => onSelect(deal)}
            className="w-full card-refined p-2.5 flex items-center justify-between text-right"
          >
             <div className="flex items-center gap-2.5">
                <div className={`w-9 h-9 ${isLight ? 'bg-white border-slate-100 text-slate-400' : 'bg-white/5 border-white/5 text-slate-500'} rounded-lg flex items-center justify-center border`}>
                   <Target size={16} />
                </div>
                <div className="space-y-0">
                   <h3 className={`text-[11px] font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>{deal.title}</h3>
                   <span className="text-[7px] font-bold text-slate-500 block uppercase">{deal.contractId}</span>
                </div>
             </div>
             <div className="text-left space-y-0">
                <div className={`text-[11px] font-black tabular-nums ${isLight ? 'text-slate-900' : 'text-white'} leading-none`}>{deal.amount.toLocaleString()}</div>
                <StatusLabel status={deal.status} />
             </div>
          </button>
        )) : (
          <div className="py-12 text-center space-y-3 opacity-40">
            <Layers size={32} className="mx-auto" />
            <p className="text-[10px] font-bold">معامله‌ای یافت نشد</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function WalletView({ setView, balance, theme }: { setView: (v: View) => void, balance: number, theme: string }) {
  const isLight = theme === 'light';
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
      <h1 className={`text-xl font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tighter`}>کیف پول</h1>

      <div className={`${isLight ? 'bg-white border-slate-100' : 'bg-white/5 border-white/5'} border rounded-[2rem] p-8 text-center space-y-5 shadow-sm`}>
         <div className="space-y-1.5">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">موجودی قابل برداشت (تومان)</span>
            <div className={`text-4xl font-bold tabular-nums tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>{balance.toLocaleString()}</div>
         </div>
         <div className="flex gap-3 pt-2">
            <button className="btn-primary flex-1">واریز وجه</button>
            <button className="btn-secondary flex-1">برداشت</button>
         </div>
      </div>

      <div className="space-y-2">
         <div className="flex items-center justify-between px-1">
           <h3 className="text-[8px] font-black text-slate-500 uppercase tracking-widest">آخرین تراکنش‌ها</h3>
           <IconButton icon={<History size={12} />} theme={theme} />
         </div>
         <div className={`card-refined p-0 divide-y ${isLight ? 'divide-slate-50' : 'divide-white/5'}`}>
            {[1, 2, 3].map(i => (
               <div key={i} className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                     <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${i % 2 === 0 ? (isLight ? 'bg-emerald-50 text-emerald-600' : 'bg-emerald-500/10 text-emerald-500') : (isLight ? 'bg-rose-50 text-rose-600' : 'bg-rose-500/10 text-rose-500')}`}>
                        {i % 2 === 0 ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                     </div>
                     <div className="space-y-0.5">
                        <span className={`text-[13px] font-bold block ${isLight ? 'text-slate-900' : 'text-white'}`}>{i % 2 === 0 ? 'واریز به حساب' : 'برداشت از حساب'}</span>
                        <span className="text-[11px] font-medium text-slate-400">۱۰ آبان - ۱۴:۲۰</span>
                     </div>
                  </div>
                  <span className={`text-[14px] font-bold tabular-nums ${i % 2 === 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
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
  const [step, setStep] = useState<'category' | 'role' | 'form'>('category');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    amount: '',
    duration: '7',
    description: '',
    otherParty: 'طرف دوم',
    category: '',
    role: 'seller' as 'buyer' | 'seller'
  });

  const categories = [
    { id: 'design', icon: <Palette size={22} />, title: 'طراحی و گرافیک', desc: 'طراحی لوگو، بنر، هویت بصری، UI/UX' },
    { id: 'it', icon: <Code2 size={22} />, title: 'برنامه‌نویسی و IT', desc: 'کدنویسی وبسایت، اپلیکیشن، ربات تلگرام، اسکریپت' },
    { id: 'student', icon: <GraduationCap size={22} />, title: 'خدمات دانشجویی', desc: 'ترجمه، ویراستاری، مقاله‌نویسی، پروژه‌های آکادمیک' },
    { id: 'content', icon: <PenTool size={22} />, title: 'تولید محتوا و سئو', desc: 'نگارش مقالات وبلاگ، سناریونویسی، استراتژی سئو' },
    { id: 'other', icon: <FileText size={22} />, title: 'سایر خدمات دیجیتال', desc: 'خدمات متفرقه و سایر پروژه‌ها' },
  ];

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
        createdAt: serverTimestamp(),
      });
      onSuccess();
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'deals');
    } finally {
      setLoading(false);
    }
  };

  const isLight = theme === 'light';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-10">
      {/* Creation Header & Progress */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
           <button onClick={step === 'category' ? onCancel : () => setStep(step === 'form' ? 'role' : 'category')} className={`w-9 h-9 flex items-center justify-center rounded-xl ${isLight ? 'bg-white border-slate-200' : 'bg-white/5 border-white/10'} border text-slate-500`}>
             <ChevronRight size={20} />
           </button>
           <h1 className={`text-base font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tighter`}>ایجاد معامله جدید</h1>
           <div className="w-9" />
        </div>
        
        {/* Progress Bar */}
        <div className="flex gap-2 px-1">
           <div className={`progress-step ${step === 'category' || step === 'role' || step === 'form' ? 'progress-step-active' : ''}`} />
           <div className={`progress-step ${step === 'role' || step === 'form' ? 'progress-step-active' : ''}`} />
           <div className={`progress-step ${step === 'form' ? 'progress-step-active' : ''}`} />
        </div>
      </div>

      <AnimatePresence mode="wait">
        {step === 'category' && (
          <motion.div 
            key="step-cat"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="space-y-4"
          >
            <div className="text-center space-y-2 mb-6">
               <h2 className={`text-xl font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tight`}>دسته‌بندی خدمت فریلنسری را مشخص کنید:</h2>
               <p className="text-[11px] text-slate-500 font-medium leading-relaxed max-w-[280px] mx-auto">قوانین و تعهدات حقوقی پیش‌فرض بر مبنای نوع دسته‌بندی الحاق می‌شود.</p>
            </div>
            
            <div className="grid gap-3">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => { setFormData({...formData, category: cat.id}); setStep('role'); }}
                  className="w-full text-right p-4 rounded-2xl card-selectable flex items-center gap-4 group"
                >
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-blue-600 shrink-0 ${isLight ? 'bg-slate-50' : 'bg-white/5'}`}>
                    {cat.icon}
                  </div>
                  <div className="flex-1">
                    <h3 className={`text-[14px] font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>{cat.title}</h3>
                    <p className="text-[11px] text-slate-400 font-medium leading-tight">{cat.desc}</p>
                  </div>
                  <ChevronLeft size={16} className="text-slate-300 group-hover:text-blue-600 transition-colors" />
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {step === 'role' && (
          <motion.div 
            key="step-role"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="space-y-6"
          >
             <div className="text-center space-y-2 mb-4">
               <h2 className={`text-xl font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tight`}>نقش خود را در این معامله مشخص کنید:</h2>
               <p className="text-[11px] text-slate-500 font-medium leading-relaxed max-w-[280px] mx-auto">طرف اول قرارداد می‌تواند کارفرما (خریدار) یا مجری (فروشنده) باشد.</p>
            </div>

            <div className="grid gap-4">
              <button
                onClick={() => { setFormData({...formData, role: 'buyer'}); setStep('form'); }}
                className="text-right p-6 rounded-2xl card-selectable group relative"
              >
                <div className="flex items-start justify-between mb-4">
                   <div className={`w-12 h-12 bg-blue-50 dark:bg-blue-600/10 text-blue-600 rounded-xl flex items-center justify-center shadow-sm`}>
                      <Briefcase size={24} />
                   </div>
                   <div className={`w-6 h-6 rounded-full border-2 ${isLight ? 'border-slate-100' : 'border-slate-800'} flex items-center justify-center group-hover:border-blue-600 transition-all`}>
                      <div className="w-2.5 h-2.5 bg-blue-600 rounded-full scale-0 group-hover:scale-100 transition-transform" />
                   </div>
                </div>
                <h3 className={`text-lg font-bold mb-1 ${isLight ? 'text-slate-900' : 'text-white'}`}>کارفرما (خریدار خدمت)</h3>
                <p className="text-[12px] text-slate-500 leading-relaxed">قصد سفارش کار، پرداخت امن وجه به صندوق امانت و دریافت پروژه را دارم.</p>
              </button>

              <button
                onClick={() => { setFormData({...formData, role: 'seller'}); setStep('form'); }}
                className="text-right p-6 rounded-2xl card-selectable group relative"
              >
                <div className="flex items-start justify-between mb-4">
                   <div className={`w-12 h-12 bg-emerald-50 dark:bg-emerald-600/10 text-emerald-600 rounded-xl flex items-center justify-center shadow-sm`}>
                      <Settings size={24} />
                   </div>
                   <div className={`w-6 h-6 rounded-full border-2 ${isLight ? 'border-slate-100' : 'border-slate-800'} flex items-center justify-center group-hover:border-emerald-500 transition-all`}>
                      <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full scale-0 group-hover:scale-100 transition-transform" />
                   </div>
                </div>
                <h3 className={`text-lg font-bold mb-1 ${isLight ? 'text-slate-900' : 'text-white'}`}>مجری (فروشنده / پیمانکار)</h3>
                <p className="text-[12px] text-slate-500 leading-relaxed">فایل‌ها و خدمات را آماده و پس از تایید تحویل، دستمزد را دریافت می‌کنم.</p>
              </button>
            </div>
          </motion.div>
        )}

        {step === 'form' && (
          <motion.div 
            key="step-form"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="space-y-4"
          >
            <div className="text-center space-y-1 mb-4">
               <h2 className={`text-lg font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>جزئیات معامله</h2>
               <p className="text-[10px] text-slate-500 font-medium">اطلاعات نهایی پروژه را با دقت وارد کنید.</p>
            </div>

            <div className="card-refined p-5 space-y-4">
              <div className="space-y-4 text-right">
                <div className="space-y-2">
                    <label className="label-refined">عنوان قرارداد</label>
                    <input 
                      type="text" 
                      className="input-refined" 
                      placeholder="مثلا: طراحی قالب اختصاصی وبسایت" 
                      value={formData.title}
                      onChange={e => setFormData({ ...formData, title: e.target.value })}
                    />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="label-refined">مبلغ (تومان)</label>
                      <input 
                        type="number" 
                        className="input-refined" 
                        placeholder="0" 
                        value={formData.amount}
                        onChange={e => setFormData({ ...formData, amount: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
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
                <div className="space-y-2">
                    <label className="label-refined">توضیحات اختصاصی</label>
                    <textarea 
                      className="input-refined h-28 py-4 px-6 rounded-3xl resize-none leading-relaxed" 
                      placeholder="تمام جزئیاتی که باید در داوری لحاظ شود را بنویسید..." 
                      value={formData.description}
                      onChange={e => setFormData({ ...formData, description: e.target.value })}
                    />
                </div>
              </div>
              
              <div className="pt-2">
                <button 
                  onClick={handleSubmit}
                  disabled={loading || !formData.title || !formData.amount}
                  className="btn-primary w-full h-12 text-xs shadow-xl shadow-blue-600/20"
                >
                  {loading ? (
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      در حال ثبت...
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                       تایید و ایجاد معامله امن
                       <ChevronLeft size={16} />
                    </div>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}


function DealDetailView({ deal, onBack, onDispute, theme }: { deal: Deal, onBack: () => void, onDispute: () => void, theme: string }) {
  return (
    <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="space-y-5 pb-4">
      <button onClick={onBack} className="flex items-center gap-1 text-slate-500 text-[9px] font-black uppercase tracking-widest px-1">
        <ChevronLeft size={12} className="rotate-180" /> بازگشت
      </button>

      <div className="card-granite p-8 space-y-8 glow-royal">
        <div className="flex justify-between items-start relative z-10">
           <div className="space-y-2">
              <span className="text-[11px] font-bold text-blue-400 uppercase tracking-wider">{deal.contractId}</span>
              <h1 className={`text-2xl font-bold leading-tight text-white`}>{deal.title}</h1>
              <div className="flex items-center gap-3 pt-1">
                 <div className={`w-8 h-8 rounded-full bg-white/5 flex items-center justify-center`}>
                    <User size={14} className="text-slate-400" />
                 </div>
                 <span className={`text-[13px] font-bold text-slate-300`}>{deal.otherParty}</span>
              </div>
           </div>
           <StatusLabel status={deal.status} />
        </div>

        <div className="grid grid-cols-2 gap-4 relative z-10">
           <div className={`p-5 rounded-2xl bg-white/5 border border-white/5 space-y-1`}>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">بودجه معامله</span>
              <div className={`text-lg font-bold text-white tabular-nums`}>{deal.amount.toLocaleString()} <span className="text-[10px] text-slate-400">Toman</span></div>
           </div>
           <div className={`p-5 rounded-2xl bg-white/5 border border-white/5 space-y-1`}>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">زمان باقیمانده</span>
              <div className={`text-lg font-bold text-white tabular-nums`}>۱۴ روز</div>
           </div>
        </div>

        <div className={`p-6 rounded-2xl border border-white/5 bg-white/[0.02] space-y-4 relative z-10`}>
           <div className="flex items-center justify-between">
              <span className={`text-[11px] font-bold text-slate-400 uppercase tracking-wider`}>لینک اختصاصی معامله</span>
              <QrCode size={18} className="text-blue-400" />
           </div>
           <div className="flex gap-2">
              <div className={`flex-1 bg-black/20 border border-white/5 rounded-xl px-4 py-2.5 text-left text-[11px] font-mono text-blue-400/80 overflow-hidden truncate`}>
                mianji.ir/v/{deal.contractId}
              </div>
              <button className="w-11 h-11 bg-blue-600 text-white rounded-xl flex items-center justify-center shadow-sm shrink-0 active:scale-95 transition-all">
                <Copy size={18} />
              </button>
           </div>
           <button className={`w-full h-11 bg-white/5 text-white border border-white/5 rounded-xl text-[12px] font-bold flex items-center justify-center gap-2 shadow-sm active:scale-95 transition-all`}>
              <ScanLine size={18} className="text-blue-400" /> مشاهده کد QR
           </button>
        </div>

        <div className="flex flex-col gap-3 pt-2 relative z-10">
           <button className="btn-primary w-full h-12 shadow-lg shadow-blue-600/20"><MessageCircle size={18} /> گفتگو با طرف مقابل</button>
           <button onClick={onDispute} className="h-10 w-full text-rose-400 text-[11px] font-bold hover:bg-rose-500/5 rounded-xl transition-all">گزارش تخلف یا داوری</button>
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
             قرارداد <span className={`font-black ${theme === 'dark' ? 'text-white' : 'text-blue-600'}`}>{deal.contractId}</span> در نوبت بررسی قرار گرفت.
          </p>
       </div>
       <div className={`card-refined p-4 ${theme === 'dark' ? 'bg-rose-500/5 border-rose-500/10 text-rose-200' : 'bg-rose-50 border-rose-100 text-rose-600'}`}>
          <span className="text-[10px] font-bold">تا زمان صدور رای، موجودی معامله مسدود خواهد بود.</span>
       </div>
       <button onClick={onBack} className={`btn-primary w-full ${theme === 'dark' ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-900'} h-10 text-xs shadow-none`}>بازگشت</button>
    </motion.div>
  );
}

function ProfileView({ onLogout, theme }: { onLogout: () => void, theme: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 pt-2">
      <div className="text-center space-y-5">
        <div className={`w-24 h-24 rounded-full mx-auto flex items-center justify-center relative overflow-hidden border ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-100'}`}>
          <User className={theme === 'dark' ? 'text-slate-700' : 'text-slate-300'} size={48} />
        </div>
        <div className="space-y-1">
          <h2 className={`text-2xl font-bold tracking-tight ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>سید محمد حسینی</h2>
          <div className="flex items-center justify-center gap-1.5">
             <CheckCircle2 size={14} className="text-emerald-500" />
             <span className="text-[11px] font-bold text-blue-600 uppercase tracking-widest">تایید شده</span>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        <MenuBtn icon={<Shield size={16} />} label="امنیت و تایید هویت" status="تایید شده" />
        <MenuBtn icon={<CreditCard size={16} />} label="حساب‌های بانکی" />
        <MenuBtn icon={<Settings size={16} />} label="تنظیمات پلتفرم" />
        
        <div className="pt-4 space-y-3">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2 text-right">تنظیمات گفتگو</h3>
          <div className="card-refined p-2 space-y-1">
            {[
              { label: 'ایجاد معامله از داخل چت', icon: <PlusCircle size={18} />, active: true },
              { label: 'نمایش وضعیت آنلاین', icon: <Activity size={18} />, active: true },
              { label: 'اعلان‌های پیام جدید', icon: <Bell size={18} />, active: true },
              { label: 'ذخیره خودکار رسانه', icon: <Copy size={18} />, active: false },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-white/5 rounded-xl transition-all cursor-pointer">
                <div className="flex items-center gap-3">
                  <div className="text-slate-400">{item.icon}</div>
                  <span className={`text-[12px] font-bold ${theme === 'light' ? 'text-slate-900' : 'text-slate-300'}`}>{item.label}</span>
                </div>
                <div className={`w-10 h-5 rounded-full p-1 transition-all ${item.active ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'}`}>
                   <div className={`w-3 h-3 bg-white rounded-full transition-all ${item.active ? 'translate-x-0' : 'translate-x-5'}`} />
                </div>
              </div>
            ))}
          </div>
        </div>

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

function MenuBtn({ icon, label, status, theme, onClick }: { icon: React.ReactNode, label: string, status?: string, theme?: string, onClick?: () => void }) {
  const isLight = theme === 'light';
  return (
    <button onClick={onClick} className={`w-full card-refined flex items-center justify-between p-5 ${theme === 'dark' ? 'bg-white/[0.02]' : 'bg-white shadow-sm hover:shadow-md'}`}>
      <div className="flex items-center gap-4">
        <div className={`w-10 h-10 rounded-xl ${theme === 'dark' ? 'bg-white/5 text-slate-400' : 'bg-slate-50 text-slate-500'} flex items-center justify-center border border-transparent`}>
           {icon}
        </div>
        <span className={`text-[14px] font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{label}</span>
      </div>
      {status ? (
        <span className={`text-[10px] font-bold ${theme === 'dark' ? 'text-emerald-400' : 'text-emerald-600'} bg-emerald-500/10 px-2 py-1 rounded-lg`}>{status}</span>
      ) : (
        <ChevronLeft size={16} className="text-slate-300" />
      )}
    </button>
  );
}

// --- Marketplace Views ---

function MarketplaceView({ theme, ads, setView, onSelectAd }: { theme: string, ads: Ad[], setView: (v: View) => void, onSelectAd: (ad: Ad) => void }) {
  const [filter, setFilter] = useState<'all' | 'freelance' | 'digital'>('all');
  const isLight = theme === 'light';

  const filteredAds = ads.filter(ad => {
    if (filter === 'all') return true;
    return ad.category === filter;
  });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex items-center justify-between px-1">
         <h1 className={`text-xl font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tighter`}>بازارچه میانجی</h1>
         <IconButton icon={<Filter size={16} />} theme={theme} />
      </div>

      {/* Search Bar */}
      <div className="relative">
        <div className={`absolute inset-y-0 right-4 flex items-center pointer-events-none ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
          <Search size={18} />
        </div>
        <input 
          type="text" 
          placeholder="جستجو در خدمات، پروژه‌ها و کالاها..." 
          className="w-full bg-white dark:bg-[#121418] border border-slate-100 dark:border-white/5 rounded-2xl h-14 pr-12 pl-4 text-[13px] font-medium outline-none focus:ring-4 focus:ring-blue-500/5 focus:border-blue-500 transition-all text-slate-900 dark:text-white placeholder:text-slate-400 shadow-sm"
        />
      </div>

      {/* Filter Chips */}
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
        {[
          { id: 'all', label: 'همه' },
          { id: 'freelance', label: 'فریلنسری' },
          { id: 'digital', label: 'کالا' },
          { id: 'negotiable', label: 'قیمت توافقی' },
        ].map((chip) => (
          <button
            key={chip.id}
            onClick={() => setFilter(chip.id as any)}
            className={`whitespace-nowrap px-5 py-2.5 rounded-full text-[11px] font-bold transition-all border ${filter === chip.id ? 'bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-600/20' : isLight ? 'bg-white text-slate-500 border-slate-200' : 'bg-white/5 text-slate-400 border-white/5'}`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Ad Grid */}
      <div className="grid grid-cols-2 gap-4">
        {filteredAds.map((ad) => (
          <motion.div 
            key={ad.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="card-granite overflow-hidden flex flex-col group"
          >
            <div className="aspect-[4/3] relative overflow-hidden">
               <img src={ad.imageUrl} alt={ad.title} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
               <div className="absolute top-2 left-2">
                  <div className="bg-emerald-500 text-white text-[7px] font-black px-1.5 py-0.5 rounded flex items-center gap-1 shadow-lg">
                    <Shield size={8} />
                    واسطه امن
                  </div>
               </div>
            </div>
            <div className="p-3 space-y-2 flex-1 flex flex-col relative z-10">
               <h3 className="text-[11px] font-bold text-white line-clamp-1">{ad.title}</h3>
               <div className="flex items-center justify-between">
                  <div className="text-[12px] font-black text-blue-400 tabular-nums">{ad.price.toLocaleString()} <span className="text-[8px] opacity-60">تومان</span></div>
               </div>
               <div className="pt-2 mt-auto flex gap-2">
                  <button onClick={() => onSelectAd(ad)} className="flex-1 h-8 bg-white/5 hover:bg-white/10 rounded-lg flex items-center justify-center text-slate-300 text-[10px] font-bold transition-all">
                    گفتگو
                  </button>
                  <button className="flex-1 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center text-[10px] font-bold transition-all shadow-lg shadow-blue-600/20">
                    ثبت معامله امن
                  </button>
               </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Empty State */}
      {filteredAds.length === 0 && (
        <div className="py-20 text-center space-y-4 opacity-30">
          <Layers size={48} className="mx-auto" />
          <p className="text-[12px] font-bold text-slate-500">آگهی یافت نشد</p>
        </div>
      )}

      {/* FAB */}
      <motion.button 
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setView('create-ad')}
        className="fixed bottom-24 left-6 z-50 h-14 px-6 bg-emerald-600 text-white rounded-full flex items-center gap-3 shadow-xl shadow-emerald-600/30"
      >
        <Plus size={20} />
        <span className="text-[12px] font-bold">ثبت آگهی</span>
      </motion.button>
    </motion.div>
  );
}

function CreateAdView({ theme, onCancel, onSuccess }: { theme: string, onCancel: () => void, onSuccess: () => void }) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    price: '',
    category: 'freelance',
    description: '',
  });

  const handleSubmit = async () => {
    if (!formData.title || !formData.price) return;
    setLoading(true);
    try {
      // Pick a random image for now based on category
      const images = {
        freelance: '/src/assets/images/freelance_service_setup_1793474039406.jpg',
        digital: '/src/assets/images/digital_gadget_showcase_1793474038881.jpg',
        other: '/src/assets/images/creative_design_work_1793474039218.jpg'
      };

      await addDoc(collection(db, 'ads'), {
        ...formData,
        price: Number(formData.price),
        imageUrl: images[formData.category as keyof typeof images] || images.other,
        sellerId: auth.currentUser?.uid || 'anonymous',
        sellerName: 'سید محمد حسینی',
        createdAt: serverTimestamp(),
      });
      onSuccess();
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'ads');
    } finally {
      setLoading(false);
    }
  };

  const isLight = theme === 'light';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-10">
      <div className="flex items-center justify-between">
         <button onClick={onCancel} className={`w-9 h-9 flex items-center justify-center rounded-xl ${isLight ? 'bg-white border-slate-200' : 'bg-white/5 border-white/10'} border text-slate-500`}>
           <ChevronRight size={20} />
         </button>
         <h1 className={`text-base font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tighter`}>ثبت آگهی جدید</h1>
         <div className="w-9" />
      </div>

      <div className="card-refined p-5 space-y-4">
        <div className="space-y-4 text-right">
          <div className="space-y-2">
              <label className="label-refined">عنوان آگهی</label>
              <input 
                type="text" 
                className="input-refined" 
                placeholder="مثلا: طراحی سایت با وردپرس" 
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
              />
          </div>
          <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="label-refined">قیمت (تومان)</label>
                <input 
                  type="number" 
                  className="input-refined" 
                  placeholder="0" 
                  value={formData.price}
                  onChange={e => setFormData({ ...formData, price: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <label className="label-refined">دسته‌بندی</label>
                <select 
                  className="input-refined appearance-none" 
                  value={formData.category}
                  onChange={e => setFormData({ ...formData, category: e.target.value })}
                >
                  <option value="freelance">خدمات فریلنسری</option>
                  <option value="digital">کالای دیجیتال</option>
                  <option value="other">سایر</option>
                </select>
              </div>
          </div>
          <div className="space-y-2">
              <label className="label-refined">توضیحات</label>
              <textarea 
                className="input-refined h-32 py-4 px-6 rounded-3xl resize-none leading-relaxed" 
                placeholder="جزئیات محصول یا خدمت خود را بنویسید..." 
                value={formData.description}
                onChange={e => setFormData({ ...formData, description: e.target.value })}
              />
          </div>
        </div>
        
        <button 
          onClick={handleSubmit}
          disabled={loading || !formData.title || !formData.price}
          className="btn-primary w-full h-12 text-xs shadow-xl shadow-blue-600/20"
        >
          {loading ? 'در حال ثبت...' : 'انتشار آگهی در بازارچه'}
        </button>
      </div>
    </motion.div>
  );
}

// --- Chat Hub View ---

function ChatHubView({ theme, selectedAd }: { theme: string, setView: (v: View) => void, selectedAd?: Ad | null }) {
  const [activeTab, setActiveTab] = useState<'contacts' | 'channels' | 'groups'>('contacts');
  const isLight = theme === 'light';

  const tabs = [
    { id: 'contacts', label: 'مخاطبین' },
    { id: 'channels', label: 'کانال ها' },
    { id: 'groups', label: 'گروه' }
  ];

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="space-y-6 pb-20"
    >
      {/* Product Context inside Chat if selected */}
      {selectedAd && (
        <div className="card-granite p-3 flex items-center gap-3 glow-royal mb-2 relative z-10 overflow-hidden">
           <div className="w-12 h-12 rounded-lg overflow-hidden border border-white/10 shrink-0">
              <img src={selectedAd.imageUrl} alt="" className="w-full h-full object-cover" />
           </div>
           <div className="flex-1 min-w-0">
              <h4 className="text-[11px] font-bold text-white truncate">{selectedAd.title}</h4>
              <div className="text-[10px] text-blue-400 font-black tabular-nums">{selectedAd.price.toLocaleString()} تومان</div>
           </div>
           <button className="h-8 px-4 bg-blue-600 text-white rounded-lg text-[9px] font-black uppercase">ثبت معامله</button>
        </div>
      )}

      {/* Search Bar */}
      <div className="relative">
        <div className={`absolute inset-y-0 right-4 flex items-center pointer-events-none ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
          <Search size={18} />
        </div>
        <input 
          type="text" 
          placeholder="جستجوی مخاطبین، کانال ها، گروه" 
          className="w-full bg-white dark:bg-[#121418] border border-slate-100 dark:border-white/5 rounded-2xl h-14 pr-12 pl-4 text-[13px] font-medium outline-none focus:ring-4 focus:ring-blue-500/5 focus:border-blue-500 transition-all text-slate-900 dark:text-white placeholder:text-slate-400 shadow-sm"
        />
      </div>

      {/* Segmented Control Tabs */}
      <div className={`flex p-1 ${isLight ? 'bg-slate-50' : 'bg-white/5'} rounded-2xl`}>
        {tabs.map((tab) => (
          <button 
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex-1 py-2.5 rounded-xl text-[10px] font-bold transition-all ${activeTab === tab.id ? (isLight ? 'bg-white text-blue-600 shadow-sm' : 'bg-white/10 text-white') : 'text-slate-400 hover:text-slate-600'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'contacts' && (
          <motion.div key="contacts" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-3">
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2">مخاطبین فعال</h3>
            {[
              { name: 'رضا علوی', status: 'تراکنش در جریان: پروژه الف', time: '۱۲:۴۵', badge: 'فعال' },
              { name: 'سارا کریمی', status: 'تراکنش در جریان: سئو سایت', time: 'دیروز', badge: 'در انتظار' },
              { name: 'امیر محمدی', status: 'آخرین بازدید: ۱۰ دقیقه پیش', time: '۱۱:۳۰', badge: 'فعال' },
            ].map((item, i) => (
              <button key={i} className="w-full card-granite p-4 flex items-center justify-between text-right group hover:border-blue-500/30">
                <div className="flex items-center gap-4 relative z-10">
                  <div className="relative">
                    <div className="w-11 h-11 rounded-full bg-white/5 flex items-center justify-center border border-white/10 overflow-hidden">
                      <User size={22} className="text-slate-500" />
                    </div>
                    <div className="absolute bottom-0 left-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-[#0f1115]" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-[13px] font-bold text-white">{item.name}</h4>
                    <div className="flex items-center gap-1.5">
                      <Clock size={10} className="text-blue-400" />
                      <p className="text-[10px] text-slate-400 font-medium">{item.status}</p>
                    </div>
                  </div>
                </div>
                <div className="text-left space-y-2 relative z-10">
                  <span className="text-[9px] text-slate-500 block font-medium">{item.time}</span>
                  <span className={`px-2 py-0.5 rounded-md text-[8px] font-black uppercase ${item.badge === 'در انتظار' ? 'bg-amber-500/10 text-amber-500' : 'bg-blue-500/10 text-blue-400'}`}>
                    {item.badge}
                  </span>
                </div>
              </button>
            ))}
          </motion.div>
        )}

        {activeTab === 'groups' && (
          <motion.div key="groups" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-3">
             <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2">گروه‌های معاملاتی</h3>
             {[
               { name: 'تیم طراحی UI/UX', status: '۳ عضو آنلاین', time: '۱۰:۲۰', badge: 'گروه' },
               { name: 'پروژه توسعه اپلیکیشن', status: '۵ عضو فعال', time: '۰۹:۱۵', badge: 'گروه' },
             ].map((item, i) => (
               <button key={i} className="w-full card-granite p-4 flex items-center justify-between text-right group hover:border-blue-500/30">
                 <div className="flex items-center gap-4 relative z-10">
                   <div className="flex -space-x-3 rtl:space-x-reverse">
                     <div className="w-10 h-10 rounded-full border-2 border-[#0f1115] bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold">U1</div>
                     <div className="w-10 h-10 rounded-full border-2 border-[#0f1115] bg-emerald-600 flex items-center justify-center text-white text-[10px] font-bold">U2</div>
                   </div>
                   <div className="space-y-1">
                     <h4 className="text-[13px] font-bold text-white">{item.name}</h4>
                     <p className="text-[10px] text-slate-400 font-medium">{item.status}</p>
                   </div>
                 </div>
                 <div className="text-left space-y-2 relative z-10">
                   <span className="text-[9px] text-slate-500 block font-medium">{item.time}</span>
                   <span className="px-2 py-0.5 rounded-md text-[8px] font-black uppercase bg-amber-500/10 text-amber-500">
                     {item.badge}
                   </span>
                 </div>
               </button>
             ))}
          </motion.div>
        )}

        {activeTab === 'channels' && (
          <motion.div key="channels" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-4">
            <button className="w-full h-14 border-2 border-dashed border-slate-200 dark:border-white/5 rounded-2xl flex items-center justify-center gap-2 text-slate-400 hover:text-blue-500 hover:border-blue-500/30 transition-all">
              <PlusCircle size={20} />
              <span className="text-[12px] font-bold">ایجاد کانال جدید</span>
            </button>
            
            <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2">کانال‌های رسمی و عمومی</h3>
            {[
              { name: 'اخبار میانجی (رسمی)', subs: '۲۴.۵ هزار دنبال‌کننده', icon: <Shield size={20} />, color: 'bg-blue-600' },
              { name: 'فرصت‌های شغلی برنامه نویسی', subs: '۱۲.۱ هزار دنبال‌کننده', icon: <Code2 size={20} />, color: 'bg-emerald-600' },
              { name: 'ایده‌های طراحی و گرافیک', subs: '۸.۳ هزار دنبال‌کننده', icon: <Palette size={20} />, color: 'bg-purple-600' },
            ].map((chan, i) => (
              <button key={i} className="w-full card-granite p-4 flex items-center justify-between text-right group hover:border-blue-500/30">
                <div className="flex items-center gap-4 relative z-10">
                  <div className={`w-12 h-12 rounded-2xl ${chan.color} flex items-center justify-center text-white shadow-lg`}>
                    {chan.icon}
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-[13px] font-bold text-white">{chan.name}</h4>
                    <p className="text-[10px] text-slate-400 font-medium">{chan.subs}</p>
                  </div>
                </div>
                <button className="h-8 px-4 bg-white/5 hover:bg-white/10 border border-white/5 rounded-lg text-[10px] font-bold text-slate-300 relative z-10">عضویت</button>
              </button>
            ))}
          </motion.div>
        )}


      </AnimatePresence>

      {/* Floating Action Button for New Chat */}
      <motion.button 
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="fixed bottom-24 left-6 z-50 h-14 px-6 bg-blue-600 text-white rounded-full flex items-center gap-3 shadow-xl shadow-blue-600/30"
      >
        <MessageSquare size={20} />
        <span className="text-[12px] font-bold">چت جدید</span>
      </motion.button>
    </motion.div>
  );
}
