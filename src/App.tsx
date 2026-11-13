/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Shield, Plus, Home, User, ChevronLeft, CheckCircle2, Clock,
  AlertCircle, Wallet, ClipboardList, Bell, ArrowUpRight,
  MessageCircle, LogOut, Search, Filter, MoreVertical, ChevronRight,
  Send, MessageSquare, HelpCircle, Check, Lock, Gavel, QrCode,
  Camera, Mic, Image as ImageIcon, FileText, Paperclip,
  Play, Pause, X, Settings, Users, ShieldCheck, Info,
  Menu, CreditCard, Sparkles, Sun, Moon, Copy, ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { auth, db } from './lib/firebase';
import {
  collection, query, where, getDocs, orderBy, limit,
  doc, getDoc, getDocFromServer, onSnapshot, setDoc, updateDoc, addDoc, serverTimestamp
} from 'firebase/firestore';
import { signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth';
import { getEscrowActions, EscrowAction } from './services/escrowService';

// --- Shared Helpers ---
const normalizeDigits = (val: string) =>
  String(val || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();

const toMillis = (ts: any): number => {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts?.toMillis === 'function') return ts.toMillis();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts?.seconds === 'number') return ts.seconds * 1000;
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatTimeFa = (ts: any): string => {
  const ms = toMillis(ts);
  if (!ms) return 'لحظاتی پیش';
  return new Date(ms).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
};

const formatDateFa = (ts: any): string => {
  const ms = toMillis(ts);
  if (!ms) return 'امروز';
  return new Date(ms).toLocaleDateString('fa-IR');
};

const formatDateTimeFa = (ts: any): string => {
  const ms = toMillis(ts);
  if (!ms) return 'اکنون';
  return new Date(ms).toLocaleString('fa-IR');
};

const getAvailableBalance = (user: UserProfile | null) =>
  Math.max(0, Number(user?.wallet_balance ?? 0) - Number(user?.escrow_locked_balance ?? 0));

const remoteLog = (level: 'info' | 'warn' | 'error', message: string, details?: any) => {
  const logFn = console[level] || console.log;
  logFn(`[Mianji-${level.toUpperCase()}] ${message}`, details || '');

  if (details instanceof Error) {
    details = { message: details.message, stack: details.stack };
  }

  fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, details })
  }).catch(() => {});
};

// Validate Firestore connection on boot
getDocFromServer(doc(db, 'test', 'connection')).catch((err) => {
  if (err instanceof Error && err.message.includes('the client is offline')) {
    console.warn('Firestore client is offline or unreachable.');
  }
});

// --- Error Boundary ---
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
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
type View =
  | 'auth'
  | 'dashboard'
  | 'deals'
  | 'create'
  | 'wallet'
  | 'profile'
  | 'detail'
  | 'support'
  | 'notifications'
  | 'messages'
  | 'contacts'
  | 'dispute'
  | 'direct_chat'
  | 'admin';

type InfoModalType = 'rules' | 'about' | 'settings' | 'invite' | 'kyc' | 'notif_prefs' | 'security' | null;

interface ToastState {
  message: string;
  type: 'success' | 'error' | 'info';
}

interface UserProfile {
  id: string | number;
  full_name: string | null;
  phone_number: string | null;
  role: string | null; // 'owner' | 'admin' | 'user'
  permissions?: {
    manage_support?: boolean;
    manage_deals?: boolean;
    manage_finance?: boolean;
    manage_users?: boolean;
  };
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
  buyer_id: string | number;
  seller_id: string | number;
  status: 'draft' | 'awaiting_payment' | 'active' | 'work_submitted' | 'completed' | 'cancelled' | 'disputed';
  created_at?: any;
  createdAt?: any;
  category?: string;
  description?: string;
  buyer?: UserProfile;
  seller?: UserProfile;
}

