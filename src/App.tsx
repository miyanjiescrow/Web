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
  HelpCircle, Trash2, Check, Lock, Unlock, Gavel, QrCode, 
  Camera, Mic, Image as ImageIcon, FileText, Paperclip, 
  Play, Pause, X, Settings, Users, ShieldCheck, Info, 
  Menu, CreditCard, Star, Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { supabase, isConfigured, IS_DEMO_MODE as initialIsDemo } from './lib/supabase';
import { getEscrowActions, EscrowAction } from './services/escrowService';

// --- Helpers ---
const remoteLog = (level: 'info' | 'warn' | 'error', message: string, details?: any) => {
  // Always log to local console first for immediate visibility
  const logFn = console[level] || console.log;
  logFn(`[Mianji-${level.toUpperCase()}] ${message}`, details || '');

  if (details instanceof Error) {
    details = { message: details.message, stack: details.stack };
  }
  
  // Forward to server (Render logs)
  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, details })
  }).catch(() => {}); 
};

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
    remoteLog('error', `ErrorBoundary Catch: ${error?.message || 'Unknown'}`, { error, errorInfo });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center bg-black text-white font-sans" dir="rtl">
          <div className="w-16 h-16 bg-rose-500/10 rounded-2xl flex items-center justify-center text-rose-500 mb-6">
            <AlertCircle size={32} />
          </div>
          <h1 className="text-xl font-black mb-4">خطای سیستم</h1>
          <p className="text-slate-400 text-sm mb-8 leading-relaxed">برنامه با خطا مواجه شد. گزارش به سرور ارسال گردید.</p>
          <button onClick={() => window.location.reload()} className="h-12 px-8 bg-white text-black font-bold rounded-xl active:scale-95 transition-all">بارگذاری مجدد</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- Types ---
type View = 'auth' | 'dashboard' | 'deals' | 'create' | 'wallet' | 'profile' | 'detail' | 'support' | 'notifications' | 'messages' | 'contacts';

