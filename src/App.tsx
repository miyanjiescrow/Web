/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, Plus, Home, User, ChevronLeft, CheckCircle2, Clock, 
  AlertCircle, Wallet, ClipboardList, Bell, ArrowUpRight, 
  ArrowDownLeft, MessageCircle, LogOut, Search, Filter, 
  MoreVertical, Activity, ChevronRight, Send, MessageSquare, 
  HelpCircle, Trash2, Check, Lock, Unlock, Gavel
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase, isConfigured, IS_DEMO_MODE as initialIsDemo } from './lib/supabase';
import { getEscrowActions, EscrowAction } from './services/escrowService';

// --- Error Boundary ---
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }
  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }
  render() {
    const isDebug = localStorage.getItem('mianji_debug') === 'true';
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center bg-black text-white font-sans" dir="rtl">
          <div className="w-16 h-16 bg-rose-500/10 rounded-2xl flex items-center justify-center text-rose-500 mb-6">
            <AlertCircle size={32} />
          </div>
          <h1 className="text-xl font-black mb-4">خطای غیرمنتظره رخ داد</h1>
          <p className="text-slate-400 text-sm mb-8 leading-relaxed">متأسفانه برنامه با خطا مواجه شد. لطفاً صفحه را رفرش کنید.</p>
          
          {isDebug && (
            <div className="p-4 bg-white/5 rounded-xl text-[10px] font-mono text-left w-full overflow-auto max-h-60 opacity-80 mb-8 border border-white/10 select-text">
              <p className="text-rose-400 font-bold mb-2">DEBUG INFO:</p>
              {this.state.error?.stack || this.state.error?.toString()}
            </div>
          )}

          <button onClick={() => window.location.reload()} className="h-12 px-8 bg-white text-black font-bold rounded-xl active:scale-95 transition-all">تلاش مجدد</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Types ---
type View = 'auth' | 'dashboard' | 'deals' | 'create' | 'wallet' | 'profile' | 'detail' | 'support' | 'notifications';

interface UserProfile {
  id: string | number; 
  full_name: string | null;
  phone_number: string | null;
  role: string | null;
  wallet_balance: number;
  escrow_locked_balance: number;
  kyc_status: string;
}

interface Contract {
  id?: string;
  contract_id: string;
  title: string;
  amount: number;
  buyer_id: number;
  seller_id: number;
  status: 'draft' | 'awaiting_payment' | 'active' | 'work_submitted' | 'completed' | 'cancelled' | 'disputed';
  created_at: string;
  buyer?: UserProfile;
  seller?: UserProfile;
}

interface Message {
  id: string;
  contract_id: string;
  sender_id: number;
  message_text: string;
  is_system: boolean;
  created_at: string;
}

// --- App Component ---
export default function App() {
  const [view, setView] = useState<View>('auth');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDebug, setIsDebug] = useState(true); 
  const [isDemo, setIsDemo] = useState(initialIsDemo);

  useEffect(() => {
    localStorage.setItem('mianji_debug', 'true');
  }, []);

  const toggleDebug = () => {
    const newState = !isDebug;
    setIsDebug(newState);
    localStorage.setItem('mianji_debug', newState.toString());
  };

  const enterDemoMode = () => {
    setIsDemo(true);
    localStorage.setItem('mianji_demo_mode', 'true');
    // Seed mock data for demo
    const mockUser: UserProfile = {
      id: 12345678,
      full_name: 'کاربر آزمایشی',
      phone_number: '09123456789',
      role: 'user',
      wallet_balance: 5000000,
      escrow_locked_balance: 1500000,
      kyc_status: 'verified'
    };
    
    const mockContracts: Contract[] = [
      {
        id: 'mock-1',
        contract_id: 'M-123456',
        title: 'پروژه طراحی لوگو',
        amount: 2500000,
        buyer_id: 87654321,
        seller_id: 12345678,
        status: 'active',
        created_at: new Date().toISOString()
      },
      {
        id: 'mock-2',
        contract_id: 'M-654321',
        title: 'برنامه‌نویسی پنل مدیریت',
        amount: 15000000,
        buyer_id: 12345678,
        seller_id: 99999999,
        status: 'work_submitted',
        created_at: new Date().toISOString()
      }
    ];

    localStorage.setItem('mianji_mock_user', JSON.stringify(mockUser));
    localStorage.setItem('mianji_mock_contracts', JSON.stringify(mockContracts));
    window.location.reload(); // Reload to apply demo state across hooks
  };

  // Auth & Init
  useEffect(() => {
    const initApp = async () => {
      // 1. Check for Demo Session
      if (isDemo) {
        const savedUser = localStorage.getItem('mianji_mock_user');
        if (savedUser) {
          const u = JSON.parse(savedUser);
          setUser(u);
          setIsAuthenticated(true);
          setView('dashboard');
          
          const savedContracts = localStorage.getItem('mianji_mock_contracts');
          if (savedContracts) setContracts(JSON.parse(savedContracts));
        }
        setLoading(false);
        return;
      }

      // 2. Check Supabase Connectivity
      if (isConfigured) {
        try {
          const { error: connError } = await supabase.from('users').select('count', { count: 'exact', head: true });
          if (connError) {
            console.error("Supabase Connection Error:", connError);
          }
        } catch (e) {
          console.error("Supabase initialization crash:", e);
        }
      }

      // 3. Check for Telegram Web App (TWA)
      const tg = (window as any).Telegram?.WebApp;
      if (tg && tg.initDataUnsafe?.user) {
        tg.expand();
        tg.ready();
        
        const tgUser = tg.initDataUnsafe.user;
        
        if (isConfigured) {
          const { data, error } = await supabase.from('users').select('*').eq('id', tgUser.id).maybeSingle();
          if (data) {
            localStorage.setItem('mianji_user', JSON.stringify(data));
            setUser(data);
            setIsAuthenticated(true);
            setView('dashboard');
            fetchInitialData(data.id);
            setLoading(false);
            return;
          }
        }
      }

      // 4. Check for manual session
      const saved = localStorage.getItem('mianji_user');
      if (saved) {
        const u = JSON.parse(saved);
        setUser(u);
        setIsAuthenticated(true);
        setView('dashboard');
        fetchInitialData(u.id);
      }
      setLoading(false);
    };
    initApp();
  }, [isDemo]);

  const fetchInitialData = async (userId: string | number) => {
    if (isDemo) return;
    if (!isConfigured) return;
    
    // 1. Fetch User
    const { data: userData } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
    if (userData) setUser(userData);

    // 2. Fetch Contracts
    const { data: contractData, error: contractError } = await supabase
      .from('contracts')
      .select('*, buyer:buyer_id(*), seller:seller_id(*)')
      .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    
    if (contractError) {
      const { data: simpleData } = await supabase
        .from('contracts')
        .select('*')
        .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
        .order('created_at', { ascending: false });
      if (simpleData) setContracts(simpleData);
    } else if (contractData) {
      setContracts(contractData);
    }

    // 3. Fetch Notifications
    const { data: notifyData } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (notifyData) setNotifications(notifyData || []);
  };

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [loginPhone, setLoginPhone] = useState('');

  const handleLogin = async (phone: string) => {
    if (!phone) return;
    setIsLoggingIn(true);

    if (isDemo) {
      setTimeout(() => {
        setLoginPhone(phone);
        setIsOtpSent(true);
        setIsLoggingIn(false);
      }, 500);
      return;
    }
    
    try {
      const clean = phone.replace(/[^0-9]/g, '');
      const coreDigits = clean.length >= 10 ? clean.slice(-10) : clean;

      if (phone === "999") {
        const { data: admin } = await supabase.from('users').select('*').limit(1).maybeSingle();
        if (admin) {
           setLoginPhone(admin.phone_number || '');
           setIsOtpSent(true);
        } else {
          const dummyId = Math.floor(100000 + Math.random() * 900000);
          const { data: newUser } = await supabase.from('users').insert({
            id: dummyId,
            full_name: 'Developer Admin',
            phone_number: '09000000000',
            wallet_balance: 1000000,
            kyc_status: 'verified'
          }).select().single();
          if (newUser) {
            setLoginPhone(newUser.phone_number);
            setIsOtpSent(true);
          }
        }
        setIsLoggingIn(false);
        return;
      }

      const { data, error } = await supabase
        .from('users')
        .select('*')
        .ilike('phone_number', `%${coreDigits}`)
        .maybeSingle();
      
      if (error) {
        alert(`خطای دیتابیس: ${error.message}`);
        return;
      }
      
      if (!data) {
        alert('کاربر یافت نشد. ابتدا در ربات ثبت‌نام کنید.');
        return;
      }

      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: data.phone_number })
      });
      
      if ((await res.json()).success) {
        setLoginPhone(data.phone_number);
        setIsOtpSent(true);
      }
    } catch (err: any) {
      alert(`خطای شبکه: ${err.message}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleVerifyOtp = async (code: string) => {
    setIsLoggingIn(true);

    if (isDemo) {
      setTimeout(() => {
        const mockUser: UserProfile = {
          id: 12345678,
          full_name: 'کاربر آزمایشی',
          phone_number: loginPhone,
          role: 'user',
          wallet_balance: 5000000,
          escrow_locked_balance: 1500000,
          kyc_status: 'verified'
        };
        localStorage.setItem('mianji_mock_user', JSON.stringify(mockUser));
        setUser(mockUser);
        setIsAuthenticated(true);
        setView('dashboard');
        setIsLoggingIn(false);
      }, 500);
      return;
    }

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: loginPhone, code })
      });
      const result = await res.json();

      if (result.success && result.user) {
        localStorage.setItem('mianji_user', JSON.stringify(result.user));
        setUser(result.user);
        setIsAuthenticated(true);
        setView('dashboard');
        fetchInitialData(result.user.id);
      } else {
        alert('کد نامعتبر است.');
      }
    } catch (err: any) {
      alert(`خطا: ${err.message}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('mianji_user');
    localStorage.removeItem('mianji_mock_user');
    localStorage.removeItem('mianji_demo_mode');
    setIsAuthenticated(false);
    setUser(null);
    setView('auth');
    setIsDemo(false);
  };

  if (loading) return <div className="min-h-screen bg-black flex items-center justify-center"><div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>;

  if (!isConfigured && !isDemo) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-8 text-center" dir="rtl">
        <div className="w-16 h-16 bg-blue-600/10 rounded-2xl flex items-center justify-center text-blue-500 mb-6">
          <Shield size={32} />
        </div>
        <h1 className="text-xl font-black text-white mb-4 tracking-tight">میانجی اسکرو</h1>
        <p className="text-slate-400 text-sm mb-12 leading-relaxed">
          برای اتصال به دیتابیس واقعی، تنظیمات Supabase را در Secrets وارد کنید. <br/>
          در غیر این صورت می‌توانید از حالت نمایشی برای تست محیط استفاده کنید.
        </p>
        <div className="space-y-4 w-full max-w-xs">
          <button onClick={enterDemoMode} className="w-full h-14 bg-blue-600 text-white font-black rounded-2xl shadow-xl shadow-blue-600/20 active:scale-95 transition-all">ورود به حالت نمایشی (Demo)</button>
          <button onClick={() => window.location.reload()} className="w-full h-14 bg-white/5 border border-white/10 text-slate-300 font-bold rounded-2xl active:scale-95 transition-all">تلاش مجدد برای اتصال واقعی</button>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-black text-slate-200 font-sans selection:bg-blue-600/30" dir="rtl">
        <div className="max-w-md mx-auto min-h-screen flex flex-col relative pb-24">
          
          {/* Header */}
          {isAuthenticated && (
            <header className="h-20 flex items-center justify-between px-6 sticky top-0 bg-black/80 backdrop-blur-md z-50 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]">
                  <Shield size={22} strokeWidth={2.5} />
                </div>
                <div>
                  <h1 className="text-lg font-black text-white leading-none">میانجی</h1>
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Escrow Platform</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setView('notifications')} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center relative text-slate-400 active:scale-90 transition-all">
                  <Bell size={20} />
                  {notifications.some(n => !n.is_read) && <div className="absolute top-2.5 right-2.5 w-2 h-2 bg-blue-500 rounded-full border-2 border-black" />}
                </button>
                <button onClick={() => setView('profile')} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 active:scale-90 transition-all">
                  <User size={20} />
                </button>
              </div>
            </header>
          )}

          <main className="flex-1 p-5 overflow-x-hidden">
            <AnimatePresence mode="wait">
              {!isAuthenticated && <AuthView onLogin={handleLogin} onVerify={handleVerifyOtp} isLoading={isLoggingIn} isOtpSent={isOtpSent} loginPhone={loginPhone} onToggleDebug={toggleDebug} isDebug={isDebug} />}
              {isAuthenticated && view === 'dashboard' && <DashboardView user={user} contracts={contracts} setView={setView} isDebug={isDebug} />}
              {isAuthenticated && view === 'deals' && <DealsView contracts={contracts} setView={setView} />}
              {isAuthenticated && view === 'wallet' && <WalletView user={user} />}
              {isAuthenticated && view === 'detail' && <DealDetailView user={user} setView={setView} refresh={() => user && fetchInitialData(user.id)} isDebug={isDebug} />}
              {isAuthenticated && view === 'create' && <CreateDealView user={user} onBack={() => setView('dashboard')} onSuccess={() => { setView('deals'); user && fetchInitialData(user.id); }} />}
            </AnimatePresence>
            
            {isDebug && <DebugPanel user={user} contracts={contracts} isConfigured={isConfigured} />}
          </main>

          {/* Bottom Nav */}
          {isAuthenticated && (
            <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-sm h-18 bg-[#09090b]/90 backdrop-blur-xl border border-white/10 rounded-[2rem] flex items-center justify-around px-4 shadow-2xl z-[100]">
              <NavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={22} />} label="خانه" />
              <NavBtn active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={22} />} label="معاملات" />
              <div className="relative -translate-y-6">
                <button onClick={() => setView('create')} className="w-14 h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-[0_0_30px_rgba(37,99,235,0.4)] border-4 border-black active:scale-90 transition-all">
                  <Plus size={28} strokeWidth={3} />
                </button>
              </div>
              <NavBtn active={view === 'wallet'} onClick={() => setView('wallet')} icon={<Wallet size={22} />} label="کیف پول" />
              <NavBtn active={view === 'profile'} onClick={() => setView('profile')} icon={<User size={22} />} label="پنل" />
            </nav>
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
}