interface Message {
  id: string;
  contract_id: string;
  sender_id: string | number;
  message_text: string;
  message_type: 'text' | 'image' | 'voice' | 'file';
  attachment_url?: string;
  is_system?: boolean;
  created_at?: any;
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
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('mianji_theme') !== 'light');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [infoModal, setInfoModal] = useState<InfoModalType>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [loginPhone, setLoginPhone] = useState('');
  const [previewOtp, setPreviewOtp] = useState<string | null>(null);

  const pendingUserRef = useRef<UserProfile | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = (message: string, type: ToastState['type'] = 'info') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('mianji_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('mianji_theme', 'light');
    }
  }, [isDarkMode]);

  useEffect(() => {
    const handleOpenScanner = () => setShowWebScanner(true);
    document.addEventListener('open-qr-scanner', handleOpenScanner);
    return () => document.removeEventListener('open-qr-scanner', handleOpenScanner);
  }, []);

  useEffect(() => {
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
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const toggleDebug = () => {
    const newState = !isDebug;
    setIsDebug(newState);
    localStorage.setItem('mianji_debug', newState.toString());
    notify(newState ? 'حالت دیباگ فعال شد' : 'حالت دیباگ غیرفعال شد', 'info');
  };

  const loadLocalFallbackData = () => {
    try {
      const savedContracts = localStorage.getItem('mianji_mock_contracts');
      setContracts(savedContracts ? JSON.parse(savedContracts) : []);
      const savedNotes = localStorage.getItem('mianji_mock_notifications');
      if (savedNotes) {
        setNotifications(JSON.parse(savedNotes));
      } else {
        const defaultNotes = [
          {
            id: 'note_welcome',
            title: 'به میانجی خوش آمدید',
            message: 'پلتفرم امن واسطه‌گری معاملات دیجیتال و فریلنسری آماده استفاده است.',
            is_read: false,
            createdAt: new Date().toISOString()
          }
        ];
        setNotifications(defaultNotes);
        localStorage.setItem('mianji_mock_notifications', JSON.stringify(defaultNotes));
      }
    } catch {
      setContracts([]);
      setNotifications([]);
    }
  };

  const fetchInitialData = async (userId: string | number) => {
    if (!auth.currentUser || localStorage.getItem('mianji_demo_mode') === 'true') {
      loadLocalFallbackData();
      return;
    }

    const uid = String(userId);
    try {
      const userDoc = await getDoc(doc(db, 'users', uid));
      if (userDoc.exists()) {
        setUser({ id: userDoc.id, ...userDoc.data() } as UserProfile);
      }

      const fetchRoleDeals = async (field: 'buyer_id' | 'seller_id') => {
        try {
          return await getDocs(query(collection(db, 'deals'), where(field, '==', uid), orderBy('createdAt', 'desc')));
        } catch {
          return await getDocs(query(collection(db, 'deals'), where(field, '==', uid)));
        }
      };

      const [buyerDeals, sellerDeals] = await Promise.all([
        fetchRoleDeals('buyer_id'),
        fetchRoleDeals('seller_id')
      ]);

      const dealMap = new Map<string, Contract>();
      [...buyerDeals.docs, ...sellerDeals.docs].forEach((d) => {
        dealMap.set(d.id, { id: d.id, ...d.data() } as Contract);
      });

      const allDeals = Array.from(dealMap.values()).sort(
        (a, b) => toMillis(b.createdAt || b.created_at) - toMillis(a.createdAt || a.created_at)
      );
      setContracts(allDeals);

      let notifySnap;
      try {
        notifySnap = await getDocs(
          query(collection(db, 'notifications'), where('user_id', '==', uid), orderBy('createdAt', 'desc'), limit(15))
        );
      } catch {
        notifySnap = await getDocs(query(collection(db, 'notifications'), where('user_id', '==', uid), limit(15)));
      }
      setNotifications(notifySnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (err) {
      remoteLog('warn', 'Fetch Initial Data fell back to local storage', err);
      loadLocalFallbackData();
    }
  };

  // Auth & Init
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      try {
        if (fbUser) {
          const userRef = doc(db, 'users', fbUser.uid);
          const userDoc = await getDoc(userRef);
          if (userDoc.exists()) {
            const userData = { id: userDoc.id, ...userDoc.data() } as UserProfile;
            setUser(userData);
            setIsAuthenticated(true);
            setView((prev) => (prev === 'auth' ? 'dashboard' : prev));
            fetchInitialData(fbUser.uid);
          } else if (pendingUserRef.current) {
            const pending = pendingUserRef.current;
            const profileData = {
              id: fbUser.uid,
              phone_number: String(pending.phone_number || ''),
              full_name: String(pending.full_name || 'کاربر میانجی'),
              kyc_status: 'pending',
              wallet_balance: 0,
              escrow_locked_balance: 0,
              role: 'user',
              updatedAt: serverTimestamp()
            };
            try {
              await setDoc(userRef, profileData);
            } catch (writeErr) {
              remoteLog('warn', 'Could not create Firestore user profile, using session profile', writeErr);
            }
            const activeProfile: UserProfile = {
              ...pending,
              id: fbUser.uid
            };
            pendingUserRef.current = null;
            setUser(activeProfile);
            setIsAuthenticated(true);
            setView('dashboard');
            fetchInitialData(fbUser.uid);
          } else {
            remoteLog('warn', `Firebase user ${fbUser.uid} has no Firestore profile.`);
            setIsAuthenticated(false);
            setUser(null);
            setView('auth');
          }
        } else {
          // Restore Preview/fallback session if present
          const savedMock = localStorage.getItem('mianji_mock_user');
          if (savedMock) {
            try {
              const parsed = JSON.parse(savedMock) as UserProfile;
              setUser(parsed);
              setIsAuthenticated(true);
              setView((prev) => (prev === 'auth' ? 'dashboard' : prev));
              loadLocalFallbackData();
              return;
            } catch {
              localStorage.removeItem('mianji_mock_user');
            }
          }
          setIsAuthenticated(false);
          setUser(null);
          setView('auth');
        }
      } catch (err: any) {
        remoteLog('error', 'Auth state change initialization failed', err);
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
          .then((res) => res.json())
          .then(async (data) => {
            if (data.success && data.customToken) {
              if (data.user) pendingUserRef.current = data.user;
              await signInWithCustomToken(auth, data.customToken);
            } else if (data.success && data.user) {
              setUser(data.user);
              setIsAuthenticated(true);
              setView('dashboard');
              localStorage.setItem('mianji_mock_user', JSON.stringify(data.user));
              loadLocalFallbackData();
            }
          })
          .catch((err) => remoteLog('warn', 'Telegram WebApp auto-login failed', err));
      }
    }

    return () => unsubscribe();
  }, []);

  const handleLogin = async (phone: string) => {
    const cleanPhone = normalizeDigits(phone).replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      return { error: 'لطفاً شماره همراه معتبر (حداقل ۱۰ رقم) وارد کنید' };
    }
    setIsLoggingIn(true);
    setPreviewOtp(null);
    remoteLog('info', `Login attempt for phone: ${cleanPhone}`);

    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone })
      });

      const rawText = await res.text();
      let otpRes: any = {};
      try {
        otpRes = JSON.parse(rawText);
      } catch {
        remoteLog('error', 'send-otp returned non-JSON', rawText.slice(0, 300));
        return { error: 'سرور در حال بارگذاری است. لطفاً چند لحظه دیگر امتحان کنید.' };
      }

      if (otpRes.success) {
        setLoginPhone(otpRes.phone || cleanPhone);
        setPreviewOtp(otpRes.previewOtp || null);
        setIsOtpSent(true);
        return { success: true };
      } else {
        return {
          error: otpRes.error || 'خطا در برقراری ارتباط با سرور',
          needRegistration: otpRes.needRegistration
        };
      }
    } catch (err: any) {
      remoteLog('error', 'Login Exception', err);
      return { error: `خطای ارتباط با سرور: ${err.message}` };
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleVerifyOtp = async (code: string) => {
    const cleanCode = normalizeDigits(code).replace(/[^0-9]/g, '');
    if (cleanCode.length < 6) {
      return { error: 'لطفاً کد تایید ۶ رقمی را کامل وارد کنید' };
    }
    setIsLoggingIn(true);

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: loginPhone, code: cleanCode })
      });

      const rawText = await res.text();
      let result: any = {};
      try {
        result = JSON.parse(rawText);
      } catch {
        return { error: 'سرور در حال بارگذاری است. لطفاً دوباره تلاش کنید.' };
      }

      if (result.success && result.user) {
        setPreviewOtp(null);
        if (result.customToken) {
          try {
            pendingUserRef.current = result.user;
            await signInWithCustomToken(auth, result.customToken);
            return { success: true };
          } catch (authErr) {
            remoteLog('warn', 'Custom token sign-in fallback activated', authErr);
          }
        }
        // Fallback / Preview session mode
        localStorage.setItem('mianji_mock_user', JSON.stringify(result.user));
        setUser(result.user);
        setIsAuthenticated(true);
        setView('dashboard');
        loadLocalFallbackData();
        notify('خوش آمدید!', 'success');
        return { success: true };
      } else {
        remoteLog('warn', 'OTP verification rejected', result.error);
        return { error: result.error || 'کد تایید اشتباه است.' };
      }
    } catch (err: any) {
      remoteLog('error', 'OTP Verify Exception', err);
      return { error: err.message || 'خطای ارتباط با سرور' };
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleResetOtp = () => {
    setIsOtpSent(false);
    setLoginPhone('');
    setPreviewOtp(null);
  };

  const handleLogout = async () => {
    remoteLog('info', 'User logged out');
    try {
      await signOut(auth);
    } catch {}
    localStorage.removeItem('mianji_mock_user');
    localStorage.removeItem('mianji_demo_mode');
    localStorage.removeItem('selected_contract');
    pendingUserRef.current = null;
    setIsOtpSent(false);
    setLoginPhone('');
    setPreviewOtp(null);
    setContracts([]);
    setNotifications([]);
    setIsAuthenticated(false);
    setUser(null);
    setView('auth');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div
        className="min-h-screen bg-slate-50 dark:bg-black text-slate-900 dark:text-slate-200 font-sans selection:bg-blue-600/30 overflow-x-hidden transition-colors duration-300"
        dir="rtl"
      >
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
          user={user}
          setView={setView}
          onLogout={handleLogout}
          onOpenModal={setInfoModal}
        />

        {/* Global Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className={`fixed top-5 left-1/2 -translate-x-1/2 z-[1500] px-5 py-3 rounded-2xl shadow-2xl border backdrop-blur-xl flex items-center gap-3 text-xs font-black max-w-[90vw] ${
                toast.type === 'success'
                  ? 'bg-emerald-600/95 border-emerald-400/30 text-white'
                  : toast.type === 'error'
                  ? 'bg-rose-600/95 border-rose-400/30 text-white'
                  : 'bg-slate-900/95 dark:bg-zinc-900/95 border-white/10 text-white'
              }`}
            >
              {toast.type === 'success' ? (
                <CheckCircle2 size={16} />
              ) : toast.type === 'error' ? (
                <AlertCircle size={16} />
              ) : (
                <Info size={16} />
              )}
              <span>{toast.message}</span>
            </motion.div>
          )}
        </AnimatePresence>

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
                <div className="cursor-pointer" onClick={() => setView('dashboard')}>
                  <h1 className="text-base md:text-lg font-black text-slate-900 dark:text-white leading-none">میانجی</h1>
                  <span className="text-[9px] md:text-[10px] text-slate-500 uppercase tracking-widest font-bold">Escrow Platform</span>
                </div>
              </div>

              <div className="hidden md:flex flex-1 max-w-sm mx-8">
                <div className="w-full h-10 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl flex items-center px-4 gap-2 text-slate-500 focus-within:border-blue-500/40 transition-colors">
                  <Search size={16} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      if (view !== 'deals' && e.target.value.trim()) setView('deals');
                    }}
                    placeholder="جستجو در معاملات..."
                    className="bg-transparent outline-none text-xs text-slate-900 dark:text-white w-full placeholder:text-slate-500"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="text-slate-400 hover:text-slate-600 dark:hover:text-white">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 md:gap-3">
                <button
                  onClick={() => setIsDarkMode(!isDarkMode)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all shadow-protruding"
                  title={isDarkMode ? 'حالت روز' : 'حالت شب'}
                >
                  {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                  onClick={() => setView('notifications')}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center relative text-slate-500 dark:text-slate-400 active:scale-90 transition-all shadow-protruding"
                >
                  <Bell size={16} />
                  {notifications.some((n) => !n.is_read) && (
                    <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 bg-blue-500 rounded-full border-2 border-white dark:border-black" />
                  )}
                </button>
                <button
                  onClick={() => setView('profile')}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all overflow-hidden border-2 border-blue-500/30 shadow-protruding"
                >
                  {user?.full_name ? (
                    <div className="w-full h-full flex items-center justify-center bg-blue-600 text-white font-black text-[10px] md:text-xs">
                      {user.full_name[0]}
                    </div>
                  ) : (
                    <User size={16} />
                  )}
                </button>
              </div>
            </header>
          )}

          <main className="flex-1 overflow-x-hidden">
            <AnimatePresence mode="wait">
              {!isAuthenticated && (
                <AuthView
                  onLogin={handleLogin}
                  onVerify={handleVerifyOtp}
                  onResetPhone={handleResetOtp}
                  isLoading={isLoggingIn}
                  isOtpSent={isOtpSent}
                  loginPhone={loginPhone}
                  previewOtp={previewOtp}
                  onToggleDebug={toggleDebug}
                  isDebug={isDebug}
                />
              )}
              {isAuthenticated && view === 'dashboard' && (
                <DashboardView
                  user={user}
                  contracts={contracts}
                  setView={setView}
                  onOpenRules={() => setInfoModal('rules')}
                  isDebug={isDebug}
                />
              )}
              {isAuthenticated && view === 'deals' && (
                <DealsView contracts={contracts} setView={setView} searchQuery={searchQuery} setSearchQuery={setSearchQuery} />
              )}
              {isAuthenticated && view === 'wallet' && (
                <WalletView user={user} setUser={setUser} notify={notify} />
              )}
              {isAuthenticated && view === 'messages' && <MessagesView contracts={contracts} setView={setView} />}
              {isAuthenticated && view === 'contacts' && <ContactsView setView={setView} notify={notify} />}
              {isAuthenticated && view === 'profile' && (
                <ProfileView
                  user={user}
                  contracts={contracts}
                  setView={setView}
                  onLogout={handleLogout}
                  onOpenModal={setInfoModal}
                />
              )}
              {isAuthenticated && view === 'support' && <SupportView user={user} setView={setView} notify={notify} />}
              {isAuthenticated && view === 'dispute' && (
                <DisputeView user={user} setView={setView} refresh={() => user && fetchInitialData(user.id)} notify={notify} />
              )}
              {isAuthenticated && view === 'direct_chat' && <DirectChatView user={user} setView={setView} />}
              {isAuthenticated && view === 'detail' && (
                <DealDetailView
                  user={user}
                  setView={setView}
                  refresh={() => user && fetchInitialData(user.id)}
                  isDebug={isDebug}
                  notify={notify}
                />
              )}
              {isAuthenticated && view === 'create' && (
                <CreateDealView
                  user={user}
                  setView={setView}
                  onBack={() => setView('dashboard')}
                  onSuccess={() => {
                    setView('deals');
                    user && fetchInitialData(user.id);
                    notify('قرارداد امن با موفقیت ایجاد شد', 'success');
                  }}
                  notify={notify}
                />
              )}
              {isAuthenticated && view === 'notifications' && (
                <NotificationsView notifications={notifications} setNotifications={setNotifications} setView={setView} />
              )}
              {isAuthenticated && view === 'admin' && (
                <AdminPanelView user={user} contracts={contracts} setView={setView} notify={notify} />
              )}
            </AnimatePresence>
          </main>

          {/* Bottom Nav */}
          {isAuthenticated && (
            <nav className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[92%] max-w-md h-16 md:h-18 bg-white/90 dark:bg-[#09090b]/90 backdrop-blur-xl border border-slate-200 dark:border-white/10 rounded-[1.5rem] md:rounded-[2rem] flex items-center justify-around px-2 md:px-4 shadow-2xl z-[100] transition-all">
              <NavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={16} />} label="خانه" />
              <NavBtn active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={16} />} label="معاملات" />
              <div className="relative -translate-y-5 md:-translate-y-6">
                <button
                  onClick={() => setView('create')}
                  className="w-12 h-12 md:w-14 md:h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-[0_0_30px_rgba(37,99,235,0.4)] border-4 border-slate-50 dark:border-black active:scale-90 transition-all"
                >
                  <Plus className="w-6 h-6 md:w-8 md:h-8" strokeWidth={3} />
                </button>
              </div>
              <NavBtn active={view === 'messages'} onClick={() => setView('messages')} icon={<MessageSquare size={16} />} label="پیام‌ها" />
              <NavBtn active={view === 'profile'} onClick={() => setView('profile')} icon={<User size={16} />} label="پنل" />
            </nav>
          )}

          {/* Web QR Scanner Modal */}
          <AnimatePresence>
            {showWebScanner && (
              <QrScannerModal
                onClose={() => setShowWebScanner(false)}
                onScan={(code) => {
                  setShowWebScanner(false);
                  const contract = contracts.find((c) => c.contract_id === code);
                  if (contract) {
                    localStorage.setItem('selected_contract', JSON.stringify(contract));
                    setView('detail');
                    notify('قرارداد با موفقیت شناسایی شد', 'success');
                  } else {
                    notify('قرارداد یافت نشد یا معتبر نیست.', 'error');
                  }
                }}
              />
            )}
          </AnimatePresence>

          {/* Unified Platform Info & Settings Modal */}
          <AnimatePresence>
            {infoModal && (
              <PlatformModal
                type={infoModal}
                user={user}
                isDarkMode={isDarkMode}
                setIsDarkMode={setIsDarkMode}
                isDebug={isDebug}
                onToggleDebug={toggleDebug}
                onClose={() => setInfoModal(null)}
                notify={notify}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </ErrorBoundary>
  );
}

// --- View Components ---

function AuthView({
  onLogin,
  onVerify,
  onResetPhone,
  isLoading,
  isOtpSent,
  loginPhone,
  previewOtp,
  onToggleDebug,
  isDebug
}: {
  onLogin: (p: string) => Promise<{ success?: boolean; error?: string; needRegistration?: boolean } | void>;
  onVerify: (c: string) => Promise<{ success?: boolean; error?: string }>;
  onResetPhone: () => void;
  isLoading: boolean;
  isOtpSent: boolean;
  loginPhone: string;
  previewOtp: string | null;
  onToggleDebug: () => void;
  isDebug: boolean;
}) {
  const [phone, setPhone] = useState(loginPhone || '');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [needReg, setNeedReg] = useState(false);
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

  const submitPhone = async () => {
    if (isLoading || !phone) return;
    setError('');
    setNeedReg(false);
    const res = await onLogin(phone);
    if (res && typeof res === 'object') {
      if (res.error) setError(res.error);
      if (res.needRegistration) setNeedReg(true);
    }
  };

  const submitOtp = async () => {
    if (isLoading || code.length < 6) return;
    setError('');
    const res = await onVerify(code);
    if (res?.error) setError(res.error);
  };

  return (
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="min-h-[75vh] flex flex-col justify-center text-center p-6 max-w-md mx-auto">
      <div className="mb-10">
        <div
          onClick={handleLogoClick}
          className="w-20 h-20 bg-blue-600 rounded-[2rem] flex items-center justify-center text-white mx-auto shadow-[0_0_40px_rgba(37,99,235,0.3)] mb-6 active:scale-90 transition-transform cursor-pointer"
        >
          <Shield size={40} />
        </div>
        <h1 className="text-4xl font-black text-slate-900 dark:text-white mb-3 tracking-tighter transition-colors">میانجی</h1>
        <p className="text-slate-500 text-sm font-medium">امنیت در معاملات فریلنسری و دیجیتال</p>
        {isDebug && <span className="inline-block mt-2 px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 text-[9px] font-mono">DEBUG MODE</span>}
      </div>

      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 p-7 md:p-8 rounded-[2.5rem] space-y-6 shadow-2xl transition-colors">
        {!isOtpSent ? (
          <>
            <div className="text-right space-y-2 mb-2">
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                برای ورود، شماره همراه خود را وارد کنید. کد تایید به حساب تلگرام شما ارسال خواهد شد.
              </p>
            </div>
            <div className="space-y-3 text-right">
              <label className="text-[11px] font-black text-blue-500 uppercase tracking-widest px-1">شماره همراه</label>
              <input
                type="tel"
                inputMode="tel"
                dir="ltr"
                placeholder="0912..."
                value={phone}
                onChange={(e) => {
                  setPhone(normalizeDigits(e.target.value));
                  setError('');
                  setNeedReg(false);
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitPhone()}
                disabled={isLoading}
                className="input-refined text-center font-mono tracking-wider"
              />
            </div>
            {error && (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl space-y-3 text-right">
                <div className="flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
                  <p className="text-xs font-bold text-rose-500 flex-1 leading-relaxed">{error}</p>
                </div>
                <div className="flex items-center gap-2 pt-1.5">
                  {needReg && (
                    <a
                      href="https://t.me/mianji_ir_bot"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 h-9 bg-linear-to-r from-sky-400 via-blue-600 to-indigo-600 hover:opacity-95 text-white rounded-lg font-black text-[11px] flex items-center justify-center gap-1.5 shadow-[0_0_15px_rgba(56,189,248,0.25)] border border-sky-300/30 transition-all active:scale-95"
                    >
                      <Send size={12} className="-rotate-45" />
                      استارت ربات
                    </a>
                  )}
                  <button
                    onClick={() => {
                      setError('');
                      setNeedReg(false);
                    }}
                    className={`h-9 px-3 bg-slate-200/60 hover:bg-slate-200 dark:bg-white/10 dark:hover:bg-white/15 text-slate-800 dark:text-slate-200 border border-slate-300/50 dark:border-white/10 rounded-lg text-[11px] font-bold transition-all active:scale-95 ${
                      needReg ? '' : 'w-full'
                    }`}
                  >
                    تلاش مجدد
                  </button>
                </div>
              </div>
            )}
            <button
              onClick={submitPhone}
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
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                dir="ltr"
                placeholder="------"
                value={code}
                onChange={(e) => {
                  const clean = normalizeDigits(e.target.value).replace(/[^0-9]/g, '').slice(0, 6);
                  setCode(clean);
                  setError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitOtp()}
                disabled={isLoading}
                className={`w-full h-14 bg-slate-50 dark:bg-black border rounded-2xl text-center text-2xl font-black tracking-[0.5em] outline-none transition-all text-slate-900 dark:text-white disabled:opacity-50 shadow-protruding ${
                  error ? 'border-rose-500 ring-4 ring-rose-500/10' : 'border-slate-200 dark:border-white/10 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-600/10'
                }`}
              />

              {previewOtp && (
                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex items-center justify-between gap-2 text-right">
                  <div>
                    <p className="text-[10px] font-black text-blue-500">کد آزمایشی پیش‌نمایش (Preview)</p>
                    <p className="text-xs font-mono font-black text-slate-900 dark:text-white tracking-widest mt-0.5">{previewOtp}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCode(previewOtp);
                      setError('');
                    }}
                    className="h-8 px-3 bg-blue-600 text-white rounded-lg text-[10px] font-black active:scale-95 transition-all"
                  >
                    درج کد
                  </button>
                </div>
              )}

              {error ? (
                <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-right mt-2">
                  <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
                  <div className="flex-1">
                    <p className="text-xs font-bold text-rose-500">{error}</p>
                  </div>
                  <button
                    onClick={() => {
                      setError('');
                      setCode('');
                    }}
                    className="text-xs font-bold text-slate-500 hover:text-slate-900 dark:hover:text-white"
                  >
                    تلاش مجدد
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-slate-500 text-center">کد تایید به تلگرام {loginPhone || phone} ارسال شد</p>
              )}
            </div>
            <button
              onClick={submitOtp}
              disabled={isLoading || code.length < 6}
              className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-black shadow-lg shadow-emerald-600/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3 btn-protruding"
            >
              {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'ورود به پنل'}
            </button>
            <button
              onClick={() => {
                setCode('');
                setError('');
                onResetPhone();
              }}
              className="w-full text-[11px] text-slate-500 font-bold hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              تغییر شماره همراه
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}

function DashboardView({ user, contracts, setView, onOpenRules }: any) {
  const activeCount = contracts.filter((c: any) => !['completed', 'cancelled'].includes(c.status)).length;
  const walletBalance = Number(user?.wallet_balance ?? 0);
  const lockedBalance = Number(user?.escrow_locked_balance ?? 0);
  const availableBalance = Math.max(0, walletBalance - lockedBalance);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-8 md:space-y-12">
      {/* Welcome Brief */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 md:w-16 md:h-16 rounded-[1.5rem] bg-blue-600 flex items-center justify-center text-white shadow-xl shadow-blue-600/20">
            <Sparkles className="w-6 h-6 md:w-8 md:h-8" fill="currentColor" />
          </div>
          <div>
            <h2 className="text-sm md:text-lg font-black text-slate-900 dark:text-white">خوش آمدید، {user?.full_name || 'کاربر میانجی'}</h2>
            <p className="text-[10px] md:text-xs text-slate-500 mt-1 uppercase tracking-widest font-bold">Smart Escrow Panel</p>
          </div>
        </div>
        <div className="text-left hidden sm:block">
          <span className="text-[10px] md:text-xs font-black text-slate-500 uppercase tracking-widest block">وضعیت حساب</span>
          <span className="text-xs md:text-sm font-bold text-emerald-500 flex items-center gap-1 justify-end">
            <Sparkles size={14} /> {user?.kyc_status === 'verified' ? 'احراز هویت شده' : 'کاربر فعال'}
          </span>
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
                <span className="text-4xl md:text-6xl font-black text-slate-900 dark:text-white tabular-nums tracking-tighter leading-none">
                  {walletBalance.toLocaleString()}
                </span>
                <span className="text-xs md:text-sm font-bold text-slate-500 uppercase">Toman</span>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-1 gap-4 w-full md:w-64">
              <div className="p-4 bg-white/60 dark:bg-black/40 rounded-2xl border border-slate-200 dark:border-white/5 backdrop-blur-md">
                <span className="text-[8px] md:text-[10px] text-slate-500 block mb-1 uppercase font-bold tracking-wider">LOCKED</span>
                <span className="text-sm md:text-lg font-black text-amber-500 tabular-nums">{lockedBalance.toLocaleString()}</span>
              </div>
              <div className="p-4 bg-white/60 dark:bg-black/40 rounded-2xl border border-slate-200 dark:border-white/5 backdrop-blur-md">
                <span className="text-[8px] md:text-[10px] text-slate-500 block mb-1 uppercase font-bold tracking-wider">AVAILABLE</span>
                <span className="text-sm md:text-lg font-black text-emerald-500 tabular-nums">{availableBalance.toLocaleString()}</span>
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
          <button
            onClick={() => setView('support')}
            className="p-6 bg-white dark:bg-white/5 rounded-[2rem] border border-slate-200 dark:border-white/5 flex flex-col items-center justify-center text-center gap-2 shadow-sm dark:shadow-none hover:border-blue-500/20 transition-all"
          >
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">پشتیبانی</span>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
              <span className="text-xs font-black text-slate-900 dark:text-white uppercase">Online</span>
            </div>
          </button>
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
            else document.dispatchEvent(new CustomEvent('open-qr-scanner'));
          }}
        />
        <FeatureCard
          icon={<ShieldCheck className="text-emerald-500" />}
          label="مرکز قوانین"
          desc="راهنمای استفاده و امنیت"
          onClick={onOpenRules}
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
          <button onClick={() => setView('deals')} className="text-xs md:text-sm font-bold text-blue-500 hover:text-blue-400 transition-colors">
            مشاهده همه لیست
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {contracts.slice(0, 6).map((c: any) => (
            <DealCard
              key={c.contract_id}
              contract={c}
              onClick={() => {
                localStorage.setItem('selected_contract', JSON.stringify(c));
                setView('detail');
              }}
            />
          ))}
          {contracts.length === 0 && (
            <div className="md:col-span-2 lg:col-span-3 p-16 text-center border-2 border-dashed border-slate-200 dark:border-white/5 rounded-[3rem] bg-slate-100/50 dark:bg-white/[0.01]">
              <ClipboardList size={48} className="mx-auto text-slate-300 dark:text-slate-800 mb-6" />
              <p className="text-sm font-bold text-slate-500">هنوز هیچ معامله‌ای ثبت نکرده‌اید</p>
              <button
                onClick={() => setView('create')}
                className="mt-6 text-blue-500 font-bold text-xs uppercase tracking-widest border-b border-blue-500/30 pb-1"
              >
                ایجاد اولین معامله
              </button>
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

function DealDetailView({ user, setView, refresh, isDebug, notify }: any) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'chat'>('info');
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showAttachments, setShowAttachments] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('selected_contract');
    if (saved) setContract(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (!contract) return;
    const useLocal = localStorage.getItem('mianji_demo_mode') === 'true' || !auth.currentUser;
    if (useLocal) {
      const savedMsgs = localStorage.getItem(`mianji_mock_messages_${contract.contract_id}`);
      setMessages(savedMsgs ? JSON.parse(savedMsgs) : []);
      return;
    }

    let q;
    try {
      q = query(
        collection(db, 'contract_messages'),
        where('contract_id', '==', contract.contract_id),
        orderBy('created_at', 'asc')
      );
    } catch {
      q = query(collection(db, 'contract_messages'), where('contract_id', '==', contract.contract_id));
    }

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const msgs = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() } as Message))
          .sort((a, b) => toMillis(a.created_at) - toMillis(b.created_at));
        setMessages(msgs);
      },
      (err) => {
        remoteLog('warn', 'Message listener fallback to local cache', err);
        const savedMsgs = localStorage.getItem(`mianji_mock_messages_${contract.contract_id}`);
        if (savedMsgs) setMessages(JSON.parse(savedMsgs));
      }
    );

    return () => unsubscribe();
  }, [contract]);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, activeTab]);

  const sendMsg = async (text: string = newMessage, type: Message['message_type'] = 'text', url?: string) => {
    if ((!text.trim() && type === 'text') || !user || !contract) return;

    const useLocal = localStorage.getItem('mianji_demo_mode') === 'true' || !auth.currentUser;
    if (useLocal) {
      const newMsg: Message = {
        id: 'm_' + Date.now(),
        contract_id: contract.contract_id,
        sender_id: String(user.id),
        message_text: text.trim(),
        message_type: type,
        attachment_url: url,
        created_at: new Date().toISOString()
      };
      const updated = [...messages, newMsg];
      setMessages(updated);
      localStorage.setItem(`mianji_mock_messages_${contract.contract_id}`, JSON.stringify(updated));
      setNewMessage('');
      setShowAttachments(false);
      return;
    }

    try {
      const payload: any = {
        contract_id: contract.contract_id,
        sender_id: String(user.id),
        message_text: text.trim().slice(0, 1000),
        message_type: type,
        created_at: serverTimestamp()
      };
      if (url) payload.attachment_url = url;
      await addDoc(collection(db, 'contract_messages'), payload);
      setNewMessage('');
      setShowAttachments(false);
    } catch (err: any) {
      remoteLog('error', 'Failed to send contract message', err);
      notify('خطا در ارسال پیام', 'error');
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
    } catch {
      notify('دسترسی به میکروفون داده نشد.', 'error');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'file') => {
    const file = e.target.files?.[0];
    if (file) {
      const mockUrl = URL.createObjectURL(file);
      sendMsg(file.name, type, mockUrl);
      e.target.value = '';
    }
  };

  const scanQr = () => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.showScanQrPopup) {
      tg.showScanQrPopup({ text: 'کد کیوآر قرارداد را اسکن کنید' }, (text: string) => {
        if (text === contract?.contract_id) {
          tg.closeScanQrPopup();
          notify('قرارداد با موفقیت تایید و امضا شد.', 'success');
        }
        return true;
      });
    } else {
      document.dispatchEvent(new CustomEvent('open-qr-scanner'));
    }
  };

  const isLocal = localStorage.getItem('mianji_demo_mode') === 'true' || !auth.currentUser;
  const actions: EscrowAction[] = contract
    ? getEscrowActions(
        contract,
        user?.id,
        async () => {
          await refresh();
          if (isLocal) {
            const saved = localStorage.getItem('selected_contract');
            if (saved) setContract(JSON.parse(saved));
          } else {
            const contractDoc = await getDoc(doc(db, 'deals', String(contract.id || contract.contract_id)));
            if (contractDoc.exists()) {
              const data = { id: contractDoc.id, ...contractDoc.data() } as Contract;
              setContract(data);
              localStorage.setItem('selected_contract', JSON.stringify(data));
            }
          }
        },
        isLocal
      )
    : [];

  if (!contract) {
    return (
      <div className="p-16 text-center space-y-4">
        <p className="text-sm font-bold text-slate-500">قراردادی انتخاب نشده است</p>
        <button onClick={() => setView('deals')} className="px-6 py-2 bg-blue-600 text-white rounded-xl text-xs font-black">
          بازگشت به لیست معاملات
        </button>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 h-full flex flex-col lg:max-w-6xl lg:mx-auto">
      {/* Header & Mobile Tab Switcher */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => setView('deals')}
          className="w-10 h-10 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-600 dark:text-slate-400 active:scale-90 transition-all shrink-0"
        >
          <ChevronRight size={20} />
        </button>

        <div className="flex-1 flex justify-center lg:hidden">
          <div className="flex p-1 bg-white dark:bg-[#09090b] rounded-2xl border border-slate-200 dark:border-white/5 shadow-sm">
            <button
              onClick={() => setActiveTab('info')}
              className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${
                activeTab === 'info' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500'
              }`}
            >
              جزئیات
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${
                activeTab === 'chat' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500'
              }`}
            >
              گفتگو
            </button>
          </div>
        </div>

        <div className="hidden lg:block flex-1 text-center">
          <h2 className="text-xl font-black text-slate-900 dark:text-white">مدیریت قرارداد</h2>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowQr(true)}
            className="w-10 h-10 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-blue-500 active:scale-90 transition-all"
          >
            <QrCode size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 lg:grid lg:grid-cols-12 lg:gap-8 min-h-0 overflow-hidden">
        {/* Info Column */}
        <div className={`lg:col-span-5 lg:flex lg:flex-col space-y-6 ${activeTab === 'info' ? 'block' : 'hidden lg:block'} overflow-y-auto pr-1`}>
          <div className="flex flex-col items-center gap-4 py-8 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] relative overflow-hidden shrink-0 shadow-xl dark:shadow-none">
            <div className="absolute top-0 left-0 w-full h-1 bg-slate-100 dark:bg-white/5">
              <div className="h-full bg-blue-600 shadow-[0_0_10px_#2563eb] transition-all" style={{ width: getProgress(contract.status) }} />
            </div>
            <StatusIcon status={contract.status} />
            <div className="text-center px-4">
              <h1 className="text-xl font-black text-slate-900 dark:text-white mb-1">{contract.title}</h1>
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{contract.contract_id}</span>
              {isDebug && <p className="text-[8px] font-mono text-rose-400 mt-1">UUID: {contract.id || 'N/A'}</p>}
            </div>
            <StatusLabel status={contract.status} />
          </div>

          <div className="grid grid-cols-2 gap-4 shrink-0">
            <DetailItem label="بودجه پروژه" value={Number(contract.amount || 0).toLocaleString()} unit="تومان" />
            <DetailItem label="وضعیت" value={translateStatus(contract.status)} color="text-blue-500" />
            <DetailItem label="کارفرما" value={String(user?.id) === String(contract.buyer_id) ? 'شما' : 'طرف مقابل'} />
            <DetailItem label="مجری" value={String(user?.id) === String(contract.seller_id) ? 'شما' : 'طرف مقابل'} />
          </div>

          {contract.description && (
            <div className="p-5 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-2xl text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              <span className="text-[10px] font-black text-slate-400 block mb-1">شرایط قرارداد:</span>
              {contract.description}
            </div>
          )}

          <div className="pt-2 space-y-3 shrink-0">
            <button
              onClick={scanQr}
              className="w-full h-14 bg-slate-900 dark:bg-white text-white dark:text-black rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95"
            >
              <Camera size={18} />
              امضای حضوری (اسکن QR)
            </button>
            {actions.map((act, idx) => (
              <button
                key={idx}
                disabled={actionBusy}
                onClick={async () => {
                  setActionBusy(true);
                  try {
                    await act.action();
                    notify('وضعیت قرارداد با موفقیت به‌روزرسانی شد', 'success');
                  } catch (e: any) {
                    notify(e?.message || 'خطا در به‌روزرسانی وضعیت قرارداد', 'error');
                  } finally {
                    setActionBusy(false);
                  }
                }}
                className={`w-full h-14 rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50 ${
                  act.variant === 'primary'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                    : act.variant === 'danger'
                    ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                    : 'bg-white dark:bg-white/5 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/10'
                }`}
              >
                {act.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chat Column */}
        <div
          className={`lg:col-span-7 flex flex-col bg-white dark:bg-[#09090b] rounded-[2.5rem] border border-slate-200 dark:border-white/5 overflow-hidden h-[60vh] lg:h-[72vh] relative shadow-xl dark:shadow-none ${
            activeTab === 'chat' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          <div ref={chatRef} className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-hide bg-slate-50 dark:bg-[#050505]">
            <div className="flex justify-center mb-6">
              <span className="px-4 py-1 bg-white dark:bg-white/5 rounded-full text-[10px] text-slate-500 font-bold border border-slate-200 dark:border-white/5">
                {formatDateFa(contract.createdAt || contract.created_at)}
              </span>
            </div>

            {messages.length === 0 && (
              <div className="text-center py-12 text-slate-400 text-xs font-bold">
                گفتگو درباره قرارداد را اینجا شروع کنید
              </div>
            )}

            {messages.map((m) => {
              const isOwn = String(m.sender_id) === String(user?.id);
              return (
                <div key={m.id} className={`flex ${isOwn ? 'justify-start' : 'justify-end'}`}>
                  <div
                    className={`max-w-[85%] px-4 py-3 rounded-[1.5rem] text-[12px] leading-relaxed relative shadow-lg ${
                      isOwn
                        ? 'bg-blue-600 text-white rounded-br-none'
                        : 'bg-white dark:bg-[#18181b] text-slate-900 dark:text-slate-200 border border-slate-200 dark:border-white/5 rounded-bl-none'
                    }`}
                  >
                    {m.message_type === 'text' || !m.message_type ? <p className="whitespace-pre-wrap">{m.message_text}</p> : null}
                    {m.message_type === 'image' && m.attachment_url && (
                      <img
                        src={m.attachment_url}
                        className="rounded-xl mb-1 max-w-full cursor-pointer hover:opacity-90 transition-opacity"
                        alt="Attachment"
                        onClick={() => setPreviewImg(m.attachment_url || null)}
                      />
                    )}
                    {m.message_type === 'voice' && m.attachment_url && <VoiceMessagePlayer url={m.attachment_url} isOwn={isOwn} />}
                    {m.message_type === 'file' && (
                      <a
                        href={m.attachment_url || '#'}
                        download={m.message_text}
                        className="flex items-center gap-3 p-3 bg-black/10 dark:bg-black/20 rounded-xl border border-black/5 dark:border-white/5 hover:bg-black/20 transition-all"
                      >
                        <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center text-blue-500">
                          <FileText size={16} />
                        </div>
                        <div className="flex-1 overflow-hidden">
                          <p className="text-[10px] font-bold truncate">{m.message_text}</p>
                          <p className="text-[8px] opacity-60 uppercase">Document / File</p>
                        </div>
                      </a>
                    )}
                    <div className={`flex items-center gap-1 mt-1 justify-end opacity-60 ${isOwn ? 'text-blue-100' : 'text-slate-500'}`}>
                      <span className="text-[8px] font-mono">{formatTimeFa(m.created_at)}</span>
                      {isOwn && <Check size={10} strokeWidth={3} />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <AnimatePresence>
            {showAttachments && (
              <motion.div
                initial={{ y: 100 }}
                animate={{ y: 0 }}
                exit={{ y: 100 }}
                className="absolute bottom-20 left-4 right-4 bg-white dark:bg-black border border-slate-200 dark:border-white/10 rounded-3xl p-4 grid grid-cols-3 gap-4 shadow-2xl z-20"
              >
                <AttachmentBtn icon={<ImageIcon />} label="گالری" onClick={() => document.getElementById('imgInput')?.click()} />
                <AttachmentBtn icon={<FileText />} label="فایل" onClick={() => document.getElementById('fileInput')?.click()} />
                <AttachmentBtn icon={<Camera />} label="دوربین" onClick={() => document.getElementById('camInput')?.click()} />
                <input id="imgInput" type="file" accept="image/*" hidden onChange={(e) => handleFileUpload(e, 'image')} />
                <input id="fileInput" type="file" hidden onChange={(e) => handleFileUpload(e, 'file')} />
                <input id="camInput" type="file" accept="image/*" capture="environment" hidden onChange={(e) => handleFileUpload(e, 'image')} />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="p-4 bg-slate-100/70 dark:bg-black/40 border-t border-slate-200 dark:border-white/5 flex items-center gap-2">
            <button
              onClick={() => setShowAttachments(!showAttachments)}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${
                showAttachments ? 'bg-blue-600 text-white' : 'bg-white dark:bg-white/5 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-transparent'
              }`}
            >
              <Paperclip size={20} />
            </button>
            <input
              className="flex-1 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 rounded-2xl px-5 h-12 text-sm text-slate-900 dark:text-white focus:border-blue-600 outline-none"
              placeholder="پیام خود را بنویسید..."
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMsg()}
            />
            {newMessage.trim() ? (
              <button
                onClick={() => sendMsg()}
                className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20 active:scale-90 transition-all"
              >
                <Send size={18} />
              </button>
            ) : (
              <button
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
                onTouchStart={startRecording}
                onTouchEnd={stopRecording}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${
                  isRecording ? 'bg-rose-600 text-white animate-pulse' : 'bg-white dark:bg-white/5 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-transparent'
                }`}
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
            <div className="w-10 h-10 rounded-xl bg-rose-500 flex items-center justify-center text-white">
              <Gavel size={20} />
            </div>
            <div>
              <p className="text-xs font-black text-slate-900 dark:text-white">اختلاف ثبت شده است</p>
              <p className="text-[10px] text-rose-500 dark:text-rose-300">در حال بررسی توسط داور میانجی</p>
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

      {/* QR Code Modal */}
      <AnimatePresence>
        {showQr && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-8">
            <div className="w-full max-w-sm bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 rounded-[3rem] p-8 text-center space-y-6 relative">
              <button onClick={() => setShowQr(false)} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500">
                <X size={20} />
              </button>
              <div className="pt-8">
                <div className="p-6 bg-white rounded-3xl inline-block shadow-[0_0_50px_rgba(0,0,0,0.1)] border border-slate-100">
                  <QRCodeSVG value={contract.contract_id} size={200} />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-black text-slate-900 dark:text-white">کیو‌آر تایید قرارداد</h3>
                <p className="text-xs text-slate-500 leading-relaxed">طرف مقابل با اسکن این کد می‌تواند قرارداد را در لحظه امضا و تایید کند.</p>
              </div>
              <div className="pt-2">
                <span className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">{contract.contract_id}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* In-App Image Lightbox Modal */}
      <AnimatePresence>
        {previewImg && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setPreviewImg(null)}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[300] flex items-center justify-center p-6"
          >
            <button onClick={() => setPreviewImg(null)} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center">
              <X size={20} />
            </button>
            <img src={previewImg} alt="Full Preview" className="max-w-full max-h-[85vh] rounded-2xl shadow-2xl" />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function AttachmentBtn({ icon, label, onClick }: any) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 p-4 bg-slate-100 dark:bg-white/5 rounded-2xl hover:bg-slate-200 dark:hover:bg-white/10 transition-all active:scale-95">
      <div className="text-blue-500">{icon}</div>
      <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400">{label}</span>
    </button>
  );
}

// --- Helpers & Small Components ---

function Sidebar({ isOpen, onClose, user, setView, onLogout, onOpenModal }: any) {
  const menuItems: { icon: React.ReactNode; label: string; action: () => void; badge?: string; disabled?: boolean }[] = [
    ...(user?.role === 'owner' || user?.role === 'admin'
      ? [{ icon: <Shield />, label: 'پنل مدیریت و پشتیبانی', action: () => setView('admin') }]
      : []),
    { icon: <User />, label: 'پروفایل کاربری', action: () => setView('profile') },
    { icon: <CreditCard />, label: 'تراکنش‌های مالی', action: () => setView('wallet') },
    { icon: <Sparkles />, label: 'بازارچه میانجی', action: () => {}, badge: 'بزودی', disabled: true },
    { icon: <Mic />, label: 'تماس صوتی و تصویری', action: () => {}, badge: 'بزودی', disabled: true },
    { icon: <Users />, label: 'معرفی به دوستان', action: () => onOpenModal('invite') },
    { icon: <ShieldCheck />, label: 'قوانین و مقررات', action: () => onOpenModal('rules') },
    { icon: <HelpCircle />, label: 'پشتیبانی آنلاین', action: () => setView('support') },
    { icon: <Settings />, label: 'تنظیمات پنل', action: () => onOpenModal('settings') },
    { icon: <Info />, label: 'درباره میانجی', action: () => onOpenModal('about') }
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1000]"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
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
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500 active:scale-90 transition-all"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 space-y-0.5 overflow-y-auto scrollbar-hide">
              {menuItems.map((item, idx) => (
                <button
                  key={idx}
                  disabled={item.disabled}
                  onClick={() => {
                    item.action();
                    onClose();
                  }}
                  className={`w-full flex items-center gap-3 p-2 rounded-xl transition-all group relative ${
                    item.disabled
                      ? 'opacity-30 grayscale cursor-not-allowed'
                      : 'hover:bg-slate-50 dark:hover:bg-white/5 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white active:scale-[0.98]'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-lg bg-slate-100 dark:bg-white/5 flex items-center justify-center transition-colors ${
                      !item.disabled && 'group-hover:bg-blue-600/10 group-hover:text-blue-500 shadow-sm'
                    }`}
                  >
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
                <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black text-sm shadow-lg border-2 border-white dark:border-black/50">
                  {user?.full_name?.[0] || 'U'}
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-black text-slate-900 dark:text-white truncate transition-colors">{user?.full_name || 'کاربر مهمان'}</p>
                  <p className="text-[9px] text-slate-500 font-mono" dir="ltr">
                    {user?.phone_number}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  onLogout();
                  onClose();
                }}
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

function DealCard({ contract, onClick }: { contract: Contract; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full p-6 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-3xl text-right flex justify-between items-center group active:scale-[0.98] transition-all shadow-protruding shadow-protruding-hover hover:border-blue-500/20"
    >
      <div className="space-y-1 text-right">
        <h3 className="text-sm font-black text-slate-900 dark:text-white group-hover:text-blue-500 transition-colors">{contract.title}</h3>
        <span className="text-[10px] font-bold text-slate-500 tabular-nums">{Number(contract.amount || 0).toLocaleString()} تومان</span>
      </div>
      <StatusLabel status={contract.status} small />
    </button>
  );
}

function DetailItem({ label, value, unit, color }: any) {
  return (
    <div className="p-4 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-2xl shadow-sm dark:shadow-none">
      <span className="text-[9px] font-black text-slate-500 block mb-1">{label}</span>
      <div className={`text-sm font-black text-slate-900 dark:text-white ${color || ''}`}>
        {value} {unit && <span className="text-[10px] text-slate-500 dark:text-slate-600">{unit}</span>}
      </div>
    </div>
  );
}

function StatusLabel({ status, small }: { status: string; small?: boolean }) {
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
  if (['completed'].includes(status))
    return (
      <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center border border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.1)]">
        <Check size={32} strokeWidth={3} />
      </div>
    );
  if (['active', 'work_submitted'].includes(status))
    return (
      <div className="w-16 h-16 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(37,99,235,0.3)]">
        <Lock size={32} strokeWidth={3} />
      </div>
    );
  if (['disputed'].includes(status))
    return (
      <div className="w-16 h-16 bg-rose-500/10 text-rose-500 rounded-full flex items-center justify-center border border-rose-500/20">
        <Gavel size={32} strokeWidth={3} />
      </div>
    );
  return (
    <div className="w-16 h-16 bg-slate-100 dark:bg-white/5 text-slate-500 rounded-full flex items-center justify-center border border-slate-200 dark:border-white/10">
      <Clock size={32} strokeWidth={3} />
    </div>
  );
}

function getProgress(status: string) {
  if (status === 'completed') return '100%';
  if (status === 'work_submitted') return '75%';
  if (status === 'active') return '50%';
  if (status === 'awaiting_payment') return '25%';
  return '10%';
}

function translateStatus(status: string) {
  const map: any = {
    draft: 'پیش‌نویس',
    awaiting_payment: 'در انتظار پرداخت',
    active: 'در حال اجرا',
    work_submitted: 'تحویل شده',
    completed: 'تسویه شده',
    cancelled: 'لغو شده',
    disputed: 'اختلاف'
  };
  return map[status] || status;
}

function DealsView({ contracts, setView, searchQuery, setSearchQuery }: any) {
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'pending' | 'completed' | 'disputed'>('all');
  const [showFilters, setShowFilters] = useState(false);

  const filtered = contracts.filter((c: Contract) => {
    const q = (searchQuery || '').trim().toLowerCase();
    const matchesSearch = !q || c.title.toLowerCase().includes(q) || c.contract_id.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    if (filterStatus === 'active') return ['active', 'work_submitted'].includes(c.status);
    if (filterStatus === 'pending') return ['draft', 'awaiting_payment'].includes(c.status);
    if (filterStatus === 'completed') return c.status === 'completed';
    if (filterStatus === 'disputed') return c.status === 'disputed';
    return true;
  });

  const filterChips = [
    { key: 'all', label: 'همه' },
    { key: 'active', label: 'در حال اجرا' },
    { key: 'pending', label: 'در انتظار' },
    { key: 'completed', label: 'تکمیل شده' },
    { key: 'disputed', label: 'اختلاف' }
  ] as const;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 pb-10">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-black text-slate-900 dark:text-white">لیست معاملات</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('create')}
            className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-black flex items-center gap-1.5 shadow-lg shadow-blue-600/20 active:scale-95 transition-all"
          >
            <Plus size={16} /> جدید
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`w-10 h-10 rounded-xl border flex items-center justify-center transition-all ${
              showFilters ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400'
            }`}
          >
            <Filter size={18} />
          </button>
        </div>
      </div>

      <div className="relative md:hidden">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="جستجوی عنوان یا شناسه قرارداد..."
          className="input-refined pr-11 h-12 text-xs"
        />
      </div>

      {(showFilters || filterStatus !== 'all') && (
        <div className="flex flex-wrap gap-2">
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setFilterStatus(chip.key)}
              className={`px-4 py-2 rounded-xl text-[11px] font-black transition-all ${
                filterStatus === chip.key
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-600/20'
                  : 'bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-500'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3">
        {filtered.length > 0 ? (
          filtered.map((c: any) => (
            <DealCard
              key={c.contract_id}
              contract={c}
              onClick={() => {
                localStorage.setItem('selected_contract', JSON.stringify(c));
                setView('detail');
              }}
            />
          ))
        ) : (
          <div className="p-16 text-center bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem]">
            <ClipboardList size={42} className="mx-auto text-slate-300 dark:text-slate-700 mb-3" />
            <p className="text-xs font-bold text-slate-500">معامله‌ای با این مشخصات یافت نشد</p>
          </div>
        )}
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
      const initial = [{ id: 101, full_name: 'پشتیبانی میانجی', phone_number: '0210000', last_msg: 'چطور می‌تونم کمکتون کنم؟', time: new Date().toISOString() }];
      setDirectChats(initial);
      localStorage.setItem('mianji_direct_chats', JSON.stringify(initial));
    }
  }, []);

  const allItems = [
    ...contracts.map((c: any) => ({ ...c, type: 'contract' })),
    ...directChats.map((d: any) => ({ ...d, type: 'direct' }))
  ].sort((a, b) => toMillis(b.createdAt || b.created_at || b.time) - toMillis(a.createdAt || a.created_at || a.time));

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
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
                  item.type === 'contract' ? 'bg-blue-600/10 text-blue-500' : 'bg-emerald-600/10 text-emerald-500'
                }`}
              >
                {item.type === 'contract' ? <MessageCircle size={20} /> : <User size={20} />}
              </div>
              <div className="flex-1 overflow-hidden">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-black text-slate-900 dark:text-white truncate transition-colors">{item.title || item.full_name}</span>
                  <span className="text-[8px] text-slate-500 font-mono">{formatDateFa(item.createdAt || item.created_at || item.time)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-slate-500 truncate">
                    {item.type === 'contract' ? `گفتگو درباره قرارداد ${item.contract_id}` : item.last_msg || 'گفتگوی مستقیم'}
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
      <div className="p-8 border-2 border-dashed border-slate-200 dark:border-white/5 rounded-[2.5rem] bg-slate-100/50 dark:bg-white/[0.01] text-center space-y-4">
        <div className="w-12 h-12 bg-amber-500/10 text-amber-500 rounded-2xl flex items-center justify-center mx-auto">
          <Sparkles size={24} />
        </div>
        <div>
          <h3 className="text-sm font-black text-slate-900 dark:text-white">منتظر بازارچه میانجی باشید</h3>
          <p className="text-[10px] text-slate-500 leading-relaxed mt-1">بستری امن برای خرید و فروش خدمات و کالاهای دیجیتال با ضمانت میانجی</p>
        </div>
      </div>
    </motion.div>
  );
}

function CreateDealView({ user, onBack, onSuccess, setView, notify }: any) {
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
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const prefill = localStorage.getItem('mianji_prefill_phone');
    if (prefill) {
      setFormData((prev) => ({ ...prev, phone: normalizeDigits(prefill) }));
      localStorage.removeItem('mianji_prefill_phone');
    }
  }, []);

  const handleSubmit = async () => {
    setFormError('');
    const titleTrim = formData.title.trim();
    const numericAmount = Number(normalizeDigits(formData.amount).replace(/[^0-9]/g, ''));
    const otherPhoneClean = normalizeDigits(formData.phone).replace(/[^0-9]/g, '');

    if (!titleTrim || !formData.amount || !otherPhoneClean) {
      setFormError('لطفاً عنوان، مبلغ و شماره همراه طرف مقابل را کامل وارد کنید');
      return;
    }
    if (!numericAmount || numericAmount < 1000) {
      setFormError('مبلغ معامله باید حداقل ۱,۰۰۰ تومان باشد');
      return;
    }
    if (otherPhoneClean.length < 10) {
      setFormError('شماره همراه طرف مقابل معتبر نیست');
      return;
    }

    const ownClean = normalizeDigits(String(user?.phone_number || '')).replace(/[^0-9]/g, '');
    if (ownClean && ownClean.slice(-10) === otherPhoneClean.slice(-10)) {
      setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد');
      return;
    }

    setLoading(true);
    try {
      const contractId = `M-${Math.floor(100000 + Math.random() * 900000)}`;
      const isLocalMode = localStorage.getItem('mianji_demo_mode') === 'true' || !auth.currentUser;

      let otherUser: any = null;
      try {
        const lookupRes = await fetch(`/api/users/lookup?phone=${encodeURIComponent(otherPhoneClean)}`);
        const lookupResult = await lookupRes.json();
        if (lookupResult.success && lookupResult.user) {
          otherUser = lookupResult.user;
        }
      } catch {}

      if (isLocalMode) {
        const otherId = otherUser?.id || `u_${otherPhoneClean.slice(-10)}`;
        const newContract: Contract = {
          id: contractId,
          contract_id: contractId,
          title: titleTrim,
          amount: numericAmount,
          buyer_id: formData.role === 'buyer' ? String(user.id) : String(otherId),
          seller_id: formData.role === 'seller' ? String(user.id) : String(otherId),
          status: 'draft',
          category: formData.category,
          description: formData.description.trim(),
          created_at: new Date().toISOString()
        };
        const saved = localStorage.getItem('mianji_mock_contracts');
        const existing = saved ? JSON.parse(saved) : [];
        localStorage.setItem('mianji_mock_contracts', JSON.stringify([newContract, ...existing]));
        onSuccess();
        return;
      }

      if (!otherUser) {
        setFormError('شماره همراه طرف مقابل در سیستم یافت نشد. او باید ابتدا ربات تلگرام را استارت کند.');
        setLoading(false);
        return;
      }

      const dealData = {
        contract_id: contractId,
        title: titleTrim.slice(0, 200),
        amount: numericAmount,
        buyer_id: formData.role === 'buyer' ? String(user.id) : String(otherUser.id),
        seller_id: formData.role === 'seller' ? String(user.id) : String(otherUser.id),
        status: 'draft',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        category: formData.category,
        description: formData.description.trim().slice(0, 2000),
        deadline: String(formData.deadline || '7').slice(0, 20),
        revisions: String(formData.revisions || '2').slice(0, 20)
      };

      // Use contractId as document ID so security rules (contract_messages / transactions) resolve cleanly
      await setDoc(doc(db, 'deals', contractId), dealData);
      onSuccess();
    } catch (err: any) {
      remoteLog('error', 'Error creating deal', err);
      notify(err?.message || 'خطا در ثبت معامله', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-8 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="w-10 h-10 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all"
        >
          <ChevronRight size={20} />
        </button>
        <h2 className="text-xl font-black text-slate-900 dark:text-white">ایجاد معامله جدید</h2>
      </div>

      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 p-8 md:p-12 rounded-[2.5rem] space-y-8 shadow-2xl">
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">عنوان پروژه</label>
              <input
                placeholder="طراحی وب‌سایت، فروش اکانت و..."
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                className="input-refined shadow-protruding"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">مبلغ معامله (تومان)</label>
              <input
                type="text"
                inputMode="numeric"
                dir="ltr"
                placeholder="1000000"
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') })}
                className="input-refined shadow-protruding text-center font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">دسته‌بندی معامله</label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <CategoryBtn active={formData.category === 'digital'} onClick={() => setFormData({ ...formData, category: 'digital' })} label="خدمات دیجیتال" icon={<Sparkles size={12} />} />
              <CategoryBtn active={formData.category === 'physical'} onClick={() => setFormData({ ...formData, category: 'physical' })} label="کالای فیزیکی" icon={<CreditCard size={12} />} />
              <CategoryBtn active={formData.category === 'account'} onClick={() => setFormData({ ...formData, category: 'account' })} label="اکانت و اشتراک" icon={<User size={12} />} />
              <CategoryBtn active={formData.category === 'other'} onClick={() => setFormData({ ...formData, category: 'other' })} label="سایر موارد" icon={<MoreVertical size={12} />} />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">شماره همراه طرف مقابل</label>
            <div className="flex gap-2">
              <input
                type="tel"
                dir="ltr"
                placeholder="0912..."
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: normalizeDigits(e.target.value) })}
                className="input-refined shadow-protruding text-center font-mono"
              />
              <button
                type="button"
                onClick={() => setView('contacts')}
                className="w-14 h-14 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-2xl flex items-center justify-center text-blue-500 hover:bg-slate-50 dark:hover:bg-white/10 active:scale-95 transition-all shadow-protruding shrink-0"
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
                type="text"
                inputMode="numeric"
                dir="ltr"
                placeholder="7"
                value={formData.deadline}
                onChange={(e) => setFormData({ ...formData, deadline: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') })}
                className="input-refined shadow-protruding text-center font-mono"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase px-1">تعداد ویرایش رایگان</label>
              <input
                type="text"
                inputMode="numeric"
                dir="ltr"
                placeholder="2"
                value={formData.revisions}
                onChange={(e) => setFormData({ ...formData, revisions: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') })}
                className="input-refined shadow-protruding text-center font-mono"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">توضیحات و شرایط قرارداد</label>
            <textarea
              placeholder="جزئیات پروژه، نحوه تحویل و هرگونه توافق جانبی را اینجا بنویسید..."
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full h-32 bg-slate-50 dark:bg-black border border-slate-200 dark:border-white/10 rounded-2xl p-5 text-sm text-slate-900 dark:text-white focus:border-blue-600 outline-none transition-all resize-none shadow-protruding"
            />
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase px-1">نقش شما در معامله</label>
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setFormData({ ...formData, role: 'seller' })}
                className={`h-16 rounded-2xl font-bold text-sm border transition-all flex flex-col items-center justify-center gap-1 ${
                  formData.role === 'seller'
                    ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20'
                    : 'bg-slate-50 dark:bg-black border-slate-200 dark:border-white/10 text-slate-500'
                }`}
              >
                مجری هستم
                <span className="text-[8px] opacity-70">ارائه‌دهنده خدمات/کالا</span>
              </button>
              <button
                type="button"
                onClick={() => setFormData({ ...formData, role: 'buyer' })}
                className={`h-16 rounded-2xl font-bold text-sm border transition-all flex flex-col items-center justify-center gap-1 ${
                  formData.role === 'buyer'
                    ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20'
                    : 'bg-slate-50 dark:bg-black border-slate-200 dark:border-white/10 text-slate-500'
                }`}
              >
                کارفرما هستم
                <span className="text-[8px] opacity-70">پرداخت‌کننده وجه</span>
              </button>
            </div>
          </div>
        </div>

        {formError && (
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 text-right">
            <AlertCircle size={18} className="text-rose-500 shrink-0" />
            <p className="text-xs font-bold text-rose-500">{formError}</p>
          </div>
        )}

        <div className="pt-2">
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full h-16 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
          >
            {loading ? (
              <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <Check size={20} />
                تایید و ایجاد قرارداد امن
              </>
            )}
          </button>
          <p className="text-[10px] text-slate-500 text-center mt-4">
            با کلیک روی این دکمه، شما <span className="text-blue-500">قوانین میانجی</span> را می‌پذیرید.
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function DisputeView({ user, setView, refresh, notify }: any) {
  const [contract, setContract] = useState<any>(null);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [newEvidenceText, setNewEvidenceText] = useState('');
  const [loading, setLoading] = useState(false);
  const [verdict, setVerdict] = useState<'refund' | 'release' | 'split'>('release');

  useEffect(() => {
    const saved = localStorage.getItem('selected_contract');
    if (saved) {
      const c = JSON.parse(saved);
      setContract(c);
      const savedEvidence = localStorage.getItem(`mianji_dispute_evidence_${c.contract_id}`);
      if (savedEvidence) {
        setEvidence(JSON.parse(savedEvidence));
      } else {
        setEvidence([
          { id: 1, sender_id: c.buyer_id, text: 'کار مطابق با توافق انجام نشده است.', created_at: new Date().toISOString() },
          { id: 2, sender_id: c.seller_id, text: 'تمامی مراحل پروژه انجام و تاییدیه گرفته شده بود.', created_at: new Date().toISOString() }
        ]);
      }
    }
  }, []);

  const submitEvidence = (customText?: string) => {
    const txt = (customText ?? newEvidenceText).trim();
    if (!txt || !contract) return;
    const item = {
      id: Date.now(),
      sender_id: user?.id,
      text: txt,
      created_at: new Date().toISOString()
    };
    const updated = [...evidence, item];
    setEvidence(updated);
    localStorage.setItem(`mianji_dispute_evidence_${contract.contract_id}`, JSON.stringify(updated));
    if (!customText) setNewEvidenceText('');
    notify('گزارش شما در پرونده داوری ثبت شد', 'success');
  };

  const canArbitrate = user?.role === 'owner' || user?.role === 'admin' || !auth.currentUser;

  const handleVerdict = async () => {
    if (!contract) return;
    setLoading(true);
    const newStatus = verdict === 'refund' ? 'cancelled' : 'completed';
    const isLocal = localStorage.getItem('mianji_demo_mode') === 'true' || !auth.currentUser;

    try {
      if (isLocal) {
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
        const contractRef = doc(db, 'deals', String(contract.id || contract.contract_id));
        await updateDoc(contractRef, {
          status: newStatus,
          updatedAt: serverTimestamp()
        });
      }
      await refresh();
      setView('detail');
      notify('رأی داور با موفقیت ثبت و معامله مختومه شد.', 'success');
    } catch (err: any) {
      notify(err?.message || 'تنها داور یا مدیر سیستم مجاز به ثبت رأی نهایی است.', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!contract) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setView('detail')}
          className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all"
        >
          <ChevronRight size={20} />
        </button>
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
          <div className="p-5 bg-slate-50 dark:bg-black/40 rounded-3xl border border-slate-200 dark:border-white/5">
            <span className="text-[10px] font-black text-slate-500 uppercase block mb-1">مبلغ مورد تنازع</span>
            <span className="text-xl font-black text-slate-900 dark:text-white tabular-nums">{Number(contract.amount || 0).toLocaleString()} تومان</span>
          </div>
          <div className="p-5 bg-slate-50 dark:bg-black/40 rounded-3xl border border-slate-200 dark:border-white/5">
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
          {evidence.map((item) => {
            const isOwn = String(item.sender_id) === String(user?.id);
            return (
              <div key={item.id} className={`flex flex-col gap-2 ${isOwn ? 'items-start' : 'items-end'}`}>
                <div
                  className={`p-4 rounded-2xl text-[11px] md:text-xs leading-relaxed max-w-[90%] ${
                    isOwn
                      ? 'bg-blue-600 text-white shadow-lg'
                      : 'bg-slate-100 dark:bg-white/5 text-slate-900 dark:text-slate-300 border border-slate-200 dark:border-white/10 shadow-sm'
                  }`}
                >
                  <p className="mb-2 font-bold opacity-60 text-[8px]">{String(item.sender_id) === String(contract.buyer_id) ? 'کارفرما' : 'مجری'}</p>
                  {item.text}
                </div>
              </div>
            );
          })}

          <div className="pt-4 border-t border-slate-100 dark:border-white/5 space-y-4">
            <textarea
              value={newEvidenceText}
              onChange={(e) => setNewEvidenceText(e.target.value)}
              className="w-full h-24 bg-slate-50 dark:bg-black border border-slate-200 dark:border-white/10 rounded-2xl p-4 text-xs text-slate-900 dark:text-white focus:border-blue-600 outline-none transition-all resize-none shadow-protruding"
              placeholder="توضیحات تکمیلی یا دفاعیه خود را اینجا بنویسید..."
            />
            <div className="flex gap-2">
              <input
                id="disputeFileInput"
                type="file"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) submitEvidence(`📎 پیوست مدرک: ${file.name}`);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => document.getElementById('disputeFileInput')?.click()}
                className="flex-1 h-12 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-700 dark:text-white rounded-xl text-[10px] font-black flex items-center justify-center gap-2 btn-protruding"
              >
                <Paperclip size={14} /> ضمیمه فایل/تصویر
              </button>
              <button
                type="button"
                onClick={() => submitEvidence()}
                disabled={!newEvidenceText.trim()}
                className="flex-1 h-12 bg-blue-600 text-white rounded-xl text-[10px] font-black active:scale-95 transition-all shadow-lg shadow-blue-600/20 btn-protruding disabled:opacity-50"
              >
                ارسال گزارش به داور
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Arbitrator Panel */}
      {canArbitrate && (
        <div className="p-8 bg-linear-to-br from-amber-600/10 to-transparent border border-amber-500/20 rounded-[2.5rem] space-y-6 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-amber-500/30" />
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-500">
              <Sparkles size={20} />
            </div>
            <h3 className="text-sm font-black text-amber-500 uppercase tracking-widest">پنل داوری</h3>
          </div>

          <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-relaxed">
            داور محترم، پس از بررسی کامل شواهد و گفتگوهای طرفین، می‌توانید نسبت به تخصیص وجه معامله اقدام کنید. این تصمیم قطعی و غیرقابل بازگشت است.
          </p>

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
      )}
    </motion.div>
  );
}

function VerdictBtn({ active, onClick, label, desc }: any) {
  return (
    <button
      onClick={onClick}
      className={`p-4 rounded-2xl border transition-all text-right space-y-1 ${
        active
          ? 'bg-amber-500 border-amber-600 text-black shadow-lg shadow-amber-600/20'
          : 'bg-white dark:bg-black border-slate-200 dark:border-white/10 text-slate-500 shadow-sm dark:shadow-none'
      }`}
    >
      <p className="text-xs font-black">{label}</p>
      <p className={`text-[8px] font-bold ${active ? 'text-black/60' : 'text-slate-500 dark:text-slate-600'}`}>{desc}</p>
    </button>
  );
}

function CategoryBtn({ active, onClick, label, icon }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-12 rounded-xl flex items-center justify-center gap-2 text-[10px] font-bold border transition-all ${
        active
          ? 'bg-blue-600/10 dark:bg-white/10 border-blue-600/20 dark:border-white/20 text-blue-600 dark:text-white shadow-lg dark:shadow-white/5'
          : 'bg-white dark:bg-black border-slate-200 dark:border-white/5 text-slate-500 hover:border-slate-300 dark:hover:border-white/10 shadow-sm dark:shadow-none'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ContactsView({ setView, notify }: any) {
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
        { id: 3, full_name: 'شرکت آریا', phone_number: '02188889900', status: 'verified', trust_score: 85 }
      ];
      setContacts(initial);
      localStorage.setItem('mianji_contacts', JSON.stringify(initial));
    }
  }, []);

  const handleAdd = () => {
    const cleanPhone = normalizeDigits(newContact.phone).replace(/[^0-9]/g, '');
    if (!newContact.name.trim() || cleanPhone.length < 8) {
      notify('لطفاً نام و شماره تماس معتبر وارد کنید', 'error');
      return;
    }
    const item = {
      id: Date.now(),
      full_name: newContact.name.trim(),
      phone_number: cleanPhone,
      status: 'pending',
      trust_score: 0
    };
    const updated = [item, ...contacts];
    setContacts(updated);
    localStorage.setItem('mianji_contacts', JSON.stringify(updated));
    setNewAddContact({ name: '', phone: '' });
    setShowAddModal(false);
    notify('مخاطب جدید ذخیره شد', 'success');
  };

  const normalizedQuery = normalizeDigits(searchTerm).toLowerCase();
  const filtered = contacts.filter(
    (c) => c.full_name.toLowerCase().includes(normalizedQuery) || String(c.phone_number).includes(normalizedQuery)
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center justify-between px-2">
        <h2 className="text-xl font-black text-slate-900 dark:text-white">مخاطبین من</h2>
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
          onChange={(e) => setSearchTerm(e.target.value)}
          className="input-refined pr-12 shadow-protruding"
        />
      </div>

      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-slate-100 dark:divide-white/5 shadow-2xl">
        {filtered.length > 0 ? (
          filtered.map((contact) => (
            <div key={contact.id} className="p-5 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors relative group">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-700 dark:text-slate-300 font-black relative border border-slate-200 dark:border-white/5">
                {contact.full_name[0]}
                <div
                  className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-white dark:border-black ${
                    contact.status === 'verified' ? 'bg-emerald-500' : 'bg-slate-400'
                  }`}
                />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-black text-slate-900 dark:text-white">{contact.full_name}</span>
                  {contact.trust_score > 0 && (
                    <span className="px-2 py-0.5 bg-blue-500/10 text-blue-500 text-[8px] font-black rounded-full uppercase">Trust {contact.trust_score}</span>
                  )}
                </div>
                <p className="text-[10px] text-slate-500 font-mono" dir="ltr">
                  {contact.phone_number}
                </p>
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
                  className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-400 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-white/10 transition-all active:scale-90"
                  title="معامله جدید"
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="p-20 text-center text-slate-500">
            <Users size={48} className="mx-auto mb-4 opacity-20" />
            <p className="text-xs font-bold">مخاطبی یافت نشد</p>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[500] flex items-center justify-center p-6"
          >
            <div className="w-full max-w-sm bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 rounded-[2.5rem] p-8 space-y-6 relative shadow-2xl">
              <button
                onClick={() => setShowAddModal(false)}
                className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500"
              >
                <X size={20} />
              </button>
              <div className="text-center pt-4">
                <h3 className="text-xl font-black text-slate-900 dark:text-white">افزودن مخاطب</h3>
                <p className="text-xs text-slate-500 mt-1">اطلاعات مخاطب جدید را وارد کنید</p>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase px-1">نام و نام خانوادگی</label>
                  <input
                    value={newContact.name}
                    onChange={(e) => setNewAddContact({ ...newContact, name: e.target.value })}
                    placeholder="مثلاً: علی رضایی"
                    className="input-refined shadow-protruding"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase px-1">شماره همراه</label>
                  <input
                    dir="ltr"
                    value={newContact.phone}
                    onChange={(e) => setNewAddContact({ ...newContact, phone: normalizeDigits(e.target.value) })}
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

function WalletView({ user, setUser, notify }: any) {
  const [modalMode, setModalMode] = useState<'deposit' | 'withdraw' | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [refInput, setRefInput] = useState('');
  const [history, setHistory] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem('mianji_wallet_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const walletBalance = Number(user?.wallet_balance ?? 0);
  const lockedBalance = Number(user?.escrow_locked_balance ?? 0);
  const availableBalance = getAvailableBalance(user);

  const handleWalletSubmit = () => {
    const amt = Number(normalizeDigits(amountInput).replace(/[^0-9]/g, ''));
    if (!amt || amt < 10000) {
      notify('حداقل مبلغ تراکنش ۱۰,۰۰۰ تومان است', 'error');
      return;
    }
    if (modalMode === 'withdraw' && amt > availableBalance) {
      notify('موجودی قابل برداشت کافی نیست', 'error');
      return;
    }
    if (modalMode === 'withdraw' && refInput.trim().length < 8) {
      notify('شماره شبا یا کارت مقصد را کامل وارد کنید', 'error');
      return;
    }

    const entry = {
      id: 'tx_' + Date.now(),
      type: modalMode,
      amount: amt,
      ref: refInput.trim() || `REQ-${Math.floor(100000 + Math.random() * 900000)}`,
      status: !auth.currentUser ? 'completed' : 'pending',
      created_at: new Date().toISOString()
    };

    const nextHistory = [entry, ...history];
    setHistory(nextHistory);
    localStorage.setItem('mianji_wallet_history', JSON.stringify(nextHistory));

    if (!auth.currentUser && user) {
      const nextBalance = modalMode === 'deposit' ? walletBalance + amt : Math.max(0, walletBalance - amt);
      const updatedUser = { ...user, wallet_balance: nextBalance };
      setUser(updatedUser);
      localStorage.setItem('mianji_mock_user', JSON.stringify(updatedUser));
    }

    notify(
      modalMode === 'deposit' ? 'درخواست افزایش موجودی با موفقیت ثبت شد' : 'درخواست تسویه حساب ثبت گردید',
      'success'
    );
    setAmountInput('');
    setRefInput('');
    setModalMode(null);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8 max-w-2xl mx-auto pb-12">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-[1.5rem] flex items-center justify-center mx-auto border border-emerald-500/20">
          <Wallet size={28} />
        </div>
        <h2 className="text-2xl font-black text-slate-900 dark:text-white">کیف پول من</h2>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div className="p-8 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] flex flex-col items-center gap-4 shadow-xl dark:shadow-none">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">موجودی کل</span>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-black text-slate-900 dark:text-white tabular-nums">{walletBalance.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500 uppercase">Toman</span>
          </div>
          <div className="grid grid-cols-2 gap-3 w-full pt-2">
            <div className="p-3 bg-slate-50 dark:bg-white/5 rounded-2xl text-center">
              <span className="text-[9px] font-bold text-slate-500 block">قابل برداشت</span>
              <span className="text-sm font-black text-emerald-500 tabular-nums">{availableBalance.toLocaleString()}</span>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-white/5 rounded-2xl text-center">
              <span className="text-[9px] font-bold text-slate-500 block">در امانت معاملات</span>
              <span className="text-sm font-black text-amber-500 tabular-nums">{lockedBalance.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => setModalMode('deposit')}
            className="h-16 bg-blue-600 text-white rounded-2xl font-black flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-all text-sm btn-protruding"
          >
            <Plus size={18} /> افزایش موجودی
          </button>
          <button
            onClick={() => setModalMode('withdraw')}
            className="h-16 bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white rounded-2xl font-black flex items-center justify-center gap-2 active:scale-95 transition-all text-sm shadow-protruding"
          >
            <ArrowUpRight size={18} /> درخواست تسویه
          </button>
        </div>
      </div>

      {history.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-black text-slate-900 dark:text-white px-2">سوابق مالی اخیر</h3>
          <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2rem] divide-y divide-slate-100 dark:divide-white/5 overflow-hidden">
            {history.map((tx) => (
              <div key={tx.id} className="p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black text-slate-900 dark:text-white">
                    {tx.type === 'deposit' ? 'شارژ کیف پول' : 'درخواست تسویه'} — {Number(tx.amount).toLocaleString()} تومان
                  </p>
                  <p className="text-[10px] text-slate-500 font-mono mt-0.5">{tx.ref}</p>
                </div>
                <span
                  className={`px-3 py-1 rounded-full text-[9px] font-black ${
                    tx.status === 'completed' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                  }`}
                >
                  {tx.status === 'completed' ? 'تکمیل شد' : 'در حال بررسی'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <AnimatePresence>
        {modalMode && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/80 backdrop-blur-md z-[500] flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 rounded-[2.5rem] p-8 space-y-5 relative shadow-2xl">
              <button
                onClick={() => setModalMode(null)}
                className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500"
              >
                <X size={20} />
              </button>
              <div className="text-center pt-4">
                <h3 className="text-lg font-black text-slate-900 dark:text-white">
                  {modalMode === 'deposit' ? 'افزایش موجودی کیف پول' : 'درخواست تسویه حساب'}
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  {modalMode === 'deposit' ? 'مبلغ واریزی و کد پیگیری را وارد کنید' : `حداکثر قابل برداشت: ${availableBalance.toLocaleString()} تومان`}
                </p>
              </div>
              <div className="space-y-3">
                <input
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  placeholder="مبلغ به تومان (مثلا 500000)"
                  value={amountInput}
                  onChange={(e) => setAmountInput(normalizeDigits(e.target.value).replace(/[^0-9]/g, ''))}
                  className="input-refined text-center font-mono"
                />
                <input
                  type="text"
                  dir="ltr"
                  placeholder={modalMode === 'deposit' ? 'شماره پیگیری فیش (اختیاری)' : 'شماره شبا (IR...)'}
                  value={refInput}
                  onChange={(e) => setRefInput(normalizeDigits(e.target.value))}
                  className="input-refined text-center font-mono"
                />
              </div>
              <button
                onClick={handleWalletSubmit}
                className="w-full h-14 bg-blue-600 text-white rounded-2xl font-black shadow-lg shadow-blue-600/20 active:scale-95 transition-all"
              >
                ثبت درخواست
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ProfileView({ user, contracts, setView, onLogout, onOpenModal }: any) {
  const completedCount = (contracts || []).filter((c: any) => c.status === 'completed').length;

  const profileMenu = [
    { icon: <Wallet size={16} />, label: 'مدیریت کیف پول', desc: 'شارژ و برداشت موجودی', action: () => setView('wallet') },
    {
      icon: <ShieldCheck size={16} />,
      label: 'احراز هویت (KYC)',
      desc: 'تایید هویت برای افزایش سقف معامله',
      badge: user?.kyc_status === 'verified' ? 'تایید شده' : 'در انتظار',
      badgeColor: user?.kyc_status === 'verified' ? 'text-emerald-500' : 'text-amber-500',
      action: () => onOpenModal('kyc')
    },
    { icon: <ClipboardList size={16} />, label: 'تاریخچه معاملات', desc: 'مشاهده تمام قراردادهای قبلی', action: () => setView('deals') },
    { icon: <Bell size={16} />, label: 'تنظیمات اطلاع‌رسانی', desc: 'پیامک و نوتیفیکیشن تلگرام', action: () => onOpenModal('notif_prefs') },
    { icon: <Lock size={16} />, label: 'امنیت و ورود', desc: 'مدیریت دستگاه‌ها و نشست‌های فعال', action: () => onOpenModal('security') },
    { icon: <HelpCircle size={16} />, label: 'مرکز پشتیبانی', desc: 'پاسخ به سوالات و ارسال تیکت', action: () => setView('support') }
  ];

  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-6 max-w-2xl mx-auto pb-10">
      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] p-8 flex flex-col items-center text-center space-y-4 relative overflow-hidden shadow-2xl dark:shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
        <div className="absolute top-0 left-0 w-full h-32 bg-linear-to-b from-blue-600/10 to-transparent" />
        <div className="relative">
          <div className="w-20 h-20 rounded-[2rem] bg-blue-600 flex items-center justify-center text-white font-black text-2xl shadow-xl shadow-blue-600/20 border-4 border-slate-50 dark:border-black">
            {user?.full_name?.[0] || 'U'}
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-emerald-500 rounded-full border-4 border-white dark:border-black flex items-center justify-center text-white shadow-lg">
            <ShieldCheck size={12} fill="currentColor" />
          </div>
        </div>
        <div className="relative z-10">
          <h2 className="text-lg font-black text-slate-900 dark:text-white">{user?.full_name || 'کاربر مهمان'}</h2>
          <p className="text-[10px] text-slate-500 font-mono" dir="ltr">
            {user?.phone_number || '09xxxxxxxxx'}
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 bg-blue-600/10 border border-blue-600/20 rounded-full">
          <Sparkles size={10} className="text-blue-500" />
          <span className="text-[9px] font-black text-blue-500 uppercase tracking-widest">
            {user?.role === 'owner' ? 'Platform Owner' : user?.role === 'admin' ? 'Platform Admin' : 'Verified Member'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2rem] p-5 space-y-2 shadow-sm dark:shadow-none">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">وضعیت تایید</span>
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-blue-500" fill="currentColor" />
            <span className="text-lg font-black text-slate-900 dark:text-white">{user?.kyc_status === 'verified' ? 'تایید شده' : 'در حال بررسی'}</span>
          </div>
        </div>
        <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2rem] p-5 space-y-2 shadow-sm dark:shadow-none">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block">معاملات موفق</span>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-500" />
            <span className="text-lg font-black text-slate-900 dark:text-white tabular-nums">{completedCount}</span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/5 rounded-[2.5rem] overflow-hidden divide-y divide-slate-100 dark:divide-white/5 shadow-xl dark:shadow-none">
        {profileMenu.map((item, idx) => (
          <button
            key={idx}
            onClick={item.action}
            className="w-full p-5 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-white/5 transition-all active:bg-slate-100 dark:active:bg-white/10 text-right group"
          >
            <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500 dark:text-slate-400 group-hover:bg-blue-600/10 group-hover:text-blue-500 transition-colors shrink-0">
              {item.icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-black text-slate-900 dark:text-white">{item.label}</span>
                {item.badge && <span className={`text-[9px] font-black uppercase tracking-widest ${item.badgeColor}`}>{item.badge}</span>}
              </div>
              <p className="text-[10px] text-slate-500">{item.desc}</p>
            </div>
            <ChevronLeft size={16} className="text-slate-400 dark:text-slate-700 group-hover:text-slate-600 dark:group-hover:text-slate-400 transition-colors" />
          </button>
        ))}
      </div>

      <button
        onClick={onLogout}
        className="w-full h-16 rounded-[1.5rem] bg-rose-500/10 text-rose-500 font-black flex items-center justify-center gap-3 active:scale-95 transition-all border border-rose-500/10 hover:bg-rose-500/20"
      >
        <LogOut size={18} /> خروج از حساب کاربری
      </button>

      <div className="text-center">
        <p className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">Mianji Escrow v2.4.0</p>
      </div>
    </motion.div>
  );
}

function SupportView({ user, setView, notify }: any) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [tickets, setTickets] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem('mianji_support_tickets');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const submitTicket = () => {
    if (!subject.trim() || !message.trim()) {
      notify('لطفاً موضوع و متن پیام را وارد کنید', 'error');
      return;
    }
    const newTicket = {
      id: 'T-' + Math.floor(1000 + Math.random() * 9000),
      user_name: user?.full_name || 'کاربر میانجی',
      subject: subject.trim(),
      message: message.trim(),
      status: 'pending',
      created_at: new Date().toISOString()
    };
    const updated = [newTicket, ...tickets];
    setTickets(updated);
    localStorage.setItem('mianji_support_tickets', JSON.stringify(updated));
    setSubject('');
    setMessage('');
    notify('تیکت پشتیبانی با موفقیت ثبت شد', 'success');
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 max-w-2xl mx-auto pb-16">
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-600 dark:text-slate-300"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">مرکز پشتیبانی آنلاین</h2>
            <p className="text-[10px] text-slate-500 font-bold">پاسخگویی سریع تیم میانجی</p>
          </div>
        </div>
        <a
          href="https://t.me/mianji_ir_bot"
          target="_blank"
          rel="noopener noreferrer"
          className="h-9 px-4 bg-blue-600 text-white rounded-xl text-xs font-black flex items-center gap-1.5"
        >
          <ExternalLink size={14} /> ربات تلگرام
        </a>
      </div>

      <div className="card-refined p-6 space-y-4">
        <h3 className="text-sm font-black text-slate-900 dark:text-white">ارسال تیکت جدید</h3>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="موضوع درخواست یا مشکل..."
          className="input-refined"
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="توضیحات کامل خود را بنویسید..."
          className="w-full h-28 bg-slate-50 dark:bg-black border border-slate-200 dark:border-white/10 rounded-2xl p-4 text-xs text-slate-900 dark:text-white outline-none focus:border-blue-600 resize-none"
        />
        <button
          onClick={submitTicket}
          className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs active:scale-95 transition-all"
        >
          ارسال تیکت پشتیبانی
        </button>
      </div>

      {tickets.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-black text-slate-900 dark:text-white px-2">تیکت‌های ارسالی</h3>
          {tickets.map((t) => (
            <div key={t.id} className="card-refined p-5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-900 dark:text-white">{t.subject}</span>
                <span className="px-2.5 py-0.5 rounded-full text-[9px] font-black bg-amber-500/10 text-amber-500">در انتظار بررسی</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">{t.message}</p>
              <p className="text-[9px] text-slate-400 font-mono">{t.id} • {formatDateTimeFa(t.created_at)}</p>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// --- Voice Message Player ---
function VoiceMessagePlayer({ url, isOwn }: { url: string; isOwn: boolean }) {
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
    else audioRef.current?.play().catch(() => {});
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="flex items-center gap-3 py-1 min-w-[160px]">
      <button
        onClick={toggle}
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${
          isOwn ? 'bg-white/20 hover:bg-white/30' : 'bg-blue-600/20 hover:bg-blue-600/30 text-blue-500'
        }`}
      >
        {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="mr-[-2px]" />}
      </button>
      <div className="h-1.5 flex-1 bg-white/10 rounded-full overflow-hidden relative">
        <motion.div className={`absolute left-0 top-0 h-full ${isOwn ? 'bg-white' : 'bg-blue-600'}`} style={{ width: `${progress}%` }} />
      </div>
      <span className="text-[9px] font-mono opacity-60">Audio</span>
    </div>
  );
}

// --- Web QR Scanner Modal ---
function QrScannerModal({ onClose, onScan }: { onClose: () => void; onScan: (res: string) => void }) {
  useEffect(() => {
    const scanner = new Html5QrcodeScanner('qr-reader', { fps: 10, qrbox: 250 }, false);
    scanner.render(
      (result) => {
        onScan(result);
        scanner.clear().catch(() => {});
      },
      () => {}
    );
    return () => {
      scanner.clear().catch(() => {});
    };
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/95 backdrop-blur-xl z-[300] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 rounded-[2.5rem] p-8 space-y-6 relative">
        <button onClick={onClose} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500 z-10">
          <X size={20} />
        </button>
        <div className="text-center space-y-2 pt-4">
          <h3 className="text-xl font-black text-slate-900 dark:text-white">اسکنر قرارداد</h3>
          <p className="text-xs text-slate-500">دوربین را مقابل کد QR قرارداد قرار دهید</p>
        </div>
        <div id="qr-reader" className="overflow-hidden rounded-3xl border border-slate-200 dark:border-white/5 bg-black/50" />
        <p className="text-[10px] text-slate-500 text-center">میانجی به صورت خودکار کد را شناسایی می‌کند</p>
      </div>
    </motion.div>
  );
}

// --- Unified Platform Info Modal ---
function PlatformModal({ type, user, isDarkMode, setIsDarkMode, isDebug, onToggleDebug, onClose, notify }: any) {
  const botLink = 'https://t.me/mianji_ir_bot';

  const copyText = async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      notify('لینک با موفقیت کپی شد', 'success');
    } catch {
      notify('کپی انجام نشد', 'error');
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1100] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white dark:bg-[#09090b] border border-slate-200 dark:border-white/10 rounded-[2.5rem] p-8 space-y-6 relative shadow-2xl">
        <button onClick={onClose} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-500">
          <X size={20} />
        </button>

        {type === 'rules' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">قوانین و مقررات میانجی</h3>
            <ul className="space-y-2.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed list-disc pr-4">
              <li>وجه معامله تا لحظه تایید نهایی تحویل کارفرما به صورت امانت نزد میانجی قفل می‌ماند.</li>
              <li>هیچ‌یک از طرفین امکان تغییر یک‌طرفه مبلغ یا طرفین قرارداد پس از ثبت را ندارند.</li>
              <li>در صورت بروز اختلاف، تمامی گفتگوهای ثبت‌شده در صفحه معامله مبنای داوری خواهد بود.</li>
              <li>احراز هویت شماره همراه از طریق ربات رسمی تلگرام برای امنیت دوطرفه الزامی است.</li>
            </ul>
          </div>
        )}

        {type === 'invite' && (
          <div className="space-y-4 text-center pt-4">
            <div className="w-14 h-14 bg-blue-600/10 text-blue-500 rounded-2xl flex items-center justify-center mx-auto">
              <Users size={26} />
            </div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">معرفی میانجی به دوستان</h3>
            <p className="text-xs text-slate-500 leading-relaxed">برای انجام معاملات امن با همکاران و مشتریان خود، لینک ربات میانجی را برای آن‌ها ارسال کنید.</p>
            <div className="p-3 bg-slate-100 dark:bg-white/5 rounded-2xl font-mono text-xs text-blue-500" dir="ltr">
              {botLink}
            </div>
            <button onClick={() => copyText(botLink)} className="w-full h-12 bg-blue-600 text-white rounded-xl font-black text-xs flex items-center justify-center gap-2">
              <Copy size={16} /> کپی لینک دعوت
            </button>
          </div>
        )}

        {type === 'settings' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">تنظیمات پنل</h3>
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-white/5 rounded-2xl">
              <span className="text-xs font-bold text-slate-900 dark:text-white">حالت شب (Dark Mode)</span>
              <button onClick={() => setIsDarkMode(!isDarkMode)} className="px-4 py-1.5 rounded-xl bg-blue-600 text-white text-[11px] font-black">
                {isDarkMode ? 'فعال' : 'غیرفعال'}
              </button>
            </div>
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-white/5 rounded-2xl">
              <span className="text-xs font-bold text-slate-900 dark:text-white">حالت عیب‌یابی (Debug)</span>
              <button onClick={onToggleDebug} className={`px-4 py-1.5 rounded-xl text-[11px] font-black ${isDebug ? 'bg-amber-500 text-black' : 'bg-slate-200 dark:bg-white/10 text-slate-600 dark:text-slate-300'}`}>
                {isDebug ? 'فعال' : 'غیرفعال'}
              </button>
            </div>
          </div>
        )}

        {type === 'about' && (
          <div className="space-y-4 text-center pt-4">
            <div className="w-14 h-14 bg-blue-600 text-white rounded-2xl flex items-center justify-center mx-auto shadow-lg shadow-blue-600/20">
              <Shield size={28} />
            </div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">پلتفرم امن میانجی</h3>
            <p className="text-xs text-slate-500 leading-relaxed">شبکه هوشمند واسطه‌گری مالی و ضمانت معاملات آنلاین، یکپارچه با ربات تلگرام میانجی.</p>
            <span className="inline-block px-3 py-1 bg-slate-100 dark:bg-white/5 rounded-full text-[10px] font-mono text-slate-500">Version 2.4.0</span>
          </div>
        )}

        {type === 'kyc' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">وضعیت احراز هویت (KYC)</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              وضعیت فعلی حساب شما:{' '}
              <strong className="text-emerald-500">{user?.kyc_status === 'verified' ? 'تایید شده (سطح نقره‌ای)' : 'در حال تکمیل'}</strong>
            </p>
            <p className="text-[11px] text-slate-500">شماره همراه ثبت‌شده در تلگرام: <span dir="ltr" className="font-mono">{user?.phone_number}</span></p>
          </div>
        )}

        {type === 'notif_prefs' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">تنظیمات اطلاع‌رسانی</h3>
            <p className="text-xs text-slate-500 leading-relaxed">تمامی کدهای تایید و تغییرات وضعیت قراردادها به صورت لحظه‌ای به ربات تلگرام شما ارسال می‌شوند.</p>
          </div>
        )}

        {type === 'security' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">امنیت و نشست فعال</h3>
            <p className="text-xs text-slate-500 leading-relaxed">ورود دو مرحله‌ای از طریق ربات رسمی تلگرام میانجی فعال است و هر کد تایید تنها یک‌بار و تا ۱۵ دقیقه معتبر است.</p>
          </div>
        )}
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
    if (saved) {
      const t = JSON.parse(saved);
      setTarget(t);
      const historyKey = `mianji_direct_msgs_${t.id}`;
      const existing = localStorage.getItem(historyKey);
      if (existing) {
        setMessages(JSON.parse(existing));
      } else {
        setMessages([
          { id: 1, sender_id: 0, text: 'سلام، وقت بخیر', created_at: new Date(Date.now() - 3600000).toISOString() },
          { id: 2, sender_id: user?.id, text: 'درود، چطور می‌تونم کمکتون کنم؟', created_at: new Date(Date.now() - 1800000).toISOString() }
        ]);
      }
    }
  }, []);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  const send = () => {
    if (!newMessage.trim() || !target) return;
    const msg = {
      id: Date.now(),
      sender_id: user?.id,
      text: newMessage.trim(),
      created_at: new Date().toISOString()
    };
    const updated = [...messages, msg];
    setMessages(updated);
    localStorage.setItem(`mianji_direct_msgs_${target.id}`, JSON.stringify(updated));
    setNewMessage('');
  };

  if (!target) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col max-w-4xl mx-auto pb-6">
      <div className="flex items-center justify-between mb-4 px-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('contacts')}
            className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-500 dark:text-slate-400 active:scale-90 transition-all"
          >
            <ChevronRight size={20} />
          </button>
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black">{target.full_name[0]}</div>
          <div>
            <h2 className="text-sm font-black text-slate-900 dark:text-white">{target.full_name}</h2>
            <p className="text-[10px] text-emerald-500 font-bold">Online</p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col bg-white dark:bg-[#09090b] rounded-[2.5rem] border border-slate-200 dark:border-white/5 overflow-hidden min-h-[60vh] relative shadow-2xl">
        <div ref={chatRef} className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50 dark:bg-[#050505] scrollbar-hide">
          {messages.map((m) => {
            const isOwn = String(m.sender_id) === String(user?.id);
            return (
              <div key={m.id} className={`flex ${isOwn ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[80%] px-4 py-3 rounded-[1.5rem] text-[12px] leading-relaxed relative ${
                    isOwn
                      ? 'bg-blue-600 text-white rounded-br-none shadow-[0_4px_15px_rgba(37,99,235,0.2)]'
                      : 'bg-white dark:bg-[#18181b] text-slate-900 dark:text-slate-200 border border-slate-200 dark:border-white/5 rounded-bl-none shadow-lg'
                  }`}
                >
                  {m.text}
                  <div className={`text-[8px] mt-1 text-left opacity-50 ${isOwn ? 'text-blue-100' : 'text-slate-500'}`}>{formatTimeFa(m.created_at)}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-4 bg-slate-100/50 dark:bg-black/40 border-t border-slate-200 dark:border-white/5 flex items-center gap-2">
          <input
            className="input-refined flex-1 shadow-protruding"
            placeholder="پیام خود را بنویسید..."
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <button onClick={send} className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-600/20 active:scale-90 transition-all">
            <Send size={18} />
          </button>
        </div>
      </div>

      <div className="mt-4 flex justify-center">
        <button
          onClick={() => {
            localStorage.setItem('mianji_prefill_phone', target.phone_number);
            setView('create');
          }}
          className="px-6 py-2 bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-full text-[10px] font-black text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-white transition-all flex items-center gap-2 shadow-sm dark:shadow-none"
        >
          <Sparkles size={12} className="text-blue-500" />
          شروع معامله امن با این مخاطب
        </button>
      </div>
    </motion.div>
  );
}

function NotificationsView({
  notifications,
  setNotifications,
  setView
}: {
  notifications: any[];
  setNotifications: React.Dispatch<React.SetStateAction<any[]>>;
  setView: (v: View) => void;
}) {
  const persistLocal = (next: any[]) => {
    if (!auth.currentUser) {
      localStorage.setItem('mianji_mock_notifications', JSON.stringify(next));
    }
  };

  const markAsRead = async (id: string) => {
    const next = notifications.map((n) => (n.id === id ? { ...n, is_read: true } : n));
    setNotifications(next);
    persistLocal(next);
    if (auth.currentUser) {
      try {
        await updateDoc(doc(db, 'notifications', id), { is_read: true });
      } catch {}
    }
  };

  const markAllAsRead = async () => {
    const unread = notifications.filter((n) => !n.is_read);
    const next = notifications.map((n) => ({ ...n, is_read: true }));
    setNotifications(next);
    persistLocal(next);
    if (auth.currentUser) {
      try {
        await Promise.all(unread.map((n) => updateDoc(doc(db, 'notifications', n.id), { is_read: true })));
      } catch {}
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-20">
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-600 dark:text-slate-300 active:scale-95 transition-all"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">اعلان‌ها</h2>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Notifications</p>
          </div>
        </div>
        {notifications.some((n) => !n.is_read) && (
          <button onClick={markAllAsRead} className="text-xs font-bold text-blue-500 hover:text-blue-400 px-3 py-1.5 bg-blue-500/10 rounded-xl">
            خواندن همه
          </button>
        )}
      </div>

      <div className="space-y-3">
        {notifications.length === 0 ? (
          <div className="card-refined p-12 text-center text-slate-500">
            <Bell size={36} className="mx-auto mb-3 opacity-30" />
            <p className="text-xs font-bold">هیچ اعلانی وجود ندارد</p>
          </div>
        ) : (
          notifications.map((n: any) => (
            <div
              key={n.id}
              onClick={() => !n.is_read && markAsRead(n.id)}
              className={`card-refined p-5 flex items-start gap-4 cursor-pointer transition-all ${!n.is_read ? 'bg-blue-500/5 border-blue-500/20' : ''}`}
            >
              <div
                className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                  !n.is_read ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30' : 'bg-slate-100 dark:bg-white/5 text-slate-400'
                }`}
              >
                <Bell size={18} />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-black text-slate-900 dark:text-white">{n.title || 'اعلان جدید'}</h4>
                  {!n.is_read && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{n.message || n.text || ''}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}

function AdminPanelView({ user, contracts, setView, notify }: { user: UserProfile | null; contracts: Contract[]; setView: (v: View) => void; notify: (m: string, t?: ToastState['type']) => void }) {
  const [activeTab, setActiveTab] = useState<'support' | 'finance' | 'deals' | 'users'>('support');
  const [supportInquiries, setSupportInquiries] = useState<any[]>([
    { id: 'sup_1', user_name: 'علی رضایی', phone: '09123456789', text: 'سلام، واریز وجه انجام شده ولی هنوز در کیف پول ننشسته.', status: 'pending', created_at: new Date().toISOString() },
    { id: 'sup_2', user_name: 'سارا احمدی', phone: '09198765432', text: 'چطور می‌توانم معامله امن با قرارداد اختصاصی ثبت کنم؟', status: 'resolved', created_at: new Date(Date.now() - 86400000).toISOString() }
  ]);
  const [manualSlips, setManualSlips] = useState<any[]>([
    { id: 'slip_1', user_name: 'محمد رضایی', amount: 5000000, type: 'deposit', ref_code: 'TRX-982341', status: 'pending', created_at: new Date().toISOString() },
    { id: 'slip_2', user_name: 'زهرا کریمی', amount: 2500000, type: 'withdraw', ref_code: 'W-482910', status: 'pending', created_at: new Date(Date.now() - 3600000).toISOString() }
  ]);
  const [replyMap, setReplyMap] = useState<Record<string, string>>({});
  const [adminPerms, setAdminPerms] = useState({ manage_support: true, manage_finance: true });

  const isOwner = user?.role === 'owner';

  const handleResolveSupport = (id: string) => {
    setSupportInquiries((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'resolved', reply: replyMap[id] || 'پاسخ داده شد' } : s)));
    setReplyMap((prev) => ({ ...prev, [id]: '' }));
    notify('پاسخ تیکت با موفقیت ثبت شد', 'success');
  };

  const handleApproveSlip = (id: string) => {
    setManualSlips((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'approved' } : s)));
    notify('تراکنش تایید شد', 'success');
  };

  const handleRejectSlip = (id: string) => {
    setManualSlips((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'rejected' } : s)));
    notify('تراکنش رد شد', 'info');
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-24">
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center text-slate-600 dark:text-slate-300 active:scale-95 transition-all"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">پنل مدیریت و پشتیبانی</h2>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">{isOwner ? 'مالک کل (Owner)' : 'ادمین سیستم (Admin)'}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <button
          onClick={() => setActiveTab('support')}
          className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
            activeTab === 'support' ? 'bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-600/30' : 'card-refined text-slate-700 dark:text-slate-300'
          }`}
        >
          <MessageSquare size={20} />
          <div>
            <span className="text-xs font-black block">پشتیبانی و تیکت‌ها</span>
            <span className="text-[9px] opacity-80">{supportInquiries.filter((s) => s.status === 'pending').length} در انتظار</span>
          </div>
        </button>
        <button
          onClick={() => setActiveTab('finance')}
          className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
            activeTab === 'finance' ? 'bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-600/30' : 'card-refined text-slate-700 dark:text-slate-300'
          }`}
        >
          <CreditCard size={20} />
          <div>
            <span className="text-xs font-black block">بررسی فیش‌ها و مالی</span>
            <span className="text-[9px] opacity-80">{manualSlips.filter((s) => s.status === 'pending').length} درخواست</span>
          </div>
        </button>
        <button
          onClick={() => setActiveTab('deals')}
          className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
            activeTab === 'deals' ? 'bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-600/30' : 'card-refined text-slate-700 dark:text-slate-300'
          }`}
        >
          <ClipboardList size={20} />
          <div>
            <span className="text-xs font-black block">نظارت بر معاملات</span>
            <span className="text-[9px] opacity-80">{contracts.length} قرارداد</span>
          </div>
        </button>
        {isOwner && (
          <button
            onClick={() => setActiveTab('users')}
            className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
              activeTab === 'users' ? 'bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-600/30' : 'card-refined text-slate-700 dark:text-slate-300'
            }`}
          >
            <Users size={20} />
            <div>
              <span className="text-xs font-black block">مدیریت دسترسی‌ها</span>
              <span className="text-[9px] opacity-80">کنترل مالک</span>
            </div>
          </button>
        )}
      </div>

      {activeTab === 'support' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-black text-slate-900 dark:text-white">پیام‌ها و مشکلات کاربران (پشتیبانی زنده)</h3>
          </div>
          <div className="space-y-3">
            {supportInquiries.map((item) => (
              <div key={item.id} className="card-refined p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-600/10 text-blue-500 flex items-center justify-center font-black text-sm">{item.user_name[0]}</div>
                    <div>
                      <h4 className="text-xs font-black text-slate-900 dark:text-white">
                        {item.user_name} ({item.phone})
                      </h4>
                      <span className="text-[9px] text-slate-500">{formatDateTimeFa(item.created_at)}</span>
                    </div>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-[10px] font-bold ${
                      item.status === 'pending' ? 'bg-amber-500/10 text-amber-500' : 'bg-emerald-500/10 text-emerald-500'
                    }`}
                  >
                    {item.status === 'pending' ? 'در انتظار پاسخ' : 'پاسخ داده شده'}
                  </span>
                </div>
                <div className="p-4 bg-slate-50 dark:bg-white/5 rounded-2xl text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{item.text}</div>
                {item.status === 'pending' && (
                  <div className="flex items-center gap-2 pt-2">
                    <input
                      type="text"
                      placeholder="پاسخ به کاربر..."
                      className="input-refined flex-1 h-11 text-xs"
                      value={replyMap[item.id] || ''}
                      onChange={(e) => setReplyMap((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    />
                    <button
                      onClick={() => handleResolveSupport(item.id)}
                      className="h-11 px-5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-black shadow-lg shadow-blue-600/25 active:scale-95 transition-all"
                    >
                      ارسال پاسخ و حل مشکل
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'finance' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-black text-slate-900 dark:text-white">بررسی فیش‌های واریزی و درخواست‌های برداشت دستی</h3>
          </div>
          <div className="space-y-3">
            {manualSlips.map((slip) => (
              <div key={slip.id} className="card-refined p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2.5 py-0.5 rounded-md text-[10px] font-black uppercase ${
                        slip.type === 'deposit' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                      }`}
                    >
                      {slip.type === 'deposit' ? 'واریز (فیش)' : 'برداشت وجه'}
                    </span>
                    <span className="text-xs font-bold text-slate-500">کد پیگیری: {slip.ref_code}</span>
                  </div>
                  <h4 className="text-sm font-black text-slate-900 dark:text-white">
                    {slip.user_name} — <span className="text-blue-500">{Number(slip.amount).toLocaleString()} تومان</span>
                  </h4>
                  <span className="text-[9px] text-slate-400 block">{formatDateTimeFa(slip.created_at)}</span>
                </div>

                <div className="flex items-center gap-2">
                  {slip.status === 'pending' ? (
                    <>
                      <button
                        onClick={() => handleApproveSlip(slip.id)}
                        className="h-10 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black shadow-md shadow-emerald-600/20 active:scale-95 transition-all"
                      >
                        تایید واریز / فیش
                      </button>
                      <button
                        onClick={() => handleRejectSlip(slip.id)}
                        className="h-10 px-4 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-black shadow-md shadow-rose-600/20 active:scale-95 transition-all"
                      >
                        رد درخواست
                      </button>
                    </>
                  ) : (
                    <span
                      className={`px-3 py-1 rounded-xl text-xs font-bold ${
                        slip.status === 'approved' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                      }`}
                    >
                      {slip.status === 'approved' ? 'تایید و اعمال شد' : 'رد شد'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'deals' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-black text-slate-900 dark:text-white">نظارت بر تمامی معاملات پلتفرم</h3>
          </div>
          <div className="space-y-3">
            {contracts.length > 0 ? (
              contracts.map((c) => (
                <div key={c.id || c.contract_id} className="card-refined p-5 flex items-center justify-between gap-4">
                  <div>
                    <h4 className="text-sm font-black text-slate-900 dark:text-white">{c.title}</h4>
                    <span className="text-[10px] text-slate-500">
                      شناسه: {c.contract_id} | مبلغ: {Number(c.amount || 0).toLocaleString()} تومان
                    </span>
                  </div>
                  <StatusLabel status={c.status} />
                </div>
              ))
            ) : (
              <div className="card-refined p-10 text-center text-xs font-bold text-slate-500">قراردادی ثبت نشده است</div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'users' && isOwner && (
        <div className="card-refined p-6 space-y-6">
          <div>
            <h3 className="text-sm font-black text-slate-900 dark:text-white">تعیین دسترسی ادمین‌ها توسط مالک</h3>
            <p className="text-[11px] text-slate-500 mt-1">به عنوان مالک کل، می‌توانید سطوح دسترسی بخش‌های پشتیبانی و مالی را برای ادمین‌ها تنظیم کنید.</p>
          </div>

          <div className="space-y-4">
            <label className="p-4 bg-slate-50 dark:bg-white/5 rounded-2xl flex items-center justify-between cursor-pointer">
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">بخش پشتیبانی و پاسخ به تیکت‌ها</h4>
                <span className="text-[10px] text-slate-500">دسترسی ادمین به چت‌ها و حل مشکلات کاربران</span>
              </div>
              <input
                type="checkbox"
                checked={adminPerms.manage_support}
                onChange={(e) => {
                  setAdminPerms((p) => ({ ...p, manage_support: e.target.checked }));
                  notify('سطح دسترسی پشتیبانی به‌روزرسانی شد', 'info');
                }}
                className="w-5 h-5 accent-blue-600 rounded-lg cursor-pointer"
              />
            </label>
            <label className="p-4 bg-slate-50 dark:bg-white/5 rounded-2xl flex items-center justify-between cursor-pointer">
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">بخش بررسی فیش‌ها و درخواست‌های مالی</h4>
                <span className="text-[10px] text-slate-500">دسترسی ادمین به تایید/رد واریزی و برداشت‌ها</span>
              </div>
              <input
                type="checkbox"
                checked={adminPerms.manage_finance}
                onChange={(e) => {
                  setAdminPerms((p) => ({ ...p, manage_finance: e.target.checked }));
                  notify('سطح دسترسی مالی به‌روزرسانی شد', 'info');
                }}
                className="w-5 h-5 accent-blue-600 rounded-lg cursor-pointer"
              />
            </label>
          </div>
        </div>
      )}
    </motion.div>
  );
}
