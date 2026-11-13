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
  Menu, CreditCard, Star, Sparkles, Sun, Moon
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { auth, db } from './lib/firebase';
import { 
  collection, query, where, getDocs, orderBy, limit, 
  doc, getDoc, onSnapshot, setDoc, updateDoc, addDoc, serverTimestamp 
} from 'firebase/firestore';
import { signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth';
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
type View = 'auth' | 'dashboard' | 'deals' | 'create' | 'wallet' | 'profile' | 'detail' | 'support' | 'notifications' | 'messages' | 'contacts' | 'dispute' | 'direct_chat';

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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showWebScanner, setShowWebScanner] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(true);

  useEffect(() => {
    if (isDarkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [isDarkMode]);

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

  // Auth & Init
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      try {
        if (fbUser) {
          // User is signed in via Firebase
          const userDoc = await getDoc(doc(db, 'users', fbUser.uid));
          if (userDoc.exists()) {
            const userData = { id: userDoc.id, ...userDoc.data() } as UserProfile;
            setUser(userData);
            setIsAuthenticated(true);
            setView('dashboard');
            fetchInitialData(fbUser.uid);
          } else {
            remoteLog('warn', `Firebase user ${fbUser.uid} has no Firestore profile.`);
            // Maybe handle missing profile?
          }
        } else {
          setIsAuthenticated(false);
          setUser(null);
          setView('auth');
        }
      } catch (err: any) {
        remoteLog('error', 'Auth state change initialization failed', err);
        // If it's a permission error, maybe sign out to be safe
        if (err.code === 'permission-denied') {
          signOut(auth).catch(() => {});
        }
      } finally {
        setLoading(false);
      }
    });

    // Check for Telegram Web App (TWA)
    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      tg.expand();
      tg.ready();
      if (tg.initData && !auth.currentUser) {
        fetch('/api/auth/telegram-webapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: tg.initData })
        })
        .then(res => res.json())
        .then(async (data) => {
          if (data.success && data.customToken) {
            await signInWithCustomToken(auth, data.customToken);
          }
        })
        .catch(err => remoteLog('error', 'Telegram WebApp auto-login failed', err));
      }
    }

    return () => unsubscribe();
  }, []);

  const fetchInitialData = async (userId: string | number) => {
    try {
      // 1. Fetch User
      const userDoc = await getDoc(doc(db, 'users', userId.toString()));
      if (userDoc.exists()) {
        setUser({ id: userDoc.id, ...userDoc.data() } as UserProfile);
      }

      // 2. Fetch Contracts (Deals)
      const dealsQuery = query(
        collection(db, 'deals'),
        where('buyer_id', '==', userId.toString()),
        orderBy('createdAt', 'desc')
      );
      
      const buyerDeals = await getDocs(dealsQuery);
      const sellerDeals = await getDocs(query(
        collection(db, 'deals'),
        where('seller_id', '==', userId.toString()),
        orderBy('createdAt', 'desc')
      ));
      
      const allDeals = [...buyerDeals.docs, ...sellerDeals.docs]
        .map(doc => ({ id: doc.id, ...doc.data() } as Contract))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      
      setContracts(allDeals);

      // 3. Fetch Notifications
      const notifyQuery = query(
        collection(db, 'notifications'),
        where('user_id', '==', userId.toString()),
        orderBy('createdAt', 'desc'),
        limit(10)
      );
      const notifySnap = await getDocs(notifyQuery);
      setNotifications(notifySnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (err) {
      remoteLog('error', 'Fetch Initial Data failed', err);
    }
  };

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [loginPhone, setLoginPhone] = useState('');

  const handleLogin = async (phone: string) => {
    if (!phone) return { error: 'لطفا شماره همراه خود را وارد کنید' };
    setIsLoggingIn(true);
    remoteLog('info', `Login attempt for phone: ${phone}`);

    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      
      const otpRes = await res.json();
      if (otpRes.success) {
        setLoginPhone(otpRes.phone || phone);
        setIsOtpSent(true);
        return { success: true };
      } else {
        return { error: otpRes.error || 'خطا در برقراری ارتباط با سرور' };
      }
    } catch (err: any) {
      remoteLog('error', 'Login Exception', err);
      return { error: `خطای شبکه: ${err.message}` };
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleVerifyOtp = async (code: string) => {
    setIsLoggingIn(true);

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: loginPhone, code })
      });
      const result = await res.json();

      if (result.success && result.customToken) {
        await signInWithCustomToken(auth, result.customToken);
      } else {
        throw new Error(result.error || 'کد نامعتبر است.');
      }
    } catch (err: any) {
      remoteLog('error', 'OTP Verify Exception', err);
      return { error: err.message };
    } finally {
      setIsLoggingIn(false);
    }
    return { success: true };
  };

  const handleLogout = async () => {
    remoteLog('info', 'User logged out');
    await signOut(auth);
    localStorage.removeItem('mianji_mock_user');
    localStorage.removeItem('mianji_demo_mode');
    setIsAuthenticated(false);
    setUser(null);
    setView('auth');
  };

  if (loading) return <div className="min-h-screen bg-black flex items-center justify-center"><div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-200 font-sans selection:bg-blue-600/30 overflow-x-hidden transition-colors duration-300" dir="rtl">
        <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} user={user} setView={setView} onLogout={handleLogout} />
        
        <div className="max-w-6xl mx-auto min-h-screen flex flex-col relative pb-24 lg:pb-8 lg:pt-4 px-4 md:px-8 lg:px-12">
          
          {/* Header */}
          {isAuthenticated && (
            <header className="h-16 md:h-20 flex items-center justify-between sticky top-0 bg-white/80 dark:bg-black/80 backdrop-blur-md z-50 border-b border-slate-200 dark:border-white/5 rounded-2xl mb-4 px-4">
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setIsSidebarOpen(true)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all"
                >
                  <Menu size={20} />
                </button>
                <div>
                  <h1 className="text-base md:text-lg font-black text-slate-900 dark:text-white leading-none">میانجی</h1>
                  <span className="text-[9px] md:text-[10px] text-slate-500 uppercase tracking-widest font-bold">Escrow Platform</span>
                </div>
              </div>
              
              <div className="hidden md:flex flex-1 max-w-sm mx-8">
                 <div className="w-full h-10 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl flex items-center px-4 gap-2 text-slate-500">
                    <Search size={16} />
                    <span className="text-xs">جستجو در معاملات...</span>
                 </div>
              </div>

              <div className="flex items-center gap-2 md:gap-3">
                <button 
                  onClick={() => setIsDarkMode(!isDarkMode)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all shadow-protruding"
                >
                  {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button onClick={() => setView('notifications')} className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center relative text-slate-500 dark:text-slate-400 active:scale-90 transition-all shadow-protruding">
                  <Bell size={16} />
                  {notifications.some(n => !n.is_read) && <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 bg-blue-500 rounded-full border-2 border-white dark:border-black" />}
                </button>
                <button onClick={() => setView('profile')} className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all overflow-hidden border-2 border-blue-500/30 shadow-protruding">
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
              {isAuthenticated && view === 'dispute' && <DisputeView user={user} setView={setView} refresh={() => user && fetchInitialData(user.id)} />}
              {isAuthenticated && view === 'direct_chat' && <DirectChatView user={user} setView={setView} />}
              {isAuthenticated && view === 'detail' && <DealDetailView user={user} setView={setView} refresh={() => user && fetchInitialData(user.id)} isDebug={isDebug} />}
              {isAuthenticated && view === 'create' && <CreateDealView user={user} setView={setView} onBack={() => setView('dashboard')} onSuccess={() => { setView('deals'); user && fetchInitialData(user.id); }} />}
            </AnimatePresence>
          </main>

          {/* Bottom Nav */}
          {isAuthenticated && (
            <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[92%] max-w-md h-16 md:h-18 bg-white/90 dark:bg-[#09090b]/90 backdrop-blur-xl border border-slate-200 dark:border-white/10 rounded-[1.5rem] md:rounded-[2rem] flex items-center justify-around px-2 md:px-4 shadow-2xl z-[100] transition-all">
              <NavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={16} />} label="خانه" />
              <NavBtn active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={16} />} label="معاملات" />
              <div className="relative -translate-y-5 md:-translate-y-6">
                <button onClick={() => setView('create')} className="w-12 h-12 md:w-14 md:h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-[0_0_30px_rgba(37,99,235,0.4)] border-4 border-slate-50 dark:border-black active:scale-90 transition-all">
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

function AuthView({ onLogin, onVerify, isLoading, isOtpSent, loginPhone, onToggleDebug, isDebug }: { onLogin: (p: string) => Promise<{success?: boolean, error?: string} | void>, onVerify: (c: string) => Promise<{success?: boolean, error?: string}>, isLoading: boolean, isOtpSent: boolean, loginPhone: string, onToggleDebug: () => void, isDebug: boolean }) {
  const [phone, setPhone] = useState(loginPhone || '');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
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
        <h1 className="text-4xl font-black text-slate-900 dark:text-white mb-4 tracking-tighter transition-colors">میانجی</h1>
        <p className="text-slate-500 text-sm font-medium">امنیت در معاملات فریلنسری و دیجیتال</p>
      </div>

      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 p-8 rounded-[2.5rem] space-y-6 shadow-2xl transition-colors">
        {!isOtpSent ? (
          <>
            <div className="text-right space-y-2 mb-2">
               <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed">
                 برای ورود، شماره همراه خود را وارد کنید. کد تایید به حساب تلگرام شما ارسال خواهد شد.
               </p>
            </div>
            <div className="space-y-3 text-right">
              <label className="text-[11px] font-black text-blue-500 uppercase tracking-widest px-1">شماره همراه</label>
              <input 
                type="tel" 
                placeholder="0912..." 
                value={phone}
                onChange={e => { setPhone(e.target.value); setError(''); }}
                disabled={isLoading}
                className="input-refined"
              />
            </div>
            {error && (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-right">
                <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
                <div className="flex-1">
                  <p className="text-xs font-bold text-rose-500">{error}</p>
                </div>
                <button 
                  onClick={() => setError('')} 
                  className="text-xs font-bold text-slate-400 hover:text-white"
                >
                  تلاش مجدد
                </button>
              </div>
            )}
            <button 
              onClick={async () => {
                setError('');
                const res = await onLogin(phone);
                if (res && typeof res === 'object' && res.error) {
                  setError(res.error);
                }
              }}
              disabled={isLoading || !phone}
              className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3 btn-protruding"
            >
              {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'دریافت کد تایید'}
            </button>
          </>
        ) : (
          <>
            <div className="space-y-3 text-right">
              <label className="text-[11px] font-black text-emerald-500 uppercase tracking-widest px-1">کد تایید ارسال شده را وارد کنید</label>
              <input 
                type="number" 
                placeholder="------" 
                value={code}
                onChange={e => { setCode(e.target.value); setError(''); }}
                disabled={isLoading}
                className={`w-full h-14 bg-slate-50 dark:bg-black border rounded-2xl text-center text-2xl font-black tracking-[0.5em] outline-none transition-all text-slate-900 dark:text-white disabled:opacity-50 shadow-protruding ${error ? 'border-rose-500 ring-4 ring-rose-500/10' : 'border-slate-200 dark:border-white/10 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-600/10'}`}
              />
              {error ? (
                <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-right mt-2">
                  <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
                  <div className="flex-1">
                    <p className="text-xs font-bold text-rose-500">{error}</p>
                  </div>
                  <button 
                    onClick={() => { setError(''); setCode(''); }} 
                    className="text-xs font-bold text-slate-400 hover:text-white"
                  >
                    تلاش مجدد
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-slate-500 text-center">کد تایید به تلگرام {loginPhone || phone} ارسال شد</p>
              )}
            </div>
            <button 
              onClick={async () => {
                setError('');
                const res = await onVerify(code);
                if (res?.error) setError(res.error);
              }}
              disabled={isLoading || code.length < 5}
              className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-black shadow-lg shadow-emerald-600/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3 btn-protruding"
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
      {/* Welcome Brief */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 md:w-16 md:h-16 rounded-[1.5rem] bg-blue-600 flex items-center justify-center text-white shadow-xl shadow-blue-600/20">
            <Sparkles className="w-6 h-6 md:w-8 md:h-8" fill="currentColor" />
          </div>
          <div>
            <h2 className="text-sm md:text-lg font-black text-slate-900 dark:text-white">خوش آمدید، {user?.full_name}</h2>
            <p className="text-[10px] md:text-xs text-slate-500 mt-1 uppercase tracking-widest font-bold">Smart Escrow Panel</p>
          </div>
        </div>
        <div className="text-left hidden sm:block">
           <span className="text-[10px] md:text-xs font-black text-slate-500 uppercase tracking-widest block">وضعیت حساب</span>
           <span className="text-xs md:text-sm font-bold text-emerald-500 flex items-center gap-1 justify-end"><Sparkles size={14} /> کاربر ویژه</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Wallet Card */}
        <div 
          onClick={() => setView('wallet')}
          className="lg:col-span-8 relative p-8 md:p-12 rounded-[3rem] bg-linear-to-br from-blue-600/20 to-transparent border border-slate-200 dark:border-white/5 overflow-hidden group cursor-pointer shadow-2xl transition-all hover:border-blue-500/20 shadow-blue-900/10 dark:shadow-blue-900/20"
        >
          <div className="absolute top-0 right-0 w-80 h-80 bg-blue-600/10 blur-[100px] rounded-full -translate-y-1/2 translate-x-1/2" />
          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-8">
            <div className="space-y-6">
              <div className="flex items-center gap-2 px-4 py-1.5 bg-slate-100 dark:bg-white/5 rounded-full border border-slate-200 dark:border-white/5 w-fit">
                <Wallet size={14} className="text-blue-500" />
                <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-widest">موجودی کیف پول</span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-4xl md:text-6xl font-black text-slate-900 dark:text-white tabular-nums tracking-tighter leading-none">{user?.wallet_balance.toLocaleString()}</span>
                <span className="text-xs md:text-sm font-bold text-slate-500 uppercase">Toman</span>
              </div>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-1 gap-4 w-full md:w-64">
              <div className="p-4 bg-white/40 dark:bg-black/40 rounded-2xl border border-slate-200 dark:border-white/5 backdrop-blur-md">
                <span className="text-[8px] md:text-[10px] text-slate-500 block mb-1 uppercase font-bold tracking-wider">LOCKED</span>
                <span className="text-sm md:text-lg font-black text-amber-500 tabular-nums">{user?.escrow_locked_balance.toLocaleString()}</span>
              </div>
              <div className="p-4 bg-white/40 dark:bg-black/40 rounded-2xl border border-slate-200 dark:border-white/5 backdrop-blur-md">
                <span className="text-[8px] md:text-[10px] text-slate-500 block mb-1 uppercase font-bold tracking-wider">AVAILABLE</span>
                <span className="text-sm md:text-lg font-black text-emerald-500 tabular-nums">{(user?.wallet_balance - user?.escrow_locked_balance).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className="absolute bottom-6 right-8 md:bottom-auto md:top-8 md:right-8">
            <ChevronLeft size={24} className="text-slate-400 dark:text-slate-600 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>

        {/* Quick Stats Banner */}
        <div className="lg:col-span-4 grid grid-cols-3 lg:grid-cols-1 gap-4">
          <StatCard label="معامله فعال" value={activeCount} />
          <StatCard label="تراکنش‌های کل" value={contracts.length} />
          <div className="p-6 bg-white dark:bg-white/5 rounded-[2rem] border border-slate-200 dark:border-white/5 flex flex-col items-center justify-center text-center gap-2 shadow-sm dark:shadow-none">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">پشتیبانی</span>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
              <span className="text-xs font-black text-slate-900 dark:text-white uppercase">Online</span>
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
          <h2 className="text-lg md:text-xl font-black text-slate-900 dark:text-white">آخرین معاملات</h2>
          <button onClick={() => setView('deals')} className="text-xs md:text-sm font-bold text-blue-500 hover:text-blue-400 transition-colors">مشاهده همه لیست</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {contracts.slice(0, 6).map((c: any) => (
            <DealCard key={c.contract_id} contract={c} onClick={() => { localStorage.setItem('selected_contract', JSON.stringify(c)); setView('detail'); }} />
          ))}
          {contracts.length === 0 && (
            <div className="md:col-span-2 lg:col-span-3 p-16 text-center border-2 border-dashed border-white/5 rounded-[3rem] bg-white/[0.01] shadow-[inset_0_0_20px_rgba(255,255,255,0.01)]">
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
    <div className="p-6 bg-white dark:bg-white/5 rounded-[2rem] border border-slate-200 dark:border-white/5 flex flex-col items-center justify-center text-center gap-1 transition-all hover:bg-slate-50 dark:hover:bg-white/[0.08] shadow-protruding dark:shadow-none">
      <span className="text-[10px] font-bold text-slate-500 block uppercase tracking-wider">{label}</span>
      <span className="text-2xl md:text-3xl font-black text-slate-900 dark:text-white tabular-nums">{value}</span>
    </div>
  );
}

function FeatureCard({ icon, label, desc, onClick }: any) {
  return (
    <button 
      onClick={onClick}
      className="p-4 md:p-6 rounded-[2rem] bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 text-right space-y-3 active:scale-95 transition-all group hover:border-blue-500/30 flex flex-col items-end w-full shadow-protruding shadow-protruding-hover"
    >
      <div className="w-7 h-7 md:w-9 md:h-9 rounded-lg bg-slate-50 dark:bg-white/5 flex items-center justify-center transition-colors group-hover:bg-blue-600/10 shrink-0 shadow-protruding">
        {React.cloneElement(icon, { size: 14 })}
      </div>
      <div>
        <h3 className="text-[11px] md:text-[13px] font-black text-slate-900 dark:text-white">{label}</h3>
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
    const q = query(
      collection(db, 'contract_messages'),
      where('contract_id', '==', contract.contract_id),
      orderBy('created_at', 'asc')
    );
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message));
      setMessages(msgs);
    });

    return () => unsubscribe();
  }, [contract]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, activeTab]);

  const sendMsg = async (text: string = newMessage, type: Message['message_type'] = 'text', url?: string) => {
    if ((!text.trim() && type === 'text') || !user || !contract) return;
    await addDoc(collection(db, 'contract_messages'), {
      contract_id: contract.contract_id,
      sender_id: user.id,
      message_text: text,
      message_type: type,
      attachment_url: url,
      created_at: serverTimestamp()
    });
    setNewMessage('');
    setShowAttachments(false);
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

  const actions = contract ? getEscrowActions(contract, user.id, async () => {
    refresh();
    const contractDoc = await getDoc(doc(db, 'deals', contract.id || contract.contract_id));
    if (contractDoc.exists()) {
      const data = { id: contractDoc.id, ...contractDoc.data() } as Contract;
      setContract(data);
      localStorage.setItem('selected_contract', JSON.stringify(data));
    }
  }, localStorage.getItem('mianji_demo_mode') === 'true') : [];

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

      {contract.status === 'disputed' && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-3xl flex items-center justify-between gap-4 shadow-lg shadow-rose-900/10">
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 rounded-xl bg-rose-500 flex items-center justify-center text-white"><Gavel size={20} /></div>
             <div>
               <p className="text-xs font-black text-white">اختلاف ثبت شده است</p>
               <p className="text-[10px] text-rose-300">در حال بررسی توسط داور میانجی</p>
             </div>
          </div>
          <button 
            onClick={() => setView('dispute')}
            className="px-5 py-2 bg-rose-500 text-white rounded-xl text-[10px] font-black active:scale-95 transition-all"
          >
            مرکز حل اختلاف
          </button>
        </div>
      )}

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
            className="fixed top-0 right-0 bottom-0 w-[75%] max-w-xs bg-white dark:bg-[#09090b] border-l border-slate-200 dark:border-white/10 z-[1001] p-4 flex flex-col shadow-[-20px_0_50px_rgba(0,0,0,0.1)] dark:shadow-[-20px_0_50px_rgba(0,0,0,0.8)]"
          >
            <div className="flex items-center justify-between mb-6 px-1">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/30">
                  <Shield size={16} />
                </div>
                <span className="font-black text-sm text-slate-900 dark:text-white transition-colors">منوی اصلی</span>
              </div>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500 active:scale-90 transition-all"><X size={16} /></button>
            </div>

            <div className="flex-1 space-y-0.5 overflow-y-auto scrollbar-hide">
              {menuItems.map((item, idx) => (
                <button 
                  key={idx}
                  disabled={item.disabled}
                  onClick={() => { setView(item.view); onClose(); }}
                  className={`w-full flex items-center gap-3 p-2 rounded-xl transition-all group relative ${item.disabled ? 'opacity-30 grayscale cursor-not-allowed' : 'hover:bg-slate-50 dark:hover:bg-white/5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white active:scale-[0.98]'}`}
                >
                  <div className={`w-8 h-8 rounded-lg bg-slate-100 dark:bg-white/5 flex items-center justify-center transition-colors ${!item.disabled && 'group-hover:bg-blue-600/10 group-hover:text-blue-500 shadow-sm'}`}>
                    {React.cloneElement(item.icon as any, { size: 16 })}
                  </div>
                  <div className="flex-1 text-right">
                    <span className="text-[11px] font-bold block leading-none">{item.label}</span>
                    {item.badge && <span className="text-[7px] font-black text-blue-500 uppercase tracking-tighter mt-1 block">{item.badge}</span>}
                  </div>
                </button>
              ))}
            </div>

            <div className="pt-5 border-t border-slate-100 dark:border-white/5 space-y-4">
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-white/5 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black text-sm shadow-lg border-2 border-white dark:border-black/50">{user?.full_name?.[0] || 'U'}</div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-black text-slate-900 dark:text-white truncate transition-colors">{user?.full_name || 'کاربر مهمان'}</p>
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
    <button onClick={onClick} className="bg-white dark:bg-[#09090b] border border-slate-100 dark:border-white/5 p-5 rounded-[2rem] text-right space-y-4 hover:border-blue-500/20 transition-all shadow-protruding shadow-protruding-hover active:scale-95">
      <div className={`w-12 h-12 rounded-2xl bg-slate-50 dark:bg-white/5 flex items-center justify-center ${color} shadow-protruding`}>{icon}</div>
      <div>
        <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 block uppercase tracking-wider">{label}</span>
        <span className="text-lg font-black text-slate-900 dark:text-white transition-colors">{value}</span>
      </div>
    </button>
  );
}

function DealCard({ contract, onClick }: { contract: Contract, onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full p-6 bg-white dark:bg-[#09090b] border border-slate-100 dark:border-white/5 rounded-3xl text-right flex justify-between items-center group active:scale-[0.98] transition-all shadow-protruding shadow-protruding-hover hover:border-blue-500/20">
      <div className="space-y-1 text-right">
        <h3 className="text-sm font-black text-slate-900 dark:text-white group-hover:text-blue-500 transition-colors">{contract.title}</h3>
        <span className="text-[10px] font-bold text-slate-500 tabular-nums">{contract.amount.toLocaleString()} تومان</span>
      </div>
      <StatusLabel status={contract.status} small />
    </button>
  );
}

function DetailItem({ label, value, unit, color }: any) {
  return (
    <div className="p-4 bg-white dark:bg-[#09090b] border border-slate-100 dark:border-white/5 rounded-2xl shadow-sm dark:shadow-none">
      <span className="text-[9px] font-black text-slate-500 block mb-1">{label}</span>
      <div className={`text-sm font-black text-slate-900 dark:text-white ${color}`}>
        {value} {unit && <span className="text-[10px] text-slate-500 dark:text-slate-600">{unit}</span>}
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
  const [directChats, setDirectChats] = useState<any[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('mianji_direct_chats');
    if (saved) setDirectChats(JSON.parse(saved));
    else {
      // Seed initial mock direct chat
      const initial = [{ id: 101, full_name: 'پشتیبانی میانجی', phone_number: '0210000', last_msg: 'چطور می‌تونم کمکتون کنم؟', time: new Date().toISOString() }];
      setDirectChats(initial);
      localStorage.setItem('mianji_direct_chats', JSON.stringify(initial));
    }
  }, []);

  const allItems = [
    ...contracts.map((c: any) => ({ ...c, type: 'contract' })),
    ...directChats.map((d: any) => ({ ...d, type: 'direct' }))
  ].sort((a, b) => new Date(b.created_at || b.time).getTime() - new Date(a.created_at || a.time).getTime());

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-xl font-black text-slate-900 dark:text-white transition-colors">پیام‌ها</h2>
        <div className="flex gap-2">
          <button 
            onClick={() => setView('contacts')}
            className="px-4 py-2 bg-blue-600 text-white rounded-full text-[10px] font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all flex items-center gap-2"
          >
            <Plus size={14} /> شروع گفتگو یا معامله
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-slate-100 dark:divide-white/5 shadow-2xl transition-colors">
        {allItems.length > 0 ? (
          allItems.map((item: any) => (
            <button 
              key={item.contract_id || item.id} 
              onClick={() => { 
                if (item.type === 'contract') {
                  localStorage.setItem('selected_contract', JSON.stringify(item)); 
                  setView('detail'); 
                } else {
                  localStorage.setItem('mianji_chat_target', JSON.stringify(item));
                  setView('direct_chat');
                }
              }}
              className="w-full p-5 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-white/5 transition-all active:scale-[0.99] text-right group"
            >
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${item.type === 'contract' ? 'bg-blue-600/10 text-blue-500' : 'bg-emerald-600/10 text-emerald-500'}`}>
                {item.type === 'contract' ? <MessageCircle size={20} /> : <User size={20} />}
              </div>
              <div className="flex-1 overflow-hidden">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-black text-slate-900 dark:text-white truncate transition-colors">{item.title || item.full_name}</span>
                  <span className="text-[8px] text-slate-500 font-mono">{(new Date(item.created_at || item.time)).toLocaleDateString('fa-IR')}</span>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-slate-500 truncate">
                    {item.type === 'contract' ? `گفتگو درباره قرارداد ${item.contract_id}` : (item.last_msg || 'گفتگوی مستقیم')}
                  </p>
                  {item.type === 'contract' ? <StatusLabel status={item.status} small /> : <span className="text-[8px] font-black text-emerald-500 uppercase tracking-widest">Direct Chat</span>}
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="p-16 text-center">
            <MessageSquare size={48} className="mx-auto text-slate-300 dark:text-slate-800 mb-4 opacity-50" />
            <p className="text-xs font-bold text-slate-400 dark:text-slate-600">هنوز گفتگویی شروع نشده است</p>
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

function CreateDealView({ user, onBack, onSuccess, setView }: any) {
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

  useEffect(() => {
    const prefill = localStorage.getItem('mianji_prefill_phone');
    if (prefill) {
      setFormData(prev => ({ ...prev, phone: prefill }));
      localStorage.removeItem('mianji_prefill_phone');
    }
  }, []);

  const handleSubmit = async () => {
    if (!formData.title || !formData.amount || !formData.phone) {
      alert('لطفاً تمام فیلدها را پر کنید');
      return;
    }
    setLoading(true);
    try {
      // Find other party (using last 10 digits)
      const otherPhoneClean = formData.phone.replace(/[^0-9]/g, '');
      const otherCoreDigits = otherPhoneClean.length >= 10 ? otherPhoneClean.slice(-10) : otherPhoneClean;

      const isDemoLocal = localStorage.getItem('mianji_demo_mode') === 'true';
      const contractId = `M-${Math.floor(100000 + Math.random() * 900000)}`;

      if (isDemoLocal) {
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

      // Find other party (using server-side lookup to avoid permission issues)
      const lookupRes = await fetch(`/api/users/lookup?phone=${encodeURIComponent(formData.phone)}`);
      const lookupResult = await lookupRes.json();
      
      if (!lookupResult.success || !lookupResult.user) {
        alert('شماره همراه طرف مقابل یافت نشد. او باید ابتدا در سیستم عضو باشد.');
        setLoading(false);
        return;
      }

      const otherUser = lookupResult.user;

      const dealData = {
        contract_id: contractId,
        title: formData.title,
        amount: Number(formData.amount),
        buyer_id: formData.role === 'buyer' ? user.id : otherUser.id,
        seller_id: formData.role === 'seller' ? user.id : otherUser.id,
        status: 'draft',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        category: formData.category,
        description: formData.description
      };

      await addDoc(collection(db, 'deals'), dealData);
      onSuccess();
    } catch (err) {
      console.error('Error creating deal:', err);
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
                className="input-refined shadow-protruding"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">مبلغ معامله (تومان)</label>
              <input 
                type="number"
                placeholder="0"
                value={formData.amount}
                onChange={e => setFormData({...formData, amount: e.target.value})}
                className="input-refined shadow-protruding"
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
            <div className="flex gap-2">
              <input 
                placeholder="0912..." 
                value={formData.phone}
                onChange={e => setPhone(e.target.value, formData, setFormData)}
                className="input-refined shadow-protruding"
              />
              <button 
                onClick={() => setView('contacts')}
                className="w-14 h-14 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-2xl flex items-center justify-center text-blue-500 hover:bg-slate-50 dark:hover:bg-white/10 active:scale-95 transition-all shadow-protruding"
                title="انتخاب از مخاطبین"
              >
                <Users size={20} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">مهلت تحویل (روز)</label>
              <input 
                type="number"
                placeholder="7"
                value={formData.deadline}
                onChange={e => setFormData({...formData, deadline: e.target.value})}
                className="input-refined shadow-protruding"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">تعداد ویرایش رایگان</label>
              <input 
                type="number"
                placeholder="2"
                value={formData.revisions}
                onChange={e => setFormData({...formData, revisions: e.target.value})}
                className="input-refined shadow-protruding"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">توضیحات و شرایط قرارداد</label>
            <textarea 
              placeholder="جزئیات پروژه، نحوه تحویل و هرگونه توافق جانبی را اینجا بنویسید..."
              value={formData.description}
              onChange={e => setFormData({...formData, description: e.target.value})}
              className="w-full h-32 bg-slate-50 dark:bg-black border border-slate-200 dark:border-white/10 rounded-2xl p-5 text-sm text-slate-900 dark:text-white focus:border-blue-600 outline-none transition-all resize-none shadow-protruding"
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

function DisputeView({ user, setView, refresh }: any) {
  const [contract, setContract] = useState<any>(null);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [verdict, setVerdict] = useState<'refund' | 'release' | 'split'>('release');

  useEffect(() => {
    const saved = localStorage.getItem('selected_contract');
    if (saved) {
      const c = JSON.parse(saved);
      setContract(c);
      // Mock evidence
      setEvidence([
        { id: 1, sender_id: c.buyer_id, text: 'کار مطابق با توافق انجام نشده است.', created_at: new Date().toISOString() },
        { id: 2, sender_id: c.seller_id, text: 'تمامی مراحل پروژه انجام و تاییدیه گرفته شده بود.', created_at: new Date().toISOString() },
      ]);
    }
  }, []);

  const handleVerdict = async () => {
    setLoading(true);
    // In demo mode or real app, we update contract status
    const newStatus = verdict === 'refund' ? 'cancelled' : verdict === 'release' ? 'completed' : 'completed'; // Simplified
    
    if (localStorage.getItem('mianji_demo_mode') === 'true') {
       const saved = localStorage.getItem('mianji_mock_contracts');
       if (saved) {
         const contracts = JSON.parse(saved);
         const idx = contracts.findIndex((c: any) => c.contract_id === contract.contract_id);
         if (idx !== -1) {
           contracts[idx].status = newStatus;
           localStorage.setItem('mianji_mock_contracts', JSON.stringify(contracts));
           localStorage.setItem('selected_contract', JSON.stringify(contracts[idx]));
         }
       }
    } else {
       const contractRef = doc(db, 'deals', contract.id || contract.contract_id);
       await updateDoc(contractRef, { 
         status: newStatus,
         updatedAt: serverTimestamp()
       });
    }
    
    setLoading(false);
    refresh();
    setView('detail');
    alert('رأی داور با موفقیت ثبت و معامله مختومه شد.');
  };

  if (!contract) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center gap-3">
        <button onClick={() => setView('detail')} className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all"><ChevronRight size={20} /></button>
        <h2 className="text-xl font-black text-slate-900 dark:text-white">مرکز حل اختلاف</h2>
      </div>

      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] p-8 space-y-6 relative overflow-hidden shadow-2xl">
        <div className="absolute top-0 right-0 w-64 h-64 bg-rose-500/5 blur-[80px] rounded-full" />
        <div className="flex items-center gap-4 relative z-10">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-500 shadow-lg shadow-rose-900/10 dark:shadow-rose-900/20">
            <Gavel size={32} />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">پرونده شماره {contract.contract_id.replace('M-', 'D-')}</h3>
            <p className="text-xs text-slate-500">مربوط به معامله: {contract.title}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
           <div className="p-5 bg-black/40 rounded-3xl border border-white/5">
             <span className="text-[10px] font-black text-slate-500 uppercase block mb-1">مبلغ مورد تنازع</span>
             <span className="text-xl font-black text-white tabular-nums">{contract.amount.toLocaleString()} تومان</span>
           </div>
           <div className="p-5 bg-black/40 rounded-3xl border border-white/5">
             <span className="text-[10px] font-black text-slate-500 uppercase block mb-1">وضعیت فعلی</span>
             <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
                <span className="text-xs font-bold text-rose-500">در حال داوری</span>
             </div>
           </div>
        </div>
      </div>

      {/* Evidence Timeline */}
      <div className="space-y-4">
        <h3 className="text-sm font-black text-slate-900 dark:text-white px-2">شواهد و مستندات</h3>
        <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] p-6 space-y-6 shadow-xl">
           {evidence.map(item => (
             <div key={item.id} className={`flex flex-col gap-2 ${item.sender_id === user.id ? 'items-start' : 'items-end'}`}>
                <div className={`p-4 rounded-2xl text-[11px] md:text-xs leading-relaxed max-w-[90%] ${item.sender_id === user.id ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-100 dark:bg-white/5 text-slate-900 dark:text-slate-300 border border-slate-200 dark:border-white/10 shadow-sm'}`}>
                  <p className="mb-2 font-bold opacity-60 text-[8px]">{item.sender_id === contract.buyer_id ? 'کارفرما' : 'مجری'}</p>
                  {item.text}
                </div>
             </div>
           ))}

           <div className="pt-4 border-t border-slate-100 dark:border-white/5 space-y-4">
              <textarea 
                className="w-full h-24 bg-slate-50 dark:bg-black border border-slate-200 dark:border-white/10 rounded-2xl p-4 text-xs text-slate-900 dark:text-white focus:border-blue-600 outline-none transition-all resize-none shadow-protruding"
                placeholder="توضیحات تکمیلی یا دفاعیه خود را اینجا بنویسید..."
              />
              <div className="flex gap-2">
                <button className="flex-1 h-12 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-white rounded-xl text-[10px] font-black flex items-center justify-center gap-2 btn-protruding">
                  <Paperclip size={14} /> ضمیمه فایل/تصویر
                </button>
                <button className="flex-1 h-12 bg-blue-600 text-white rounded-xl text-[10px] font-black active:scale-95 transition-all shadow-lg shadow-blue-600/20 btn-protruding">
                  ارسال گزارش به داور
                </button>
              </div>
           </div>
        </div>
      </div>

      {/* Arbitrator Panel (Simulated/Admin) */}
      <div className="p-8 bg-linear-to-br from-amber-600/10 to-transparent border border-amber-500/20 rounded-[2.5rem] space-y-6 shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-amber-500/30" />
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-500"><Sparkles size={20} /></div>
          <h3 className="text-sm font-black text-amber-500 uppercase tracking-widest">پنل داوری (شبیه‌ساز)</h3>
        </div>
        
        <p className="text-[10px] text-slate-400 leading-relaxed">داور محترم، پس از بررسی کامل شواهد و گفتگوهای طرفین، می‌توانید نسبت به تخصیص وجه معامله اقدام کنید. این تصمیم قطعی و غیرقابل بازگشت است.</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
           <VerdictBtn active={verdict === 'refund'} onClick={() => setVerdict('refund')} label="برگشت کامل وجه" desc="به حساب کارفرما" />
           <VerdictBtn active={verdict === 'release'} onClick={() => setVerdict('release')} label="تسویه کامل" desc="به حساب مجری" />
           <VerdictBtn active={verdict === 'split'} onClick={() => setVerdict('split')} label="تقسیم وجه" desc="به نسبت ۵۰/۵۰" />
        </div>

        <button 
          onClick={handleVerdict}
          disabled={loading}
          className="w-full h-14 bg-amber-500 text-black font-black rounded-2xl shadow-xl shadow-amber-600/20 active:scale-95 transition-all flex items-center justify-center gap-3"
        >
          {loading ? <div className="w-5 h-5 border-2 border-black/30 border-t-black rounded-full animate-spin" /> : 'ثبت رأی نهایی داور'}
        </button>
      </div>
    </motion.div>
  );
}

function VerdictBtn({ active, onClick, label, desc }: any) {
  return (
    <button 
      onClick={onClick}
      className={`p-4 rounded-2xl border transition-all text-right space-y-1 ${active ? 'bg-amber-500 border-amber-600 text-black shadow-lg shadow-amber-600/20' : 'bg-white dark:bg-black border-slate-200 dark:border-white/10 text-slate-500 shadow-sm dark:shadow-none'}`}
    >
      <p className="text-xs font-black">{label}</p>
      <p className={`text-[8px] font-bold ${active ? 'text-black/60' : 'text-slate-500 dark:text-slate-600'}`}>{desc}</p>
    </button>
  );
}

function CategoryBtn({ active, onClick, label, icon }: any) {
  return (
    <button 
      onClick={onClick}
      className={`h-12 rounded-xl flex items-center justify-center gap-2 text-[10px] font-bold border transition-all ${active ? 'bg-blue-600/10 dark:bg-white/10 border-blue-600/20 dark:border-white/20 text-blue-600 dark:text-white shadow-lg dark:shadow-white/5' : 'bg-white dark:bg-black border-slate-100 dark:border-white/5 text-slate-500 hover:border-slate-300 dark:hover:border-white/10 shadow-sm dark:shadow-none'}`}
    >
      {icon}
      {label}
    </button>
  );
}

function ContactsView({ user, setView }: any) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [newContact, setNewAddContact] = useState({ name: '', phone: '' });

  useEffect(() => {
    const saved = localStorage.getItem('mianji_contacts');
    if (saved) {
      setContacts(JSON.parse(saved));
    } else {
      const initial = [
        { id: 1, full_name: 'رضا علوی', phone_number: '09120001122', status: 'verified', trust_score: 98 },
        { id: 2, full_name: 'مریم حسینی', phone_number: '09355554433', status: 'verified', trust_score: 100 },
        { id: 3, full_name: 'شرکت آریا', phone_number: '02188889900', status: 'verified', trust_score: 85 },
      ];
      setContacts(initial);
      localStorage.setItem('mianji_contacts', JSON.stringify(initial));
    }
  }, []);

  const handleAdd = () => {
    if (!newContact.name || !newContact.phone) return;
    const item = { 
      id: Date.now(), 
      full_name: newContact.name, 
      phone_number: newContact.phone, 
      status: 'pending', 
      trust_score: 0 
    };
    const updated = [item, ...contacts];
    setContacts(updated);
    localStorage.setItem('mianji_contacts', JSON.stringify(updated));
    setNewAddContact({ name: '', phone: '' });
    setShowAddModal(false);
  };

  const filtered = contacts.filter(c => c.full_name.includes(searchTerm) || c.phone_number.includes(searchTerm));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-xl font-black text-white">مخاطبین من</h2>
        <button 
          onClick={() => setShowAddModal(true)}
          className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20 active:scale-90 transition-all"
        >
          <Plus size={20} />
        </button>
      </div>

      <div className="relative">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
        <input 
          placeholder="جستجوی نام یا شماره همراه..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="input-refined pr-12 shadow-protruding"
        />
      </div>

      <div className="bg-[#09090b] border border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-white/5 shadow-2xl">
        {filtered.length > 0 ? filtered.map(contact => (
          <div key={contact.id} className="p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors relative group">
            <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-slate-300 font-black relative border border-white/5">
              {contact.full_name[0]}
              <div className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-black ${contact.status === 'verified' ? 'bg-emerald-500' : 'bg-slate-500'}`} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-black text-white">{contact.full_name}</span>
                {contact.trust_score > 0 && <span className="px-2 py-0.5 bg-blue-500/10 text-blue-500 text-[8px] font-black rounded-full uppercase">Trust {contact.trust_score}</span>}
              </div>
              <p className="text-[10px] text-slate-500 font-mono" dir="ltr">{contact.phone_number}</p>
            </div>
            <div className="flex items-center gap-2">
               <button 
                onClick={() => {
                  localStorage.setItem('mianji_chat_target', JSON.stringify(contact));
                  setView('direct_chat');
                }}
                className="w-10 h-10 rounded-xl bg-blue-600/10 text-blue-500 flex items-center justify-center hover:bg-blue-600 hover:text-white transition-all active:scale-90 shadow-lg shadow-blue-600/5"
                title="ارسال پیام"
               >
                 <MessageCircle size={18} />
               </button>
               <button 
                onClick={() => {
                  localStorage.setItem('mianji_prefill_phone', contact.phone_number);
                  setView('create');
                }}
                className="w-10 h-10 rounded-xl bg-white/5 text-slate-400 flex items-center justify-center hover:bg-white/10 transition-all active:scale-90"
                title="معامله جدید"
               >
                 <Plus size={18} />
               </button>
            </div>
          </div>
        )) : (
          <div className="p-20 text-center text-slate-600">
             <Users size={48} className="mx-auto mb-4 opacity-20" />
             <p className="text-xs font-bold">مخاطبی یافت نشد</p>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showAddModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/90 backdrop-blur-md z-[500] flex items-center justify-center p-6">
             <div className="w-full max-w-sm bg-[#09090b] border border-white/10 rounded-[2.5rem] p-8 space-y-6 relative shadow-[0_0_50px_rgba(37,99,235,0.1)]">
                <button onClick={() => setShowAddModal(false)} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-slate-400"><X size={20} /></button>
                <div className="text-center pt-4">
                  <h3 className="text-xl font-black text-white">افزودن مخاطب</h3>
                  <p className="text-xs text-slate-500 mt-1">اطلاعات مخاطب جدید را وارد کنید</p>
                </div>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase px-1">نام و نام خانوادگی</label>
                    <input 
                      value={newContact.name}
                      onChange={e => setNewAddContact({...newContact, name: e.target.value})}
                      placeholder="مثلاً: علی رضایی"
                      className="input-refined shadow-protruding"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase px-1">شماره همراه</label>
                    <input 
                      value={newContact.phone}
                      onChange={e => setNewAddContact({...newContact, phone: e.target.value})}
                      placeholder="0912..."
                      className="input-refined text-center font-mono shadow-protruding"
                    />
                  </div>
                </div>
                <button 
                  onClick={handleAdd}
                  disabled={!newContact.name || !newContact.phone}
                  className="w-full h-14 bg-blue-600 text-white rounded-2xl font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all disabled:opacity-50"
                >
                  ذخیره مخاطب
                </button>
             </div>
          </motion.div>
        )}
      </AnimatePresence>
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
        <div className="p-8 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] flex flex-col items-center gap-2 shadow-xl dark:shadow-none">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">موجودی کل</span>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-black text-slate-900 dark:text-white tabular-nums">{user?.wallet_balance.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500 uppercase">Toman</span>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button className="h-16 bg-blue-600 text-white rounded-2xl font-black flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-all text-sm btn-protruding">
            <Plus size={18} /> افزایش موجودی
          </button>
          <button className="h-16 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white rounded-2xl font-black flex items-center justify-center gap-2 active:scale-95 transition-all text-sm shadow-protruding">
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
      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] p-8 flex flex-col items-center text-center space-y-4 relative overflow-hidden shadow-2xl dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
        <div className="absolute top-0 left-0 w-full h-32 bg-linear-to-b from-blue-600/10 to-transparent" />
        <div className="relative">
          <div className="w-20 h-24 rounded-[2rem] bg-blue-600 flex items-center justify-center text-white font-black text-2xl shadow-xl shadow-blue-600/20 border-4 border-slate-50 dark:border-black">
            {user?.full_name?.[0] || 'U'}
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-emerald-500 rounded-full border-4 border-black flex items-center justify-center text-white shadow-lg">
            <ShieldCheck size={12} fill="currentColor" />
          </div>
        </div>
        <div className="relative z-10">
          <h2 className="text-lg font-black text-white">{user?.full_name || 'کاربر مهمان'}</h2>
          <p className="text-[10px] text-slate-500 font-mono" dir="ltr">{user?.phone_number || '09xxxxxxxxx'}</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 bg-blue-600/10 border border-blue-600/20 rounded-full">
          <Sparkles size={10} className="text-blue-500" />
          <span className="text-[9px] font-black text-blue-500 uppercase tracking-widest">Premium User</span>
        </div>
      </div>

      {/* Trust Score Summary - REMOVED */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2rem] p-5 space-y-2 shadow-sm dark:shadow-none">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">وضعیت تایید</span>
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-blue-500" fill="currentColor" />
            <span className="text-lg font-black text-slate-900 dark:text-white">تایید شده</span>
          </div>
        </div>
        <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2rem] p-5 space-y-2 shadow-sm dark:shadow-none">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">معاملات موفق</span>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-500" />
            <span className="text-lg font-black text-slate-900 dark:text-white">12</span>
          </div>
        </div>
      </div>

      {/* Profile Menu */}
      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-slate-100 dark:divide-white/5 shadow-xl dark:shadow-none">
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

function DirectChatView({ user, setView }: any) {
  const [target, setTarget] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('mianji_chat_target');
    if (saved) setTarget(JSON.parse(saved));
    
    // Simulate some history
    setMessages([
      { id: 1, sender_id: 0, text: 'سلام، وقت بخیر', created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: 2, sender_id: user.id, text: 'درود، چطور می‌تونم کمکتون کنم؟', created_at: new Date(Date.now() - 1800000).toISOString() },
    ]);
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  const send = () => {
    if (!newMessage.trim()) return;
    const msg = {
      id: Date.now(),
      sender_id: user.id,
      text: newMessage,
      created_at: new Date().toISOString()
    };
    setMessages([...messages, msg]);
    setNewMessage('');
  };

  if (!target) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col max-w-4xl mx-auto pb-6">
      <div className="flex items-center justify-between mb-4 px-2">
        <div className="flex items-center gap-3">
          <button onClick={() => setView('contacts')} className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all"><ChevronRight size={20} /></button>
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black">{target.full_name[0]}</div>
          <div>
            <h2 className="text-sm font-black text-slate-900 dark:text-white">{target.full_name}</h2>
            <p className="text-[10px] text-emerald-500 font-bold">Online</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-400 opacity-50 cursor-not-allowed"><Mic size={18} /></button>
          <button className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-400 opacity-50 cursor-not-allowed"><Camera size={18} /></button>
        </div>
      </div>

      <div className="flex-1 flex flex-col bg-white dark:bg-[#09090b] rounded-[2.5rem] border border-slate-200 dark:border-white/5 overflow-hidden min-h-[60vh] relative shadow-2xl">
         <div ref={chatRef} className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50 dark:bg-[#050505] scrollbar-hide">
            {messages.map(m => (
              <div key={m.id} className={`flex ${m.sender_id === user.id ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[80%] px-4 py-3 rounded-[1.5rem] text-[12px] leading-relaxed relative ${m.sender_id === user.id ? 'bg-blue-600 text-white rounded-br-none shadow-[0_4px_15px_rgba(37,99,235,0.2)]' : 'bg-white dark:bg-[#18181b] text-slate-900 dark:text-slate-200 border border-slate-200 dark:border-white/5 rounded-bl-none shadow-lg'}`}>
                  {m.text}
                  <div className={`text-[8px] mt-1 text-left opacity-50 ${m.sender_id === user.id ? 'text-blue-100' : 'text-slate-500'}`}>
                    {new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
         </div>

         <div className="p-4 bg-slate-100/50 dark:bg-black/40 border-t border-slate-200 dark:border-white/5 flex items-center gap-2">
            <input 
              className="input-refined flex-1 shadow-protruding"
              placeholder="پیام خود را بنویسید..."
              value={newMessage}
              onChange={e => setNewMessage(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && send()}
            />
            <button onClick={send} className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20 active:scale-90 transition-all">
              <Send size={18} />
            </button>
         </div>
      </div>
      
      <div className="mt-4 flex justify-center">
        <button 
          onClick={() => { localStorage.setItem('mianji_prefill_phone', target.phone_number); setView('create'); }}
          className="px-6 py-2 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-full text-[10px] font-black text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-white transition-all flex items-center gap-2 shadow-sm dark:shadow-none"
        >
          <Sparkles size={12} className="text-blue-500" />
          شروع معامله امن با این مخاطب
        </button>
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