interface UserProfile {
  id: string | number; 
  full_name: string | null;
  phone_number: string | null;
  role: string | null;
  wallet_balance: number;
  escrow_locked_balance: number;
  kyc_status: string;
  trust_score?: number;
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
  message_type: 'text' | 'image' | 'voice' | 'file';
  attachment_url?: string;
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
  const [isDebug, setIsDebug] = useState(localStorage.getItem('mianji_debug') === 'true'); 
  const [isDemo, setIsDemo] = useState(initialIsDemo);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showWebScanner, setShowWebScanner] = useState(false);

  useEffect(() => {
    const handleOpenScanner = () => setShowWebScanner(true);
    document.addEventListener('open-qr-scanner', handleOpenScanner);
    return () => document.removeEventListener('open-qr-scanner', handleOpenScanner);
  }, []);

  useEffect(() => {
    // 1. Global Error Listeners to catch ALL bugs and send to Render
    const handleError = (event: ErrorEvent) => {
      remoteLog('error', `Global Error: ${event.message}`, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      remoteLog('error', `Unhandled Rejection: ${event.reason}`, event.reason);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    // 2. Debug persistence
    if (localStorage.getItem('mianji_debug') === 'true') {
      setIsDebug(true);
    }

    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const toggleDebug = () => {
    const newState = !isDebug;
    setIsDebug(newState);
    localStorage.setItem('mianji_debug', newState.toString());
    remoteLog('info', `Debug mode ${newState ? 'enabled' : 'disabled'} by user`);
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
            remoteLog('error', 'Supabase Connection Error', connError);
          }
        } catch (e) {
          console.error("Supabase initialization crash:", e);
          remoteLog('error', 'Supabase initialization crash', e);
        }
      }

      // 3. Check for Telegram Web App (TWA)
      const tg = (window as any).Telegram?.WebApp;
      if (tg && tg.initDataUnsafe?.user) {
        tg.expand();
        tg.ready();
        
        const tgUser = tg.initDataUnsafe.user;
        remoteLog('info', `TWA User detected: ${tgUser.id}`);
        
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
          if (error) remoteLog('error', 'TWA User fetch error', error);
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
      remoteLog('warn', 'Contracts fetch with joins failed, trying simple fetch', contractError);
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
    remoteLog('info', `Login attempt for phone: ${phone}`);

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
          remoteLog('info', 'Creating dummy user for bypass');
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
        remoteLog('error', 'Login DB Error', error);
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
      remoteLog('error', 'Login Exception', err);
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
      remoteLog('error', 'OTP Verify Exception', err);
      alert(`خطا: ${err.message}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = () => {
    remoteLog('info', 'User logged out');
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
      <div className="min-h-screen bg-black text-slate-200 font-sans selection:bg-blue-600/30 overflow-x-hidden" dir="rtl">
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} user={user} setView={setView} onLogout={handleLogout} />
        
        <div className="max-w-6xl mx-auto min-h-screen flex flex-col relative pb-24 lg:pb-8 lg:pt-4 px-4 md:px-8 lg:px-12">
          
          {/* Header */}
          {isAuthenticated && (
            <header className="h-16 md:h-20 flex items-center justify-between sticky top-0 bg-black/80 backdrop-blur-md z-50 border-b border-white/5 rounded-2xl mb-4">
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setIsSidebarOpen(true)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 active:scale-90 transition-all"
                >
                  <Menu size={20} />
                </button>
                <div>
                  <h1 className="text-base md:text-lg font-black text-white leading-none">میانجی</h1>
                  <span className="text-[9px] md:text-[10px] text-slate-500 uppercase tracking-widest font-bold">Escrow Platform</span>
                </div>
              </div>
              
              {/* Desktop Nav Search Placeholder */}
              <div className="hidden md:flex flex-1 max-w-sm mx-8">
                 <div className="w-full h-10 bg-white/5 border border-white/10 rounded-xl flex items-center px-4 gap-2 text-slate-500">
                    <Search size={16} />
                    <span className="text-xs">جستجو در معاملات...</span>
                 </div>
              </div>

              <div className="flex items-center gap-2">
                <button onClick={() => setView('notifications')} className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center relative text-slate-400 active:scale-90 transition-all">
                  <Bell size={16} />
                  {notifications.some(n => !n.is_read) && <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 bg-blue-500 rounded-full border-2 border-black" />}
                </button>
                <button onClick={() => setView('profile')} className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 active:scale-90 transition-all overflow-hidden border-2 border-blue-500/30">
                  {user?.full_name ? <div className="w-full h-full flex items-center justify-center bg-blue-600 text-white font-black text-[10px] md:text-xs">{user.full_name[0]}</div> : <User size={16} />}
                </button>
              </div>
            </header>
          )}

          <main className="flex-1 overflow-x-hidden">
            <AnimatePresence mode="wait">
              {!isAuthenticated && <AuthView onLogin={handleLogin} onVerify={handleVerifyOtp} isLoading={isLoggingIn} isOtpSent={isOtpSent} loginPhone={loginPhone} onToggleDebug={toggleDebug} isDebug={isDebug} />}
              {isAuthenticated && view === 'dashboard' && <DashboardView user={user} contracts={contracts} setView={setView} isDebug={isDebug} />}
              {isAuthenticated && view === 'deals' && <DealsView contracts={contracts} setView={setView} />}
              {isAuthenticated && view === 'wallet' && <WalletView user={user} />}
              {isAuthenticated && view === 'messages' && <MessagesView contracts={contracts} setView={setView} />}
              {isAuthenticated && view === 'contacts' && <ContactsView user={user} setView={setView} />}
              {isAuthenticated && view === 'profile' && <ProfileView user={user} setView={setView} onLogout={handleLogout} />}
              {isAuthenticated && view === 'detail' && <DealDetailView user={user} setView={setView} refresh={() => user && fetchInitialData(user.id)} isDebug={isDebug} />}
              {isAuthenticated && view === 'create' && <CreateDealView user={user} onBack={() => setView('dashboard')} onSuccess={() => { setView('deals'); user && fetchInitialData(user.id); }} />}
            </AnimatePresence>
          </main>

          {/* Bottom Nav / Desktop Floating Side Nav */}
          {isAuthenticated && (
            <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[92%] max-w-md h-16 md:h-18 bg-[#09090b]/90 backdrop-blur-xl border border-white/10 rounded-[1.5rem] md:rounded-[2rem] flex items-center justify-around px-2 md:px-4 shadow-2xl z-[100] transition-all">
              <NavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={16} />} label="خانه" />
              <NavBtn active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={16} />} label="معاملات" />
              <div className="relative -translate-y-5 md:-translate-y-6">
                <button onClick={() => setView('create')} className="w-12 h-12 md:w-14 md:h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-[0_0_30px_rgba(37,99,235,0.4)] border-4 border-black active:scale-90 transition-all">
                  <Plus className="w-6 h-6 md:w-8 md:h-8" strokeWidth={3} />
                </button>
              </div>
              <NavBtn active={view === 'messages'} onClick={() => setView('messages')} icon={<MessageSquare size={16} />} label="پیام‌ها" />
              <NavBtn active={view === 'profile'} onClick={() => setView('profile')} icon={<User size={16} />} label="پنل" />
            </nav>
          )}

          <AnimatePresence>
            {showWebScanner && (
              <QrScannerModal 
                onClose={() => setShowWebScanner(false)} 
                onScan={(code) => {
                  setShowWebScanner(false);
                  const contract = contracts.find(c => c.contract_id === code);
                  if (contract) {
                    localStorage.setItem('selected_contract', JSON.stringify(contract));
                    setView('detail');
                  } else {
                    alert('قرارداد یافت نشد یا معتبر نیست.');
                  }
                }} 
              />
            )}
          </AnimatePresence>
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
      </div>

      <div className="bg-[#09090b] border border-white/5 p-8 rounded-[2.5rem] space-y-6 shadow-2xl">
        {!isOtpSent ? (
          <>
            <div className="text-right space-y-2 mb-4">
               <p className="text-[10px] text-slate-400 leading-relaxed">
                 برای ورود، ابتدا باید در ربات تلگرام میانجی تایید هویت شده باشید. کد تایید به حساب تلگرام شما ارسال خواهد شد.
               </p>
            </div>
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
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8 md:space-y-12">
      {/* Trust & Profile Brief */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 md:w-16 md:h-16 rounded-[1.5rem] bg-blue-600 flex items-center justify-center text-white shadow-xl shadow-blue-600/20">
            <Star className="w-6 h-6 md:w-8 md:h-8" fill="currentColor" />
          </div>
          <div>
            <h2 className="text-sm md:text-lg font-black text-white">امتیاز اعتماد شما</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-blue-500 font-bold text-xs md:text-sm">{user?.trust_score || 100}</span>
              <div className="w-24 md:w-48 h-2 bg-white/5 rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${user?.trust_score || 100}%` }}
                  className="h-full bg-blue-600" 
                />
              </div>
            </div>
          </div>
        </div>
        <div className="text-left hidden sm:block">
           <span className="text-[10px] md:text-xs font-black text-slate-500 uppercase tracking-widest block">سطح حساب</span>
           <span className="text-xs md:text-sm font-bold text-emerald-500 flex items-center gap-1 justify-end"><Sparkles size={14} /> کاربر ویژه</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Wallet Card */}
        <div 
          onClick={() => setView('wallet')}
          className="lg:col-span-8 relative p-8 md:p-12 rounded-[3rem] bg-linear-to-br from-blue-600/20 to-transparent border border-white/5 overflow-hidden group cursor-pointer shadow-2xl transition-all hover:border-white/10"
        >
          <div className="absolute top-0 right-0 w-80 h-80 bg-blue-600/10 blur-[100px] rounded-full -translate-y-1/2 translate-x-1/2" />
          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-8">
            <div className="space-y-6">
              <div className="flex items-center gap-2 px-4 py-1.5 bg-white/5 rounded-full border border-white/5 w-fit">
                <Wallet size={14} className="text-blue-500" />
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">موجودی کیف پول</span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-4xl md:text-6xl font-black text-white tabular-nums tracking-tighter leading-none">{user?.wallet_balance.toLocaleString()}</span>
                <span className="text-xs md:text-sm font-bold text-slate-500 uppercase">Toman</span>
              </div>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-1 gap-4 w-full md:w-64">
              <div className="p-4 bg-black/40 rounded-2xl border border-white/5 backdrop-blur-md">
                <span className="text-[8px] md:text-[10px] text-slate-500 block mb-1 uppercase font-bold tracking-wider">LOCKED</span>
                <span className="text-sm md:text-lg font-black text-amber-500 tabular-nums">{user?.escrow_locked_balance.toLocaleString()}</span>
              </div>
              <div className="p-4 bg-black/40 rounded-2xl border border-white/5 backdrop-blur-md">
                <span className="text-[8px] md:text-[10px] text-slate-500 block mb-1 uppercase font-bold tracking-wider">AVAILABLE</span>
                <span className="text-sm md:text-lg font-black text-emerald-500 tabular-nums">{(user?.wallet_balance - user?.escrow_locked_balance).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className="absolute bottom-6 right-8 md:bottom-auto md:top-8 md:right-8">
            <ChevronLeft size={24} className="text-slate-600 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>

        {/* Quick Stats Banner */}
        <div className="lg:col-span-4 grid grid-cols-3 lg:grid-cols-1 gap-4">
          <StatCard label="معامله فعال" value={activeCount} />
          <StatCard label="تراکنش‌های کل" value={contracts.length} />
          <div className="p-6 bg-white/5 rounded-[2rem] border border-white/5 flex flex-col items-center justify-center text-center gap-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">پشتیبانی</span>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
              <span className="text-xs font-black text-white uppercase">Online</span>
            </div>
          </div>
        </div>
      </div>

      {/* Features Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
        <FeatureCard 
          icon={<Plus className="text-blue-500" />} 
          label="معامله جدید" 
          desc="ایجاد قرارداد امن میانجی"
          onClick={() => setView('create')} 
        />
        <FeatureCard 
          icon={<QrCode className="text-amber-500" />} 
          label="اسکن قرارداد" 
          desc="تایید و امضای حضوری سریع"
          onClick={() => {
            const tg = (window as any).Telegram?.WebApp;
            if (tg?.showScanQrPopup) tg.showScanQrPopup({ text: 'کد قرارداد را اسکن کنید' });
            else {
              // Trigger our custom web scanner (handled in App component state)
              document.dispatchEvent(new CustomEvent('open-qr-scanner'));
            }
          }} 
        />
        <FeatureCard 
          icon={<ShieldCheck className="text-emerald-500" />} 
          label="مرکز قوانین" 
          desc="راهنمای استفاده و امنیت"
          onClick={() => {}} 
        />
        <FeatureCard 
          icon={<Users className="text-purple-500" />} 
          label="مخاطبین من" 
          desc="مدیریت دوستان و شرکا"
          onClick={() => setView('contacts')} 
        />
      </div>

      {/* Recent Activity */}
      <div className="space-y-6">
        <div className="flex items-center justify-between px-2 mt-4">
          <h2 className="text-lg md:text-xl font-black text-white">آخرین معاملات</h2>
          <button onClick={() => setView('deals')} className="text-xs md:text-sm font-bold text-blue-500 hover:text-blue-400 transition-colors">مشاهده همه لیست</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {contracts.slice(0, 6).map((c: any) => (
            <DealCard key={c.contract_id} contract={c} onClick={() => { localStorage.setItem('selected_contract', JSON.stringify(c)); setView('detail'); }} />
          ))}
          {contracts.length === 0 && (
            <div className="md:col-span-2 lg:col-span-3 p-16 text-center border-2 border-dashed border-white/5 rounded-[3rem] bg-white/[0.02]">
              <ClipboardList size={48} className="mx-auto text-slate-800 mb-6" />
              <p className="text-sm font-bold text-slate-600">هنوز هیچ معامله‌ای ثبت نکرده‌اید</p>
              <button onClick={() => setView('create')} className="mt-6 text-blue-500 font-bold text-xs uppercase tracking-widest border-b border-blue-500/30 pb-1">ایجاد اولین معامله</button>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function StatCard({ label, value }: any) {
  return (
    <div className="p-6 bg-white/5 rounded-[2rem] border border-white/5 flex flex-col items-center justify-center text-center gap-1 transition-all hover:bg-white/[0.08]">
      <span className="text-[10px] font-bold text-slate-500 block uppercase tracking-wider">{label}</span>
      <span className="text-2xl md:text-3xl font-black text-white tabular-nums">{value}</span>
    </div>
  );
}

function FeatureCard({ icon, label, desc, onClick }: any) {
  return (
    <button 
      onClick={onClick}
      className="p-4 md:p-6 rounded-[2rem] bg-[#09090b] border border-white/5 text-right space-y-3 active:scale-95 transition-all group hover:border-blue-500/30 flex flex-col items-end w-full"
    >
      <div className="w-7 h-7 md:w-9 md:h-9 rounded-lg bg-white/5 flex items-center justify-center transition-colors group-hover:bg-blue-600/10 shrink-0">
        {React.cloneElement(icon, { size: 14 })}
      </div>
      <div>
        <h3 className="text-[11px] md:text-[13px] font-black text-white">{label}</h3>
        <p className="text-[8px] md:text-[10px] font-medium text-slate-500 leading-tight line-clamp-1">{desc}</p>
      </div>
    </button>
  );
}

function DealDetailView({ user, setView, refresh, isDebug }: any) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'chat'>('info');
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

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

  const sendMsg = async (text: string = newMessage, type: Message['message_type'] = 'text', url?: string) => {
    if ((!text.trim() && type === 'text') || !user || !contract) return;
    const { error } = await supabase.from('contract_messages').insert({
      contract_id: contract.contract_id,
      sender_id: user.id,
      message_text: text,
      message_type: type,
      attachment_url: url
    });
    if (!error) {
      setNewMessage('');
      setShowAttachments(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const mockUrl = URL.createObjectURL(audioBlob);
        sendMsg('پیام صوتی', 'voice', mockUrl);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      alert('دسترسی به میکروفون داده نشد.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'file') => {
    const file = e.target.files?.[0];
    if (file) {
      const mockUrl = URL.createObjectURL(file);
      sendMsg(file.name, type, mockUrl);
    }
  };

  const scanQr = () => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.showScanQrPopup) {
      tg.showScanQrPopup({ text: 'کد کیوآر قرارداد را اسکن کنید' }, (text: string) => {
        if (text === contract?.contract_id) {
          tg.closeScanQrPopup();
          alert('قرارداد با موفقیت تایید و امضا شد.');
        }
        return true;
      });
    } else {
      alert('این قابلیت در اپلیکیشن تلگرام در دسترس است. (در دمو صرفاً شبیه‌سازی می‌شود)');
    }
  };

  const actions = contract ? getEscrowActions(contract, user.id, () => {
    refresh();
    supabase.from('contracts').select('*').eq('contract_id', contract.contract_id).maybeSingle().then(({data}) => {
      if (data) {
        setContract(data);
        localStorage.setItem('selected_contract', JSON.stringify(data));
      }
    });
  }) : [];

  if (!contract) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 h-full flex flex-col lg:max-w-6xl lg:mx-auto">
      {/* Header & Mobile Tab Switcher */}
      <div className="flex items-center justify-between gap-4">
        <button onClick={() => setView('dashboard')} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 active:scale-90 transition-all shrink-0">
          <ChevronRight size={20} />
        </button>
        
        <div className="flex-1 flex justify-center lg:hidden">
          <div className="flex p-1 bg-[#09090b] rounded-2xl border border-white/5">
            <button onClick={() => setActiveTab('info')} className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${activeTab === 'info' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500'}`}>جزئیات</button>
            <button onClick={() => setActiveTab('chat')} className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${activeTab === 'chat' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500'}`}>گفتگو</button>
          </div>
        </div>

        <div className="hidden lg:block flex-1 text-center">
          <h2 className="text-xl font-black text-white">مدیریت قرارداد</h2>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowQr(true)} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-blue-500 active:scale-90 transition-all">
            <QrCode size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 lg:grid lg:grid-cols-12 lg:gap-8 min-h-0 overflow-hidden">
        {/* Info Column */}
        <div className={`lg:col-span-5 lg:flex lg:flex-col space-y-6 ${activeTab === 'info' ? 'block' : 'hidden lg:block'} overflow-y-auto pr-1`}>
          <div className="flex flex-col items-center gap-4 py-8 bg-[#09090b] border border-white/5 rounded-[2.5rem] relative overflow-hidden shrink-0">
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

          <div className="grid grid-cols-2 gap-4 shrink-0">
            <DetailItem label="بودجه پروژه" value={contract.amount.toLocaleString()} unit="تومان" />
            <DetailItem label="وضعیت" value={translateStatus(contract.status)} color="text-blue-500" />
            <DetailItem label="کارفرما" value={user.id === contract.buyer_id ? 'شما' : 'طرف مقابل'} />
            <DetailItem label="مجری" value={user.id === contract.seller_id ? 'شما' : 'طرف مقابل'} />
          </div>

          <div className="pt-4 space-y-3 shrink-0">
             <button 
               onClick={scanQr}
               className="w-full h-16 bg-white text-black rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95"
             >
               <Camera size={20} />
               امضای حضوری (اسکن QR)
             </button>
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

        {/* Chat Column */}
        <div className={`lg:col-span-7 flex flex-col bg-[#09090b] rounded-[2.5rem] border border-white/5 overflow-hidden h-[60vh] lg:h-full relative ${activeTab === 'chat' ? 'flex' : 'hidden lg:flex'}`}>
          <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-hide bg-[#050505]">
            <div className="flex justify-center mb-6">
               <span className="px-4 py-1 bg-white/5 rounded-full text-[10px] text-slate-500 font-bold backdrop-blur-md border border-white/5">امروز</span>
            </div>

            {messages.map(m => (
              <div key={m.id} className={`flex ${m.sender_id === user.id ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[85%] px-4 py-3 rounded-[1.5rem] text-[12px] leading-relaxed relative shadow-lg ${m.sender_id === user.id ? 'bg-blue-600 text-white rounded-br-none' : 'bg-[#18181b] text-slate-200 border border-white/5 rounded-bl-none'}`}>
                  {m.message_type === 'text' || !m.message_type ? (
                    <p className="whitespace-pre-wrap">{m.message_text}</p>
                  ) : null}
                  {m.message_type === 'image' && <img src={m.attachment_url} className="rounded-xl mb-1 max-w-full cursor-pointer hover:opacity-90 transition-opacity" alt="Attachment" onClick={() => window.open(m.attachment_url)} />}
                  {m.message_type === 'voice' && <VoiceMessagePlayer url={m.attachment_url!} isOwn={m.sender_id === user.id} />}
                  {m.message_type === 'file' && (
                    <a href={m.attachment_url} target="_blank" rel="noreferrer" className="flex items-center gap-3 p-3 bg-black/20 rounded-xl border border-white/5 hover:bg-black/40 transition-all">
                      <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center text-blue-500"><FileText size={16} /></div>
                      <div className="flex-1 overflow-hidden">
                        <p className="text-[10px] font-bold text-white truncate">{m.message_text}</p>
                        <p className="text-[8px] text-slate-500 uppercase">Document / File</p>
                      </div>
                    </a>
                  )}
                  <div className={`flex items-center gap-1 mt-1 justify-end opacity-50 ${m.sender_id === user.id ? 'text-blue-100' : 'text-slate-500'}`}>
                    <span className="text-[8px] font-mono">{new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>
                    {m.sender_id === user.id && <Check size={10} strokeWidth={3} />}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <AnimatePresence>
            {showAttachments && (
              <motion.div initial={{ y: 100 }} animate={{ y: 0 }} exit={{ y: 100 }} className="absolute bottom-20 left-4 right-4 bg-black border border-white/10 rounded-3xl p-4 grid grid-cols-3 gap-4 shadow-2xl z-20">
                <AttachmentBtn icon={<ImageIcon />} label="گالری" onClick={() => document.getElementById('imgInput')?.click()} />
                <AttachmentBtn icon={<FileText />} label="فایل" onClick={() => document.getElementById('fileInput')?.click()} />
                <AttachmentBtn icon={<Camera />} label="دوربین" onClick={() => {}} />
                <input id="imgInput" type="file" accept="image/*" hidden onChange={e => handleFileUpload(e, 'image')} />
                <input id="fileInput" type="file" hidden onChange={e => handleFileUpload(e, 'file')} />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="p-4 bg-black/40 border-t border-white/5 flex items-center gap-2">
            <button onClick={() => setShowAttachments(!showAttachments)} className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${showAttachments ? 'bg-blue-600 text-white' : 'bg-white/5 text-slate-400'}`}>
              <Paperclip size={20} />
            </button>
            <input 
              className="flex-1 bg-[#09090b] border border-white/10 rounded-2xl px-5 h-12 text-sm text-white focus:border-blue-600 outline-none"
              placeholder="پیام خود را بنویسید..."
              value={newMessage}
              onChange={e => setNewMessage(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && sendMsg()}
            />
            {newMessage.trim() ? (
              <button onClick={() => sendMsg()} className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20 active:scale-90 transition-all">
                <Send size={18} />
              </button>
            ) : (
              <button 
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
                onTouchStart={startRecording}
                onTouchEnd={stopRecording}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${isRecording ? 'bg-rose-600 text-white animate-pulse' : 'bg-white/5 text-slate-400'}`}
              >
                <Mic size={20} />
              </button>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showQr && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-8">
            <div className="w-full max-w-sm bg-[#09090b] border border-white/10 rounded-[3rem] p-8 text-center space-y-6 relative">
              <button onClick={() => setShowQr(false)} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-slate-400"><X size={20} /></button>
              <div className="pt-8">
                <div className="p-6 bg-white rounded-3xl inline-block shadow-[0_0_50px_rgba(255,255,255,0.1)]">
                  <QRCodeSVG value={contract.contract_id} size={200} />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-black text-white">کیو‌آر تایید قرارداد</h3>
                <p className="text-xs text-slate-500 leading-relaxed">طرف مقابل با اسکن این کد می‌تواند قرارداد را در لحظه امضا و تایید کند.</p>
              </div>
              <div className="pt-4">
                <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">{contract.contract_id}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function AttachmentBtn({ icon, label, onClick }: any) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 p-4 bg-white/5 rounded-2xl hover:bg-white/10 transition-all active:scale-95">
      <div className="text-blue-500">{icon}</div>
      <span className="text-[10px] font-bold text-slate-400">{label}</span>
    </button>
  );
}

// --- Helpers & Small Components ---

function Sidebar({ isOpen, onClose, user, setView, onLogout }: any) {
  const menuItems = [
    { icon: <User />, label: 'پروفایل کاربری', view: 'profile' },
    { icon: <CreditCard />, label: 'تراکنش‌های مالی', view: 'wallet' },
    { icon: <Sparkles />, label: 'بازارچه میانجی', view: 'messages', badge: 'بزودی', disabled: true },
    { icon: <Mic />, label: 'تماس صوتی و تصویری', view: 'dashboard', badge: 'بزودی', disabled: true },
    { icon: <Users />, label: 'معرفی به دوستان', view: 'dashboard' },
    { icon: <ShieldCheck />, label: 'قوانین و مقررات', view: 'dashboard' },
    { icon: <HelpCircle />, label: 'پشتیبانی آنلاین', view: 'dashboard' },
    { icon: <Settings />, label: 'تنظیمات پنل', view: 'dashboard' },
    { icon: <Info />, label: 'درباره میانجی', view: 'dashboard' },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1000]"
          />
          <motion.div 
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 bottom-0 w-[85%] max-w-xs bg-[#09090b] border-l border-white/10 z-[1001] p-5 flex flex-col"
          >
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20">
                  <Shield size={18} />
                </div>
                <span className="font-black text-base text-white">منوی اصلی</span>
              </div>
              <button onClick={onClose} className="w-9 h-9 rounded-full bg-white/5 flex items-center justify-center text-slate-500 active:scale-90 transition-all"><X size={18} /></button>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto scrollbar-hide -mx-2 px-2">
              {menuItems.map((item, idx) => (
                <button 
                  key={idx}
                  disabled={item.disabled}
                  onClick={() => { setView(item.view); onClose(); }}
                  className={`w-full flex items-center gap-4 p-3 rounded-2xl transition-all group relative ${item.disabled ? 'opacity-40 grayscale cursor-not-allowed' : 'hover:bg-white/5 text-slate-400 hover:text-white'}`}
                >
                  <div className={`w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center transition-colors ${!item.disabled && 'group-hover:bg-blue-600/10 group-hover:text-blue-500'}`}>
                    {React.cloneElement(item.icon as any, { size: 18 })}
                  </div>
                  <div className="flex-1 text-right">
                    <span className="text-xs font-bold block leading-none">{item.label}</span>
                    {item.badge && <span className="text-[8px] font-black text-blue-500 uppercase tracking-tighter mt-1 block">{item.badge}</span>}
                  </div>
                </button>
              ))}
            </div>

            <div className="pt-5 border-t border-white/5 space-y-4">
              <div className="p-3 rounded-2xl bg-white/5 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black text-sm shadow-lg border-2 border-black/50">{user?.full_name?.[0] || 'U'}</div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-black text-white truncate">{user?.full_name || 'کاربر مهمان'}</p>
                  <p className="text-[9px] text-slate-500 font-mono" dir="ltr">{user?.phone_number}</p>
                </div>
              </div>
              <button 
                onClick={() => { onLogout(); onClose(); }}
                className="w-full h-12 rounded-xl bg-rose-500/10 text-rose-500 font-bold text-xs flex items-center justify-center gap-2 active:scale-95 transition-all border border-rose-500/5"
              >
                <LogOut size={16} /> خروج از حساب
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function NavBtn({ active, onClick, icon, label }: any) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1.5 transition-all ${active ? 'text-blue-500' : 'text-slate-500'}`}>
      <div className={`transition-all duration-300 ${active ? 'scale-110 -translate-y-1' : 'opacity-70'}`}>{icon}</div>
      <span className={`text-[9px] font-black uppercase tracking-widest transition-all ${active ? 'opacity-100' : 'opacity-40'}`}>{label}</span>
      {active && <motion.div layoutId="nav-dot" className="w-1 h-1 bg-blue-500 rounded-full" />}
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

function MessagesView({ contracts, setView }: any) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-xl font-black text-white">پیام‌ها</h2>
        <div className="flex gap-2">
          <button className="px-4 py-1.5 bg-white/5 border border-white/10 rounded-full text-[10px] font-bold text-slate-400 hover:text-white transition-all flex items-center gap-2">
            <Sparkles size={12} className="text-amber-500" />
            بازارچه (بزودی)
          </button>
        </div>
      </div>

      <div className="bg-[#09090b] border border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-white/5">
        {contracts.length > 0 ? (
          contracts.map((c: any) => (
            <button 
              key={c.contract_id} 
              onClick={() => { localStorage.setItem('selected_contract', JSON.stringify(c)); setView('detail'); }}
              className="w-full p-5 flex items-center gap-4 hover:bg-white/5 transition-all active:bg-white/10 text-right group"
            >
              <div className="w-12 h-12 rounded-2xl bg-blue-600/10 flex items-center justify-center text-blue-500 shrink-0">
                <MessageCircle size={20} />
              </div>
              <div className="flex-1 overflow-hidden">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-black text-white truncate">{c.title}</span>
                  <span className="text-[8px] text-slate-600 font-mono">{(new Date(c.created_at)).toLocaleDateString('fa-IR')}</span>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-slate-500 truncate">گفتگو درباره قرارداد {c.contract_id}</p>
                  <StatusLabel status={c.status} small />
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="p-16 text-center">
            <MessageSquare size={48} className="mx-auto text-slate-800 mb-4 opacity-50" />
            <p className="text-xs font-bold text-slate-600">هنوز گفتگویی شروع نشده است</p>
          </div>
        )}
      </div>

      {/* Preparation for Marketplace */}
      <div className="p-8 border-2 border-dashed border-white/5 rounded-[2.5rem] bg-white/[0.01] text-center space-y-4">
        <div className="w-12 h-12 bg-amber-500/10 text-amber-500 rounded-2xl flex items-center justify-center mx-auto">
          <Sparkles size={24} />
        </div>
        <div>
          <h3 className="text-sm font-black text-white">منتظر بازارچه میانجی باشید</h3>
          <p className="text-[10px] text-slate-500 leading-relaxed mt-1">بستری امن برای خرید و فروش خدمات و کالاهای دیجیتال با ضمانت میانجی</p>
        </div>
      </div>
    </motion.div>
  );
}

function CreateDealView({ user, onBack, onSuccess }: any) {
  const [formData, setFormData] = useState({ 
    title: '', 
    amount: '', 
    role: 'seller', 
    phone: '',
    deadline: '7',
    revisions: '2',
    description: '',
    category: 'digital'
  });
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
        // In real app, we would add the expanded columns here
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
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 active:scale-90 transition-all"><ChevronRight size={20} /></button>
        <h2 className="text-xl font-black text-white">ایجاد معامله جدید</h2>
      </div>

      <div className="bg-[#09090b] border border-white/5 p-8 md:p-12 rounded-[2.5rem] space-y-8 shadow-2xl">
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">عنوان پروژه</label>
              <input 
                placeholder="طراحی وب‌سایت، فروش اکانت و..."
                value={formData.title}
                onChange={e => setFormData({...formData, title: e.target.value})}
                className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">مبلغ معامله (تومان)</label>
              <input 
                type="number"
                placeholder="0"
                value={formData.amount}
                onChange={e => setFormData({...formData, amount: e.target.value})}
                className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none transition-all"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">دسته‌بندی معامله</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
               <CategoryBtn active={formData.category === 'digital'} onClick={() => setFormData({...formData, category: 'digital'})} label="خدمات دیجیتال" icon={<Sparkles size={12} />} />
               <CategoryBtn active={formData.category === 'physical'} onClick={() => setFormData({...formData, category: 'physical'})} label="کالای فیزیکی" icon={<CreditCard size={12} />} />
               <CategoryBtn active={formData.category === 'account'} onClick={() => setFormData({...formData, category: 'account'})} label="اکانت و اشتراک" icon={<User size={12} />} />
               <CategoryBtn active={formData.category === 'other'} onClick={() => setFormData({...formData, category: 'other'})} label="سایر موارد" icon={<MoreVertical size={12} />} />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">شماره همراه طرف مقابل</label>
            <input 
              placeholder="0912..." 
              value={formData.phone}
              onChange={e => setPhone(e.target.value, formData, setFormData)}
              className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">مهلت تحویل (روز)</label>
              <input 
                type="number"
                placeholder="7"
                value={formData.deadline}
                onChange={e => setFormData({...formData, deadline: e.target.value})}
                className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">تعداد ویرایش رایگان</label>
              <input 
                type="number"
                placeholder="2"
                value={formData.revisions}
                onChange={e => setFormData({...formData, revisions: e.target.value})}
                className="w-full h-14 bg-black border border-white/10 rounded-2xl px-5 text-sm text-white focus:border-blue-600 outline-none transition-all"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">توضیحات و شرایط قرارداد</label>
            <textarea 
              placeholder="جزئیات پروژه، نحوه تحویل و هرگونه توافق جانبی را اینجا بنویسید..."
              value={formData.description}
              onChange={e => setFormData({...formData, description: e.target.value})}
              className="w-full h-32 bg-black border border-white/10 rounded-2xl p-5 text-sm text-white focus:border-blue-600 outline-none transition-all resize-none"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">نقش شما در معامله</label>
            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={() => setFormData({...formData, role: 'seller'})}
                className={`h-16 rounded-2xl font-bold text-sm border transition-all flex flex-col items-center justify-center gap-1 ${formData.role === 'seller' ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-black border-white/10 text-slate-500'}`}
              >
                مجری هستم
                <span className="text-[8px] opacity-60">ارائه‌دهنده خدمات/کالا</span>
              </button>
              <button 
                onClick={() => setFormData({...formData, role: 'buyer'})}
                className={`h-16 rounded-2xl font-bold text-sm border transition-all flex flex-col items-center justify-center gap-1 ${formData.role === 'buyer' ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-black border-white/10 text-slate-500'}`}
              >
                کارفرما هستم
                <span className="text-[8px] opacity-60">پرداخت‌کننده وجه</span>
              </button>
            </div>
          </div>
        </div>

        <div className="pt-4">
          <button 
            onClick={handleSubmit}
            disabled={loading}
            className="w-full h-16 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
          >
            {loading ? <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : (
              <>
                <Check size={20} />
                تایید و ایجاد قرارداد امن
              </>
            )}
          </button>
          <p className="text-[10px] text-slate-500 text-center mt-4">با کلیک روی این دکمه، شما <span className="text-blue-500">قوانین میانجی</span> را می‌پذیرید.</p>
        </div>
      </div>
    </motion.div>
  );
}

function CategoryBtn({ active, onClick, label, icon }: any) {
  return (
    <button 
      onClick={onClick}
      className={`h-12 rounded-xl flex items-center justify-center gap-2 text-[10px] font-bold border transition-all ${active ? 'bg-white/10 border-white/20 text-white' : 'bg-black border-white/5 text-slate-500 hover:border-white/10'}`}
    >
      {icon}
      {label}
    </button>
  );
}

function ContactsView({ user, setView }: any) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    // In real app, fetch from user_contacts
    setContacts([
      { id: 1, full_name: 'رضا علوی', phone_number: '09120001122', status: 'verified', trust_score: 98 },
      { id: 2, full_name: 'مریم حسینی', phone_number: '09355554433', status: 'verified', trust_score: 100 },
      { id: 3, full_name: 'شرکت آریا', phone_number: '02188889900', status: 'verified', trust_score: 85 },
    ]);
  }, []);

  const filtered = contacts.filter(c => c.full_name.includes(searchTerm) || c.phone_number.includes(searchTerm));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-xl font-black text-white">مخاطبین من</h2>
        <button className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg active:scale-90 transition-all">
          <Plus size={20} />
        </button>
      </div>

      <div className="relative">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
        <input 
          placeholder="جستجوی نام یا شماره همراه..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full h-14 bg-[#09090b] border border-white/5 rounded-2xl pr-12 pl-5 text-sm text-white focus:border-blue-600 outline-none transition-all"
        />
      </div>

      <div className="bg-[#09090b] border border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-white/5">
        {filtered.map(contact => (
          <div key={contact.id} className="p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors">
            <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-slate-300 font-black relative">
              {contact.full_name[0]}
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-black" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-black text-white">{contact.full_name}</span>
                <span className="px-2 py-0.5 bg-blue-500/10 text-blue-500 text-[8px] font-black rounded-full uppercase">Trust {contact.trust_score}</span>
              </div>
              <p className="text-[10px] text-slate-500 font-mono" dir="ltr">{contact.phone_number}</p>
            </div>
            <div className="flex items-center gap-2">
               <button 
                onClick={() => setView('create')}
                className="w-10 h-10 rounded-xl bg-blue-600/10 text-blue-500 flex items-center justify-center hover:bg-blue-600 hover:text-white transition-all active:scale-90"
               >
                 <Plus size={18} />
               </button>
               <button className="w-10 h-10 rounded-xl bg-white/5 text-slate-500 flex items-center justify-center hover:bg-white/10 transition-all active:scale-90">
                 <MoreVertical size={18} />
               </button>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function WalletView({ user }: any) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8 max-w-2xl mx-auto">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-[1.5rem] flex items-center justify-center mx-auto border border-emerald-500/20">
          <Wallet size={28} />
        </div>
        <h2 className="text-2xl font-black text-white">کیف پول من</h2>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div className="p-8 bg-[#09090b] border border-white/5 rounded-[2.5rem] flex flex-col items-center gap-2">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">موجودی کل</span>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-black text-white tabular-nums">{user?.wallet_balance.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500 uppercase">Toman</span>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button className="h-16 bg-white text-black rounded-2xl font-black flex items-center justify-center gap-2 shadow-xl active:scale-95 transition-all text-sm">
            <Plus size={18} /> افزایش موجودی
          </button>
          <button className="h-16 bg-[#09090b] border border-white/10 text-white rounded-2xl font-black flex items-center justify-center gap-2 active:scale-95 transition-all text-sm">
            <ArrowUpRight size={18} /> درخواست تسویه
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function ProfileView({ user, setView, onLogout }: any) {
  const profileMenu = [
    { icon: <Wallet size={16} />, label: 'مدیریت کیف پول', desc: 'شارژ و برداشت موجودی', action: () => setView('wallet') },
    { icon: <ShieldCheck size={16} />, label: 'احراز هویت (KYC)', desc: 'تایید هویت برای افزایش سقف معامله', badge: 'تایید شده', badgeColor: 'text-emerald-500' },
    { icon: <ClipboardList size={16} />, label: 'تاریخچه معاملات', desc: 'مشاهده تمام قراردادهای قبلی', action: () => setView('deals') },
    { icon: <Bell size={16} />, label: 'تنظیمات اطلاع‌رسانی', desc: 'پیامک و نوتیفیکیشن تلگرام' },
    { icon: <Lock size={16} />, label: 'امنیت و ورود', desc: 'مدیریت دستگاه‌ها و نشست‌های فعال' },
    { icon: <HelpCircle size={16} />, label: 'مرکز پشتیبانی', desc: 'پاسخ به سوالات و ارسال تیکت' },
  ];

  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-6 max-w-2xl mx-auto pb-10">
      {/* Telegram-style Profile Header */}
      <div className="bg-[#09090b] border border-white/5 rounded-[2.5rem] p-8 flex flex-col items-center text-center space-y-4 relative overflow-hidden shadow-2xl">
        <div className="absolute top-0 left-0 w-full h-32 bg-linear-to-b from-blue-600/10 to-transparent" />
        <div className="relative">
          <div className="w-24 h-24 rounded-[2rem] bg-blue-600 flex items-center justify-center text-white font-black text-3xl shadow-xl shadow-blue-600/20 border-4 border-black">
            {user?.full_name?.[0] || 'U'}
          </div>
          <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-emerald-500 rounded-full border-4 border-black flex items-center justify-center text-white">
            <ShieldCheck size={14} fill="currentColor" />
          </div>
        </div>
        <div className="relative z-10">
          <h2 className="text-xl font-black text-white">{user?.full_name || 'کاربر مهمان'}</h2>
          <p className="text-xs text-slate-500 font-mono" dir="ltr">{user?.phone_number || '09xxxxxxxxx'}</p>
        </div>
        <div className="flex items-center gap-2 px-4 py-1 bg-white/5 rounded-full border border-white/5">
          <Sparkles size={12} className="text-amber-500" />
          <span className="text-[10px] font-black text-amber-500 uppercase tracking-widest">Premium User</span>
        </div>
      </div>

      {/* Trust Score Summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-[#09090b] border border-white/5 rounded-[2rem] p-5 space-y-2">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">امتیاز اعتماد</span>
          <div className="flex items-center gap-2">
            <Star size={14} className="text-blue-500" fill="currentColor" />
            <span className="text-lg font-black text-white">{user?.trust_score || 100}</span>
          </div>
        </div>
        <div className="bg-[#09090b] border border-white/5 rounded-[2rem] p-5 space-y-2">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">معاملات موفق</span>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-500" />
            <span className="text-lg font-black text-white">12</span>
          </div>
        </div>
      </div>

      {/* Profile Menu */}
      <div className="bg-[#09090b] border border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-white/5">
        {profileMenu.map((item, idx) => (
          <button 
            key={idx} 
            onClick={item.action}
            className="w-full p-5 flex items-center gap-4 hover:bg-white/5 transition-all active:bg-white/10 text-right group"
          >
            <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400 group-hover:bg-blue-600/10 group-hover:text-blue-500 transition-colors shrink-0">
              {item.icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-black text-white">{item.label}</span>
                {item.badge && <span className={`text-[9px] font-black uppercase tracking-widest ${item.badgeColor}`}>{item.badge}</span>}
              </div>
              <p className="text-[10px] text-slate-500">{item.desc}</p>
            </div>
            <ChevronLeft size={16} className="text-slate-700 group-hover:text-slate-400 transition-colors" />
          </button>
        ))}
      </div>

      {/* Logout */}
      <button 
        onClick={onLogout}
        className="w-full h-16 rounded-[1.5rem] bg-rose-500/10 text-rose-500 font-black flex items-center justify-center gap-3 active:scale-95 transition-all border border-rose-500/10 hover:bg-rose-500/20"
      >
        <LogOut size={18} /> خروج از حساب کاربری
      </button>

      <div className="text-center">
        <p className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Mianji Escrow v2.4.0</p>
      </div>
    </motion.div>
  );
}

function setPhone(val: string, formData: any, setFormData: any) {
  setFormData({...formData, phone: val});
}

// --- Voice Message Player ---
function VoiceMessagePlayer({ url, isOwn }: { url: string, isOwn: boolean }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => {
      setIsPlaying(false);
      setProgress(0);
    };
    audio.ontimeupdate = () => {
      if (audio.duration) setProgress((audio.currentTime / audio.duration) * 100);
    };
    return () => {
      audio.pause();
      audio.src = '';
    };
  }, [url]);

  const toggle = () => {
    if (isPlaying) audioRef.current?.pause();
    else audioRef.current?.play();
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="flex items-center gap-3 py-1 min-w-[160px]">
      <button onClick={toggle} className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-blue-600/20 hover:bg-blue-600/30 text-blue-500'}`}>
        {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="mr-[-2px]" />}
      </button>
      <div className="h-1.5 flex-1 bg-white/10 rounded-full overflow-hidden relative">
        <motion.div 
          className={`absolute left-0 top-0 h-full ${isOwn ? 'bg-white' : 'bg-blue-600'}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="text-[9px] font-mono opacity-60">Audio</span>
    </div>
  );
}

// --- Web QR Scanner Modal ---
function QrScannerModal({ onClose, onScan }: { onClose: () => void, onScan: (res: string) => void }) {
  useEffect(() => {
    const scanner = new Html5QrcodeScanner("qr-reader", { fps: 10, qrbox: 250 }, false);
    scanner.render((result) => {
      onScan(result);
      scanner.clear();
    }, (err) => {
      // ignore scan errors
    });
    return () => {
      scanner.clear().catch(e => console.error("Failed to clear scanner", e));
    };
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/95 backdrop-blur-xl z-[300] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#09090b] border border-white/10 rounded-[2.5rem] p-8 space-y-6 relative">
        <button onClick={onClose} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-slate-400 z-10"><X size={20} /></button>
        <div className="text-center space-y-2 pt-4">
          <h3 className="text-xl font-black text-white">اسکنر قرارداد</h3>
          <p className="text-xs text-slate-500">دوربین را مقابل کد QR قرارداد قرار دهید</p>
        </div>
        <div id="qr-reader" className="overflow-hidden rounded-3xl border border-white/5 bg-black/50" />
        <p className="text-[10px] text-slate-600 text-center">میانجی به صورت خودکار کد را شناسایی می‌کند</p>
      </div>
    </motion.div>
  );
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
