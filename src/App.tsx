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
  Menu, CreditCard, Sparkles, Sun, Moon, Copy, ExternalLink, Minus
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
import { TelegramMessagesHub, TelegramChatRoom } from './components/TelegramMessenger';

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
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center bg-[#05070b] text-white font-sans" dir="rtl">
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
  const [activeMobileChat, setActiveMobileChat] = useState<{ type: 'direct' | 'contract' | 'channel'; id: string } | null>(null);

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
    const root = document.documentElement;
    root.classList.toggle('dark', isDarkMode);
    root.style.colorScheme = isDarkMode ? 'dark' : 'only light';
    localStorage.setItem('mianji_theme', isDarkMode ? 'dark' : 'light');

    const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
    if (colorSchemeMeta) {
      colorSchemeMeta.setAttribute('content', isDarkMode ? 'dark' : 'only light');
    }
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', isDarkMode ? '#05070b' : '#ffffff');
    }

    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      try {
        tg.setHeaderColor?.(isDarkMode ? '#05070b' : '#ffffff');
        tg.setBackgroundColor?.(isDarkMode ? '#05070b' : '#ffffff');
      } catch {}
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

      if (otpRes.success && (otpRes.telegramDelivered || otpRes.previewOtp)) {
        setLoginPhone(otpRes.phone || cleanPhone);
        setPreviewOtp(otpRes.previewOtp || null);
        setIsOtpSent(true);
        return { success: true };
      } else {
        return {
          error: otpRes.error || 'ارسال کد تایید به تلگرام انجام نشد. لطفاً ابتدا ربات را استارت کنید.',
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
      <div className="min-h-screen bg-white dark:bg-[#05070b] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const hideBottomNavOnMobile = isAuthenticated && (view === 'direct_chat' || (view === 'messages' && activeMobileChat !== null));

  return (
    <ErrorBoundary>
      <div
        className="min-h-screen bg-white dark:bg-[#05070b] text-slate-900 dark:text-white font-sans selection:bg-blue-600/30 overflow-x-hidden transition-colors duration-300"
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
                  ? 'bg-emerald-600/95 border-emerald-300/60 text-white shadow-[0_8px_24px_rgba(16,185,129,0.4)]'
                  : toast.type === 'error'
                  ? 'bg-rose-600/95 border-rose-300/60 text-white shadow-[0_8px_24px_rgba(244,63,94,0.4)]'
                  : 'bg-white/95 dark:bg-[#141923]/95 border-slate-200/90 dark:border-white/25 text-slate-900 dark:text-white shadow-[0_12px_32px_rgba(15,23,42,0.16)] dark:shadow-[0_10px_28px_rgba(255,255,255,0.2)]'
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

        <div className={`max-w-6xl mx-auto min-h-screen flex flex-col relative ${hideBottomNavOnMobile ? 'pb-3 lg:pb-8' : 'pb-24 lg:pb-8'} lg:pt-4 px-3.5 md:px-8 lg:px-12`}>
          {/* Header */}
          {isAuthenticated && (
            <header className="h-16 md:h-20 flex items-center justify-between sticky top-0 bg-white/95 dark:bg-[#141923]/95 backdrop-blur-md z-50 border border-slate-200/90 dark:border-white/25 rounded-2xl mb-4 px-4 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.18),0_0_18px_rgba(255,255,255,0.09)]">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setIsSidebarOpen(true)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.14)]"
                >
                  <Menu size={20} />
                </button>
                <div className="cursor-pointer" onClick={() => setView('dashboard')}>
                  <h1 className="text-base md:text-lg font-black text-slate-900 dark:text-white leading-none">میانجی</h1>
                  <span className="text-[9px] md:text-[10px] text-blue-600 dark:text-slate-300 uppercase tracking-widest font-bold">Escrow Platform</span>
                </div>
              </div>

              <div className="hidden md:flex flex-1 max-w-sm mx-8">
                <div className="w-full h-10 bg-slate-50 dark:bg-[#0e131c] border border-slate-200 dark:border-white/25 rounded-xl flex items-center px-4 gap-2 text-slate-500 dark:text-slate-200 focus-within:border-blue-500/60 dark:focus-within:border-white/50 transition-colors shadow-sm dark:shadow-[0_6px_18px_rgba(255,255,255,0.12)]">
                  <Search size={16} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      if (view !== 'deals' && e.target.value.trim()) setView('deals');
                    }}
                    placeholder="جستجو در معاملات..."
                    className="bg-transparent outline-none text-xs text-slate-900 dark:text-white w-full placeholder:text-slate-400"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="text-slate-400 hover:text-slate-700 dark:hover:text-white">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 md:gap-3">
                <button
                  onClick={() => setIsDarkMode(!isDarkMode)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-amber-300 active:scale-90 transition-all shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.14)]"
                  title={isDarkMode ? 'تم روز (کاملاً سفید)' : 'تم شب'}
                >
                  {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                  onClick={() => setView('notifications')}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200 dark:border-white/25 flex items-center justify-center relative text-slate-700 dark:text-white active:scale-90 transition-all shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.14)]"
                >
                  <Bell size={16} />
                  {notifications.some((n) => !n.is_read) && (
                    <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 bg-blue-500 rounded-full border-2 border-white dark:border-[#141923]" />
                  )}
                </button>
                <button
                  onClick={() => setView('profile')}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.1] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all overflow-hidden border border-slate-200 dark:border-white/30 shadow-sm dark:shadow-[0_4px_16px_rgba(255,255,255,0.18)]"
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
              {isAuthenticated && view === 'messages' && (
                <TelegramMessagesHub
                  user={user}
                  contracts={contracts}
                  setView={setView}
                  notify={notify}
                  activeMobileChat={activeMobileChat}
                  setActiveMobileChat={setActiveMobileChat}
                />
              )}
              {isAuthenticated && view === 'contacts' && (
                <ContactsView
                  setView={setView}
                  notify={notify}
                  onOpenChat={(contactId: string) => {
                    setActiveMobileChat({ type: 'direct', id: contactId });
                    setView('messages');
                  }}
                />
              )}
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
              {isAuthenticated && view === 'direct_chat' && <DirectChatView user={user} setView={setView} notify={notify} />}
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
            <nav
              className={`fixed bottom-5 left-1/2 -translate-x-1/2 w-[92%] max-w-md h-16 md:h-18 bg-white/95 dark:bg-[#141923]/95 backdrop-blur-xl border border-slate-200/90 dark:border-white/25 rounded-[1.5rem] md:rounded-[2rem] items-center justify-around px-2 md:px-4 shadow-[0_14px_34px_-4px_rgba(15,23,42,0.16)] dark:shadow-[0_12px_34px_-2px_rgba(255,255,255,0.22),0_0_20px_rgba(255,255,255,0.12)] z-[100] transition-all ${
                hideBottomNavOnMobile ? 'hidden lg:flex' : 'flex'
              }`}
            >
              <NavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={16} />} label="خانه" />
              <NavBtn active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={16} />} label="معاملات" />
              <div className="relative -translate-y-5 md:-translate-y-6">
                <button
                  onClick={() => setView('create')}
                  className="w-12 h-12 md:w-14 md:h-14 bg-blue-600 rounded-full flex items-center justify-center text-white shadow-[0_10px_24px_rgba(15,23,42,0.22)] dark:shadow-[0_8px_24px_rgba(255,255,255,0.34)] border-4 border-white dark:border-[#05070b] ring-1 ring-slate-200 dark:ring-white/40 active:scale-90 transition-all"
                >
                  <Plus className="w-6 h-6 md:w-8 md:h-8" strokeWidth={3} />
                </button>
              </div>
              <NavBtn
                active={view === 'messages'}
                onClick={() => {
                  setActiveMobileChat(null);
                  setView('messages');
                }}
                icon={<MessageSquare size={16} />}
                label="پیام‌ها"
              />
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
    <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="min-h-[70vh] flex flex-col justify-center text-center p-4 max-w-md mx-auto">
      <div className="mb-6">
        <div
          onClick={handleLogoClick}
          className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center text-white mx-auto shadow-md dark:shadow-[0_8px_24px_rgba(255,255,255,0.2)] mb-4 active:scale-90 transition-transform cursor-pointer"
        >
          <Shield size={28} />
        </div>
        <h1 className="text-3xl font-black text-slate-900 dark:text-white mb-1.5 tracking-tighter transition-colors">میانجی</h1>
        <p className="text-slate-500 dark:text-slate-300 text-xs font-medium">امنیت در معاملات فریلنسری و دیجیتال</p>
        {isDebug && <span className="inline-block mt-2 px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 text-[9px] font-mono">DEBUG MODE</span>}
      </div>

      <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 p-5 md:p-7 rounded-3xl space-y-4 shadow-[0_14px_36px_-6px_rgba(15,23,42,0.1),0_0_14px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_34px_-4px_rgba(255,255,255,0.18),0_0_20px_rgba(255,255,255,0.1)] transition-colors">
        {!isOtpSent ? (
          <>
            <div className="text-right space-y-2 mb-2">
              <p className="text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
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
                      className="flex-1 h-9 bg-linear-to-r from-sky-400 via-blue-600 to-indigo-600 hover:opacity-95 text-white rounded-lg font-black text-[11px] flex items-center justify-center gap-1.5 shadow-[0_6px_18px_rgba(255,255,255,0.2)] border border-white/20 transition-all active:scale-95"
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
                    className={`h-9 px-3 bg-slate-200/60 hover:bg-slate-200 dark:bg-white/10 dark:hover:bg-white/15 text-slate-800 dark:text-slate-200 border border-slate-300/50 dark:border-white/25 rounded-lg text-[11px] font-bold transition-all active:scale-95 ${
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
              className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black border border-white/15 shadow-[0_8px_22px_rgba(15,23,42,0.16)] dark:shadow-[0_10px_26px_rgba(255,255,255,0.24)] active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
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
                className={`w-full h-14 bg-white dark:bg-[#141923] border rounded-2xl text-center text-2xl font-black tracking-[0.5em] outline-none transition-all text-slate-900 dark:text-white disabled:opacity-50 ${
                  error ? 'border-rose-500 ring-4 ring-rose-500/15 shadow-[0_0_18px_rgba(244,63,94,0.3)]' : 'border-slate-200/80 dark:border-white/25 focus:border-slate-400 dark:focus:border-white/35 shadow-[0_6px_18px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_rgba(255,255,255,0.16)]'
                }`}
              />

              {previewOtp && (
                <div className="p-3 bg-slate-50 dark:bg-white/[0.1] border border-slate-200/80 dark:border-white/25 rounded-2xl flex items-center justify-between gap-2 text-right">
                  <div>
                    <p className="text-[10px] font-black text-blue-600 dark:text-white">کد آزمایشی پیش‌نمایش (Preview)</p>
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
                    className="text-xs font-bold text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
                  >
                    تلاش مجدد
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-slate-500 dark:text-slate-300 text-center">
                  {previewOtp
                    ? 'کد آزمایشی پیش‌نمایش آماده است (ارسال تلگرام در محیط تست غیرفعال است)'
                    : `کد تایید به تلگرام ${loginPhone || phone} ارسال شد`}
                </p>
              )}
            </div>
            <button
              onClick={submitOtp}
              disabled={isLoading || code.length < 6}
              className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-black border border-white/15 shadow-[0_8px_22px_rgba(16,185,129,0.28)] dark:shadow-[0_10px_26px_rgba(255,255,255,0.22)] active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-3"
            >
              {isLoading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'ورود به پنل'}
            </button>
            <button
              onClick={() => {
                setCode('');
                setError('');
                onResetPhone();
              }}
              className="w-full text-[11px] text-slate-500 dark:text-slate-300 font-bold hover:text-slate-700 dark:hover:text-white transition-colors"
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
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-5 md:space-y-8">
      {/* Welcome Brief */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 md:w-12 md:h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.18)] shrink-0">
            <Sparkles className="w-5 h-5" fill="currentColor" />
          </div>
          <div>
            <h2 className="text-sm md:text-base font-black text-slate-900 dark:text-white">خوش آمدید، {user?.full_name || 'کاربر میانجی'}</h2>
            <p className="text-[10px] text-slate-500 dark:text-slate-300 mt-0.5 uppercase tracking-widest font-bold">Smart Escrow Panel</p>
          </div>
        </div>
        <div className="text-left hidden sm:block">
          <span className="text-[10px] md:text-xs font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest block">وضعیت حساب</span>
          <span className="text-xs md:text-sm font-bold text-emerald-500 flex items-center gap-1 justify-end">
            <Sparkles size={14} /> {user?.kyc_status === 'verified' ? 'احراز هویت شده' : 'کاربر فعال'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 md:gap-6">
        {/* Wallet Card */}
        <div
          onClick={() => setView('wallet')}
          className="lg:col-span-8 relative p-5 md:p-8 rounded-3xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 overflow-hidden group cursor-pointer shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)] transition-all hover:-translate-y-0.5 dark:hover:shadow-[0_16px_38px_-4px_rgba(255,255,255,0.24)]"
        >
          <div className="absolute top-0 right-0 w-56 h-56 bg-white/10 dark:bg-[#1b2230] blur-[70px] rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
          <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4 md:gap-8">
            <div className="space-y-3 md:space-y-5">
              <div className="flex items-center gap-1.5 text-[11px] font-black text-blue-600 dark:text-slate-300">
                <Wallet size={14} className="text-blue-600 dark:text-white" />
                <span>موجودی کیف پول</span>
              </div>
              <div className="flex items-baseline gap-2.5">
                <span className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white tabular-nums tracking-tight leading-none">
                  {walletBalance.toLocaleString()}
                </span>
                <span className="text-xs font-bold text-blue-600 dark:text-slate-300">تومان</span>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-1 gap-2.5 md:gap-3 w-full md:w-56">
              <div className="p-3 md:p-3.5 bg-slate-50 dark:bg-[#1b2230] rounded-2xl border border-slate-200/70 dark:border-white/25 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]">
                <span className="text-[9px] md:text-[10px] text-slate-500 dark:text-slate-300 block mb-0.5 font-bold">مسدود در معامله</span>
                <span className="text-sm md:text-base font-black text-amber-500 tabular-nums">{lockedBalance.toLocaleString()}</span>
              </div>
              <div className="p-3 md:p-3.5 bg-slate-50 dark:bg-[#1b2230] rounded-2xl border border-slate-200/70 dark:border-white/25 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]">
                <span className="text-[9px] md:text-[10px] text-slate-500 dark:text-slate-300 block mb-0.5 font-bold">قابل برداشت</span>
                <span className="text-sm md:text-base font-black text-emerald-500 tabular-nums">{availableBalance.toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className="absolute top-5 left-5 md:top-6 md:left-6">
            <ChevronLeft size={18} className="text-slate-400 dark:text-white/70 group-hover:-translate-x-1 transition-transform" />
          </div>
        </div>

        {/* Quick Stats Banner */}
        <div className="lg:col-span-4 grid grid-cols-3 lg:grid-cols-1 gap-2.5 md:gap-3">
          <StatCard label="معامله فعال" value={activeCount} />
          <StatCard label="تراکنش کل" value={contracts.length} />
          <button
            onClick={() => setView('support')}
            className="p-3.5 md:p-4 bg-white dark:bg-[#141923] rounded-2xl border border-slate-200/90 dark:border-white/25 flex flex-col items-center justify-center text-center gap-1 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)] hover:-translate-y-0.5 transition-all"
          >
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300">پشتیبانی</span>
            <span className="text-xs font-black text-emerald-500">آنلاین · ۲۴/۷</span>
          </button>
        </div>
      </div>

      {/* Features Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <FeatureCard
          icon={<Plus className="text-blue-600 dark:text-white" />}
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
      <div className="space-y-4">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-base md:text-lg font-black text-slate-900 dark:text-white">آخرین معاملات</h2>
          <button onClick={() => setView('deals')} className="text-xs font-bold text-blue-600 dark:text-white hover:opacity-80 transition-all min-h-[40px] px-3.5 rounded-xl border border-slate-200/90 dark:border-white/25 bg-white dark:bg-[#141923] shadow-sm dark:shadow-[0_6px_18px_rgba(255,255,255,0.12)]">
            مشاهده همه
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
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
            <div className="md:col-span-2 lg:col-span-3 p-8 text-center border border-slate-200/90 dark:border-white/25 rounded-3xl bg-white dark:bg-[#141923] shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
              <ClipboardList size={32} className="mx-auto text-slate-400 dark:text-white/60 mb-3" />
              <p className="text-xs font-bold text-slate-600 dark:text-slate-300">هنوز هیچ معامله‌ای ثبت نکرده‌اید</p>
              <button
                onClick={() => setView('create')}
                className="mt-4 px-4 py-2 rounded-xl bg-blue-600 text-white font-bold text-xs shadow-md dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)]"
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
    <div className="p-3.5 md:p-4 bg-white dark:bg-[#141923] rounded-2xl border border-slate-200/90 dark:border-white/25 flex flex-col items-center justify-center text-center gap-0.5 transition-all hover:-translate-y-0.5 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 block">{label}</span>
      <span className="text-xl md:text-2xl font-black text-slate-900 dark:text-white tabular-nums">{value}</span>
    </div>
  );
}

function FeatureCard({ icon, label, desc, onClick }: any) {
  return (
    <button
      onClick={onClick}
      className="p-3.5 md:p-5 rounded-2xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 text-right space-y-2 active:scale-95 transition-all group hover:-translate-y-0.5 flex flex-col items-end w-full shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]"
    >
      <div className="w-7 h-7 rounded-lg bg-slate-50 dark:bg-white/[0.08] border border-slate-200/70 dark:border-white/25 flex items-center justify-center transition-colors shrink-0">
        {React.cloneElement(icon, { size: 14 })}
      </div>
      <div>
        <h3 className="text-xs font-black text-slate-900 dark:text-white">{label}</h3>
        <p className="text-[10px] font-medium text-slate-500 dark:text-slate-300 leading-tight line-clamp-1">{desc}</p>
      </div>
    </button>
  );
}

function DealDetailView({ user, setView, refresh, isDebug, notify }: any) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'chat'>('info');
  const [showQr, setShowQr] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('selected_contract');
    if (saved) setContract(JSON.parse(saved));
  }, []);

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
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5 h-full flex flex-col lg:max-w-6xl lg:mx-auto pb-8">
      {/* Header & Mobile Tab Switcher */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => setView('deals')}
          className="w-10 h-10 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]"
        >
          <ChevronRight size={20} />
        </button>

        <div className="flex-1 flex justify-center lg:hidden">
          <div className="flex p-1 bg-white dark:bg-[#141923] rounded-2xl border border-slate-200/90 dark:border-white/25 shadow-[0_8px_24px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_rgba(255,255,255,0.14)]">
            <button
              onClick={() => setActiveTab('info')}
              className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${
                activeTab === 'info' ? 'bg-blue-600 text-white shadow-md dark:shadow-[0_6px_16px_rgba(255,255,255,0.2)]' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              جزئیات
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${
                activeTab === 'chat' ? 'bg-blue-600 text-white shadow-md dark:shadow-[0_6px_16px_rgba(255,255,255,0.2)]' : 'text-slate-600 dark:text-slate-300'
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
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]"
          >
            <QrCode size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 lg:grid lg:grid-cols-12 lg:gap-6 min-h-0 overflow-hidden">
        {/* Info Column */}
        <div className={`lg:col-span-5 lg:flex lg:flex-col space-y-4 ${activeTab === 'info' ? 'block' : 'hidden lg:block'} overflow-y-auto pr-1`}>
          <div className="flex flex-col items-center gap-4 py-7 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] relative overflow-hidden shrink-0 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-slate-100 dark:bg-white/10">
              <div className="h-full bg-blue-600 dark:bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)] transition-all" style={{ width: getProgress(contract.status) }} />
            </div>
            <StatusIcon status={contract.status} />
            <div className="text-center px-4">
              <h1 className="text-lg font-black text-slate-900 dark:text-white mb-1">{contract.title}</h1>
              <span className="text-[10px] font-bold text-blue-600 dark:text-slate-300 uppercase tracking-widest">{contract.contract_id}</span>
              {isDebug && <p className="text-[8px] font-mono text-rose-400 mt-1">UUID: {contract.id || 'N/A'}</p>}
            </div>
            <StatusLabel status={contract.status} />
          </div>

          <div className="grid grid-cols-2 gap-3 shrink-0">
            <DetailItem label="بودجه پروژه" value={Number(contract.amount || 0).toLocaleString()} unit="تومان" />
            <DetailItem label="وضعیت" value={translateStatus(contract.status)} color="text-blue-600 dark:text-blue-400" />
            <DetailItem label="کارفرما" value={String(user?.id) === String(contract.buyer_id) ? 'شما' : 'طرف مقابل'} />
            <DetailItem label="مجری" value={String(user?.id) === String(contract.seller_id) ? 'شما' : 'طرف مقابل'} />
          </div>

          {contract.description && (
            <div className="p-4 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-2xl text-xs text-slate-700 dark:text-slate-200 leading-relaxed shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08)] dark:shadow-[0_10px_28px_-4px_rgba(255,255,255,0.14)]">
              <span className="text-[10px] font-black text-blue-600 dark:text-white block mb-1">شرایط قرارداد:</span>
              {contract.description}
            </div>
          )}

          <div className="pt-1 space-y-2.5 shrink-0">
            <button
              onClick={scanQr}
              className="w-full h-13 bg-slate-900 dark:bg-white text-white dark:text-black border border-white/15 dark:border-white rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 shadow-md dark:shadow-[0_10px_26px_rgba(255,255,255,0.3)]"
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
                className={`w-full h-13 rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50 ${
                  act.variant === 'primary'
                    ? 'bg-blue-600 text-white border border-white/15 shadow-lg dark:shadow-[0_10px_26px_rgba(255,255,255,0.22)]'
                    : act.variant === 'danger'
                    ? 'bg-rose-500/15 text-rose-500 border border-rose-400/50 dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]'
                    : 'bg-white dark:bg-[#141923] text-slate-800 dark:text-white border border-slate-200/90 dark:border-white/25 shadow-sm dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]'
                }`}
              >
                {act.label}
              </button>
            ))}
          </div>
        </div>

        {/* Telegram-Style Contract Chat Column */}
        <div className={`lg:col-span-7 h-[64vh] lg:h-[72vh] ${activeTab === 'chat' ? 'block' : 'hidden lg:block'}`}>
          <TelegramChatRoom
            mode="contract"
            chatId={contract.contract_id}
            title={contract.title}
            subtitle={`${translateStatus(contract.status)} · ${Number(contract.amount || 0).toLocaleString()} تومان`}
            avatarChar={contract.title?.[0] || 'C'}
            isOnline={contract.status === 'active' || contract.status === 'work_submitted'}
            contract={contract}
            user={user}
            notify={notify}
            fullHeightClass="h-full"
          />
        </div>
      </div>

      {contract.status === 'disputed' && (
        <div className="p-4 bg-white dark:bg-[#141923] border border-rose-400/50 rounded-2xl flex items-center justify-between gap-4 shadow-lg dark:shadow-[0_10px_26px_rgba(255,255,255,0.14)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-500 flex items-center justify-center text-white">
              <Gavel size={20} />
            </div>
            <div>
              <p className="text-xs font-black text-slate-900 dark:text-white">اختلاف ثبت شده است</p>
              <p className="text-[10px] text-rose-600 dark:text-rose-300">در حال بررسی توسط داور میانجی</p>
            </div>
          </div>
          <button
            onClick={() => setView('dispute')}
            className="px-5 py-2.5 bg-rose-600 text-white border border-white/15 rounded-xl text-[11px] font-black active:scale-95 transition-all"
          >
            مرکز حل اختلاف
          </button>
        </div>
      )}

      {/* QR Code Modal */}
      <AnimatePresence>
        {showQr && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-8">
            <div className="w-full max-w-sm bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2.5rem] p-8 text-center space-y-6 relative shadow-2xl dark:shadow-[0_14px_38px_rgba(255,255,255,0.22)]">
              <button onClick={() => setShowQr(false)} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white">
                <X size={20} />
              </button>
              <div className="pt-8">
                <div className="p-6 bg-white rounded-3xl inline-block shadow-lg border border-slate-100">
                  <QRCodeSVG value={contract.contract_id} size={200} />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xl font-black text-slate-900 dark:text-white">کیو‌آر تایید قرارداد</h3>
                <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">طرف مقابل با اسکن این کد می‌تواند قرارداد را در لحظه امضا و تایید کند.</p>
              </div>
              <div className="pt-2">
                <span className="text-[10px] font-bold text-blue-600 dark:text-slate-300 uppercase tracking-widest">{contract.contract_id}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
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
            className="fixed top-0 right-0 bottom-0 w-[75%] max-w-xs bg-white dark:bg-[#141923] border-l border-slate-200/90 dark:border-white/25 z-[1001] p-4 flex flex-col shadow-[-16px_0_40px_rgba(15,23,42,0.12)] dark:shadow-[-20px_0_50px_rgba(255,255,255,0.15)]"
          >
            <div className="flex items-center justify-between mb-6 px-1">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-md dark:shadow-[0_4px_16px_rgba(255,255,255,0.22)]">
                  <Shield size={16} />
                </div>
                <span className="font-black text-sm text-slate-900 dark:text-white transition-colors">منوی اصلی</span>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-white/[0.08] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto scrollbar-hide">
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
                      : 'hover:bg-slate-100 dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white active:scale-[0.98]'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-lg bg-slate-50 dark:bg-white/[0.1] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-blue-600 dark:text-white transition-colors ${
                      !item.disabled && 'group-hover:bg-blue-600 group-hover:text-white'
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

            <div className="pt-5 border-t border-slate-100 dark:border-white/25 space-y-4">
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-[#1b2230] flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black text-sm shadow-lg border-2 border-white dark:border-[#05070b]/50">
                  {user?.full_name?.[0] || 'U'}
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-black text-slate-900 dark:text-white truncate transition-colors">{user?.full_name || 'کاربر مهمان'}</p>
                  <p className="text-[9px] text-slate-500 dark:text-slate-300 font-mono" dir="ltr">
                    {user?.phone_number}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  onLogout();
                  onClose();
                }}
                className="w-full h-12 rounded-xl bg-rose-500/10 text-rose-500 font-bold text-xs flex items-center justify-center gap-2 active:scale-95 transition-all border border-rose-500/15"
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
    <button onClick={onClick} className={`flex flex-col items-center gap-1.5 transition-all ${active ? 'text-blue-600 dark:text-white' : 'text-slate-500 dark:text-slate-300'}`}>
      <div className={`transition-all duration-300 ${active ? 'scale-110 -translate-y-1' : 'opacity-80'}`}>{icon}</div>
      <span className={`text-[9px] font-black uppercase tracking-widest transition-all ${active ? 'opacity-100' : 'opacity-70'}`}>{label}</span>
      {active && <motion.div layoutId="nav-dot" className="w-1 h-1 bg-blue-600 dark:bg-white rounded-full" />}
    </button>
  );
}

function DealCard({ contract, onClick }: { contract: Contract; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full p-5 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-2xl md:rounded-3xl text-right flex justify-between items-center group active:scale-[0.98] transition-all shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)] hover:-translate-y-0.5 dark:hover:shadow-[0_16px_38px_-4px_rgba(255,255,255,0.24)]"
    >
      <div className="space-y-1 text-right">
        <h3 className="text-sm font-black text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-white transition-colors">{contract.title}</h3>
        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 tabular-nums">{Number(contract.amount || 0).toLocaleString()} تومان</span>
      </div>
      <StatusLabel status={contract.status} small />
    </button>
  );
}

function DetailItem({ label, value, unit, color }: any) {
  return (
    <div className="p-4 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-2xl shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08),0_0_10px_rgba(255,255,255,0.8)] dark:shadow-[0_10px_28px_-4px_rgba(255,255,255,0.14),0_0_14px_rgba(255,255,255,0.07)]">
      <span className="text-[9px] font-black text-slate-500 dark:text-slate-300 block mb-1">{label}</span>
      <div className={`text-sm font-black text-slate-900 dark:text-white ${color || ''}`}>
        {value} {unit && <span className="text-[10px] text-slate-500 dark:text-slate-300">{unit}</span>}
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
      <div className="w-16 h-16 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-lg dark:shadow-[0_10px_28px_rgba(255,255,255,0.22)]">
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
    <div className="w-16 h-16 bg-slate-100 dark:bg-[#1b2230] text-slate-500 dark:text-slate-200 rounded-full flex items-center justify-center border border-slate-200 dark:border-white/25">
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
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5 pb-10">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-black text-slate-900 dark:text-white">لیست معاملات</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('create')}
            className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-white/15 text-xs font-black flex items-center gap-1.5 shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)] active:scale-95 transition-all"
          >
            <Plus size={16} /> جدید
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`w-10 h-10 rounded-xl border flex items-center justify-center transition-all ${
              showFilters
                ? 'bg-blue-600 text-white border-white/15 shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.22)]'
                : 'bg-white dark:bg-[#141923] border-slate-200/90 dark:border-white/25 text-slate-700 dark:text-white shadow-sm dark:shadow-[0_6px_18px_rgba(255,255,255,0.12)]'
            }`}
          >
            <Filter size={18} />
          </button>
        </div>
      </div>

      <div className="relative md:hidden">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" size={16} />
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
              className={`px-4 py-2 rounded-xl text-[11px] font-black transition-all border ${
                filterStatus === chip.key
                  ? 'bg-blue-600 text-white border-white/15 shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.22)]'
                  : 'bg-white dark:bg-[#141923] border-slate-200/90 dark:border-white/25 text-slate-700 dark:text-slate-200 shadow-sm dark:shadow-[0_6px_16px_rgba(255,255,255,0.1)]'
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
          <div className="p-14 text-center bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
            <ClipboardList size={40} className="mx-auto text-slate-400 dark:text-white/50 mb-3" />
            <p className="text-xs font-bold text-slate-600 dark:text-slate-300">معامله‌ای با این مشخصات یافت نشد</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function CreateDealView({ user, onBack, onSuccess, notify }: any) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [direction, setDirection] = useState(1);
  const [formData, setFormData] = useState({
    title: '',
    amount: '',
    role: 'seller' as 'seller' | 'buyer',
    phone: '',
    deadline: '7',
    revisions: '2',
    description: '',
    category: 'digital' as 'digital' | 'physical' | 'account' | 'other'
  });
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [savedContacts, setSavedContacts] = useState<any[]>([]);
  const [lookupState, setLookupState] = useState<{
    status: 'idle' | 'checking' | 'found' | 'not_found';
    user?: { id: string; full_name: string; phone_number: string; kyc_status?: string };
  }>({ status: 'idle' });

  useEffect(() => {
    const prefill = localStorage.getItem('mianji_prefill_phone');
    if (prefill) {
      setFormData((prev) => ({ ...prev, phone: normalizeDigits(prefill) }));
      localStorage.removeItem('mianji_prefill_phone');
    }
    try {
      const contactsRaw = localStorage.getItem('mianji_contacts');
      if (contactsRaw) setSavedContacts(JSON.parse(contactsRaw));
    } catch {}
  }, []);

  // Live counterparty lookup when phone has >= 10 digits
  useEffect(() => {
    const cleanPhone = normalizeDigits(formData.phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      setLookupState({ status: 'idle' });
      return;
    }
    const timer = setTimeout(async () => {
      setLookupState({ status: 'checking' });
      try {
        const res = await fetch(`/api/users/lookup?phone=${encodeURIComponent(cleanPhone)}`);
        const data = await res.json();
        if (data.success && data.user) {
          setLookupState({ status: 'found', user: data.user });
        } else {
          setLookupState({ status: 'not_found' });
        }
      } catch {
        setLookupState({ status: 'not_found' });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [formData.phone]);

  const numericAmount = Number(normalizeDigits(formData.amount).replace(/[^0-9]/g, '')) || 0;
  const cleanCounterpartyPhone = normalizeDigits(formData.phone).replace(/[^0-9]/g, '');
  const ownCleanPhone = normalizeDigits(String(user?.phone_number || '')).replace(/[^0-9]/g, '');
  const isSameAsOwnPhone = Boolean(ownCleanPhone && cleanCounterpartyPhone.length >= 10 && ownCleanPhone.slice(-10) === cleanCounterpartyPhone.slice(-10));

  const categoryOptions = [
    { id: 'digital', label: 'خدمات دیجیتال', desc: 'طراحی، کدنویسی و سئو', icon: <Sparkles size={15} /> },
    { id: 'account', label: 'اکانت و اشتراک', desc: 'کانال، دامنه و سرویس', icon: <User size={15} /> },
    { id: 'physical', label: 'کالای فیزیکی', desc: 'سخت‌افزار و ارسال پستی', icon: <CreditCard size={15} /> },
    { id: 'other', label: 'سایر معاملات', desc: 'توافقات سفارشی', icon: <MoreVertical size={15} /> }
  ] as const;

  const quickTemplates = [
    { title: 'طراحی و پیاده‌سازی وب‌سایت', category: 'digital' as const, deadline: '14', revisions: '3' },
    { title: 'انتقال امن پیج یا کانال', category: 'account' as const, deadline: '2', revisions: '1' },
    { title: 'فروش لپ‌تاپ / کالای دیجیتال', category: 'physical' as const, deadline: '5', revisions: '0' },
    { title: 'تولید محتوا و تدوین ویدیو', category: 'digital' as const, deadline: '7', revisions: '2' }
  ];

  const quickAmounts = [
    { label: '۵۰۰ هزار', value: '500000' },
    { label: '۱ میلیون', value: '1000000' },
    { label: '۵ میلیون', value: '5000000' },
    { label: '۱۰ میلیون', value: '10000000' }
  ];

  const clauseSnippets = [
    'تحویل نهایی پس از بررسی کامل کارفرما تایید می‌شود.',
    'ضمانت اصالت و سلامت فنی تا ۴۸ ساعت پس از تحویل برقرار است.',
    'هرگونه تغییر خارج از توافق اولیه مشمول زمان و هزینه جداگانه است.'
  ];

  const stepsMeta = [
    { num: 1 as const, label: 'هویت معامله', short: 'نوع و نقش' },
    { num: 2 as const, label: 'مبلغ و زمان', short: 'ارزش مالی' },
    { num: 3 as const, label: 'طرف مقابل', short: 'شرایط و طرفین' },
    { num: 4 as const, label: 'تایید نهایی', short: 'بازبینی و ثبت' }
  ];

  const goToStep = (target: 1 | 2 | 3 | 4) => {
    setFormError('');
    setDirection(target >= step ? 1 : -1);
    setStep(target);
  };

  const validateCurrentAndNext = () => {
    setFormError('');
    if (step === 1) {
      if (!formData.title.trim() || formData.title.trim().length < 3) {
        setFormError('لطفاً عنوان شفاف معامله (حداقل ۳ کاراکتر) را وارد کنید.');
        return;
      }
      goToStep(2);
      return;
    }
    if (step === 2) {
      if (!numericAmount || numericAmount < 1000) {
        setFormError('مبلغ معامله باید حداقل ۱,۰۰۰ تومان باشد.');
        return;
      }
      goToStep(3);
      return;
    }
    if (step === 3) {
      if (cleanCounterpartyPhone.length < 10) {
        setFormError('لطفاً شماره همراه معتبر طرف مقابل (حداقل ۱۰ رقم) را وارد کنید.');
        return;
      }
      if (isSameAsOwnPhone) {
        setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد.');
        return;
      }
      goToStep(4);
    }
  };

  const adjustCounter = (field: 'deadline' | 'revisions', delta: number, min: number, max: number) => {
    const current = Number(normalizeDigits(formData[field]).replace(/[^0-9]/g, '')) || 0;
    const next = Math.min(max, Math.max(min, current + delta));
    setFormData((prev) => ({ ...prev, [field]: String(next) }));
  };

  const handleSubmit = async () => {
    setFormError('');
    const titleTrim = formData.title.trim();

    if (!titleTrim || !formData.amount || !cleanCounterpartyPhone) {
      setFormError('لطفاً عنوان، مبلغ و شماره همراه طرف مقابل را کامل وارد کنید');
      return;
    }
    if (!numericAmount || numericAmount < 1000) {
      setFormError('مبلغ معامله باید حداقل ۱,۰۰۰ تومان باشد');
      return;
    }
    if (cleanCounterpartyPhone.length < 10) {
      setFormError('شماره همراه طرف مقابل معتبر نیست');
      return;
    }
    if (isSameAsOwnPhone) {
      setFormError('شماره طرف مقابل نمی‌تواند با شماره خودتان یکسان باشد');
      return;
    }

    setLoading(true);
    try {
      const contractId = `M-${Math.floor(100000 + Math.random() * 900000)}`;
      const isLocalMode = localStorage.getItem('mianji_demo_mode') === 'true' || !auth.currentUser;

      let otherUser: any = lookupState.status === 'found' ? lookupState.user : null;
      if (!otherUser) {
        try {
          const lookupRes = await fetch(`/api/users/lookup?phone=${encodeURIComponent(cleanCounterpartyPhone)}`);
          const lookupResult = await lookupRes.json();
          if (lookupResult.success && lookupResult.user) {
            otherUser = lookupResult.user;
          }
        } catch {}
      }

      if (isLocalMode) {
        const otherId = otherUser?.id || `u_${cleanCounterpartyPhone.slice(-10)}`;
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

      await setDoc(doc(db, 'deals', contractId), dealData);
      onSuccess();
    } catch (err: any) {
      remoteLog('error', 'Error creating deal', err);
      notify(err?.message || 'خطا در ثبت معامله', 'error');
    } finally {
      setLoading(false);
    }
  };

  const activeCategoryObj = categoryOptions.find((c) => c.id === formData.category) || categoryOptions[0];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4 md:space-y-5 max-w-5xl mx-auto pb-4">
      {/* Compact Top Header & Percentage Progress Bar Only */}
      <div className="space-y-2.5 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-2xl p-3.5 md:p-4 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => (step > 1 ? goToStep((step - 1) as 1 | 2 | 3) : onBack())}
              className="min-h-[42px] min-w-[42px] rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.12)]"
              aria-label="بازگشت"
            >
              <ChevronRight size={18} />
            </button>
            <div>
              <h2 className="text-sm md:text-lg font-black text-slate-900 dark:text-white leading-tight">ساخت قرارداد امن</h2>
              <p className="text-[11px] text-blue-600 dark:text-slate-300 font-bold">
                {stepsMeta[step - 1].label}
              </p>
            </div>
          </div>
          <span className="text-sm font-black text-blue-600 dark:text-white tabular-nums">{Math.round((step / 4) * 100)}٪</span>
        </div>

        <div className="w-full h-2 bg-slate-100 dark:bg-white/10 border border-slate-200/70 dark:border-white/25 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-600 dark:bg-white rounded-full transition-all duration-300 shadow-[0_0_10px_rgba(255,255,255,0.6)]"
            style={{ width: `${Math.round((step / 4) * 100)}%` }}
          />
        </div>
      </div>

      {/* Main Split: Active Step Card + Desktop Live Contract Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-8 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-2xl md:rounded-3xl p-4 md:p-6 shadow-[0_14px_36px_-6px_rgba(15,23,42,0.1),0_0_14px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_34px_-4px_rgba(255,255,255,0.18),0_0_20px_rgba(255,255,255,0.1)] overflow-hidden">
          <AnimatePresence mode="wait" custom={direction}>
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: direction * -14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 14 }}
                transition={{ duration: 0.16 }}
                className="space-y-4"
              >
                {/* Quick Presets (Single horizontal strip) */}
                <div className="space-y-1.5">
                  <span className="text-[11px] font-black text-slate-600 dark:text-slate-300 block">پیشنهاد سریع عنوان</span>
                  <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
                    {quickTemplates.map((tpl) => (
                      <button
                        key={tpl.title}
                        type="button"
                        onClick={() =>
                          setFormData((prev) => ({
                            ...prev,
                            title: tpl.title,
                            category: tpl.category,
                            deadline: tpl.deadline,
                            revisions: tpl.revisions
                          }))
                        }
                        className={`min-h-[38px] px-3 py-1.5 rounded-xl text-[11px] font-bold border transition-all whitespace-nowrap shrink-0 active:scale-95 ${
                          formData.title === tpl.title
                            ? 'bg-blue-600 text-white border-white/15 shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.22)]'
                            : 'bg-slate-50 dark:bg-white/[0.1] border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-slate-100 hover:border-slate-300 dark:hover:border-white/30 dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]'
                        }`}
                      >
                        {tpl.title}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Title Input */}
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">عنوان قرارداد</label>
                  <input
                    placeholder="مثلاً: طراحی فروشگاه اینترنتی، فروش اکانت تلگرام..."
                    value={formData.title}
                    onChange={(e) => {
                      setFormData({ ...formData, title: e.target.value });
                      setFormError('');
                    }}
                    className="input-refined !h-11 !px-4"
                  />
                </div>

                {/* Compact 2x2 Category Selection Cards */}
                <div className="space-y-1.5">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">دسته‌بندی معامله</label>
                  <div className="grid grid-cols-2 gap-2">
                    {categoryOptions.map((cat) => {
                      const active = formData.category === cat.id;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setFormData({ ...formData, category: cat.id })}
                          className={`min-h-[48px] px-3 py-2 rounded-xl border text-right flex items-center gap-2 transition-all active:scale-[0.98] ${
                            active
                              ? 'bg-slate-100 dark:bg-white/15 border-slate-300 dark:border-white/40 text-slate-900 dark:text-white shadow-md dark:shadow-[0_6px_20px_rgba(255,255,255,0.2)]'
                              : 'bg-white dark:bg-[#1b2230] border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/25 dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]'
                          }`}
                        >
                          <span className={`shrink-0 ${active ? 'text-blue-600 dark:text-white' : 'text-slate-500 dark:text-slate-300'}`}>{cat.icon}</span>
                          <div className="flex-1 overflow-hidden">
                            <span className="text-[11px] sm:text-xs font-black block truncate">{cat.label}</span>
                            <span className="text-[9px] text-slate-500 dark:text-slate-300 hidden sm:block truncate">{cat.desc}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Compact 2-Column Role Selection */}
                <div className="space-y-1.5 pt-2 border-t border-slate-100 dark:border-white/25">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">نقش شما در قرارداد</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, role: 'seller' })}
                      className={`min-h-[52px] px-3 py-2.5 rounded-xl border text-right transition-all flex items-center justify-between gap-2 active:scale-[0.98] ${
                        formData.role === 'seller'
                          ? 'bg-blue-600 border-white/20 text-white shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.24)]'
                          : 'bg-white dark:bg-[#1b2230] border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-slate-200 dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <span className="text-xs font-black block truncate">مجری / فروشنده</span>
                        <span className={`text-[9px] block truncate mt-0.5 ${formData.role === 'seller' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-300'}`}>
                          تحویل کار و دریافت وجه
                        </span>
                      </div>
                      <ArrowUpRight size={15} className="shrink-0 opacity-85" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, role: 'buyer' })}
                      className={`min-h-[52px] px-3 py-2.5 rounded-xl border text-right transition-all flex items-center justify-between gap-2 active:scale-[0.98] ${
                        formData.role === 'buyer'
                          ? 'bg-blue-600 border-white/20 text-white shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.24)]'
                          : 'bg-white dark:bg-[#1b2230] border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-slate-200 dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <span className="text-xs font-black block truncate">کارفرما / خریدار</span>
                        <span className={`text-[9px] block truncate mt-0.5 ${formData.role === 'buyer' ? 'text-blue-100' : 'text-slate-500 dark:text-slate-300'}`}>
                          امانت‌گذاری تا تحویل
                        </span>
                      </div>
                      <Lock size={15} className="shrink-0 opacity-85" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: direction * -14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 14 }}
                transition={{ duration: 0.16 }}
                className="space-y-4"
              >
                {/* Amount Input & Quick Presets */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-black text-slate-900 dark:text-white">مبلغ معامله (تومان)</label>
                    {numericAmount > 0 && (
                      <span className="text-xs font-black text-emerald-500 tabular-nums">{numericAmount.toLocaleString()} تومان</span>
                    )}
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="1000000"
                    value={formData.amount}
                    onChange={(e) => {
                      setFormData({ ...formData, amount: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') });
                      setFormError('');
                    }}
                    className="input-refined !h-12 text-center text-lg font-black font-mono tracking-wider tabular-nums"
                  />
                  <div className="grid grid-cols-4 gap-1.5">
                    {quickAmounts.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => {
                          setFormData({ ...formData, amount: preset.value });
                          setFormError('');
                        }}
                        className={`min-h-[42px] px-1 rounded-xl text-[10px] sm:text-xs font-bold border transition-all whitespace-nowrap shrink-0 active:scale-95 ${
                          formData.amount === preset.value
                            ? 'bg-blue-600 text-white border-white/20 shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.22)]'
                            : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-slate-100 hover:border-slate-300 dark:hover:border-white/30 dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Interactive Steppers side-by-side */}
                <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-100 dark:border-white/25">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/25 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-black text-slate-900 dark:text-slate-100">مهلت تحویل</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-300">روز</span>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        onClick={() => adjustCounter('deadline', -1, 1, 365)}
                        className="w-11 h-11 rounded-lg bg-white dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.12)]"
                        aria-label="کاهش روز"
                      >
                        <Minus size={14} />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        value={formData.deadline}
                        onChange={(e) => setFormData({ ...formData, deadline: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') })}
                        className="w-full min-w-0 h-11 bg-transparent text-center text-base font-black font-mono tabular-nums text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => adjustCounter('deadline', 1, 1, 365)}
                        className="w-11 h-11 rounded-lg bg-white dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.12)]"
                        aria-label="افزایش روز"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/25 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-black text-slate-900 dark:text-slate-100">ویرایش</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-300">مرتبه</span>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <button
                        type="button"
                        onClick={() => adjustCounter('revisions', -1, 0, 50)}
                        className="w-11 h-11 rounded-lg bg-white dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.12)]"
                        aria-label="کاهش ویرایش"
                      >
                        <Minus size={14} />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        value={formData.revisions}
                        onChange={(e) => setFormData({ ...formData, revisions: normalizeDigits(e.target.value).replace(/[^0-9]/g, '') })}
                        className="w-full min-w-0 h-11 bg-transparent text-center text-base font-black font-mono tabular-nums text-slate-900 dark:text-white outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => adjustCounter('revisions', 1, 0, 50)}
                        className="w-11 h-11 rounded-lg bg-white dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.12)]"
                        aria-label="افزایش ویرایش"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Compact Escrow Protection Strip */}
                <div className="px-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/25 flex items-center justify-between text-[11px]">
                  <span className="text-slate-700 dark:text-slate-300 font-bold">حفاظت وجه در امانت میانجی</span>
                  <span className="font-black text-emerald-500">رایگان (پوشش کامل)</span>
                </div>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step-3"
                initial={{ opacity: 0, x: direction * -14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 14 }}
                transition={{ duration: 0.16 }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <label className="text-xs font-black text-slate-900 dark:text-white block">
                    شماره همراه {formData.role === 'seller' ? 'کارفرما (خریدار)' : 'مجری (فروشنده)'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      inputMode="tel"
                      dir="ltr"
                      placeholder="0912..."
                      value={formData.phone}
                      onChange={(e) => {
                        setFormData({ ...formData, phone: normalizeDigits(e.target.value) });
                        setFormError('');
                      }}
                      className="input-refined !h-11 text-center font-mono tracking-wider flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => setShowContactPicker(!showContactPicker)}
                      className={`min-h-[44px] px-3.5 rounded-xl border flex items-center justify-center gap-1.5 text-xs font-black transition-all whitespace-nowrap shrink-0 active:scale-95 ${
                        showContactPicker
                          ? 'bg-blue-600 text-white border-white/15 shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.22)]'
                          : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-white hover:border-slate-300 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.12)]'
                      }`}
                    >
                      <Users size={15} />
                      <span>مخاطبین</span>
                    </button>
                  </div>

                  {lookupState.status === 'checking' && (
                    <p className="text-[11px] text-blue-600 dark:text-slate-300 font-bold">در حال بررسی عضویت در میانجی...</p>
                  )}
                  {lookupState.status === 'found' && lookupState.user && !isSameAsOwnPhone && (
                    <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-400/50 flex items-center gap-2.5">
                      <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                      <div className="overflow-hidden">
                        <p className="text-xs font-black text-slate-900 dark:text-white truncate">{lookupState.user.full_name}</p>
                        <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">
                          حساب تاییدشده · {lookupState.user.kyc_status === 'verified' ? 'احراز کامل' : 'عضو فعال'}
                        </p>
                      </div>
                    </div>
                  )}
                  {lookupState.status === 'not_found' && cleanCounterpartyPhone.length >= 10 && !isSameAsOwnPhone && (
                    <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-400/50 flex items-center gap-2 text-right">
                      <AlertCircle size={16} className="text-amber-500 shrink-0" />
                      <p className="text-[10px] font-bold text-amber-600 dark:text-amber-300 leading-relaxed">
                        این شماره در ربات ثبت نشده است؛ برای قرارداد واقعی ابتدا ربات تلگرام را استارت کند.
                      </p>
                    </div>
                  )}

                  {showContactPicker && (
                    <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 space-y-1.5 max-h-40 overflow-y-auto">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[10px] font-black text-slate-700 dark:text-white">انتخاب سریع از مخاطبین</span>
                        <button type="button" onClick={() => setShowContactPicker(false)} className="text-slate-400 hover:text-slate-700 dark:hover:text-white p-1">
                          <X size={14} />
                        </button>
                      </div>
                      {savedContacts.length > 0 ? (
                        savedContacts.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setFormData((prev) => ({ ...prev, phone: normalizeDigits(c.phone_number) }));
                              setShowContactPicker(false);
                              setFormError('');
                            }}
                            className="w-full min-h-[40px] px-3 py-1.5 rounded-lg bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/25 flex items-center justify-between hover:border-slate-300 dark:hover:border-white/30 transition-all text-right"
                          >
                            <span className="text-xs font-black text-slate-900 dark:text-white">{c.full_name}</span>
                            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-300" dir="ltr">
                              {c.phone_number}
                            </span>
                          </button>
                        ))
                      ) : (
                        <p className="text-[11px] text-slate-500 text-center py-2">هنوز مخاطبی ذخیره نشده است.</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Terms & Quick Clauses */}
                <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-white/25">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-black text-slate-900 dark:text-white">شرایط و شرح تحویل</label>
                    <span className="text-[10px] text-slate-500 dark:text-slate-300">اختیاری</span>
                  </div>
                  <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
                    {clauseSnippets.map((clause, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() =>
                          setFormData((prev) => ({
                            ...prev,
                            description: prev.description ? `${prev.description}\n- ${clause}` : `- ${clause}`
                          }))
                        }
                        className="min-h-[36px] px-2.5 py-1 rounded-lg bg-slate-50 dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 text-[10px] font-bold text-slate-700 dark:text-slate-200 hover:border-slate-300 dark:hover:border-white/30 transition-all whitespace-nowrap shrink-0"
                      >
                        + {clause.slice(0, 28)}...
                      </button>
                    ))}
                  </div>
                  <textarea
                    placeholder="جزئیات فنی، نحوه تحویل و توافق‌ها..."
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="w-full h-24 bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/25 rounded-xl p-3 text-xs text-slate-900 dark:text-white focus:border-slate-400 dark:focus:border-white/30 outline-none transition-all resize-none"
                  />
                </div>
              </motion.div>
            )}

            {step === 4 && (
              <motion.div
                key="step-4"
                initial={{ opacity: 0, x: direction * -14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * 14 }}
                transition={{ duration: 0.16 }}
                className="space-y-3.5"
              >
                <div className="divide-y divide-slate-100 dark:divide-white/10 border border-slate-200/80 dark:border-white/25 rounded-xl bg-slate-50/70 dark:bg-[#1b2230]">
                  <div className="p-3 flex items-center justify-between gap-3">
                    <div className="overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 block">عنوان و دسته‌بندی</span>
                      <p className="text-xs md:text-sm font-black text-slate-900 dark:text-white truncate">{formData.title}</p>
                      <span className="text-[10px] text-blue-600 dark:text-slate-300">
                        {activeCategoryObj.label} · نقش: {formData.role === 'seller' ? 'مجری' : 'کارفرما'}
                      </span>
                    </div>
                    <button type="button" onClick={() => goToStep(1)} className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/25 rounded-lg min-h-[36px] px-3 shrink-0">
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3 flex items-center justify-between gap-3">
                    <div>
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 block">مبلغ و زمان‌بندی</span>
                      <p className="text-sm font-black text-emerald-500 tabular-nums">{numericAmount.toLocaleString()} تومان</p>
                      <span className="text-[10px] text-slate-500 dark:text-slate-300 tabular-nums">
                        مهلت: {formData.deadline || '7'} روز · ویرایش: {formData.revisions || '0'} بار
                      </span>
                    </div>
                    <button type="button" onClick={() => goToStep(2)} className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/25 rounded-lg min-h-[36px] px-3 shrink-0">
                      ویرایش
                    </button>
                  </div>

                  <div className="p-3 flex items-center justify-between gap-3">
                    <div className="flex-1 overflow-hidden">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 block">طرف مقابل و شرایط</span>
                      <p className="text-xs font-black text-slate-900 dark:text-white font-mono truncate" dir="ltr">
                        {formData.phone} {lookupState.user?.full_name ? `(${lookupState.user.full_name})` : ''}
                      </p>
                      <p className="text-[10px] text-slate-500 dark:text-slate-300 mt-0.5 line-clamp-2">
                        {formData.description.trim() || 'شرایط استاندارد ضمانت میانجی'}
                      </p>
                    </div>
                    <button type="button" onClick={() => goToStep(3)} className="text-[11px] font-black text-blue-600 dark:text-white bg-white dark:bg-white/10 border border-slate-200/80 dark:border-white/25 rounded-lg min-h-[36px] px-3 shrink-0">
                      ویرایش
                    </button>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200/80 dark:border-white/25 flex items-center gap-2.5 text-right">
                  <ShieldCheck size={16} className="text-blue-600 dark:text-white shrink-0" />
                  <p className="text-[10px] text-slate-700 dark:text-slate-200 leading-relaxed">
                    پس از ثبت پیش‌نویس، پرداخت صرفاً با تایید کارفرما قفل شده و تمام مراحل قابل پیگیری است.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {formError && (
            <div className="mt-3 p-3 bg-rose-500/10 border border-rose-400/50 rounded-xl flex items-center gap-2 text-right">
              <AlertCircle size={16} className="text-rose-500 shrink-0" />
              <p className="text-[11px] font-bold text-rose-500">{formError}</p>
            </div>
          )}

          {/* Wizard Footer Actions */}
          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-white/25 flex items-center justify-between gap-2.5">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => goToStep((step - 1) as 1 | 2 | 3)}
                className="min-h-[44px] px-4 rounded-xl bg-slate-50 dark:bg-white/[0.07] border border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0 shadow-sm dark:shadow-[0_6px_16px_rgba(255,255,255,0.14)]"
              >
                <ChevronRight size={15} />
                مرحله قبل
              </button>
            ) : (
              <button
                type="button"
                onClick={onBack}
                className="min-h-[44px] px-4 rounded-xl bg-slate-50 dark:bg-white/[0.07] border border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-slate-200 text-xs font-bold active:scale-95 transition-all whitespace-nowrap shrink-0 shadow-sm dark:shadow-[0_6px_16px_rgba(255,255,255,0.12)]"
              >
                انصراف
              </button>
            )}

            {step < 4 ? (
              <button
                type="button"
                onClick={validateCurrentAndNext}
                className="min-h-[44px] flex-1 sm:flex-none sm:px-7 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs border border-white/15 flex items-center justify-center gap-1.5 shadow-[0_8px_20px_rgba(15,23,42,0.15)] dark:shadow-[0_8px_24px_rgba(255,255,255,0.22)] active:scale-95 transition-all whitespace-nowrap shrink-0"
              >
                ادامه به مرحله {step + 1}
                <ChevronLeft size={15} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={loading}
                className="min-h-[44px] flex-1 sm:flex-none sm:px-7 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-xs border border-white/15 shadow-[0_8px_20px_rgba(16,185,129,0.28)] dark:shadow-[0_8px_24px_rgba(255,255,255,0.22)] active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Check size={16} />
                    تایید و ایجاد قرارداد امن
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Live Contract Preview Sidebar (Desktop only to prevent mobile scrolling) */}
        <aside className="hidden lg:block lg:col-span-4 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-3xl p-5 space-y-5 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black text-slate-900 dark:text-white">پیش‌نمایش زنده قرارداد</span>
            <Shield size={16} className="text-blue-600 dark:text-white" />
          </div>

          <div className="space-y-1">
            <h4 className="text-sm font-black text-slate-900 dark:text-white leading-snug">
              {formData.title.trim() || 'عنوان قرارداد شما'}
            </h4>
            <p className="text-[11px] text-blue-600 dark:text-slate-300">
              {activeCategoryObj.label} · {formData.role === 'seller' ? 'شما مجری هستید' : 'شما کارفرما هستید'}
            </p>
          </div>

          <div className="py-3.5 border-y border-slate-100 dark:border-white/25 flex items-baseline justify-between">
            <span className="text-xs text-slate-500 dark:text-slate-300 font-bold">ارزش قرارداد</span>
            <span className="text-xl font-black text-slate-900 dark:text-white tabular-nums">
              {numericAmount > 0 ? numericAmount.toLocaleString() : '—'}{' '}
              <span className="text-[10px] font-bold text-blue-600 dark:text-slate-300">تومان</span>
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">مهلت تحویل</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{formData.deadline || '7'} روز</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">ویرایش رایگان</span>
              <span className="font-black text-slate-900 dark:text-white tabular-nums">{formData.revisions || '0'} نوبت</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500 dark:text-slate-300">طرف مقابل</span>
              <span className="font-black text-slate-900 dark:text-white font-mono" dir="ltr">
                {formData.phone || '—'}
              </span>
            </div>
          </div>

          <div className="pt-1 space-y-1.5 text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
            <p className="font-bold text-blue-900 dark:text-blue-200">چطور کار می‌کند؟</p>
            <p>۱. کارفرما مبلغ را در کیف پول امن میانجی قفل می‌کند.</p>
            <p>۲. مجری پروژه را در مهلت تعیین‌شده تحویل می‌دهد.</p>
            <p>۳. با تایید نهایی کارفرما، وجه آزاد می‌شود.</p>
          </div>
        </aside>
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
          className="w-10 h-10 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]"
        >
          <ChevronRight size={20} />
        </button>
        <h2 className="text-xl font-black text-slate-900 dark:text-white">مرکز حل اختلاف</h2>
      </div>

      <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] p-6 md:p-8 space-y-6 relative overflow-hidden shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
        <div className="flex items-center gap-4 relative z-10">
          <div className="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-400/40 flex items-center justify-center text-rose-500 shadow-sm dark:shadow-[0_6px_18px_rgba(255,255,255,0.12)]">
            <Gavel size={28} />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">پرونده شماره {contract.contract_id.replace('M-', 'D-')}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300">مربوط به معامله: {contract.title}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-5 bg-slate-50 dark:bg-[#1b2230] rounded-2xl border border-slate-200/70 dark:border-white/25">
            <span className="text-[10px] font-black text-slate-500 dark:text-slate-300 uppercase block mb-1">مبلغ مورد تنازع</span>
            <span className="text-xl font-black text-slate-900 dark:text-white tabular-nums">{Number(contract.amount || 0).toLocaleString()} تومان</span>
          </div>
          <div className="p-5 bg-slate-50 dark:bg-[#1b2230] rounded-2xl border border-rose-300/60 dark:border-rose-400/40">
            <span className="text-[10px] font-black text-slate-500 dark:text-slate-300 uppercase block mb-1">وضعیت فعلی</span>
            <span className="text-xs font-black text-rose-500">در حال داوری رسمی</span>
          </div>
        </div>
      </div>

      {/* Evidence Timeline */}
      <div className="space-y-4">
        <h3 className="text-sm font-black text-slate-900 dark:text-white px-2">شواهد و مستندات</h3>
        <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] p-5 md:p-6 space-y-5 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
          {evidence.map((item) => {
            const isOwn = String(item.sender_id) === String(user?.id);
            return (
              <div key={item.id} className={`flex flex-col gap-2 ${isOwn ? 'items-start' : 'items-end'}`}>
                <div
                  className={`p-4 rounded-2xl text-[11px] md:text-xs leading-relaxed max-w-[90%] ${
                    isOwn
                      ? 'bg-blue-600 text-white border border-white/15 shadow-lg dark:shadow-[0_6px_18px_rgba(255,255,255,0.18)]'
                      : 'bg-slate-50 dark:bg-[#1b2230] text-slate-900 dark:text-slate-100 border border-slate-200/80 dark:border-white/25 shadow-sm dark:shadow-[0_4px_14px_rgba(255,255,255,0.08)]'
                  }`}
                >
                  <p className="mb-1.5 font-bold opacity-75 text-[10px]">{String(item.sender_id) === String(contract.buyer_id) ? 'کارفرما' : 'مجری'}</p>
                  {item.text}
                </div>
              </div>
            );
          })}

          <div className="pt-4 border-t border-slate-100 dark:border-white/25 space-y-4">
            <textarea
              value={newEvidenceText}
              onChange={(e) => setNewEvidenceText(e.target.value)}
              className="w-full h-24 bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/25 rounded-2xl p-4 text-xs text-slate-900 dark:text-white focus:border-slate-400 dark:focus:border-white/30 outline-none transition-all resize-none"
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
                className="flex-1 h-12 bg-white dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 text-slate-700 dark:text-white rounded-xl text-[11px] font-black flex items-center justify-center gap-2 btn-protruding"
              >
                <Paperclip size={14} /> ضمیمه فایل/تصویر
              </button>
              <button
                type="button"
                onClick={() => submitEvidence()}
                disabled={!newEvidenceText.trim()}
                className="flex-1 h-12 bg-blue-600 text-white border border-white/15 rounded-xl text-[11px] font-black active:scale-95 transition-all shadow-lg btn-protruding disabled:opacity-50"
              >
                ارسال گزارش به داور
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Arbitrator Panel */}
      {canArbitrate && (
        <div className="p-6 md:p-8 bg-white dark:bg-[#141923] border border-amber-400/50 rounded-[2rem] space-y-6 shadow-xl dark:shadow-[0_12px_32px_rgba(255,255,255,0.16)] relative overflow-hidden">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-400/50 flex items-center justify-center text-amber-500">
              <Sparkles size={20} />
            </div>
            <h3 className="text-sm font-black text-amber-500 uppercase tracking-widest">پنل داوری</h3>
          </div>

          <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
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
            className="w-full h-14 bg-amber-500 text-black font-black border border-amber-300 rounded-2xl shadow-xl active:scale-95 transition-all flex items-center justify-center gap-3"
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
          ? 'bg-amber-500 border-amber-300 text-black shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.2)]'
          : 'bg-slate-50 dark:bg-[#1b2230] border-slate-200/80 dark:border-white/25 text-slate-900 dark:text-slate-200'
      }`}
    >
      <p className="text-xs font-black">{label}</p>
      <p className={`text-[10px] font-bold ${active ? 'text-black/70' : 'text-slate-500 dark:text-slate-300'}`}>{desc}</p>
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
          ? 'bg-blue-600/15 border-slate-400 dark:border-white/35 text-blue-700 dark:text-white shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.18)]'
          : 'bg-white dark:bg-[#141923] border-slate-200/90 dark:border-white/25 text-slate-600 dark:text-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ContactsView({ setView, notify, onOpenChat }: any) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [newContact, setNewAddContact] = useState({ name: '', phone: '' });
  const [lookupResult, setLookupResult] = useState<{ status: 'idle' | 'checking' | 'found' | 'not_found'; name?: string }>({ status: 'idle' });

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

  useEffect(() => {
    if (!showAddModal) {
      setLookupResult({ status: 'idle' });
      return;
    }
    const cleanPhone = normalizeDigits(newContact.phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      setLookupResult({ status: 'idle' });
      return;
    }
    const timer = setTimeout(async () => {
      setLookupResult({ status: 'checking' });
      try {
        const res = await fetch(`/api/users/lookup?phone=${encodeURIComponent(cleanPhone)}`);
        const data = await res.json();
        if (data.success && data.user) {
          setLookupResult({ status: 'found', name: data.user.full_name });
        } else {
          setLookupResult({ status: 'not_found' });
        }
      } catch {
        setLookupResult({ status: 'not_found' });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [newContact.phone, showAddModal]);

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
      status: lookupResult.status === 'found' ? 'verified' : 'pending',
      trust_score: lookupResult.status === 'found' ? 95 : 0
    };
    const updated = [item, ...contacts];
    setContacts(updated);
    localStorage.setItem('mianji_contacts', JSON.stringify(updated));
    setNewAddContact({ name: '', phone: '' });
    setShowAddModal(false);
    notify('مخاطب جدید ذخیره شد', 'success');
  };

  const openContactChat = (contact: any) => {
    try {
      const raw = localStorage.getItem('mianji_direct_chats');
      const chats = raw ? JSON.parse(raw) : [];
      if (!chats.some((c: any) => String(c.id) === String(contact.id) || c.phone_number === contact.phone_number)) {
        const nextChats = [
          {
            id: contact.id,
            full_name: contact.full_name,
            phone_number: contact.phone_number,
            last_msg: 'گفتگوی مستقیم',
            time: new Date().toISOString(),
            unread: 0,
            online: contact.status === 'verified'
          },
          ...chats
        ];
        localStorage.setItem('mianji_direct_chats', JSON.stringify(nextChats));
      }
      localStorage.setItem('mianji_chat_target', JSON.stringify(contact));
    } catch {}
    if (onOpenChat) onOpenChat(String(contact.id));
    else setView('direct_chat');
  };

  const normalizedQuery = normalizeDigits(searchTerm).toLowerCase();
  const filtered = contacts.filter(
    (c) => c.full_name.toLowerCase().includes(normalizedQuery) || String(c.phone_number).includes(normalizedQuery)
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5 max-w-4xl mx-auto pb-24 relative">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xl font-black text-slate-900 dark:text-white">مخاطبین من</h2>
        <span className="text-xs font-black text-slate-500 dark:text-slate-300 tabular-nums">{filtered.length} مخاطب</span>
      </div>

      <div className="relative">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" size={18} />
        <input
          placeholder="جستجوی نام یا شماره همراه..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="input-refined pr-12"
        />
      </div>

      <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] overflow-hidden divide-y divide-slate-100 dark:divide-white/15 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.18),0_0_18px_rgba(255,255,255,0.09)]">
        {filtered.length > 0 ? (
          filtered.map((contact) => (
            <div key={contact.id} className="p-4 md:p-5 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-white/[0.06] transition-colors relative group">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-white/[0.1] flex items-center justify-center text-blue-700 dark:text-white font-black relative border border-slate-200 dark:border-white/25">
                {contact.full_name[0]}
                <div
                  className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white dark:border-[#141923] ${
                    contact.status === 'verified' ? 'bg-emerald-500' : 'bg-slate-400'
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-black text-slate-900 dark:text-white truncate">{contact.full_name}</span>
                  {contact.trust_score > 0 && (
                    <span className="text-[10px] font-black text-blue-600 dark:text-slate-200 tabular-nums">· اعتبار {contact.trust_score}٪</span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-300 font-mono" dir="ltr">
                  {contact.phone_number}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openContactChat(contact)}
                  className="w-10 h-10 rounded-xl bg-blue-600 text-white border border-white/20 flex items-center justify-center hover:bg-blue-700 transition-all active:scale-90 shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.22)]"
                  title="ارسال پیام"
                >
                  <MessageCircle size={18} />
                </button>
                <button
                  onClick={() => {
                    localStorage.setItem('mianji_prefill_phone', contact.phone_number);
                    setView('create');
                  }}
                  className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200 dark:border-white/25 text-slate-700 dark:text-white flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/20 transition-all active:scale-90"
                  title="معامله جدید"
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="p-16 text-center text-slate-500 dark:text-slate-300">
            <Users size={44} className="mx-auto mb-3 text-slate-400 dark:text-slate-300/70" />
            <p className="text-xs font-bold">مخاطبی یافت نشد</p>
          </div>
        )}
      </div>

      {/* Bottom-corner Floating Add Contact Button (Contact silhouette with '+' on chest) */}
      <button
        type="button"
        onClick={() => setShowAddModal(true)}
        aria-label="ایجاد مخاطب جدید"
        title="ایجاد مخاطب جدید"
        className="fixed bottom-24 left-5 lg:bottom-8 lg:left-8 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-700 text-white border-2 border-white dark:border-slate-200/90 flex items-center justify-center shadow-[0_12px_28px_rgba(15,23,42,0.26)] dark:shadow-[0_10px_28px_rgba(255,255,255,0.38)] active:scale-90 transition-all z-40"
      >
        <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" aria-hidden="true">
          <circle cx="12" cy="7" r="3.6" fill="currentColor" />
          <path d="M4.2 20.5c0-3.9 3.49-6.8 7.8-6.8s7.8 2.9 7.8 6.8v.5H4.2v-.5Z" fill="currentColor" />
          <path d="M12 15.6v3.8M10.1 17.5h3.8" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>

      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[500] flex items-center justify-center p-6"
          >
            <div className="w-full max-w-sm bg-white dark:bg-[#141923] border border-slate-200 dark:border-white/25 rounded-[2rem] p-7 space-y-5 relative shadow-2xl dark:shadow-[0_14px_38px_rgba(255,255,255,0.24)]">
              <button
                onClick={() => setShowAddModal(false)}
                className="absolute top-5 left-5 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/15 border border-slate-200 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white"
              >
                <X size={20} />
              </button>
              <div className="text-center pt-2">
                <h3 className="text-lg font-black text-slate-900 dark:text-white">افزودن مخاطب</h3>
                <p className="text-xs text-slate-500 dark:text-slate-300 mt-1">اطلاعات مخاطب جدید را وارد کنید</p>
              </div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">شماره همراه</label>
                  <input
                    dir="ltr"
                    inputMode="tel"
                    value={newContact.phone}
                    onChange={(e) => setNewAddContact({ ...newContact, phone: normalizeDigits(e.target.value) })}
                    placeholder="0912..."
                    className="input-refined !h-12 text-center font-mono"
                  />
                  {lookupResult.status === 'found' && lookupResult.name && (
                    <div className="p-2 rounded-xl bg-emerald-500/15 border border-emerald-400/50 flex items-center justify-between text-[11px]">
                      <span className="text-emerald-600 dark:text-emerald-300 font-bold">عضو میانجی: {lookupResult.name}</span>
                      {!newContact.name.trim() && (
                        <button
                          type="button"
                          onClick={() => setNewAddContact((p) => ({ ...p, name: lookupResult.name || '' }))}
                          className="text-blue-600 dark:text-white font-black underline"
                        >
                          درج نام
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">نام و نام خانوادگی</label>
                  <input
                    value={newContact.name}
                    onChange={(e) => setNewAddContact({ ...newContact, name: e.target.value })}
                    placeholder="مثلاً: علی رضایی"
                    className="input-refined !h-12"
                  />
                </div>
              </div>
              <button
                onClick={handleAdd}
                disabled={!newContact.name || !newContact.phone}
                className="w-full h-13 bg-blue-600 hover:bg-blue-700 text-white border border-white/20 rounded-2xl font-black shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.24)] active:scale-95 transition-all disabled:opacity-50"
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
        <div className="p-7 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2.5rem] flex flex-col items-center gap-4 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
          <span className="text-[10px] font-black text-blue-600 dark:text-slate-300 uppercase tracking-widest">موجودی کل</span>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-black text-slate-900 dark:text-white tabular-nums">{walletBalance.toLocaleString()}</span>
            <span className="text-[10px] text-blue-600 dark:text-slate-300 font-bold">تومان</span>
          </div>
          <div className="grid grid-cols-2 gap-3 w-full pt-2">
            <div className="p-3 bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/25 rounded-2xl text-center">
              <span className="text-[9px] font-bold text-slate-500 dark:text-slate-300 block">قابل برداشت</span>
              <span className="text-sm font-black text-emerald-500 tabular-nums">{availableBalance.toLocaleString()}</span>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-[#1b2230] border border-slate-200/70 dark:border-white/25 rounded-2xl text-center">
              <span className="text-[9px] font-bold text-slate-500 dark:text-slate-300 block">در امانت معاملات</span>
              <span className="text-sm font-black text-amber-500 tabular-nums">{lockedBalance.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => setModalMode('deposit')}
            className="h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black border border-white/15 flex items-center justify-center gap-2 shadow-lg dark:shadow-[0_10px_26px_rgba(255,255,255,0.22)] active:scale-95 transition-all text-sm"
          >
            <Plus size={18} /> افزایش موجودی
          </button>
          <button
            onClick={() => setModalMode('withdraw')}
            className="h-14 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 text-slate-800 dark:text-white rounded-2xl font-black flex items-center justify-center gap-2 active:scale-95 transition-all text-sm shadow-[0_10px_28px_-6px_rgba(15,23,42,0.09)] dark:shadow-[0_10px_26px_rgba(255,255,255,0.16)]"
          >
            <ArrowUpRight size={18} /> درخواست تسویه
          </button>
        </div>
      </div>

      {history.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-black text-slate-900 dark:text-white px-2">سوابق مالی اخیر</h3>
          <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] divide-y divide-slate-100 dark:divide-white/10 overflow-hidden shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
            {history.map((tx) => (
              <div key={tx.id} className="p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black text-slate-900 dark:text-white">
                    {tx.type === 'deposit' ? 'شارژ کیف پول' : 'درخواست تسویه'} — {Number(tx.amount).toLocaleString()} تومان
                  </p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-300 font-mono mt-0.5">{tx.ref}</p>
                </div>
                <span
                  className={`px-3 py-1 rounded-full text-[9px] font-black ${
                    tx.status === 'completed' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'
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
            <div className="w-full max-w-sm bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] p-7 space-y-5 relative shadow-2xl dark:shadow-[0_14px_38px_rgba(255,255,255,0.2)]">
              <button
                onClick={() => setModalMode(null)}
                className="absolute top-5 left-5 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white"
              >
                <X size={20} />
              </button>
              <div className="text-center pt-3">
                <h3 className="text-lg font-black text-slate-900 dark:text-white">
                  {modalMode === 'deposit' ? 'افزایش موجودی کیف پول' : 'درخواست تسویه حساب'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-300 mt-1">
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
                className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white border border-white/15 rounded-2xl font-black shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)] active:scale-95 transition-all"
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
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-5 max-w-2xl mx-auto pb-10">
      <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] p-7 flex flex-col items-center text-center space-y-4 relative overflow-hidden shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
        <div className="relative">
          <div className="w-20 h-20 rounded-[1.75rem] bg-blue-600 flex items-center justify-center text-white font-black text-2xl shadow-xl border-4 border-white dark:border-[#05070b]">
            {user?.full_name?.[0] || 'U'}
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-emerald-500 rounded-full border-4 border-white dark:border-[#05070b] flex items-center justify-center text-white shadow-lg">
            <ShieldCheck size={12} fill="currentColor" />
          </div>
        </div>
        <div className="relative z-10">
          <h2 className="text-lg font-black text-slate-900 dark:text-white">{user?.full_name || 'کاربر مهمان'}</h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-300 font-mono" dir="ltr">
            {user?.phone_number || '09xxxxxxxxx'}
          </p>
        </div>
        <span className="text-[10px] font-black text-blue-600 dark:text-slate-300 uppercase tracking-widest">
          {user?.role === 'owner' ? 'Platform Owner' : user?.role === 'admin' ? 'Platform Admin' : 'Verified Member'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3.5">
        <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[1.75rem] p-5 space-y-2 shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08),0_0_10px_rgba(255,255,255,0.8)] dark:shadow-[0_10px_28px_-4px_rgba(255,255,255,0.14),0_0_14px_rgba(255,255,255,0.07)]">
          <span className="text-[10px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest block">وضعیت تایید</span>
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-blue-500" fill="currentColor" />
            <span className="text-base md:text-lg font-black text-slate-900 dark:text-white">{user?.kyc_status === 'verified' ? 'تایید شده' : 'در حال بررسی'}</span>
          </div>
        </div>
        <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[1.75rem] p-5 space-y-2 shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08),0_0_10px_rgba(255,255,255,0.8)] dark:shadow-[0_10px_28px_-4px_rgba(255,255,255,0.14),0_0_14px_rgba(255,255,255,0.07)]">
          <span className="text-[10px] font-black text-slate-500 dark:text-slate-300 uppercase tracking-widest block">معاملات موفق</span>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-500" />
            <span className="text-base md:text-lg font-black text-slate-900 dark:text-white tabular-nums">{completedCount}</span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] overflow-hidden divide-y divide-slate-100 dark:divide-white/10 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_12px_32px_-4px_rgba(255,255,255,0.16),0_0_18px_rgba(255,255,255,0.08)]">
        {profileMenu.map((item, idx) => (
          <button
            key={idx}
            onClick={item.action}
            className="w-full p-4 md:p-5 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-white/[0.04] transition-all active:bg-slate-100 dark:active:bg-white/10 text-right group"
          >
            <div className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-blue-600 dark:text-white group-hover:bg-blue-600 group-hover:text-white transition-colors shrink-0">
              {item.icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-black text-slate-900 dark:text-white">{item.label}</span>
                {item.badge && <span className={`text-[9px] font-black uppercase tracking-widest ${item.badgeColor}`}>{item.badge}</span>}
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-300">{item.desc}</p>
            </div>
            <ChevronLeft size={16} className="text-slate-400 dark:text-white/70 group-hover:-translate-x-1 transition-transform" />
          </button>
        ))}
      </div>

      <button
        onClick={onLogout}
        className="w-full h-14 rounded-2xl bg-rose-500/10 text-rose-500 font-black flex items-center justify-center gap-3 active:scale-95 transition-all border border-rose-400/45 dark:shadow-[0_8px_22px_rgba(255,255,255,0.12)] hover:bg-rose-500/20"
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
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">مرکز پشتیبانی آنلاین</h2>
            <p className="text-[10px] text-blue-600 dark:text-slate-300 font-bold">پاسخگویی سریع تیم میانجی</p>
          </div>
        </div>
        <a
          href="https://t.me/mianji_ir_bot"
          target="_blank"
          rel="noopener noreferrer"
          className="h-9 px-4 bg-blue-600 text-white border border-white/15 rounded-xl text-xs font-black flex items-center gap-1.5 shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.2)]"
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
          className="w-full h-28 bg-white dark:bg-[#141923] border border-slate-200/80 dark:border-white/25 rounded-2xl p-4 text-xs text-slate-900 dark:text-white outline-none focus:border-slate-400 dark:focus:border-white/30 resize-none"
        />
        <button
          onClick={submitTicket}
          className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white border border-white/15 rounded-xl font-black text-xs active:scale-95 transition-all shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)]"
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
                <span className="text-[10px] font-black text-amber-500">در انتظار بررسی</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">{t.message}</p>
              <p className="text-[9px] text-slate-400 font-mono">{t.id} • {formatDateTimeFa(t.created_at)}</p>
            </div>
          ))}
        </div>
      )}
    </motion.div>
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
      <div className="w-full max-w-md bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] p-7 space-y-6 relative shadow-2xl dark:shadow-[0_14px_38px_rgba(255,255,255,0.2)]">
        <button onClick={onClose} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white z-10">
          <X size={20} />
        </button>
        <div className="text-center space-y-2 pt-4">
          <h3 className="text-xl font-black text-slate-900 dark:text-white">اسکنر قرارداد</h3>
          <p className="text-xs text-slate-500 dark:text-slate-300">دوربین را مقابل کد QR قرارداد قرار دهید</p>
        </div>
        <div id="qr-reader" className="overflow-hidden rounded-3xl border border-slate-200 dark:border-white/25 bg-black/50" />
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
      <div className="w-full max-w-md bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-[2rem] p-7 space-y-6 relative shadow-2xl dark:shadow-[0_14px_38px_rgba(255,255,255,0.2)]">
        <button onClick={onClose} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white">
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
            <div className="w-14 h-14 bg-slate-100 dark:bg-white/10 text-blue-600 dark:text-white border border-slate-200/80 dark:border-white/25 rounded-2xl flex items-center justify-center mx-auto">
              <Users size={26} />
            </div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">معرفی میانجی به دوستان</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">برای انجام معاملات امن با همکاران و مشتریان خود، لینک ربات میانجی را برای آن‌ها ارسال کنید.</p>
            <div className="p-3 bg-slate-50 dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 rounded-2xl font-mono text-xs text-blue-600 dark:text-white" dir="ltr">
              {botLink}
            </div>
            <button onClick={() => copyText(botLink)} className="w-full h-12 bg-blue-600 text-white border border-white/15 rounded-xl font-black text-xs flex items-center justify-center gap-2 shadow-md dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)]">
              <Copy size={16} /> کپی لینک دعوت
            </button>
          </div>
        )}

        {type === 'settings' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">تنظیمات پنل</h3>
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 rounded-2xl">
              <span className="text-xs font-bold text-slate-900 dark:text-white">حالت شب (Dark Mode)</span>
              <button onClick={() => setIsDarkMode(!isDarkMode)} className="px-4 py-1.5 rounded-xl bg-blue-600 text-white border border-white/15 text-[11px] font-black">
                {isDarkMode ? 'فعال' : 'غیرفعال'}
              </button>
            </div>
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-[#1b2230] border border-slate-200/80 dark:border-white/25 rounded-2xl">
              <span className="text-xs font-bold text-slate-900 dark:text-white">حالت عیب‌یابی (Debug)</span>
              <button onClick={onToggleDebug} className={`px-4 py-1.5 rounded-xl text-[11px] font-black border ${isDebug ? 'bg-amber-500 text-black border-amber-300' : 'bg-white dark:bg-white/10 text-slate-600 dark:text-slate-200 border-slate-200/80 dark:border-white/20'}`}>
                {isDebug ? 'فعال' : 'غیرفعال'}
              </button>
            </div>
          </div>
        )}

        {type === 'about' && (
          <div className="space-y-4 text-center pt-4">
            <div className="w-14 h-14 bg-blue-600 text-white rounded-2xl flex items-center justify-center mx-auto shadow-lg">
              <Shield size={28} />
            </div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">پلتفرم امن میانجی</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">شبکه هوشمند واسطه‌گری مالی و ضمانت معاملات آنلاین، یکپارچه با ربات تلگرام میانجی.</p>
            <span className="inline-block text-[10px] font-mono text-blue-600 dark:text-slate-300">Version 2.4.0</span>
          </div>
        )}

        {type === 'kyc' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">وضعیت احراز هویت (KYC)</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">
              وضعیت فعلی حساب شما:{' '}
              <strong className="text-emerald-500">{user?.kyc_status === 'verified' ? 'تایید شده (سطح نقره‌ای)' : 'در حال تکمیل'}</strong>
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-300">شماره همراه ثبت‌شده در تلگرام: <span dir="ltr" className="font-mono">{user?.phone_number}</span></p>
          </div>
        )}

        {type === 'notif_prefs' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">تنظیمات اطلاع‌رسانی</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">تمامی کدهای تایید و تغییرات وضعیت قراردادها به صورت لحظه‌ای به ربات تلگرام شما ارسال می‌شوند.</p>
          </div>
        )}

        {type === 'security' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">امنیت و نشست فعال</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">ورود دو مرحله‌ای از طریق ربات رسمی تلگرام میانجی فعال است و هر کد تایید تنها یک‌بار و تا ۱۵ دقیقه معتبر است.</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function DirectChatView({ user, setView, notify }: any) {
  const [target, setTarget] = useState<any>(null);

  useEffect(() => {
    const saved = localStorage.getItem('mianji_chat_target');
    if (saved) setTarget(JSON.parse(saved));
  }, []);

  if (!target) {
    return (
      <div className="p-16 text-center space-y-4">
        <p className="text-xs font-bold text-slate-500">گفتگویی انتخاب نشده است</p>
        <button onClick={() => setView('messages')} className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-black">
          بازگشت به پیام‌ها
        </button>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-[calc(100vh-6.5rem)] max-w-4xl mx-auto">
      <TelegramChatRoom
        mode="direct"
        chatId={String(target.id)}
        title={target.full_name}
        subtitle={target.is_support ? 'پشتیبانی رسمی · آنلاین' : `${target.phone_number || 'گفتگوی مستقیم'} · آنلاین`}
        avatarChar={target.full_name?.[0] || 'U'}
        isOnline
        isSupport={Boolean(target.is_support)}
        user={user}
        onBack={() => setView('messages')}
        onStartDealWithContact={() => {
          localStorage.setItem('mianji_prefill_phone', target.phone_number || '');
          setView('create');
        }}
        notify={notify}
        fullHeightClass="h-full"
      />
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
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-95 transition-all shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">اعلان‌ها</h2>
            <p className="text-[10px] text-blue-600 dark:text-slate-300 uppercase tracking-widest font-bold">Notifications</p>
          </div>
        </div>
        {notifications.some((n) => !n.is_read) && (
          <button onClick={markAllAsRead} className="text-xs font-bold text-blue-600 dark:text-white px-3 py-1.5 bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 rounded-xl shadow-sm dark:shadow-[0_6px_18px_rgba(255,255,255,0.12)]">
            خواندن همه
          </button>
        )}
      </div>

      <div className="space-y-3">
        {notifications.length === 0 ? (
          <div className="card-refined p-12 text-center text-slate-500 dark:text-slate-300">
            <Bell size={36} className="mx-auto mb-3 text-slate-400/60" />
            <p className="text-xs font-bold">هیچ اعلانی وجود ندارد</p>
          </div>
        ) : (
          notifications.map((n: any) => (
            <div
              key={n.id}
              onClick={() => !n.is_read && markAsRead(n.id)}
              className={`card-refined p-5 flex items-start gap-4 cursor-pointer transition-all ${!n.is_read ? 'ring-1 ring-slate-300 dark:ring-white/30' : ''}`}
            >
              <div
                className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                  !n.is_read ? 'bg-blue-600 text-white shadow-lg dark:shadow-[0_6px_18px_rgba(255,255,255,0.2)]' : 'bg-slate-50 dark:bg-white/[0.1] border border-slate-200/80 dark:border-white/25 text-blue-500 dark:text-white'
                }`}
              >
                <Bell size={18} />
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-black text-slate-900 dark:text-white">{n.title || 'اعلان جدید'}</h4>
                  {!n.is_read && <span className="text-[10px] font-black text-blue-600 dark:text-white">جدید</span>}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">{n.message || n.text || ''}</p>
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
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#141923] border border-slate-200/90 dark:border-white/25 flex items-center justify-center text-slate-700 dark:text-white active:scale-95 transition-all shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_22px_rgba(255,255,255,0.14)]"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">پنل مدیریت و پشتیبانی</h2>
            <p className="text-[10px] text-blue-600 dark:text-slate-300 uppercase tracking-widest font-bold">{isOwner ? 'مالک کل (Owner)' : 'ادمین سیستم (Admin)'}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <button
          onClick={() => setActiveTab('support')}
          className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
            activeTab === 'support' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)]' : 'card-refined text-slate-900 dark:text-slate-200'
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
            activeTab === 'finance' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)]' : 'card-refined text-slate-900 dark:text-slate-200'
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
            activeTab === 'deals' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)]' : 'card-refined text-slate-900 dark:text-slate-200'
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
              activeTab === 'users' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_22px_rgba(255,255,255,0.22)]' : 'card-refined text-slate-900 dark:text-slate-200'
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
                <div className="p-4 bg-slate-50 dark:bg-[#1b2230] rounded-2xl text-xs text-slate-700 dark:text-slate-300 leading-relaxed">{item.text}</div>
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
                      className="h-11 px-5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-black shadow-md dark:shadow-[0_6px_18px_rgba(255,255,255,0.18)] active:scale-95 transition-all"
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
            <label className="p-4 bg-slate-50 dark:bg-[#1b2230] rounded-2xl flex items-center justify-between cursor-pointer">
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
            <label className="p-4 bg-slate-50 dark:bg-[#1b2230] rounded-2xl flex items-center justify-between cursor-pointer">
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