// --- View Components ---

function AuthView({ onLogin, onVerify, isLoading, isOtpSent, loginPhone, onToggleDebug, isDebug }: { onLogin: (p: string) => void, onVerify: (c: string) => void, isLoading: boolean, isOtpSent: boolean, loginPhone: string, onToggleDebug: () => void, isDebug: boolean }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [clickCount, setClickCount] = useState(0);

  const handleLogoClick = () => {
    const newCount = clickCount + 1;
    if (newCount >= 5) {
      onToggleDebug();
      setClickCount(0);
    } else {
      setClickCount(newCount);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="min-h-[70vh] flex flex-col justify-center text-center p-6">
      <div className="mb-12">
        <div 
          onClick={handleLogoClick}
          className="w-20 h-20 bg-blue-600 rounded-[2rem] flex items-center justify-center text-white mx-auto shadow-[0_0_40px_rgba(37,99,235,0.3)] mb-8 active:scale-90 transition-transform cursor-pointer"
        >
          <Shield size={40} />
        </div>
        <h1 className="text-4xl font-black text-white mb-4 tracking-tighter">میانجی</h1>
        <p className="text-slate-500 text-sm font-medium">امنیت در معاملات فریلنسری و دیجیتال</p>
        
        {isDebug && <div className="mt-4 text-[8px] font-mono text-blue-500 uppercase tracking-widest">Debug Mode Active</div>}
      </div>

      <div className="bg-[#09090b] border border-white/5 p-8 rounded-[2.5rem] space-y-6 shadow-2xl">
        {!isOtpSent ? (
          <>
            <div className="space-y-3 text-right">
              <label className="text-[11px] font-black text-blue-500 uppercase tracking-widest px-1">شماره همراه (ثبت شده در ربات)</label>
              <input 
                type="tel" 
                placeholder="0912..." 
                value={phone}
                onChange={e => setPhone(e.target.value)}
                disabled={isLoading}
                className="w-full h-14 bg-black border border-white/10 rounded-2xl text-center text-xl font-bold focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10 outline-none transition-all text-white disabled:opacity-50"
              />
            </div>
            <button 
              onClick={() => onLogin(phone)}
              disabled={isLoading || !phone}
              className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
            >
              {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'دریافت کد تایید'}
            </button>
            
            <div className="pt-4 border-t border-white/5 mt-4">
               <button 
                onClick={() => onLogin("999")}
                className="w-full h-10 text-[10px] font-bold text-slate-500 hover:text-blue-400 transition-colors"
               >
                 (تست) ورود به عنوان اولین کاربر دیتابیس
               </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-3 text-right">
              <label className="text-[11px] font-black text-emerald-500 uppercase tracking-widest px-1">کد تایید ارسال شده را وارد کنید</label>
              <input 
                type="number" 
                placeholder="------" 
                value={code}
                onChange={e => setCode(e.target.value)}
                disabled={isLoading}
                className="w-full h-14 bg-black border border-white/10 rounded-2xl text-center text-2xl font-black tracking-[0.5em] focus:border-emerald-500 focus:ring-4 focus:ring-emerald-600/10 outline-none transition-all text-white disabled:opacity-50"
              />
              <p className="text-[10px] text-slate-500 text-center">کد به تلگرام {loginPhone} ارسال شد</p>
            </div>
            <button 
              onClick={() => onVerify(code)}
              disabled={isLoading || code.length < 5}
              className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-black shadow-lg shadow-emerald-600/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
            >
              {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'ورود به پنل'}
            </button>
            <button onClick={() => window.location.reload()} className="w-full text-[10px] text-slate-600 font-bold hover:text-slate-400">تغییر شماره همراه</button>
          </>
        )}
      </div>
    </motion.div>
  );
}

function DashboardView({ user, contracts, setView, isDebug }: any) {
  const activeCount = contracts.filter((c: any) => !['completed', 'cancelled'].includes(c.status)).length;
  
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
      {/* Wallet Card */}
      <div 
        onClick={() => setView('wallet')}
        className="relative p-8 rounded-[2.5rem] bg-[#09090b] border border-white/5 overflow-hidden group cursor-pointer shadow-2xl"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-blue-600/10 blur-[80px] rounded-full -translate-y-1/2 translate-x-1/2" />
        <div className="relative z-10 flex flex-col items-center gap-6">
          <div className="flex items-center gap-3 px-4 py-2 bg-white/5 rounded-full border border-white/5">
            <Wallet size={16} className="text-blue-500" />
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">موجودی کل</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-black text-white tabular-nums tracking-tighter">{user?.wallet_balance.toLocaleString()}</span>
            <span className="text-xs font-bold text-slate-500">تومان</span>
          </div>
          <div className="grid grid-cols-2 gap-3 w-full">
            <div className="p-3 bg-black/40 rounded-2xl border border-white/5 text-center">
              <span className="text-[9px] text-slate-500 block mb-1">مسدود (اسکرو)</span>
              <span className="text-xs font-bold text-amber-500">{user?.escrow_locked_balance.toLocaleString()}</span>
            </div>
            <div className="p-3 bg-black/40 rounded-2xl border border-white/5 text-center">
              <span className="text-[9px] text-slate-500 block mb-1">قابل برداشت</span>
              <span className="text-xs font-bold text-emerald-500">{(user?.wallet_balance - user?.escrow_locked_balance).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats & Actions */}
      <div className="grid grid-cols-2 gap-4">
        <ActionCard icon={<Activity size={24} />} label="معاملات فعال" value={activeCount} onClick={() => setView('deals')} color="text-blue-500" />
        <ActionCard icon={<HelpCircle size={24} />} label="پشتیبانی" value="آنلاین" onClick={() => {}} color="text-emerald-500" />
      </div>

      {isDebug && (
        <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl font-mono text-[8px] text-blue-400">
           DB Stats: {contracts.length} loaded, Status: {user?.status || 'unknown'}
        </div>
      )}

      {/* Recent Activity */}
      <div className="space-y-4">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-black text-white">آخرین معاملات</h2>
          <button onClick={() => setView('deals')} className="text-[10px] font-bold text-blue-500">مشاهده همه</button>
        </div>
        <div className="space-y-3">
          {contracts.slice(0, 3).map((c: any) => (
            <DealCard key={c.contract_id} contract={c} onClick={() => { localStorage.setItem('selected_contract', JSON.stringify(c)); setView('detail'); }} />
          ))}
          {contracts.length === 0 && (
            <div className="p-12 text-center border-2 border-dashed border-white/5 rounded-[2.5rem]">
              <ClipboardList size={32} className="mx-auto text-slate-700 mb-4" />
              <p className="text-xs font-bold text-slate-600">هنوز معامله‌ای ثبت نشده است</p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function DealDetailView({ user, setView, refresh, isDebug }: any) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'chat'>('info');
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('selected_contract');
    if (saved) setContract(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (!contract) return;
    const fetchMsgs = async () => {
      const { data } = await supabase.from('contract_messages').select('*').eq('contract_id', contract.contract_id).order('created_at', { ascending: true });
      if (data) setMessages(data);
    };
    fetchMsgs();
    
    const sub = supabase.channel(`chat-${contract.contract_id}`).on('postgres_changes', { 
      event: 'INSERT', 
      schema: 'public', 
      table: 'contract_messages', 
      filter: `contract_id=eq.${contract.contract_id}` 
    }, (p) => {
      setMessages(prev => [...prev, p.new as Message]);
    }).subscribe();

    return () => { supabase.removeChannel(sub); };
  }, [contract]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, activeTab]);

  const sendMsg = async () => {
    if (!newMessage.trim() || !user || !contract) return;
    const { error } = await supabase.from('contract_messages').insert({
      contract_id: contract.contract_id,
      sender_id: user.id,
      message_text: newMessage
    });
    if (!error) setNewMessage('');
  };

  const actions = contract ? getEscrowActions(contract, user.id, () => {
    refresh();
    // Re-fetch local contract to update UI
    supabase.from('contracts').select('*').eq('contract_id', contract.contract_id).maybeSingle().then(({data}) => {
      if (data) {
        setContract(data);
        localStorage.setItem('selected_contract', JSON.stringify(data));
      }
    });
  }) : [];

  if (!contract) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <button onClick={() => setView('dashboard')} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400">
          <ChevronRight size={20} />
        </button>
        <div className="flex p-1 bg-[#09090b] rounded-2xl border border-white/5">
          <button onClick={() => setActiveTab('info')} className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${activeTab === 'info' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500'}`}>جزئیات</button>
          <button onClick={() => setActiveTab('chat')} className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${activeTab === 'chat' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500'}`}>گفتگو</button>
        </div>
      </div>

      {activeTab === 'info' ? (
        <div className="space-y-6">
          {/* Status Badge */}
          <div className="flex flex-col items-center gap-4 py-8 bg-[#09090b] border border-white/5 rounded-[2.5rem] relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-white/5">
              <div className="h-full bg-blue-600 shadow-[0_0_10px_#2563eb]" style={{ width: getProgress(contract.status) }} />
            </div>
            <StatusIcon status={contract.status} />
            <div className="text-center">
              <h1 className="text-xl font-black text-white mb-1">{contract.title}</h1>
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{contract.contract_id}</span>
              {isDebug && <p className="text-[8px] font-mono text-rose-400 mt-1">UUID: {contract.id || 'N/A'}</p>}
            </div>
            <StatusLabel status={contract.status} />
          </div>

          {/* Details Grid */}
          <div className="grid grid-cols-2 gap-4">
            <DetailItem label="بودجه پروژه" value={contract.amount.toLocaleString()} unit="T" />
            <DetailItem label="وضعیت" value={translateStatus(contract.status)} color="text-blue-500" />
            <DetailItem label="کارفرما" value={user.id === contract.buyer_id ? 'شما' : 'طرف مقابل'} />
            <DetailItem label="مجری" value={user.id === contract.seller_id ? 'شما' : 'طرف مقابل'} />
          </div>

          {/* Action Buttons */}
          <div className="pt-4 space-y-3">
             {actions.map((act, idx) => (
               <button 
                key={idx}
                onClick={act.action}
                className={`w-full h-16 rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 ${
                  act.variant === 'primary' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 
                  act.variant === 'danger' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' : 
                  'bg-white/5 text-slate-300 border border-white/10'
                }`}
               >
                 {act.label}
               </button>
             ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col bg-[#09090b] rounded-[2.5rem] border border-white/5 overflow-hidden h-[60vh]">
          <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
            {messages.map(m => (
              <div key={m.id} className={`flex ${m.sender_id === user.id ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[85%] p-4 rounded-3xl text-[12px] leading-relaxed relative ${m.sender_id === user.id ? 'bg-blue-600 text-white rounded-br-none' : 'bg-white/5 text-slate-300 border border-white/10 rounded-bl-none'}`}>
                  {m.message_text}
                  <div className="text-[8px] mt-1 opacity-40 text-left">{new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="p-4 bg-black/40 border-t border-white/5 flex gap-2">
            <input 
              className="flex-1 bg-[#09090b] border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none"
              placeholder="پیام خود را بنویسید..."
              value={newMessage}
              onChange={e => setNewMessage(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && sendMsg()}
            />
            <button onClick={sendMsg} className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20 active:scale-90 transition-all">
              <Send size={18} />
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// --- Helpers & Small Components ---

function NavBtn({ active, onClick, icon, label }: any) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 transition-all ${active ? 'text-blue-500' : 'text-slate-600'}`}>
      <div className={`transition-all ${active ? 'scale-110 -translate-y-1' : ''}`}>{icon}</div>
      <span className="text-[9px] font-black uppercase tracking-widest">{label}</span>
    </button>
  );
}

function ActionCard({ icon, label, value, onClick, color }: any) {
  return (
    <button onClick={onClick} className="bg-[#09090b] border border-white/5 p-5 rounded-[2rem] text-right space-y-4 hover:border-white/10 transition-all">
      <div className={`w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center ${color}`}>{icon}</div>
      <div>
        <span className="text-[10px] font-black text-slate-500 block">{label}</span>
        <span className="text-lg font-black text-white">{value}</span>
      </div>
    </button>
  );
}

function DealCard({ contract, onClick }: { contract: Contract, onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full p-6 bg-[#09090b] border border-white/5 rounded-3xl text-right flex justify-between items-center group active:scale-[0.98] transition-all">
      <div className="space-y-1">
        <h3 className="text-sm font-black text-white group-hover:text-blue-500 transition-colors">{contract.title}</h3>
        <span className="text-[10px] font-bold text-slate-500">{contract.amount.toLocaleString()} تومان</span>
      </div>
      <StatusLabel status={contract.status} small />
    </button>
  );
}

function DetailItem({ label, value, unit, color }: any) {
  return (
    <div className="p-4 bg-[#09090b] border border-white/5 rounded-2xl">
      <span className="text-[9px] font-black text-slate-500 block mb-1">{label}</span>
      <div className={`text-sm font-black text-white ${color}`}>
        {value} {unit && <span className="text-[10px] text-slate-600">{unit}</span>}
      </div>
    </div>
  );
}

function StatusLabel({ status, small }: { status: string, small?: boolean }) {
  const config: any = {
    draft: { label: 'پیش‌نویس', color: 'bg-slate-500/10 text-slate-500' },
    awaiting_payment: { label: 'در انتظار پرداخت', color: 'bg-amber-500/10 text-amber-500' },
    active: { label: 'در حال اجرا', color: 'bg-blue-500/10 text-blue-500' },
    work_submitted: { label: 'تحویل کار', color: 'bg-purple-500/10 text-purple-500' },
    completed: { label: 'تکمیل شده', color: 'bg-emerald-500/10 text-emerald-500' },
    cancelled: { label: 'لغو شده', color: 'bg-rose-500/10 text-rose-500' },
    disputed: { label: 'اختلاف', color: 'bg-rose-600/10 text-rose-600' }
  };
  const { label, color } = config[status] || config.draft;
  return <span className={`px-3 py-1 rounded-full ${small ? 'text-[8px]' : 'text-[10px]'} font-black uppercase tracking-widest ${color}`}>{label}</span>;
}

function StatusIcon({ status }: { status: string }) {
  if (['completed'].includes(status)) return <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center border border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.1)]"><Check size={32} strokeWidth={3} /></div>;
  if (['active', 'work_submitted'].includes(status)) return <div className="w-16 h-16 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(37,99,235,0.3)]"><Lock size={32} strokeWidth={3} /></div>;
  if (['disputed'].includes(status)) return <div className="w-16 h-16 bg-rose-500/10 text-rose-500 rounded-full flex items-center justify-center border border-rose-500/20"><Gavel size={32} strokeWidth={3} /></div>;
  return <div className="w-16 h-16 bg-white/5 text-slate-500 rounded-full flex items-center justify-center border border-white/10"><Clock size={32} strokeWidth={3} /></div>;
}

function getProgress(status: string) {
  if (status === 'completed') return '100%';
  if (status === 'work_submitted') return '75%';
  if (status === 'active') return '50%';
  if (status === 'awaiting_payment') return '25%';
  return '5%';
}

function translateStatus(status: string) {
  const map: any = { draft: 'پیش‌نویس', awaiting_payment: 'در انتظار پرداخت', active: 'در حال اجرا', work_submitted: 'تحویل شده', completed: 'تسویه شده', cancelled: 'لغو شده', disputed: 'اختلاف' };
  return map[status] || status;
}

function DealsView({ contracts, setView }: any) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-black text-white">لیست معاملات</h2>
        <button className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400"><Filter size={18} /></button>
      </div>
      <div className="space-y-3">
        {contracts.map((c: any) => (
          <DealCard key={c.contract_id} contract={c} onClick={() => { localStorage.setItem('selected_contract', JSON.stringify(c)); setView('detail'); }} />
        ))}
      </div>
    </motion.div>
  );
}

function CreateDealView({ user, onBack, onSuccess }: any) {
  const [formData, setFormData] = useState({ title: '', amount: '', role: 'seller', phone: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!formData.title || !formData.amount || !formData.phone) {
      alert('لطفاً تمام فیلدها را پر کنید');
      return;
    }
    setLoading(true);
    try {
      const contractId = `M-${Math.floor(100000 + Math.random() * 900000)}`;
      
      if (initialIsDemo) {
        const newContract: Contract = {
          contract_id: contractId,
          title: formData.title,
          amount: Number(formData.amount),
          buyer_id: formData.role === 'buyer' ? Number(user.id) : 99988877,
          seller_id: formData.role === 'seller' ? Number(user.id) : 99988877,
          status: 'draft',
          created_at: new Date().toISOString()
        };
        const saved = localStorage.getItem('mianji_mock_contracts');
        const contracts = saved ? JSON.parse(saved) : [];
        localStorage.setItem('mianji_mock_contracts', JSON.stringify([newContract, ...contracts]));
        onSuccess();
        return;
      }

      // Find other party (using last 10 digits)
      const otherPhoneClean = formData.phone.replace(/[^0-9]/g, '');
      const otherCoreDigits = otherPhoneClean.length >= 10 ? otherPhoneClean.slice(-10) : otherPhoneClean;

      const { data: otherUser, error: lookupError } = await supabase
        .from('users')
        .select('id')
        .ilike('phone_number', `%${otherCoreDigits}`)
        .maybeSingle();
      
      if (lookupError) {
        alert(`خطای جستجوی کاربر: ${lookupError.message}`);
        setLoading(false);
        return;
      }

      if (!otherUser) {
        alert('شماره همراه طرف مقابل یافت نشد. او باید ابتدا در سیستم عضو باشد.');
        setLoading(false);
        return;
      }

      const { error } = await supabase.from('contracts').insert({
        contract_id: contractId,
        title: formData.title,
        amount: Number(formData.amount),
        buyer_id: formData.role === 'buyer' ? user.id : otherUser.id,
        seller_id: formData.role === 'seller' ? user.id : otherUser.id,
        status: 'draft',
      });

      if (error) throw error;
      onSuccess();
    } catch (err) {
      alert('خطا در ثبت معامله');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400"><ChevronRight size={20} /></button>
        <h2 className="text-xl font-black text-white">ایجاد معامله جدید</h2>
      </div>

      <div className="bg-[#09090b] border border-white/5 p-8 rounded-[2.5rem] space-y-6">
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">عنوان پروژه</label>
            <input 
              placeholder="طراحی وب‌سایت، فروش اکانت و..."
              value={formData.title}
              onChange={e => setFormData({...formData, title: e.target.value})}
              className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">مبلغ معامله (تومان)</label>
            <input 
              type="number"
              placeholder="0"
              value={formData.amount}
              onChange={e => setFormData({...formData, amount: e.target.value})}
              className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">شماره همراه طرف مقابل</label>
            <input 
              placeholder="0912..."
              value={formData.phone}
              onChange={e => setPhone(e.target.value, formData, setFormData)}
              className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button 
              onClick={() => setFormData({...formData, role: 'seller'})}
              className={`h-14 rounded-2xl font-bold text-xs border transition-all ${formData.role === 'seller' ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-black border-white/10 text-slate-500'}`}
            >
              من مجری هستم
            </button>
            <button 
              onClick={() => setFormData({...formData, role: 'buyer'})}
              className={`h-14 rounded-2xl font-bold text-xs border transition-all ${formData.role === 'buyer' ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-black border-white/10 text-slate-500'}`}
            >
              من کارفرما هستم
            </button>
          </div>
        </div>
        <button 
          onClick={handleSubmit}
          disabled={loading}
          className="w-full h-16 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all disabled:opacity-50"
        >
          {loading ? 'در حال ثبت...' : 'تایید و ارسال درخواست'}
        </button>
      </div>
    </motion.div>
  );
}

function WalletView({ user }: any) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8">
      <div className="text-center space-y-4">
        <div className="w-20 h-20 bg-emerald-500/10 text-emerald-500 rounded-[2rem] flex items-center justify-center mx-auto border border-emerald-500/20">
          <Wallet size={36} />
        </div>
        <h2 className="text-2xl font-black text-white">کیف پول من</h2>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div className="p-8 bg-[#09090b] border border-white/5 rounded-[2.5rem] flex flex-col items-center gap-2">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">موجودی کل</span>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-black text-white">{user?.wallet_balance.toLocaleString()}</span>
            <span className="text-xs text-slate-500">تومان</span>
          </div>
        </div>
        <button className="h-16 bg-white text-black rounded-2xl font-black flex items-center justify-center gap-2 shadow-xl active:scale-95 transition-all">
          <Plus size={20} /> افزایش موجودی
        </button>
        <button className="h-16 bg-[#09090b] border border-white/10 text-white rounded-2xl font-black flex items-center justify-center gap-2 active:scale-95 transition-all">
          <ArrowUpRight size={20} /> درخواست تسویه (شبا)
        </button>
      </div>
    </motion.div>
  );
}

function setPhone(val: string, formData: any, setFormData: any) {
  setFormData({...formData, phone: val});
}

function DebugPanel({ user, contracts, isConfigured }: any) {
  return (
    <div className="mt-10 p-6 bg-slate-900 border border-white/10 rounded-[2.5rem] font-mono text-[10px] text-slate-400 space-y-4">
      <p className="text-blue-500 font-bold border-b border-white/5 pb-2 uppercase tracking-widest text-center">System Debug Panel</p>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <p className="text-slate-500 uppercase font-bold text-[8px]">Environment</p>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConfigured ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            <span>Supabase Config: {isConfigured ? 'Valid' : 'Missing'}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${process.env.NODE_ENV === 'production' ? 'bg-blue-500' : 'bg-amber-500'}`} />
            <span>Env: {process.env.NODE_ENV || 'development'}</span>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-slate-500 uppercase font-bold text-[8px]">Session</p>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${user ? 'bg-emerald-500' : 'bg-slate-700'}`} />
            <span>Auth: {user ? 'Logged In' : 'Guest'}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full bg-blue-500`} />
            <span>Contracts: {contracts?.length || 0}</span>
          </div>
        </div>
      </div>

      <div className="space-y-2 border-t border-white/5 pt-4">
        <p className="text-slate-500 uppercase font-bold text-[8px]">User Data</p>
        <pre className="bg-black/40 p-3 rounded-xl overflow-auto max-h-40 text-[9px] border border-white/5">
          {JSON.stringify(user, null, 2) || "null"}
        </pre>
      </div>

      <button 
        onClick={() => { localStorage.clear(); window.location.reload(); }}
        className="w-full h-8 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-xl font-bold hover:bg-rose-500/20 transition-all uppercase tracking-tighter"
      >
        Hard Reset LocalStorage
      </button>
    </div>
  );
}
