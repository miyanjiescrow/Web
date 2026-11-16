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
  Menu, CreditCard, Sparkles, Sun, Moon, Copy, ExternalLink, Minus, Trash2,
  Star, Layers, Timer, UserPlus, Link2, Share2,
  Phone, PhoneOff, PhoneIncoming, Video, VideoOff, MicOff, Volume2,
  Monitor, Smartphone, Globe, Edit3, Briefcase, ShoppingBag, Code, Palette,
  Database, Download, Upload, AlertTriangle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode } from 'html5-qrcode';
import { auth, db, firebaseConfig, handleFirestoreError, OperationType } from './lib/firebase';
import {
  doc, getDoc, getDocFromServer, setDoc, serverTimestamp, disableNetwork, enableNetwork
} from 'firebase/firestore';
import { signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth';
import { apiFetch, uploadMediaFile } from './lib/apiClient';
import { realtimeClient } from './services/realtimeClient';
import {
  getEscrowActions,
  EscrowAction,
  transitionEscrowContract,
  transitionMilestone,
  submitDealReview,
  isPendingPartyId,
  buildDealInviteUrl,
  extractDealInviteFromQr,
  fetchDealInvitePreview,
  claimAndSignDeal,
  DealInvitePreview,
} from './services/escrowService';
import { TelegramMessagesHub, TelegramChatRoom } from './components/TelegramMessenger';
import AdminUserManager, { PlatformLimits } from './components/AdminUserManager';
import { DealsView, CreateDealView } from './components/DealsWorkspace';
import ConfirmDialog from './components/ConfirmDialog';
import {
  NotificationPreferences,
  DEFAULT_NOTIFICATION_PREFS,
  PushNavigationPayload,
  isBrowserPushSupported,
  getBrowserNotificationPermission,
  isPushBannerDismissed,
  dismissPushBanner,
  loadCachedNotificationPrefs,
  registerPushServiceWorker,
  fetchNotificationPreferences,
  saveNotificationPreferences,
  subscribeToBrowserPush,
  unsubscribeFromBrowserPush,
  syncExistingPushSubscription,
  sendServerTestPush,
  showLocalBrowserNotification,
  subscribeToSwNotificationClicks,
} from './services/pushNotifications';
import {
  validateIranianPayoutDestination,
  isValidIranianNationalId,
  isValidIranianCard,
  formatIranianCard,
  formatCardInputLive,
  formatShebaDisplay,
  detectIranianBankName,
} from './lib/bankValidation';
import { PWAInstallButton, OfflineIndicator } from './hooks/usePWA';
import {
  DEFAULT_PLATFORM_FEE_PERCENT,
  buildTelegramBotDealLink,
  computeCommissionBreakdown,
  getCategoryMeta,
  getCommissionPayerLabel,
  getDealStatusMeta,
  getMilestoneStatusMeta,
  isDisputedStatus,
  isUserDealBuyer,
  isUserDealSeller,
  normalizeDealStatus,
  normalizeDigits,
  normalizeMilestoneStatus,
} from './lib/dealSync';

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
  Math.max(
    0,
    Number(user?.wallet_balance ?? 0) -
      Number(user?.escrow_locked_balance ?? 0) -
      Number(user?.pending_withdraw_total ?? 0)
  );

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

let firestoreClientReachable = true;

// Firestore connection validation helper called during app boot
const testFirestoreConnection = async () => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    firestoreClientReachable = false;
    return;
  }

  // Fast REST reachability check (3.5s) before opening a persistent Firestore Listen stream
  try {
    const projectId = (firebaseConfig as any).projectId;
    const databaseId = (firebaseConfig as any).firestoreDatabaseId || '(default)';
    const apiKey = (firebaseConfig as any).apiKey;
    if (projectId && apiKey) {
      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), 3500);
      try {
        await fetch(
          `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/test/connection?key=${encodeURIComponent(apiKey)}`,
          { signal: controller.signal }
        );
      } finally {
        window.clearTimeout(abortTimer);
      }
    }
  } catch {
    // Direct browser access to firestore.googleapis.com is blocked/throttled; operate via backend API without triggering 10s SDK timeout
    firestoreClientReachable = false;
    await disableNetwork(db).catch(() => {});
    return;
  }

  let timedOut = false;
  const safeguardTimer = window.setTimeout(() => {
    timedOut = true;
    firestoreClientReachable = false;
    void disableNetwork(db).catch(() => {});
  }, 7000);

  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    firestoreClientReachable = true;
  } catch (err: any) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '');
    if (code === 'permission-denied') {
      firestoreClientReachable = true;
      return;
    }
    if (timedOut) {
      firestoreClientReachable = false;
      return;
    }
    if (msg.includes('the client is offline') || code === 'unavailable') {
      firestoreClientReachable = false;
      console.warn('Firestore client is temporarily offline or unreachable.');
    }
  } finally {
    window.clearTimeout(safeguardTimer);
  }
};

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
        <div className="min-h-screen flex flex-col items-center justify-center p-8 text-center bg-[#0b0f17] text-white font-sans" dir="rtl">
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
  | 'marketplace'
  | 'admin';

type InfoModalType = 'rules' | 'about' | 'support' | 'settings' | 'invite' | 'kyc' | 'notif_prefs' | 'security' | null;

interface ToastState {
  message: string;
  type: 'success' | 'error' | 'info';
}

export interface SavedBankMethod {
  id: string;
  type: 'card' | 'sheba';
  number: string;
  formatted: string;
  bank_name: string;
  label: string;
  holder_name?: string;
  is_default?: boolean;
  created_at?: string;
}

interface UserProfile {
  id: string | number;
  full_name: string | null;
  username?: string | null;
  avatar_url?: string | null;
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
  pending_withdraw_total?: number;
  kyc_status: string;
  trust_score?: number;
  is_blocked?: boolean;
  blocked_reason?: string;
  max_deal_amount?: number;
  daily_withdraw_limit?: number;
  max_active_deals?: number;
  is_withdraw_locked?: boolean;
  is_deal_locked?: boolean;
  admin_note?: string;
  national_id?: string;
  kyc_id_card_url?: string;
  kyc_selfie_url?: string;
  kyc_bank_card?: string;
  kyc_bank_name?: string;
  kyc_match_status?: 'matched' | 'mismatch' | 'pending_manual';
  kyc_match_note?: string;
  kyc_match_checked_at?: string;
  kyc_submitted_at?: string;
  kyc_reject_reason?: string;
  saved_cards?: SavedBankMethod[];
  rating_avg?: number;
  rating_count?: number;
  completed_deals_count?: number;
}

interface ContractMilestone {
  id: string;
  order?: number;
  title: string;
  amount: number;
  status: string;
  deadline_days?: number;
  submitted_at?: string;
  completed_at?: string;
  auto_release_at?: string | null;
  delivery_note?: string;
  delivery_attachment_url?: string;
  revision_note?: string;
}

interface DealReview {
  id: string;
  contract_id: string;
  reviewer_id: string;
  reviewer_name: string;
  target_user_id: string;
  score: number;
  comment?: string;
  created_at: string;
}

interface Contract {
  id?: string;
  contract_id: string;
  title: string;
  amount: number;
  fee_percent?: number;
  fee_amount?: number;
  employer_fee?: number;
  freelancer_fee?: number;
  employer_total_payable?: number;
  net_seller_amount?: number;
  commission_payer?: 'freelancer' | 'employer' | 'shared' | string;
  staged_payment?: boolean;
  is_milestone?: boolean;
  milestones?: ContractMilestone[];
  free_edits?: number;
  free_edits_total?: number;
  free_edits_left?: number;
  work_submitted_at?: string;
  delivery_due_at?: string;
  auto_release_at?: string | null;
  auto_released?: boolean;
  escrow_deposit_status?: 'unpaid' | 'paid_locked' | 'released' | 'refunded' | string;
  buyer_rating_avg?: number;
  buyer_rating_count?: number;
  seller_rating_avg?: number;
  seller_rating_count?: number;
  reviews?: DealReview[];
  resolution?: {
    verdict: 'refund' | 'release' | 'split';
    seller_percent: number;
    buyer_percent: number;
    settled_amount?: number;
    seller_gross?: number;
    seller_net?: number;
    buyer_refund?: number;
    fee_amount?: number;
    note?: string;
    arbitrator_id?: string;
    arbitrator_name?: string;
    resolved_at?: string;
    decided_at?: string;
  };
  appeal?: {
    id: string;
    requester_id: string;
    requester_name: string;
    requester_role: 'buyer' | 'seller';
    reason: string;
    attachment_url?: string;
    status: 'pending' | 'accepted' | 'rejected';
    created_at: string;
    reviewed_by?: string;
    reviewed_by_name?: string;
    reviewed_at?: string;
    review_note?: string;
  };
  buyer_id: string | number | null;
  seller_id: string | number | null;
  buyer_name?: string;
  seller_name?: string;
  buyer_fullname?: string | null;
  buyer_phone?: string | null;
  buyer_national_id?: string | null;
  seller_fullname?: string | null;
  seller_phone?: string | null;
  seller_national_id?: string | null;
  creator_id?: string | number;
  created_by?: string | number;
  invite_mode?: boolean;
  invite_token?: string;
  bot_link?: string;
  pending_phone?: string;
  is_pending_counterparty?: boolean;
  status: string;
  created_at?: any;
  createdAt?: any;
  updated_at?: any;
  category?: string;
  description?: string;
  deadline?: string | number;
  revisions?: string | number;
  inspection_hours?: number | string;
  delivery_note?: string;
  delivery_attachment_url?: string;
  revision_note?: string;
  dispute_reason?: string;
  history?: Array<{
    event: string;
    timestamp: string;
    actor: string;
    actor_id?: string | number;
  }>;
  timeline?: Array<{
    id: string;
    type: string;
    status?: string;
    actor_id?: string | number;
    actor_name?: string;
    note?: string;
    attachment_url?: string;
    timestamp: string;
  }>;
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
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [walletModalPreset, setWalletModalPreset] = useState<'deposit' | 'withdraw' | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMobileChat, setActiveMobileChat] = useState<{ type: 'direct' | 'contract' | 'channel'; id: string } | null>(null);
  const [pendingInviteTarget, setPendingInviteTarget] = useState<{ contractId: string; token?: string; deferredForAuth?: boolean } | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const signDeal = String(params.get('sign_deal') || '').trim();
      const token = String(params.get('token') || '').trim() || undefined;
      if (signDeal) {
        const target = { contractId: signDeal, token };
        sessionStorage.setItem('mianji_pending_sign_invite', JSON.stringify(target));
        return target;
      }
      const saved = sessionStorage.getItem('mianji_pending_sign_invite');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [loginPhone, setLoginPhone] = useState('');
  const [previewOtp, setPreviewOtp] = useState<string | null>(null);
  const [otpChallenge, setOtpChallenge] = useState<string | null>(null);
  const [platformLimits, setPlatformLimits] = useState<PlatformLimits>({
    min_deal_amount: 10000,
    default_max_deal_amount: 100000000,
    default_daily_withdraw_limit: 50000000,
    default_max_active_deals: 10,
    max_admin_balance_adjust: 20000000,
    platform_fee_percent: DEFAULT_PLATFORM_FEE_PERCENT,
    deposit_card_number: '',
    deposit_card_holder: '',
    deposit_sheba: '',
    deposit_note: '',
  });
  const [botUsername, setBotUsername] = useState('mianji_ir_bot');
  const [previewMode, setPreviewMode] = useState(!Boolean((import.meta as any).env?.PROD));
  const [platformStats, setPlatformStats] = useState<{ total_fees_collected: number }>({
    total_fees_collected: 0,
  });
  const [persistenceStatus, setPersistenceStatus] = useState<{
    mode: 'firestore' | 'local_disk' | 'memory_ephemeral';
    firebaseAdminReady: boolean;
    projectId: string;
    databaseId: string;
    credentialSource: string;
    credentialDetail?: string;
    lastError: string | null;
    verifiedAt: string | null;
  } | null>(null);
  const [impersonatorAdmin, setImpersonatorAdmin] = useState<{ user: UserProfile; sessionToken: string | null } | null>(() => {
    try {
      const saved = localStorage.getItem('mianji_admin_return_session');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [pushPermission, setPushPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    getBrowserNotificationPermission()
  );
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences>(() => loadCachedNotificationPrefs());
  const [pushSubCount, setPushSubCount] = useState(0);
  const [pushActive, setPushActive] = useState(false);
  const [pushBannerDismissed, setPushBannerDismissed] = useState(() => isPushBannerDismissed());

  const [showQuickCallModal, setShowQuickCallModal] = useState(false);
  const [activeCall, setActiveCall] = useState<{
    callId: string;
    peerId: string;
    peerName: string;
    mode: 'audio' | 'video';
    direction: 'outgoing' | 'incoming';
    status: 'ringing' | 'connecting' | 'connected';
    scope?: 'direct' | 'contract';
    chatId?: string;
    offerSdp?: any;
  } | null>(null);
  const [callMuted, setCallMuted] = useState(false);
  const [callCameraOff, setCallCameraOff] = useState(false);
  const [localCallStream, setLocalCallStream] = useState<MediaStream | null>(null);
  const [remoteCallStream, setRemoteCallStream] = useState<MediaStream | null>(null);

  const pendingUserRef = useRef<UserProfile | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef<View>(view);
  const activeChatRef = useRef(activeMobileChat);
  const notifPrefsRef = useRef<NotificationPreferences>(notifPrefs);
  const pushPermissionRef = useRef(pushPermission);
  const contractsRef = useRef<Contract[]>(contracts);
  const activeCallRef = useRef(activeCall);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    activeChatRef.current = activeMobileChat;
  }, [activeMobileChat]);
  useEffect(() => {
    notifPrefsRef.current = notifPrefs;
  }, [notifPrefs]);
  useEffect(() => {
    pushPermissionRef.current = pushPermission;
  }, [pushPermission]);
  useEffect(() => {
    contractsRef.current = contracts;
  }, [contracts]);
  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  const notify = (message: string, type: ToastState['type'] = 'info') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  };

  const cleanupCallResources = () => {
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      localStreamRef.current = null;
    }
    pendingIceRef.current = [];
    setLocalCallStream(null);
    setRemoteCallStream(null);
    setCallMuted(false);
    setCallCameraOff(false);
  };

  const createPeerConnection = (callId: string, peerId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    const remoteStream = new MediaStream();
    setRemoteCallStream(remoteStream);

    pc.ontrack = (event) => {
      event.streams?.[0]?.getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
      if (event.track && !remoteStream.getTracks().some((t) => t.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }
      setRemoteCallStream(new MediaStream(remoteStream.getTracks()));
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        realtimeClient.sendCallEvent('call:signal', {
          callId,
          targetUserId: peerId,
          signal: {
            candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
          },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setActiveCall((prev) => (prev && prev.callId === callId ? { ...prev, status: 'connected' } : prev));
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (activeCallRef.current?.callId === callId) {
          cleanupCallResources();
          setActiveCall(null);
        }
      }
    };

    pcRef.current = pc;
    return pc;
  };

  const startCall = async (opts: {
    targetUserId: string;
    targetName: string;
    mode: 'audio' | 'video';
    scope: 'direct' | 'contract';
    chatId: string;
  }) => {
    const targetId = String(opts.targetUserId || '').trim();
    if (!targetId || isPendingPartyId(targetId)) {
      notify('طرف مقابل هنوز عضو میانجی نشده است', 'error');
      return;
    }
    if (String(user?.id || '') === targetId) {
      notify('امکان برقراری تماس با خودتان وجود ندارد', 'error');
      return;
    }
    if (activeCallRef.current) {
      notify('در حال حاضر یک تماس فعال دارید', 'info');
      return;
    }

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        notify('مرورگر شما از تماس صوتی/تصویری پشتیبانی نمی‌کند', 'error');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: opts.mode === 'video',
      });
      localStreamRef.current = stream;
      setLocalCallStream(stream);
      setCallMuted(false);
      setCallCameraOff(false);

      const pc = createPeerConnection(callId, targetId);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      setActiveCall({
        callId,
        peerId: targetId,
        peerName: opts.targetName || 'کاربر میانجی',
        mode: opts.mode,
        direction: 'outgoing',
        status: 'ringing',
        scope: opts.scope,
        chatId: opts.chatId,
      });

      const sent = realtimeClient.sendCallEvent('call:invite', {
        callId,
        targetUserId: targetId,
        mode: opts.mode,
        scope: opts.scope,
        chatId: opts.chatId,
        signal: { sdp: offer },
      });
      if (!sent) {
        cleanupCallResources();
        setActiveCall(null);
        notify('اتصال زنده برقرار نیست. لطفاً چند لحظه بعد تلاش کنید.', 'error');
      }
    } catch {
      cleanupCallResources();
      setActiveCall(null);
      notify('دسترسی به میکروفون یا دوربین داده نشد یا سخت‌افزار در دسترس نیست', 'error');
    }
  };

  const acceptIncomingCall = async () => {
    const cur = activeCallRef.current;
    if (!cur || cur.direction !== 'incoming' || !cur.offerSdp) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        notify('مرورگر از تماس پشتیبانی نمی‌کند', 'error');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: cur.mode === 'video',
      });
      localStreamRef.current = stream;
      setLocalCallStream(stream);
      setCallMuted(false);
      setCallCameraOff(false);

      const pc = createPeerConnection(cur.callId, cur.peerId);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(cur.offerSdp));
      for (const ice of pendingIceRef.current) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(ice));
        } catch {}
      }
      pendingIceRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      setActiveCall((prev) => (prev ? { ...prev, status: 'connecting', offerSdp: undefined } : prev));
      realtimeClient.sendCallEvent('call:accept', {
        callId: cur.callId,
        targetUserId: cur.peerId,
        signal: { sdp: answer },
      });
    } catch {
      realtimeClient.sendCallEvent('call:reject', {
        callId: cur.callId,
        targetUserId: cur.peerId,
        reason: 'media_error',
      });
      cleanupCallResources();
      setActiveCall(null);
      notify('دسترسی به میکروفون یا دوربین برقرار نشد', 'error');
    }
  };

  const rejectIncomingCall = () => {
    const cur = activeCallRef.current;
    if (!cur) return;
    realtimeClient.sendCallEvent('call:reject', {
      callId: cur.callId,
      targetUserId: cur.peerId,
      reason: 'declined',
    });
    cleanupCallResources();
    setActiveCall(null);
  };

  const endCurrentCall = (notifyPeer = true) => {
    const cur = activeCallRef.current;
    if (cur && notifyPeer) {
      realtimeClient.sendCallEvent('call:end', {
        callId: cur.callId,
        targetUserId: cur.peerId,
      });
    }
    cleanupCallResources();
    setActiveCall(null);
  };

  const toggleCallMute = () => {
    if (!localStreamRef.current) return;
    const nextMuted = !callMuted;
    localStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setCallMuted(nextMuted);
  };

  const toggleCallCamera = () => {
    if (!localStreamRef.current) return;
    const nextOff = !callCameraOff;
    localStreamRef.current.getVideoTracks().forEach((t) => {
      t.enabled = !nextOff;
    });
    setCallCameraOff(nextOff);
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
      themeColorMeta.setAttribute('content', isDarkMode ? '#0b0f17' : '#ffffff');
    }

    const tg = (window as any).Telegram?.WebApp;
    if (tg) {
      try {
        tg.setHeaderColor?.(isDarkMode ? '#0b0f17' : '#ffffff');
        tg.setBackgroundColor?.(isDarkMode ? '#0b0f17' : '#ffffff');
      } catch {}
    }
  }, [isDarkMode]);

  useEffect(() => {
    const handleOpenScanner = () => setShowWebScanner(true);
    document.addEventListener('open-qr-scanner', handleOpenScanner);
    return () => document.removeEventListener('open-qr-scanner', handleOpenScanner);
  }, []);

  useEffect(() => {
    const isViteHmrWsError = (reason: any, filename?: string) => {
      const msg = String(reason?.message || reason || '');
      const stack = String(reason?.stack || filename || '');
      return msg.includes('WebSocket closed without opened') && stack.includes('@vite/client');
    };

    const handleError = (event: ErrorEvent) => {
      if (isViteHmrWsError(event.error || event.message, event.filename)) return;
      remoteLog('error', `Global Error: ${event.message}`, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      if (isViteHmrWsError(event.reason)) {
        event.preventDefault();
        return;
      }
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

  const fetchInitialData = async (userId: string | number) => {
    const uid = String(userId);
    try {
      const [dealsRes, notesRes, walletRes] = await Promise.allSettled([
        apiFetch<{ success: boolean; deals?: Contract[] }>('/api/deals'),
        apiFetch<{ success: boolean; notifications?: any[] }>('/api/notifications'),
        apiFetch<{
          success: boolean;
          balances?: { wallet_balance: number; escrow_locked_balance: number; pending_withdraw_total?: number };
        }>('/api/wallet/requests')
      ]);

      if (dealsRes.status === 'fulfilled' && dealsRes.value?.success && Array.isArray(dealsRes.value.deals)) {
        const sortedDeals = [...dealsRes.value.deals].sort(
          (a, b) => toMillis(b.createdAt || b.created_at) - toMillis(a.createdAt || a.created_at)
        );
        setContracts(sortedDeals);
      }

      if (notesRes.status === 'fulfilled' && notesRes.value?.success && Array.isArray(notesRes.value.notifications)) {
        setNotifications(notesRes.value.notifications);
      }

      if (walletRes.status === 'fulfilled' && walletRes.value?.success && walletRes.value.balances) {
        const b = walletRes.value.balances;
        setUser((prev) => {
          if (!prev || String(prev.id) !== uid) return prev;
          const nextUser = {
            ...prev,
            wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
            escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0),
            pending_withdraw_total: Number(b.pending_withdraw_total ?? prev.pending_withdraw_total ?? 0),
          };
          localStorage.setItem('mianji_mock_user', JSON.stringify(nextUser));
          return nextUser;
        });
      }

      if (auth.currentUser && firestoreClientReachable) {
        try {
          const userDoc = await Promise.race([
            getDoc(doc(db, 'users', uid)),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('firestore-read-timeout')), 7000)),
          ]);
          if (userDoc.exists()) {
            const fresh = { id: userDoc.id, ...userDoc.data() } as UserProfile;
            setUser(fresh);
            localStorage.setItem('mianji_mock_user', JSON.stringify(fresh));
          }
        } catch (err: any) {
          if (String(err?.code || '') === 'permission-denied') {
            handleFirestoreError(err, OperationType.GET, `users/${uid}`);
          }
          if (String(err?.message || '') === 'firestore-read-timeout') {
            firestoreClientReachable = false;
            await disableNetwork(db).catch(() => {});
          }
        }
      }
    } catch (err) {
      remoteLog('warn', 'Fetch Initial Data error', err);
    }
  };

  // Auth & Init
  useEffect(() => {
    void testFirestoreConnection();
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      try {
        if (fbUser) {
          const userRef = doc(db, 'users', fbUser.uid);
          let userDoc: any = null;
          if (firestoreClientReachable) {
            await enableNetwork(db).catch(() => {});
            try {
              userDoc = await Promise.race([
                getDoc(userRef),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('firestore-read-timeout')), 7000)),
              ]);
            } catch (readErr: any) {
              if (String(readErr?.code || '') === 'permission-denied') {
                // Keep server-issued session alive even if direct browser Firestore read is restricted
                remoteLog('warn', 'Firestore user profile read restricted; keeping server session', readErr?.message);
              } else if (String(readErr?.message || '') === 'firestore-read-timeout') {
                firestoreClientReachable = false;
                await disableNetwork(db).catch(() => {});
              } else {
                remoteLog('warn', 'Firestore profile read fallback activated', readErr?.message);
              }
            }
          }
          if (userDoc?.exists?.()) {
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
            } catch (writeErr: any) {
              remoteLog('warn', 'Could not create Firestore user profile, using session profile', writeErr?.message);
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
            const savedMock = localStorage.getItem('mianji_mock_user');
            const savedSession = localStorage.getItem('mianji_session_token');
            if (savedMock && savedSession) {
              try {
                const parsed = JSON.parse(savedMock) as UserProfile;
                setUser(parsed);
                setIsAuthenticated(true);
                setView((prev) => (prev === 'auth' ? 'dashboard' : prev));
                fetchInitialData(parsed.id);
                return;
              } catch {}
            }
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
              fetchInitialData(parsed.id);
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
      } finally {
        setLoading(false);
      }
    });

    const completeBotSession = async (data: any, label = 'خوش آمدید!') => {
      if (data?.sessionToken) {
        localStorage.setItem('mianji_session_token', data.sessionToken);
      }
      if (data?.success && data?.user) {
        localStorage.setItem('mianji_mock_user', JSON.stringify(data.user));
        setUser(data.user);
        setIsAuthenticated(true);
        setIsOtpSent(false);
        setView('dashboard');
        fetchInitialData(data.user.id);
        notify(label, 'success');
        if (data?.customToken) {
          pendingUserRef.current = data.user;
          void signInWithCustomToken(auth, data.customToken).catch((authErr) => {
            remoteLog('warn', 'Bot customToken sign-in fallback activated', authErr);
          });
        }
      }
    };

    // Check for direct Magic Login token from Telegram Bot (?tg_login=...)
    try {
      const searchParams = new URLSearchParams(window.location.search);
      const magicToken = String(searchParams.get('tg_login') || '').trim();
      if (magicToken) {
        searchParams.delete('tg_login');
        const nextQuery = searchParams.toString();
        const cleanUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash || ''}`;
        window.history.replaceState({}, document.title, cleanUrl);
        fetch('/api/auth/telegram-magic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: magicToken }),
        })
          .then((res) => res.json())
          .then(async (data) => {
            if (data?.success) {
              await completeBotSession(data, 'ورود مستقیم از ربات تلگرام انجام شد');
            } else if (data?.error) {
              notify(data.error, 'error');
            }
          })
          .catch((err) => remoteLog('warn', 'Telegram magic link login failed', err));
      }
    } catch {}

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
            if (data?.success) {
              await completeBotSession(data, 'خوش آمدید!');
            } else if (data?.error) {
              notify(data.error, 'error');
            }
          })
          .catch((err) => remoteLog('warn', 'Telegram WebApp auto-login failed', err));
      }
    }

    fetch('/api/limits/effective')
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.limits) setPlatformLimits(d.limits);
        if (d.success && d.platformStats) setPlatformStats(d.platformStats);
        if (d.success && d.bot_username) setBotUsername(String(d.bot_username).replace(/^@/, ''));
        if (d.success && typeof d.previewMode === 'boolean') setPreviewMode(d.previewMode);
        if (d.success && d.persistence) setPersistenceStatus(d.persistence);
      })
      .catch(() => {});

    return () => unsubscribe();
  }, []);

  const navigateFromPushPayload = (payload: PushNavigationPayload) => {
    try {
      const parsedUrl = payload.url ? new URL(payload.url, window.location.origin) : null;
      const qView = (parsedUrl?.searchParams.get('view') || '') as View;
      const cid = payload.contract_id || parsedUrl?.searchParams.get('contract_id') || '';
      const scope = (payload.scope || parsedUrl?.searchParams.get('scope') || '') as 'direct' | 'contract' | 'channel' | '';
      const chatId = payload.chat_id || payload.channel_id || parsedUrl?.searchParams.get('chat_id') || '';

      if (cid) {
        const found = contractsRef.current.find((c) => c.contract_id === cid);
        if (found) {
          localStorage.setItem('selected_contract', JSON.stringify(found));
        } else {
          localStorage.setItem('selected_contract', JSON.stringify({ contract_id: cid }));
        }
        setView(qView === 'dispute' ? 'dispute' : 'detail');
        return;
      }

      if (scope && chatId && (scope === 'direct' || scope === 'contract' || scope === 'channel')) {
        setActiveMobileChat({ type: scope, id: chatId });
        setView('messages');
        return;
      }

      if (qView && ['dashboard', 'deals', 'wallet', 'messages', 'profile', 'support', 'notifications', 'dispute', 'detail', 'admin'].includes(qView)) {
        setView(qView);
      } else if (payload.kind === 'wallet') {
        setView('wallet');
      } else if (payload.kind === 'support') {
        setView('support');
      } else if (payload.kind === 'message' || payload.kind === 'channel') {
        setView('messages');
      } else {
        setView('notifications');
      }
    } catch {}
  };

  useEffect(() => {
    return subscribeToSwNotificationClicks(navigateFromPushPayload);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (pendingInviteTarget?.deferredForAuth) {
      setPendingInviteTarget((prev) => (prev ? { ...prev, deferredForAuth: false } : null));
    }
    const params = new URLSearchParams(window.location.search);
    const paymentStatus = params.get('payment_status');
    const payAmt = params.get('amount');
    const payRef = params.get('ref');
    const qView = params.get('view') as View | null;
    const cid = params.get('contract_id');
    const scope = params.get('scope') as 'direct' | 'contract' | 'channel' | null;
    const chatId = params.get('chat_id');

    if (paymentStatus === 'success') {
      notify(
        `پرداخت با موفقیت انجام شد${payAmt ? ` (${Number(payAmt).toLocaleString()} تومان)` : ''}${payRef ? ` • کد پیگیری: ${payRef}` : ''}`,
        'success'
      );
      setView('wallet');
    } else if (paymentStatus === 'failed') {
      notify('پرداخت لغو شد یا ناموفق بود.', 'error');
      setView('wallet');
    } else if (cid || qView || (scope && chatId)) {
      navigateFromPushPayload({
        url: window.location.pathname + window.location.search,
        contract_id: cid,
        scope: scope === 'direct' || scope === 'contract' ? scope : null,
        chat_id: chatId,
      });
    }

    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [isAuthenticated]);

  const refreshPushState = async () => {
    setPushPermission(getBrowserNotificationPermission());
    const { prefs, subscriptionsCount, hasLocalSubscription } = await fetchNotificationPreferences();
    setNotifPrefs(prefs);
    setPushSubCount(subscriptionsCount);
    setPushActive(hasLocalSubscription);
  };

  const handleEnablePush = async () => {
    const res = await subscribeToBrowserPush();
    setPushPermission(res.permission);
    if (res.success) {
      setPushActive(true);
      setPushBannerDismissed(true);
      dismissPushBanner();
      await refreshPushState();
      notify('اعلان لحظه‌ای مرورگر با موفقیت فعال شد', 'success');
    } else {
      notify(res.error || 'امکان فعال‌سازی اعلان وجود ندارد', 'error');
    }
    return res;
  };

  const handleDisablePush = async () => {
    await unsubscribeFromBrowserPush();
    setPushActive(false);
    await refreshPushState();
    notify('اعلان مرورگر برای این دستگاه غیرفعال شد', 'info');
  };

  const handleUpdateNotifPrefs = async (partial: Partial<NotificationPreferences>) => {
    const next = await saveNotificationPreferences(partial);
    setNotifPrefs(next);
    notify('تنظیمات اطلاع‌رسانی ذخیره شد', 'success');
  };

  const handleTestPush = async () => {
    try {
      const res = await sendServerTestPush();
      if (res.deliveredCount > 0) {
        notify(`اعلان آزمایشی برای ${res.deliveredCount} دستگاه ارسال شد`, 'success');
      } else {
        const shown = await showLocalBrowserNotification({
          title: '🛡️ تست اعلان فوری میانجی',
          body: 'این یک پیش‌نمایش محلی اعلان مرورگر است و اتصال به‌درستی کار می‌کند.',
          tag: `mianji-test-${Date.now()}`,
          url: '/?view=notifications',
          onClick: () => setView('notifications'),
        });
        notify(
          shown
            ? 'اعلان آزمایشی در این مرورگر نمایش داده شد'
            : 'لطفاً ابتدا مجوز اعلان مرورگر را فعال کنید',
          shown ? 'success' : 'error'
        );
      }
    } catch {
      notify('خطا در ارسال اعلان آزمایشی', 'error');
    }
  };

  const handleDismissPushBanner = () => {
    dismissPushBanner();
    setPushBannerDismissed(true);
  };

  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      realtimeClient.disconnect();
      return;
    }

    const uid = String(user.id);
    realtimeClient.connect(uid);
    void registerPushServiceWorker()
      .then(() => syncExistingPushSubscription())
      .then(() => refreshPushState())
      .catch(() => {});

    const offDeal = realtimeClient.on('deal:updated', (payload: any) => {
      if (!payload?.contract) return;
      const updated = payload.contract as Contract;
      setContracts((prev) => {
        const exists = prev.some((c) => c.contract_id === updated.contract_id);
        const next = exists
          ? prev.map((c) => (c.contract_id === updated.contract_id ? { ...c, ...updated } : c))
          : [updated, ...prev];
        return next.sort((a, b) => toMillis(b.createdAt || b.created_at) - toMillis(a.createdAt || a.created_at));
      });
      try {
        const sel = localStorage.getItem('selected_contract');
        if (sel) {
          const parsedSel = JSON.parse(sel);
          if (parsedSel.contract_id === updated.contract_id) {
            localStorage.setItem('selected_contract', JSON.stringify(updated));
          }
        }
      } catch {}

      if (payload.balances?.[uid]) {
        const b = payload.balances[uid];
        setUser((prev) => {
          if (!prev) return prev;
          const nextUser = {
            ...prev,
            wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
            escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0)
          };
          localStorage.setItem('mianji_mock_user', JSON.stringify(nextUser));
          return nextUser;
        });
      }

      const lastStep = Array.isArray(updated.timeline) && updated.timeline.length > 0
        ? updated.timeline[updated.timeline.length - 1]
        : null;
      const actorId = lastStep?.actor_id ? String(lastStep.actor_id) : '';
      if (
        actorId !== uid &&
        pushPermissionRef.current === 'granted' &&
        notifPrefsRef.current.deals_enabled &&
        (document.hidden || notifPrefsRef.current.foreground_alerts)
      ) {
        const label = getDealStatusMeta(updated.status).label || 'تغییر وضعیت معامله';
        void showLocalBrowserNotification({
          title: `معامله ${updated.contract_id}`,
          body: `${updated.title || 'قرارداد میانجی'} • ${label}`,
          tag: `mianji-deal-${updated.contract_id}-${updated.status}`,
          url: `/?view=detail&contract_id=${updated.contract_id}`,
          data: { kind: 'deal', contract_id: updated.contract_id },
          onClick: () => navigateFromPushPayload({ kind: 'deal', contract_id: updated.contract_id }),
        });
      }
    });

    const offChatMessage = realtimeClient.on('chat:message', (payload: any) => {
      const msg = payload?.message;
      const scope = payload?.scope;
      const chatId = payload?.chatId;
      if (!msg || String(msg.sender_id) === uid) return;
      if (pushPermissionRef.current !== 'granted' || !notifPrefsRef.current.messages_enabled) return;

      const isViewingThisRoom =
        viewRef.current === 'messages' &&
        activeChatRef.current?.type === scope &&
        String(activeChatRef.current?.id) === String(chatId);

      if (document.hidden || (notifPrefsRef.current.foreground_alerts && !isViewingThisRoom)) {
        void showLocalBrowserNotification({
          title: msg.sender_name ? `پیام از ${msg.sender_name}` : 'پیام جدید در میانجی',
          body: msg.message_text || 'فایل جدید ارسال شد',
          tag: `mianji-msg-${msg.id}`,
          url: `/?view=messages&scope=${scope}&chat_id=${chatId}`,
          data: { kind: 'message', scope, chat_id: String(chatId) },
          onClick: () => navigateFromPushPayload({ kind: 'message', scope, chat_id: String(chatId) }),
        });
      }
    });

    const offChannelPost = realtimeClient.on('channel:post', (payload: any) => {
      const post = payload?.post;
      const channelId = payload?.channelId;
      if (!post || post.silent || String(post.author_id) === uid) return;
      if (pushPermissionRef.current !== 'granted' || !notifPrefsRef.current.channels_enabled) return;

      const isViewingChannel =
        viewRef.current === 'messages' &&
        activeChatRef.current?.type === 'channel' &&
        String(activeChatRef.current?.id) === String(channelId);

      if (document.hidden || (notifPrefsRef.current.foreground_alerts && !isViewingChannel)) {
        void showLocalBrowserNotification({
          title: `📢 ${post.author_name || 'کانال میانجی'}`,
          body: String(post.text || '').slice(0, 140),
          tag: `mianji-channel-${post.id}`,
          url: `/?view=messages&scope=channel&chat_id=${channelId}`,
          data: { kind: 'channel', channel_id: String(channelId) },
          onClick: () => navigateFromPushPayload({ kind: 'channel', channel_id: String(channelId) }),
        });
      }
    });

    const offWallet = realtimeClient.on('wallet:updated', (payload: any) => {
      if (String(payload?.userId) !== uid || !payload?.balances) return;
      const b = payload.balances;
      setUser((prev) => {
        if (!prev) return prev;
        const nextUser = {
          ...prev,
          wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
          escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0),
          pending_withdraw_total: Number(b.pending_withdraw_total ?? prev.pending_withdraw_total ?? 0),
        };
        localStorage.setItem('mianji_mock_user', JSON.stringify(nextUser));
        return nextUser;
      });
    });

    const offUserUpdated = realtimeClient.on('user:updated', (payload: any) => {
      if (String(payload?.userId) !== uid || !payload?.user) return;
      setUser((prev) => {
        if (!prev) return prev;
        const nextUser = { ...prev, ...payload.user };
        localStorage.setItem('mianji_mock_user', JSON.stringify(nextUser));
        return nextUser;
      });
    });

    const offNote = realtimeClient.on('notification:new', (payload: any) => {
      if (String(payload?.userId) !== uid || !payload?.notification) return;
      const note = payload.notification;
      setNotifications((prev) => (prev.some((n) => n.id === note.id) ? prev : [note, ...prev]));
    });

    const offCallInvite = realtimeClient.on('call:invite', (payload: any) => {
      if (!payload?.callId || !payload?.fromUserId) return;
      if (activeCallRef.current) {
        realtimeClient.sendCallEvent('call:reject', {
          callId: payload.callId,
          targetUserId: payload.fromUserId,
          reason: 'busy',
        });
        return;
      }
      pendingIceRef.current = [];
      setActiveCall({
        callId: String(payload.callId),
        peerId: String(payload.fromUserId),
        peerName: String(payload.fromName || payload.callerName || 'کاربر میانجی'),
        mode: payload.mode === 'video' ? 'video' : 'audio',
        direction: 'incoming',
        status: 'ringing',
        scope: payload.scope,
        chatId: payload.chatId,
        offerSdp: payload.signal?.sdp || payload.sdp,
      });
    });

    const offCallAccept = realtimeClient.on('call:accept', async (payload: any) => {
      if (!payload?.callId || activeCallRef.current?.callId !== payload.callId) return;
      const pc = pcRef.current;
      const answerSdp = payload.signal?.sdp || payload.sdp;
      if (pc && answerSdp) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
          for (const ice of pendingIceRef.current) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(ice));
            } catch {}
          }
          pendingIceRef.current = [];
          setActiveCall((prev) => (prev && prev.callId === payload.callId ? { ...prev, status: 'connecting' } : prev));
        } catch {}
      }
    });

    const offCallSignal = realtimeClient.on('call:signal', async (payload: any) => {
      if (!payload?.callId || activeCallRef.current?.callId !== payload.callId) return;
      const pc = pcRef.current;
      const candidate = payload.signal?.candidate || payload.candidate;
      if (candidate) {
        if (pc && pc.remoteDescription) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch {}
        } else {
          pendingIceRef.current.push(candidate);
        }
      }
    });

    const offCallReject = realtimeClient.on('call:reject', (payload: any) => {
      if (!payload?.callId || activeCallRef.current?.callId !== payload.callId) return;
      cleanupCallResources();
      setActiveCall(null);
      notify(payload.reason === 'busy' ? 'کاربر در حال مکالمه دیگری است' : 'تماس توسط طرف مقابل رد شد', 'info');
    });

    const offCallEnd = realtimeClient.on('call:end', (payload: any) => {
      if (!payload?.callId || activeCallRef.current?.callId !== payload.callId) return;
      cleanupCallResources();
      setActiveCall(null);
      notify('تماس پایان یافت', 'info');
    });

    const offCallUnavailable = realtimeClient.on('call:unavailable', (payload: any) => {
      if (!payload?.callId || activeCallRef.current?.callId !== payload.callId) return;
      cleanupCallResources();
      setActiveCall(null);
      notify('طرف مقابل در حال حاضر آنلاین نیست', 'error');
    });

    return () => {
      offDeal();
      offChatMessage();
      offChannelPost();
      offWallet();
      offUserUpdated();
      offNote();
      offCallInvite();
      offCallAccept();
      offCallSignal();
      offCallReject();
      offCallEnd();
      offCallUnavailable();
    };
  }, [isAuthenticated, user?.id]);

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
        setOtpChallenge(otpRes.otpChallenge || null);
        setIsOtpSent(true);
        return { success: true };
      } else {
        return {
          error: otpRes.previewMode
            ? ''
            : otpRes.error || 'ارسال کد تایید به تلگرام انجام نشد. لطفاً ابتدا ربات را استارت کنید.',
          needRegistration: otpRes.needRegistration,
          previewMode: Boolean(otpRes.previewMode),
        };
      }
    } catch (err: any) {
      remoteLog('error', 'Login Exception', err);
      return { error: `خطای ارتباط با سرور: ${err.message}` };
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleRegisterPreview = async (phone: string, fullName: string) => {
    const cleanPhone = normalizeDigits(phone).replace(/[^0-9]/g, '');
    const cleanName = fullName.trim();
    if (!cleanPhone || cleanPhone.length < 10) {
      return { error: 'لطفاً شماره همراه معتبر (حداقل ۱۰ رقم) وارد کنید' };
    }
    if (cleanName.length < 2) {
      return { error: 'لطفاً نام و نام خانوادگی خود را وارد کنید' };
    }
    setIsLoggingIn(true);
    setPreviewOtp(null);
    setOtpChallenge(null);
    try {
      const res = await fetch('/api/auth/register-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone, full_name: cleanName })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setLoginPhone(data.phone || cleanPhone);
        setPreviewOtp(data.previewOtp || null);
        setOtpChallenge(data.otpChallenge || null);
        setIsOtpSent(true);
        notify('حساب کاربری ایجاد و کد ورود آماده شد', 'success');
        return { success: true };
      }
      return { error: data.error || 'خطا در ثبت‌نام پیش‌نمایش' };
    } catch (err: any) {
      return { error: `خطای ارتباط با سرور: ${err.message}` };
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleVerifyOtp = async (code: string, fallbackPhone?: string) => {
    const cleanCode = normalizeDigits(code).replace(/[^0-9]/g, '');
    if (cleanCode.length < 6) {
      return { error: 'لطفاً کد تایید ۶ رقمی را کامل وارد کنید' };
    }
    const targetPhone = loginPhone || normalizeDigits(fallbackPhone || '').replace(/[^0-9]/g, '');
    setIsLoggingIn(true);

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: targetPhone, code: cleanCode, otpChallenge })
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
        setOtpChallenge(null);
        setIsOtpSent(false);
        if (result.sessionToken) {
          localStorage.setItem('mianji_session_token', result.sessionToken);
        }
        localStorage.setItem('mianji_mock_user', JSON.stringify(result.user));
        setUser(result.user);
        setIsAuthenticated(true);
        setView('dashboard');
        fetchInitialData(result.user.id);
        notify('خوش آمدید!', 'success');
        if (result.customToken) {
          pendingUserRef.current = result.user;
          void signInWithCustomToken(auth, result.customToken).catch((authErr) => {
            remoteLog('warn', 'Custom token sign-in fallback activated', authErr);
          });
        }
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

  const handleImpersonateUser = async ({
    user: targetUser,
    customToken,
    sessionToken,
  }: {
    user: any;
    customToken?: string | null;
    sessionToken?: string | null;
  }) => {
    if (!impersonatorAdmin && user) {
      const savedAdmin = {
        user,
        sessionToken: localStorage.getItem('mianji_session_token'),
      };
      setImpersonatorAdmin(savedAdmin);
      localStorage.setItem('mianji_admin_return_session', JSON.stringify(savedAdmin));
    }

    if (sessionToken) {
      localStorage.setItem('mianji_session_token', sessionToken);
    }
    localStorage.setItem('mianji_mock_user', JSON.stringify(targetUser));

    if (customToken) {
      try {
        pendingUserRef.current = targetUser;
        await signInWithCustomToken(auth, customToken);
      } catch {
        // Fallback session already stored cleanly
      }
    }

    setUser(targetUser);
    setIsAuthenticated(true);
    setView('dashboard');
    fetchInitialData(String(targetUser.id));
    notify(`وارد حساب «${targetUser.full_name || targetUser.id}» شدید`, 'info');
  };

  const handleExitImpersonation = async () => {
    if (!impersonatorAdmin) return;
    const { user: adminUser, sessionToken } = impersonatorAdmin;
    localStorage.removeItem('mianji_admin_return_session');
    setImpersonatorAdmin(null);

    if (sessionToken) {
      localStorage.setItem('mianji_session_token', sessionToken);
    } else {
      localStorage.removeItem('mianji_session_token');
    }
    localStorage.setItem('mianji_mock_user', JSON.stringify(adminUser));

    setUser(adminUser);
    setIsAuthenticated(true);
    setView('admin');
    fetchInitialData(String(adminUser.id));
    notify('به حساب مدیریت بازگشتید', 'success');
  };

  const handleResetOtp = () => {
    setIsOtpSent(false);
    setLoginPhone('');
    setPreviewOtp(null);
    setOtpChallenge(null);
  };

  const handleLogout = async (skipServerLogout = false) => {
    remoteLog('info', 'User logged out');
    endCurrentCall(true);
    if (!skipServerLogout) {
      await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    }
    try {
      await signOut(auth);
    } catch {}
    realtimeClient.disconnect();
    localStorage.removeItem('mianji_mock_user');
    localStorage.removeItem('mianji_demo_mode');
    localStorage.removeItem('selected_contract');
    localStorage.removeItem('mianji_session_token');
    localStorage.removeItem('mianji_admin_return_session');
    setImpersonatorAdmin(null);
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

  useEffect(() => {
    const onSessionRevoked = (ev: any) => {
      const msg = ev?.detail || 'نشست این دستگاه لغو شد. لطفاً دوباره وارد شوید.';
      void handleLogout(true);
      notify(msg, 'error');
    };
    window.addEventListener('mianji:session-revoked', onSessionRevoked);
    return () => window.removeEventListener('mianji:session-revoked', onSessionRevoked);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-[#0b0f17] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const hideBottomNavOnMobile = isAuthenticated && view === 'messages' && activeMobileChat !== null;

  return (
    <ErrorBoundary>
      <OfflineIndicator />
      <div
        className="min-h-screen bg-white dark:bg-[#0b0f17] text-slate-900 dark:text-slate-100 font-sans selection:bg-blue-600/30 overflow-x-hidden transition-colors duration-300"
        dir="rtl"
      >
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
          user={user}
          setView={setView}
          onLogout={() => setLogoutConfirmOpen(true)}
          onOpenModal={setInfoModal}
          onOpenQuickCall={() => setShowQuickCallModal(true)}
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
                  ? 'bg-emerald-600/95 border-emerald-400/40 text-white shadow-[0_8px_24px_rgba(16,185,129,0.35)]'
                  : toast.type === 'error'
                  ? 'bg-rose-600/95 border-rose-400/40 text-white shadow-[0_8px_24px_rgba(244,63,94,0.35)]'
                  : 'bg-white/95 dark:bg-[#131924]/95 border-slate-200/90 dark:border-white/[0.08] text-slate-900 dark:text-white shadow-[0_12px_32px_rgba(15,23,42,0.16)] dark:shadow-[0_12px_28px_rgba(0,0,0,0.55)]'
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
          {/* Active Impersonation Banner */}
          {isAuthenticated && impersonatorAdmin && (
            <div className="mb-3 px-4 py-2.5 rounded-2xl bg-amber-500/15 border border-amber-500/35 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 font-black text-amber-700 dark:text-amber-300">
                <Shield size={16} />
                <span>
                  در حال مشاهده و مدیریت اکانت: {user?.full_name || user?.id} ({user?.phone_number || 'بدون شماره'})
                </span>
              </div>
              <button
                onClick={handleExitImpersonation}
                className="h-8 px-3.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-black text-[11px] active:scale-95 transition-all"
              >
                بازگشت به پنل مدیریت
              </button>
            </div>
          )}

          {/* Blocked User Guard */}
          {isAuthenticated && user?.is_blocked && !impersonatorAdmin ? (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="max-w-md w-full card-refined p-7 text-center space-y-4 border-rose-500/35">
                <div className="w-14 h-14 rounded-2xl bg-rose-500/15 text-rose-500 flex items-center justify-center mx-auto">
                  <AlertCircle size={28} />
                </div>
                <h2 className="text-lg font-black text-slate-900 dark:text-white">حساب کاربری مسدود شده است</h2>
                <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">
                  {user.blocked_reason || 'دسترسی این حساب توسط تیم مدیریت محدود و مسدود شده است. برای پیگیری با پشتیبانی تماس بگیرید.'}
                </p>
                <button
                  onClick={() => setLogoutConfirmOpen(true)}
                  className="w-full h-11 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-black"
                >
                  خروج از حساب
                </button>
              </div>
            </div>
          ) : (
            <>
          {/* Header */}
          {isAuthenticated && (
            <header className="h-16 md:h-20 flex items-center justify-between gap-2 sticky top-0 bg-white/95 dark:bg-[#111722]/95 backdrop-blur-md z-50 border border-slate-200/90 dark:border-white/[0.07] rounded-2xl mb-4 px-3 sm:px-4 shadow-[0_10px_28px_-8px_rgba(15,23,42,0.08)] dark:shadow-[0_12px_30px_-10px_rgba(0,0,0,0.55)]">
              <div className="flex items-center gap-2 sm:gap-3 shrink-0 min-w-0">
                <button
                  onClick={() => setIsSidebarOpen(true)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-slate-200 active:scale-90 transition-all shrink-0"
                >
                  <Menu size={20} />
                </button>
                <div className="cursor-pointer shrink-0" onClick={() => setView('dashboard')}>
                  <h1 className="text-base md:text-lg font-black text-slate-900 dark:text-white leading-none whitespace-nowrap">میانجی</h1>
                  <span className="text-[9px] md:text-[10px] text-blue-600 dark:text-slate-400 uppercase tracking-wider font-bold whitespace-nowrap block mt-0.5">Escrow Platform</span>
                </div>
              </div>

              <div className="hidden md:flex flex-1 max-w-sm mx-6 lg:mx-8">
                <div className="w-full h-10 bg-slate-50 dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] rounded-xl flex items-center px-4 gap-2 text-slate-500 dark:text-slate-300 focus-within:border-blue-500/60 transition-colors">
                  <Search size={16} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      if (view !== 'deals' && e.target.value.trim()) setView('deals');
                    }}
                    placeholder="جستجو در معاملات..."
                    className="bg-transparent outline-none font-sans text-[14px] font-medium text-slate-900 dark:text-white w-full placeholder:text-slate-400 dark:placeholder:text-slate-400"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="text-slate-400 hover:text-slate-700 dark:hover:text-white">
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 sm:gap-2 md:gap-2.5 shrink-0">
                <button
                  onClick={() => setIsDarkMode(!isDarkMode)}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-amber-300 active:scale-90 transition-all"
                  title={isDarkMode ? 'تم روز (کاملاً سفید)' : 'تم شب'}
                >
                  {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                  onClick={() => setView('notifications')}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center relative text-slate-700 dark:text-slate-200 active:scale-90 transition-all"
                >
                  <Bell size={16} />
                  {notifications.some((n) => !n.is_read) && (
                    <div className="absolute top-2.5 right-2.5 w-1.5 h-1.5 bg-blue-500 rounded-full border-2 border-white dark:border-[#111722]" />
                  )}
                </button>
                <button
                  onClick={() => setView('profile')}
                  className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-slate-50 dark:bg-white/[0.05] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all overflow-hidden border border-slate-200 dark:border-white/[0.1]"
                >
                  {user?.avatar_url ? (
                    <img src={user.avatar_url} alt={user.full_name || 'آواتار'} className="w-full h-full object-cover" />
                  ) : user?.full_name ? (
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
                  onRegisterPreview={handleRegisterPreview}
                  onVerify={handleVerifyOtp}
                  onResetPhone={handleResetOtp}
                  isLoading={isLoggingIn}
                  isOtpSent={isOtpSent}
                  loginPhone={loginPhone}
                  previewOtp={previewOtp}
                  botUsername={botUsername}
                  previewMode={previewMode}
                  onToggleDebug={toggleDebug}
                  isDebug={isDebug}
                  isDarkMode={isDarkMode}
                  onToggleTheme={() => setIsDarkMode(!isDarkMode)}
                  onOpenSupport={() => setInfoModal('support')}
                  onOpenAbout={() => setInfoModal('about')}
                />
              )}
              {isAuthenticated && view === 'dashboard' && (
                <DashboardView
                  user={user}
                  contracts={contracts}
                  setView={setView}
                  onOpenRules={() => setInfoModal('rules')}
                  onOpenWalletAction={(mode: 'deposit' | 'withdraw') => {
                    setWalletModalPreset(mode);
                    setView('wallet');
                  }}
                  isDebug={isDebug}
                  showPushBanner={
                    isBrowserPushSupported() &&
                    pushPermission === 'default' &&
                    !pushBannerDismissed
                  }
                  onEnablePush={handleEnablePush}
                  onDismissPushBanner={handleDismissPushBanner}
                />
              )}
              {isAuthenticated && view === 'deals' && (
                <DealsView
                  user={user}
                  contracts={contracts}
                  platformLimits={platformLimits}
                  botUsername={botUsername}
                  setView={setView}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  onOpenQrScanner={() => setShowWebScanner(true)}
                  notify={notify}
                  onOpenDealChat={(c: any) => {
                    localStorage.setItem('selected_contract', JSON.stringify(c));
                    setActiveMobileChat({ type: 'contract', id: c.contract_id });
                    setView('messages');
                  }}
                />
              )}
              {isAuthenticated && view === 'wallet' && (
                <WalletView
                  user={user}
                  setUser={setUser}
                  notify={notify}
                  platformLimits={platformLimits}
                  initialAction={walletModalPreset}
                  onConsumeInitialAction={() => setWalletModalPreset(null)}
                  onOpenContract={(cid: string) => {
                    const found = contracts.find((c) => c.contract_id === cid);
                    if (found) {
                      localStorage.setItem('selected_contract', JSON.stringify(found));
                      setView('detail');
                    } else {
                      notify('جزئیات این قرارداد در فهرست فعلی یافت نشد', 'info');
                    }
                  }}
                />
              )}
              {isAuthenticated && view === 'messages' && (
                <TelegramMessagesHub
                  user={user}
                  contracts={contracts}
                  setView={setView}
                  notify={notify}
                  activeMobileChat={activeMobileChat}
                  setActiveMobileChat={setActiveMobileChat}
                  onStartCall={startCall}
                  onOpenDealById={(cid: string) => {
                    const found = contracts.find((c) => c.contract_id === cid);
                    if (found) {
                      localStorage.setItem('selected_contract', JSON.stringify(found));
                      setView('detail');
                    } else {
                      notify('قرارداد مورد نظر یافت نشد', 'error');
                    }
                  }}
                  onDealUpdated={async (updated: any, balances?: any) => {
                    if (updated?.contract_id) {
                      setContracts((prev) => {
                        const exists = prev.some((c) => c.contract_id === updated.contract_id);
                        const next = exists
                          ? prev.map((c) => (c.contract_id === updated.contract_id ? { ...c, ...updated } : c))
                          : [updated, ...prev];
                        return next.sort((a, b) => toMillis(b.createdAt || b.created_at) - toMillis(a.createdAt || a.created_at));
                      });
                      localStorage.setItem('selected_contract', JSON.stringify(updated));
                    }
                    if (balances && user?.id && balances[String(user.id)]) {
                      const b = balances[String(user.id)];
                      setUser((prev) => {
                        if (!prev) return prev;
                        const nextUser = {
                          ...prev,
                          wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
                          escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0)
                        };
                        localStorage.setItem('mianji_mock_user', JSON.stringify(nextUser));
                        return nextUser;
                      });
                    }
                    if (user?.id) await fetchInitialData(user.id);
                  }}
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
              {isAuthenticated && view === 'marketplace' && (
                <MarketplaceView
                  setView={setView}
                  notify={notify}
                />
              )}
              {isAuthenticated && view === 'profile' && (
                <ProfileView
                  user={user}
                  setUser={setUser}
                  contracts={contracts}
                  setView={setView}
                  onLogout={() => setLogoutConfirmOpen(true)}
                  onOpenModal={setInfoModal}
                  notify={notify}
                />
              )}
              {isAuthenticated && view === 'support' && <SupportView user={user} setView={setView} notify={notify} botUsername={botUsername} />}
              {isAuthenticated && view === 'dispute' && (
                <DisputeView user={user} setView={setView} refresh={() => user && fetchInitialData(user.id)} notify={notify} />
              )}
              {isAuthenticated && view === 'detail' && (
                <DealDetailView
                  user={user}
                  setUser={setUser}
                  contracts={contracts}
                  setView={setView}
                  refresh={() => user && fetchInitialData(user.id)}
                  isDebug={isDebug}
                  notify={notify}
                  botUsername={botUsername}
                  onOpenDirectChat={async (targetUserId: string) => {
                    try {
                      const res = await apiFetch<{ success: boolean; chat?: { id: string } }>('/api/chats/direct/open', {
                        method: 'POST',
                        body: JSON.stringify({ target_user_id: targetUserId })
                      });
                      if (res.success && res.chat?.id) {
                        setActiveMobileChat({ type: 'direct', id: res.chat.id });
                        setView('messages');
                      }
                    } catch (err: any) {
                      notify(err?.message || 'خطا در باز کردن گفتگوی مستقیم', 'error');
                    }
                  }}
                  onDealUpdated={async (updated: any, balances?: any) => {
                    if (updated?.contract_id) {
                      setContracts((prev) => {
                        const exists = prev.some((c) => c.contract_id === updated.contract_id);
                        return exists
                          ? prev.map((c) => (c.contract_id === updated.contract_id ? { ...c, ...updated } : c))
                          : [updated, ...prev];
                      });
                    }
                    if (balances && user?.id && balances[String(user.id)]) {
                      const b = balances[String(user.id)];
                      setUser((prev) => {
                        if (!prev) return prev;
                        const nextUser = {
                          ...prev,
                          wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
                          escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0)
                        };
                        localStorage.setItem('mianji_mock_user', JSON.stringify(nextUser));
                        return nextUser;
                      });
                    }
                    if (user?.id) await fetchInitialData(user.id);
                  }}
                />
              )}
              {isAuthenticated && view === 'create' && (
                <CreateDealView
                  user={user}
                  contracts={contracts}
                  platformLimits={platformLimits}
                  botUsername={botUsername}
                  onBack={() => setView('dashboard')}
                  onCreated={(createdContract?: any) => {
                    if (createdContract?.contract_id) {
                      setContracts((prev) => [
                        createdContract,
                        ...prev.filter((c) => c.contract_id !== createdContract.contract_id),
                      ]);
                      localStorage.setItem('selected_contract', JSON.stringify(createdContract));
                    }
                    user && fetchInitialData(user.id);
                  }}
                  onSuccess={(createdContract?: any) => {
                    if (createdContract) {
                      localStorage.setItem('selected_contract', JSON.stringify(createdContract));
                      setView('detail');
                    } else {
                      setView('deals');
                    }
                    user && fetchInitialData(user.id);
                  }}
                  notify={notify}
                />
              )}
              {isAuthenticated && view === 'notifications' && (
                <NotificationsView notifications={notifications} setNotifications={setNotifications} setView={setView} />
              )}
              {isAuthenticated && view === 'admin' && (
                <AdminPanelView
                  user={user}
                  contracts={contracts}
                  platformStats={platformStats}
                  persistenceStatus={persistenceStatus}
                  onPersistenceUpdated={setPersistenceStatus}
                  setView={setView}
                  notify={notify}
                  onImpersonate={handleImpersonateUser}
                  onLimitsUpdated={setPlatformLimits}
                />
              )}
            </AnimatePresence>
          </main>
            </>
          )}

          {/* Bottom Nav */}
          {isAuthenticated && (
            <nav
              className={`fixed bottom-5 left-1/2 -translate-x-1/2 w-[92%] max-w-md h-16 md:h-18 bg-white/95 dark:bg-[#111722]/95 backdrop-blur-xl border border-slate-200/90 dark:border-white/[0.08] rounded-2xl md:rounded-3xl items-center justify-around px-2 md:px-4 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.14)] dark:shadow-[0_14px_32px_-8px_rgba(0,0,0,0.65)] z-[100] transition-all ${
                hideBottomNavOnMobile ? 'hidden lg:flex' : 'flex'
              }`}
            >
              <NavBtn active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={16} />} label="خانه" />
              <NavBtn active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={16} />} label="معاملات" />
              <div className="relative -translate-y-5 md:-translate-y-6">
                <button
                  onClick={() => setView('create')}
                  className="w-12 h-12 md:w-14 md:h-14 bg-blue-600 hover:bg-blue-500 rounded-full flex items-center justify-center text-white shadow-[0_8px_22px_rgba(37,99,235,0.35)] border-4 border-white dark:border-[#0b0f17] active:scale-90 transition-all"
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
                onScan={async (code) => {
                  setShowWebScanner(false);
                  const extracted = extractDealInviteFromQr(code);
                  if (!extracted?.contractId) {
                    notify('کد معامله یا QR نامعتبر است. نمونه معتبر: DEV-0508-4821 یا لینک دعوت قرارداد.', 'error');
                    return;
                  }
                  const contract = contracts.find(
                    (c) => String(c.contract_id || '').toUpperCase() === extracted.contractId.toUpperCase()
                  );
                  const isOpenInvite = Boolean(
                    extracted.token ||
                      !contract ||
                      contract.is_pending_counterparty ||
                      isPendingPartyId(contract.buyer_id) ||
                      isPendingPartyId(contract.seller_id) ||
                      ['draft', 'pending_party_b'].includes(normalizeDealStatus(contract.status))
                  );
                  if (isOpenInvite) {
                    setPendingInviteTarget({ contractId: extracted.contractId, token: extracted.token });
                    return;
                  }
                  if (contract) {
                    localStorage.setItem('selected_contract', JSON.stringify(contract));
                    setView('detail');
                    const isBuyer = isUserDealBuyer(contract, user);
                    const canonicalSt = normalizeDealStatus(contract.status);
                    if ((canonicalSt === 'draft' || canonicalSt === 'pending_party_b') && isBuyer) {
                      try {
                        await transitionEscrowContract(
                          contract,
                          'awaiting_payment',
                          async () => {
                            if (user?.id) await fetchInitialData(user.id);
                          },
                          false,
                          { note: 'تایید و امضای قرارداد با اسکن QR' }
                        );
                        notify('قرارداد با اسکن QR تایید شد و در انتظار پرداخت است', 'success');
                      } catch {
                        notify('قرارداد با موفقیت شناسایی شد', 'success');
                      }
                    } else {
                      notify('قرارداد با موفقیت شناسایی شد', 'success');
                    }
                  } else {
                    notify('قرارداد یافت نشد یا معتبر نیست.', 'error');
                  }
                }}
              />
            )}
          </AnimatePresence>

          {/* Active WebRTC Voice/Video Call Overlay */}
          <AnimatePresence>
            {activeCall && (
              <CallOverlayModal
                call={activeCall}
                localStream={localCallStream}
                remoteStream={remoteCallStream}
                muted={callMuted}
                cameraOff={callCameraOff}
                onAccept={acceptIncomingCall}
                onReject={rejectIncomingCall}
                onEnd={() => endCurrentCall(true)}
                onToggleMute={toggleCallMute}
                onToggleCamera={toggleCallCamera}
              />
            )}
          </AnimatePresence>

          {/* Quick Call Picker Modal (Activated from Sidebar) */}
          <AnimatePresence>
            {showQuickCallModal && isAuthenticated && (
              <QuickCallModal
                user={user}
                contracts={contracts}
                onClose={() => setShowQuickCallModal(false)}
                onStartCall={(opts: any) => {
                  setShowQuickCallModal(false);
                  void startCall(opts);
                }}
              />
            )}
          </AnimatePresence>

          {/* Open-Invite Link / QR Sign Modal (Works both before & after login) */}
          <AnimatePresence>
            {pendingInviteTarget && !pendingInviteTarget.deferredForAuth && (
              <InviteSignModal
                target={pendingInviteTarget}
                isAuthenticated={isAuthenticated}
                user={user}
                notify={notify}
                onRequireAuth={() => {
                  try {
                    sessionStorage.setItem(
                      'mianji_pending_sign_invite',
                      JSON.stringify({ contractId: pendingInviteTarget.contractId, token: pendingInviteTarget.token })
                    );
                  } catch {}
                  setPendingInviteTarget((prev) => (prev ? { ...prev, deferredForAuth: true } : null));
                  notify('برای امضا و ثبت نهایی قرارداد، لطفاً وارد حساب خود شوید', 'info');
                }}
                onClose={() => {
                  try {
                    sessionStorage.removeItem('mianji_pending_sign_invite');
                  } catch {}
                  setPendingInviteTarget(null);
                }}
                onSigned={async (deal: any) => {
                  try {
                    sessionStorage.removeItem('mianji_pending_sign_invite');
                  } catch {}
                  setPendingInviteTarget(null);
                  if (deal?.contract_id) {
                    localStorage.setItem('selected_contract', JSON.stringify(deal));
                    setContracts((prev) => {
                      const exists = prev.some((c) => c.contract_id === deal.contract_id);
                      return exists
                        ? prev.map((c) => (c.contract_id === deal.contract_id ? { ...c, ...deal } : c))
                        : [deal, ...prev];
                    });
                    setView('detail');
                  }
                  if (user?.id) await fetchInitialData(user.id);
                }}
                onOpenDealDetail={(contractId: string) => {
                  try {
                    sessionStorage.removeItem('mianji_pending_sign_invite');
                  } catch {}
                  setPendingInviteTarget(null);
                  const found = contracts.find((c) => String(c.contract_id || '').toUpperCase() === contractId.toUpperCase());
                  if (found) {
                    localStorage.setItem('selected_contract', JSON.stringify(found));
                    setView('detail');
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
                setUser={setUser}
                isDarkMode={isDarkMode}
                setIsDarkMode={setIsDarkMode}
                isDebug={isDebug}
                onToggleDebug={toggleDebug}
                pushPermission={pushPermission}
                notifPrefs={notifPrefs}
                pushSubCount={pushSubCount}
                pushActive={pushActive}
                onEnablePush={handleEnablePush}
                onDisablePush={handleDisablePush}
                onUpdateNotifPrefs={handleUpdateNotifPrefs}
                onTestPush={handleTestPush}
                onSwitchType={(next: InfoModalType) => setInfoModal(next)}
                onClose={() => setInfoModal(null)}
                notify={notify}
                botUsername={botUsername}
              />
            )}
          </AnimatePresence>

          <ConfirmDialog
            open={logoutConfirmOpen}
            title="خروج از حساب کاربری"
            description="آیا مطمئن هستید که می‌خواهید از حساب کاربری خود خارج شوید؟ برای ورود مجدد نیاز به دریافت کد تایید خواهید داشت."
            previewText={
              user
                ? `${user.full_name || 'کاربر میانجی'}${user.phone_number ? ` — ${user.phone_number}` : ''}`
                : undefined
            }
            confirmLabel="بله، خروج از حساب"
            cancelLabel="ماندن در حساب"
            tone="danger"
            icon="logout"
            busy={logoutBusy}
            onCancel={() => {
              if (!logoutBusy) setLogoutConfirmOpen(false);
            }}
            onConfirm={async () => {
              setLogoutBusy(true);
              try {
                await handleLogout(false);
              } finally {
                setLogoutBusy(false);
                setLogoutConfirmOpen(false);
              }
            }}
          />
        </div>
      </div>
    </ErrorBoundary>
  );
}

// --- View Components ---

function AuthView({
  onLogin,
  onRegisterPreview,
  onVerify,
  onResetPhone,
  isLoading,
  isOtpSent,
  loginPhone,
  previewOtp,
  botUsername,
  previewMode,
  onToggleDebug,
  isDebug,
  isDarkMode,
  onToggleTheme,
  onOpenSupport,
  onOpenAbout,
}: {
  onLogin: (p: string) => Promise<{ success?: boolean; error?: string; needRegistration?: boolean; previewMode?: boolean } | void>;
  onRegisterPreview?: (p: string, fullName: string) => Promise<{ success?: boolean; error?: string }>;
  onVerify: (c: string, fallbackPhone?: string) => Promise<{ success?: boolean; error?: string }>;
  onResetPhone: () => void;
  isLoading: boolean;
  isOtpSent: boolean;
  loginPhone: string;
  previewOtp: string | null;
  botUsername?: string;
  previewMode?: boolean;
  onToggleDebug: () => void;
  isDebug: boolean;
  isDarkMode?: boolean;
  onToggleTheme?: () => void;
  onOpenSupport?: () => void;
  onOpenAbout?: () => void;
}) {
  const cleanBotUsername = String(botUsername || 'mianji_ir_bot').replace(/^@/, '');
  const botLink = `https://t.me/${cleanBotUsername}`;
  const [phone, setPhone] = useState(loginPhone || '');
  const [fullName, setFullName] = useState('');
  const [showQuickReg, setShowQuickReg] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [needReg, setNeedReg] = useState(false);
  const [clickCount, setClickCount] = useState(0);
  const autoSubmittedCodeRef = useRef<string>('');
  const isPreviewMode = previewMode ?? !Boolean((import.meta as any).env?.PROD);

  useEffect(() => {
    if (!isOtpSent) {
      autoSubmittedCodeRef.current = '';
      setCode('');
    }
  }, [isOtpSent]);

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
      if (res.needRegistration) {
        setNeedReg(true);
        if (res.previewMode || isPreviewMode) {
          setShowQuickReg(true);
        }
      }
    }
  };

  const submitQuickRegister = async () => {
    if (isLoading || !onRegisterPreview) return;
    setError('');
    const res = await onRegisterPreview(phone, fullName);
    if (res?.error) setError(res.error);
  };

  const submitOtp = async (overrideCode?: string) => {
    const targetCode = typeof overrideCode === 'string' ? overrideCode : code;
    if (isLoading || targetCode.length < 6) return;
    setError('');
    autoSubmittedCodeRef.current = targetCode;
    const res = await onVerify(targetCode, loginPhone || phone);
    if (res?.error) setError(res.error);
  };

  const resendOtp = async () => {
    const target = loginPhone || phone;
    if (isLoading || !target) return;
    setError('');
    setCode('');
    autoSubmittedCodeRef.current = '';
    const res = await onLogin(target);
    if (res && typeof res === 'object' && res.error) {
      setError(res.error);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="min-h-[82vh] flex flex-col justify-center px-4 py-6 max-w-[430px] mx-auto"
    >
      {/* Large Architectural Brand Showcase Card */}
      <div
        onClick={handleLogoClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleLogoClick();
        }}
        className="relative overflow-hidden rounded-[30px] bg-gradient-to-b from-[#06080d] via-[#040509] to-[#020305] border border-slate-900 dark:border-white/[0.08] px-6 pt-7 pb-7 mb-4 shadow-[0_24px_50px_-18px_rgba(0,0,0,0.75)] select-none cursor-pointer group"
      >
        {/* Subtle Deep Architectural Glow & Grid */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 left-1/2 -translate-x-1/2 w-80 h-56 rounded-full bg-blue-600/12 blur-3xl transition-opacity duration-500 group-hover:opacity-90"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-16 -right-12 w-52 h-52 rounded-full bg-indigo-500/8 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.4) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />

        {/* Top Corner Controls Inside Card */}
        <div className="relative z-10 flex items-center justify-between mb-3">
          <span className="text-[10px] font-bold tracking-[0.18em] text-slate-400/80 uppercase">
            ESCROW PLATFORM
          </span>
          {onToggleTheme && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleTheme();
              }}
              aria-label="تغییر تم روز و شب"
              className="w-9 h-9 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-slate-200 transition-all active:scale-90"
            >
              {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          )}
        </div>

        {/* Large Calligraphy Logo */}
        <div className="relative z-10 flex flex-col items-center text-center">
          <h1 className="sr-only">میانجی</h1>
          <div className="relative flex items-center justify-center mb-2">
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-blue-500/10 blur-2xl rounded-full scale-90"
            />
            <img
              src="/assets/aistudio/________________47d33e49.webp"
              alt="لوگو میانجی"
              referrerPolicy="no-referrer"
              className="relative h-28 sm:h-32 w-auto object-contain drop-shadow-[0_12px_30px_rgba(37,99,235,0.28)] transition-transform duration-300 group-active:scale-95"
            />
          </div>

          <p className="mt-1 text-xs sm:text-[13px] font-medium text-slate-400">
            ضمانت هوشمند و امانی معاملات دیجیتال
          </p>

          {isDebug && (
            <span className="mt-3 px-2.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-400/25 text-amber-300 text-[10px] font-mono">
              DEBUG MODE
            </span>
          )}
        </div>
      </div>

      {/* Minimal Uncluttered Obsidian Black Auth Card (Consistent in Day & Night Mode) */}
      <div className="bg-gradient-to-b from-[#080b12] via-[#05070c] to-[#030408] border border-slate-900 dark:border-white/[0.08] p-5 sm:p-6 rounded-[26px] space-y-4 shadow-[0_24px_50px_-18px_rgba(0,0,0,0.7)] text-white transition-colors">
        {!isOtpSent ? (
          <>
            <div className="space-y-2 text-right">
              <label className="block text-xs font-black text-slate-200 px-1">
                شماره همراه
              </label>
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
                onKeyDown={(e) => e.key === 'Enter' && (showQuickReg ? submitQuickRegister() : submitPhone())}
                disabled={isLoading}
                className="w-full h-13 px-4 rounded-2xl !bg-[#0c111c] !border !border-white/[0.1] !text-white placeholder:!text-slate-500 text-center text-base font-sans tabular-nums tracking-wider outline-none focus:!bg-[#111827] focus:!border-blue-500/60 focus:!ring-2 focus:!ring-blue-500/20 transition-all disabled:opacity-50"
              />
            </div>

            {((needReg && isPreviewMode) || showQuickReg) && isPreviewMode && (
              <div className="p-4 bg-blue-500/10 border border-blue-500/25 rounded-2xl space-y-3 text-right">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-black text-blue-400">
                    ساخت حساب سریع (پیش‌نمایش)
                  </span>
                  {showQuickReg && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowQuickReg(false);
                        setNeedReg(false);
                      }}
                      className="text-[10px] font-bold text-slate-400 hover:text-white"
                    >
                      بستن
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  placeholder="نام و نام خانوادگی"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitQuickRegister()}
                  disabled={isLoading}
                  className="w-full h-12 px-4 rounded-xl !bg-[#0a0f19] !border !border-white/[0.1] !text-white placeholder:!text-slate-500 text-right text-[14px] outline-none focus:!bg-[#101726] focus:!border-blue-500/60 transition-all disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={submitQuickRegister}
                  disabled={isLoading || !phone || fullName.trim().length < 2}
                  className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                >
                  ثبت‌نام و دریافت کد ورود
                </button>
              </div>
            )}

            {error && (
              <div className="p-3.5 bg-rose-500/12 border border-rose-500/25 rounded-2xl space-y-2.5 text-right">
                <div className="flex items-center gap-2.5">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <p className="text-xs font-bold text-rose-400 flex-1 leading-relaxed">{error}</p>
                </div>
                <div className="flex items-center gap-2">
                  {needReg && (
                    <a
                      href={botLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 h-9 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[11px] flex items-center justify-center gap-1.5 transition-all active:scale-95"
                    >
                      <Send size={12} className="-rotate-45" />
                      استارت ربات تلگرام
                    </a>
                  )}
                  <button
                    onClick={() => {
                      setError('');
                      setNeedReg(false);
                    }}
                    className={`h-9 px-3 bg-white/10 hover:bg-white/15 text-slate-200 rounded-xl text-[11px] font-bold transition-all active:scale-95 ${
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
              className="w-full h-13 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black text-sm border border-white/10 shadow-[0_10px_24px_-8px_rgba(37,99,235,0.5)] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                'ورود با کد تلگرام'
              )}
            </button>

            <div className="flex items-center justify-between gap-2 pt-1 text-[11px]">
              <a
                href={botLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 font-bold text-slate-400 hover:text-blue-400 transition-colors"
              >
                <Send size={12} className="-rotate-45 text-blue-400" />
                <span>ورود مستقیم با ربات @{cleanBotUsername}</span>
              </a>
              {isPreviewMode && !showQuickReg && !needReg && (
                <button
                  type="button"
                  onClick={() => setShowQuickReg(true)}
                  className="font-bold text-blue-400 hover:underline"
                >
                  حساب آزمایشی
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2.5 text-right">
              <div className="flex items-center justify-between px-1">
                <label className="text-xs font-black text-emerald-400">
                  کد تایید ۶ رقمی
                </label>
                <span dir="ltr" className="text-[11px] font-sans tabular-nums text-slate-400">
                  {loginPhone || phone}
                </span>
              </div>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                dir="ltr"
                placeholder="------"
                value={code}
                onChange={(e) => {
                  const clean = normalizeDigits(e.target.value).replace(/[^0-9]/g, '').slice(0, 6);
                  setCode(clean);
                  setError('');
                  if (clean.length < 6) {
                    autoSubmittedCodeRef.current = '';
                  } else if (clean.length === 6 && autoSubmittedCodeRef.current !== clean && !isLoading) {
                    void submitOtp(clean);
                  }
                }}
                onKeyDown={(e) => e.key === 'Enter' && void submitOtp()}
                disabled={isLoading}
                className={`w-full h-14 !bg-[#0c111c] border rounded-2xl text-center font-sans tabular-nums text-2xl font-black tracking-[0.5em] outline-none transition-all !text-white placeholder:!text-slate-600 disabled:opacity-50 ${
                  error
                    ? '!border-rose-500 ring-4 ring-rose-500/15'
                    : '!border-white/[0.1] focus:!border-blue-500/60 focus:!bg-[#111827]'
                }`}
              />

              {previewOtp && (
                <div className="p-3 bg-white/[0.05] border border-white/[0.08] rounded-2xl flex items-center justify-between gap-2 text-right">
                  <div>
                    <p className="text-[10px] font-black text-blue-400">کد آزمایشی پیش‌نمایش</p>
                    <p className="text-xs font-mono font-black text-white tracking-widest mt-0.5">
                      {previewOtp}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const cleanPreview = normalizeDigits(previewOtp).replace(/[^0-9]/g, '').slice(0, 6);
                      setCode(cleanPreview);
                      setError('');
                      if (cleanPreview.length === 6 && !isLoading) {
                        void submitOtp(cleanPreview);
                      }
                    }}
                    className="h-8 px-3 bg-blue-600 text-white rounded-lg text-[10px] font-black active:scale-95 transition-all"
                  >
                    درج و ورود
                  </button>
                </div>
              )}

              {error && (
                <div className="p-3.5 bg-rose-500/12 border border-rose-500/25 rounded-2xl flex items-center gap-2.5 text-right">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <p className="text-xs font-bold text-rose-400 flex-1">{error}</p>
                  <button
                    onClick={() => {
                      setError('');
                      setCode('');
                      autoSubmittedCodeRef.current = '';
                    }}
                    className="text-[11px] font-bold text-slate-300 hover:text-white"
                  >
                    پاک کردن
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={() => void submitOtp()}
              disabled={isLoading || code.length < 6}
              className="w-full h-13 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-black text-sm border border-white/10 shadow-[0_10px_24px_-8px_rgba(16,185,129,0.45)] active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                'تایید و ورود'
              )}
            </button>

            <div className="flex items-center justify-between gap-2 pt-1 text-[11px]">
              <button
                type="button"
                disabled={isLoading}
                onClick={resendOtp}
                className="text-blue-400 font-bold hover:underline disabled:opacity-50"
              >
                ارسال مجدد کد
              </button>
              <button
                type="button"
                onClick={() => {
                  setCode('');
                  setError('');
                  onResetPhone();
                }}
                className="text-slate-400 font-bold hover:text-white transition-colors"
              >
                تغییر شماره همراه
              </button>
            </div>
          </>
        )}
      </div>

      {/* Quick QR / Contract Code Entry Before Login */}
      <button
        type="button"
        onClick={() => document.dispatchEvent(new CustomEvent('open-qr-scanner'))}
        className="w-full h-12 mt-3 rounded-2xl bg-gradient-to-b from-[#0d1526] to-[#070b14] border border-amber-500/35 hover:border-amber-400/60 text-amber-300 text-xs font-black flex items-center justify-center gap-2 shadow-[0_14px_30px_-14px_rgba(0,0,0,0.65)] transition-all active:scale-[0.98]"
      >
        <QrCode size={16} />
        <span>کد معامله یا QR دارید؟ مشاهده و امضای قرارداد</span>
      </button>

      {/* Bottom Support & About Quick Actions */}
      <div className="grid grid-cols-2 gap-3 mt-3">
        <button
          type="button"
          onClick={onOpenSupport}
          className="h-12 rounded-2xl bg-gradient-to-b from-[#080b12] to-[#040509] border border-slate-900 dark:border-white/[0.08] hover:border-blue-500/40 text-slate-200 text-xs font-black flex items-center justify-center gap-2 shadow-[0_14px_30px_-14px_rgba(0,0,0,0.65)] transition-all active:scale-95"
        >
          <MessageSquare size={15} className="text-blue-400" />
          <span>پشتیبانی</span>
        </button>
        <button
          type="button"
          onClick={onOpenAbout}
          className="h-12 rounded-2xl bg-gradient-to-b from-[#080b12] to-[#040509] border border-slate-900 dark:border-white/[0.08] hover:border-blue-500/40 text-slate-200 text-xs font-black flex items-center justify-center gap-2 shadow-[0_14px_30px_-14px_rgba(0,0,0,0.65)] transition-all active:scale-95"
        >
          <Info size={15} className="text-blue-400" />
          <span>درباره ما</span>
        </button>
      </div>
    </motion.div>
  );
}

function EscrowBalanceCard({
  availableBalance,
  lockedBalance,
  pendingWithdrawTotal = 0,
  walletBalance,
  onDeposit,
  onWithdraw,
  onCardClick,
}: {
  availableBalance: number;
  lockedBalance: number;
  pendingWithdrawTotal?: number;
  walletBalance: number;
  onDeposit: () => void;
  onWithdraw: () => void;
  onCardClick?: () => void;
}) {
  return (
    <div
      onClick={onCardClick}
      className={`rounded-3xl bg-gradient-to-br from-[#121629] via-[#101425] to-[#0b0f1c] border border-slate-800/80 dark:border-white/[0.08] p-6 md:p-7 text-white shadow-[0_16px_38px_-12px_rgba(11,15,28,0.45)] dark:shadow-[0_14px_34px_-12px_rgba(0,0,0,0.65)] ${
        onCardClick ? 'cursor-pointer' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
        <span className="text-xs font-bold text-slate-400">موجودی قابل برداشت کیف پول</span>
        {lockedBalance > 0 || pendingWithdrawTotal > 0 ? (
          <div className="flex items-center gap-2.5 flex-wrap">
            {lockedBalance > 0 && (
              <span className="text-[11px] font-bold text-amber-400/90 tabular-nums">
                در امانت: {lockedBalance.toLocaleString()} تومان
              </span>
            )}
            {pendingWithdrawTotal > 0 && (
              <span className="text-[11px] font-bold text-sky-400/90 tabular-nums">
                در انتظار برداشت: {pendingWithdrawTotal.toLocaleString()} تومان
              </span>
            )}
          </div>
        ) : onCardClick ? (
          <span className="text-[11px] font-bold text-slate-400 flex items-center gap-0.5 hover:text-white transition-colors">
            کیف پول <ChevronLeft size={14} />
          </span>
        ) : null}
      </div>

      <div className="flex items-baseline gap-2.5">
        <span className="text-3xl md:text-4xl font-black text-white tabular-nums tracking-tight leading-none">
          {availableBalance.toLocaleString()}
        </span>
        <span className="text-xs md:text-sm font-bold text-emerald-400">تومان</span>
      </div>

      {walletBalance !== availableBalance && (
        <p className="text-[11px] text-slate-400 mt-2 tabular-nums">
          موجودی کل حساب: {walletBalance.toLocaleString()} تومان
        </p>
      )}

      <div className="border-t border-white/[0.08] my-5" />

      <div className="grid grid-cols-2 gap-3" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onDeposit}
          className="h-12 rounded-xl bg-[#0d9466] hover:bg-[#059669] text-white font-bold text-xs md:text-sm flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
        >
          <Plus size={16} />
          <span>واریز و ارسال فیش</span>
        </button>
        <button
          type="button"
          onClick={onWithdraw}
          className="h-12 rounded-xl bg-white/[0.06] hover:bg-white/[0.11] border border-white/[0.08] text-slate-100 font-bold text-xs md:text-sm flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
        >
          <ArrowUpRight size={16} />
          <span>درخواست برداشت</span>
        </button>
      </div>
    </div>
  );
}

function DashboardView({
  user,
  contracts,
  setView,
  onOpenRules,
  onOpenWalletAction,
  showPushBanner,
  onEnablePush,
  onDismissPushBanner,
}: any) {
  const activeCount = contracts.filter((c: any) => !['completed', 'cancelled'].includes(c.status)).length;
  const walletBalance = Number(user?.wallet_balance ?? 0);
  const lockedBalance = Number(user?.escrow_locked_balance ?? 0);
  const pendingWithdrawTotal = Number(user?.pending_withdraw_total ?? 0);
  const availableBalance = getAvailableBalance(user);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-5 md:space-y-6">
      {/* Browser Push Opt-In Banner */}
      {showPushBanner && (
        <div className="p-4 rounded-2xl bg-blue-600/10 border border-blue-500/25 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
              <Bell size={18} />
            </div>
            <div className="min-w-0">
              <h3 className="text-xs font-black text-slate-900 dark:text-white">فعال‌سازی اعلان لحظه‌ای مرورگر</h3>
              <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                تغییرات وضعیت قراردادها و پیام‌های جدید را حتی در پس‌زمینه فوراً دریافت کنید.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onEnablePush}
              className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black active:scale-95 transition-all"
            >
              فعال‌سازی
            </button>
            <button
              type="button"
              onClick={onDismissPushBanner}
              className="h-9 px-3 rounded-xl bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300 text-xs font-bold"
            >
              بعداً
            </button>
          </div>
        </div>
      )}

      {/* Welcome Brief */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 md:w-11 md:h-11 rounded-2xl bg-blue-600 flex items-center justify-center text-white shrink-0 overflow-hidden">
            {user?.avatar_url ? (
              <img src={user.avatar_url} alt={user.full_name || 'کاربر'} className="w-full h-full object-cover" />
            ) : (
              <ShieldCheck className="w-5 h-5" />
            )}
          </div>
          <div>
            <h2 className="text-sm md:text-base font-black text-slate-900 dark:text-white">خوش آمدید، {user?.full_name || 'کاربر میانجی'}</h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-medium">
              {user?.kyc_status === 'verified' ? 'حساب احراز هویت شده' : 'حساب کاربری فعال'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setView('wallet')}
          className="hidden sm:flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-[#131924] border border-slate-200/80 dark:border-white/[0.07] text-xs font-bold text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
        >
          <Wallet size={14} />
          <span>کیف پول</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Clean Suggested Balance Card */}
        <div className="lg:col-span-8">
          <EscrowBalanceCard
            availableBalance={availableBalance}
            lockedBalance={lockedBalance}
            pendingWithdrawTotal={pendingWithdrawTotal}
            walletBalance={walletBalance}
            onDeposit={() => (onOpenWalletAction ? onOpenWalletAction('deposit') : setView('wallet'))}
            onWithdraw={() => (onOpenWalletAction ? onOpenWalletAction('withdraw') : setView('wallet'))}
            onCardClick={() => setView('wallet')}
          />
        </div>

        {/* Quick Stats Banner */}
        <div className="lg:col-span-4 grid grid-cols-3 lg:grid-cols-1 gap-2.5">
          <StatCard label="معامله فعال" value={activeCount} />
          <StatCard label="تراکنش کل" value={contracts.length} />
          <button
            onClick={() => setView('support')}
            className="p-3.5 md:p-4 card-obsidian card-obsidian-interactive flex flex-col items-center justify-center text-center gap-0.5"
          >
            <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">پشتیبانی</span>
            <span className="text-xs font-black text-emerald-500">آنلاین · ۲۴/۷</span>
          </button>
        </div>
      </div>

      {/* Features Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FeatureCard
          icon={<Plus className="text-blue-600 dark:text-blue-400" />}
          label="معامله جدید"
          desc="ایجاد قرارداد امن میانجی"
          onClick={() => setView('create')}
        />
        <FeatureCard
          icon={<QrCode className="text-amber-500" />}
          label="اسکن QR یا کد معامله"
          desc="مشاهده و امضا قبل از پیوستن"
          onClick={() => document.dispatchEvent(new CustomEvent('open-qr-scanner'))}
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
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-base md:text-lg font-black text-slate-900 dark:text-white">آخرین معاملات</h2>
          <button onClick={() => setView('deals')} className="text-xs font-bold text-blue-600 dark:text-slate-300 hover:text-blue-700 dark:hover:text-white transition-colors min-h-[38px] px-3.5 rounded-xl card-obsidian">
            مشاهده همه
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
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
            <div className="md:col-span-2 lg:col-span-3 p-8 text-center rounded-2xl card-obsidian">
              <ClipboardList size={32} className="mx-auto text-slate-400 dark:text-slate-500 mb-3" />
              <p className="text-xs font-bold text-slate-600 dark:text-slate-300">هنوز هیچ معامله‌ای ثبت نکرده‌اید</p>
              <button
                onClick={() => setView('create')}
                className="mt-4 px-4 py-2 rounded-xl bg-blue-600 text-white font-bold text-xs"
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
    <div className="p-3.5 md:p-4 card-obsidian card-obsidian-interactive flex flex-col items-center justify-center text-center gap-0.5">
      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">{label}</span>
      <span className="text-xl md:text-2xl font-black text-slate-900 dark:text-white tabular-nums">{value}</span>
    </div>
  );
}

function FeatureCard({ icon, label, desc, onClick }: any) {
  return (
    <button
      onClick={onClick}
      className="p-3.5 md:p-4 card-obsidian card-obsidian-interactive text-right space-y-2.5 active:scale-95 group flex flex-col items-end w-full"
    >
      <div className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-white/[0.06] border border-slate-200/70 dark:border-white/[0.06] flex items-center justify-center shrink-0">
        {React.cloneElement(icon, { size: 15 })}
      </div>
      <div>
        <h3 className="text-xs font-black text-slate-900 dark:text-white">{label}</h3>
        <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400 leading-tight line-clamp-1 mt-0.5">{desc}</p>
      </div>
    </button>
  );
}

function DealDetailView({
  user,
  setUser,
  contracts,
  setView,
  refresh,
  isDebug,
  notify,
  botUsername,
  onOpenDirectChat,
  onDealUpdated,
}: any) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [activeTab, setActiveTab] = useState<'info' | 'chat'>('info');
  const [showQr, setShowQr] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingModal, setPendingModal] = useState<{
    status: 'work_submitted' | 'active' | 'revisions_requested' | 'in_dispute' | 'disputed';
    milestoneId?: string;
    milestoneAction?: 'submit' | 'revision';
    title: string;
    placeholder: string;
    submitLabel: string;
  } | null>(null);
  const [noteInput, setNoteInput] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reviewScore, setReviewScore] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [pendingActionConfirm, setPendingActionConfirm] = useState<{
    title: string;
    description: string;
    previewText?: string;
    confirmLabel: string;
    tone: 'danger' | 'warning' | 'primary';
    run: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('selected_contract');
    if (saved) {
      try {
        setContract(JSON.parse(saved));
      } catch {}
    }

    const offDeal = realtimeClient.on('deal:updated', (payload: any) => {
      if (!payload?.contract) return;
      setContract((prev) => {
        if (!prev || prev.contract_id !== payload.contract.contract_id) return prev;
        localStorage.setItem('selected_contract', JSON.stringify(payload.contract));
        return payload.contract;
      });
    });
    return () => {
      offDeal();
    };
  }, []);

  useEffect(() => {
    if (!contract?.contract_id || !Array.isArray(contracts)) return;
    const fresh = contracts.find((c: Contract) => c.contract_id === contract.contract_id);
    if (fresh) {
      setContract(fresh);
      localStorage.setItem('selected_contract', JSON.stringify(fresh));
    }
  }, [contracts, contract?.contract_id]);

  useEffect(() => {
    const hasActiveCountdown =
      normalizeDealStatus(contract?.status) === 'work_submitted' ||
      (Array.isArray(contract?.milestones) &&
        contract.milestones.some((m) => normalizeMilestoneStatus(m.status) === 'work_submitted'));
    if (!hasActiveCountdown) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [contract?.status, contract?.milestones]);

  const handleTransitionSync = async (updatedDeal?: any, balances?: any) => {
    if (updatedDeal) {
      setContract(updatedDeal);
      localStorage.setItem('selected_contract', JSON.stringify(updatedDeal));
    }
    if (balances && user?.id && balances[String(user.id)] && setUser) {
      const b = balances[String(user.id)];
      setUser((prev: any) => {
        if (!prev) return prev;
        const nextUser = {
          ...prev,
          wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
          escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0),
        };
        localStorage.setItem('mianji_mock_user', JSON.stringify(nextUser));
        return nextUser;
      });
    }
    if (onDealUpdated) {
      await onDealUpdated(updatedDeal, balances);
    } else {
      await refresh();
    }
  };

  const scanQr = () => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.showScanQrPopup) {
      tg.showScanQrPopup({ text: 'کد QR قرارداد را اسکن کنید' }, (text: string) => {
        const parsed = extractDealInviteFromQr(text);
        if (parsed?.contractId && parsed.contractId.toUpperCase() === String(contract?.contract_id || '').toUpperCase()) {
          tg.closeScanQrPopup();
          const isBuyerNow = isUserDealBuyer(contract, user);
          const stNow = normalizeDealStatus(contract?.status);
          if ((stNow === 'draft' || stNow === 'pending_party_b') && isBuyerNow) {
            transitionEscrowContract(contract, 'awaiting_payment', handleTransitionSync, false, {
              note: 'تایید و امضای قرارداد با اسکن QR',
            })
              .then(() => notify('قرارداد تایید و آماده پرداخت شد.', 'success'))
              .catch(() => notify('قرارداد شناسایی شد.', 'info'));
          } else {
            notify('قرارداد با موفقیت شناسایی شد.', 'success');
          }
          return true;
        }
        return false;
      });
    } else {
      document.dispatchEvent(new CustomEvent('open-qr-scanner'));
    }
  };

  const actions: EscrowAction[] = contract
    ? getEscrowActions(contract, user || user?.id, handleTransitionSync, false)
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

  const uid = String(user?.id || '');
  const isBuyer = isUserDealBuyer(contract, user);
  const isSeller = isUserDealSeller(contract, user);
  const buyerPending = isPendingPartyId(contract.buyer_id);
  const sellerPending = isPendingPartyId(contract.seller_id);
  const isPendingInvite = Boolean(contract.is_pending_counterparty || buyerPending || sellerPending);
  const counterpartyId = isBuyer ? String(contract.seller_id || '') : String(contract.buyer_id || '');
  const buyerLabel = isBuyer
    ? 'شما'
    : buyerPending
    ? 'در انتظار پیوستن طرف مقابل'
    : contract.buyer_fullname || contract.buyer_name || contract.buyer?.full_name || 'کارفرما';
  const sellerLabel = isSeller
    ? 'شما'
    : sellerPending
    ? 'در انتظار پیوستن طرف مقابل'
    : contract.seller_fullname || contract.seller_name || contract.seller?.full_name || 'مجری';
  const availableBalance = getAvailableBalance(user);
  const amountNum = Number(contract.amount || 0);
  const canonicalStatus = normalizeDealStatus(contract.status);
  const breakdown = computeCommissionBreakdown(
    amountNum,
    Number(contract.fee_percent ?? DEFAULT_PLATFORM_FEE_PERCENT),
    contract.commission_payer
  );
  const employerPayable = Number(contract.employer_total_payable ?? breakdown.employerTotalPayable);
  const insufficientForEscrow =
    canonicalStatus === 'awaiting_payment' && isBuyer && availableBalance < employerPayable;
  const inviteUrl = buildDealInviteUrl(contract.contract_id, contract.invite_token);
  const botLink = contract.bot_link || buildTelegramBotDealLink(contract.contract_id, botUsername || 'mianji_ir_bot');
  const categoryMeta = getCategoryMeta(contract.category);
  const hasMilestones = Boolean(
    (contract.staged_payment ?? contract.is_milestone) &&
      Array.isArray(contract.milestones) &&
      contract.milestones.length >= 2
  );

  const handleActionClick = async (act: EscrowAction) => {
    if (act.label.includes('تحویل کار')) {
      setNoteInput('');
      setAttachmentUrl('');
      setPendingModal({
        status: 'work_submitted',
        title: 'ثبت تحویل کار و فایل نهایی',
        placeholder: 'توضیحات تحویل پروژه، لینک یا نکات بررسی برای کارفرما...',
        submitLabel: 'ارسال تحویل کار',
      });
      return;
    }
    if (act.label.includes('درخواست اصلاح')) {
      setNoteInput('');
      setAttachmentUrl('');
      setPendingModal({
        status: 'revisions_requested',
        title: 'ثبت درخواست اصلاحات',
        placeholder: 'موارد نیازمند اصلاح را به صورت شفاف برای مجری بنویسید...',
        submitLabel: 'ارسال درخواست اصلاحات',
      });
      return;
    }
    if (act.label.includes('گزارش اختلاف')) {
      setNoteInput('');
      setAttachmentUrl('');
      setPendingModal({
        status: 'in_dispute',
        title: 'ثبت اختلاف و ارجاع به داور میانجی',
        placeholder: 'شرح دقیق اختلاف یا تخلف برای بررسی تیم داوری...',
        submitLabel: 'ثبت رسمی اختلاف',
      });
      return;
    }

    if (act.label.includes('آزادسازی')) {
      setPendingActionConfirm({
        title: 'تایید نهایی و آزادسازی وجه',
        description:
          'با تایید شما، مبلغ قفل‌شده در حساب امانت به موجودی مجری واریز می‌شود و قرارداد بسته خواهد شد. این اقدام غیرقابل بازگشت است.',
        previewText: `${contract.title} — مبلغ: ${amountNum.toLocaleString()} تومان`,
        confirmLabel: 'بله، وجه آزاد شود',
        tone: 'warning',
        run: async () => {
          await act.action();
          notify('وضعیت قرارداد با موفقیت به‌روزرسانی و وجه آزاد شد', 'success');
        },
      });
      return;
    }

    if (act.label.includes('لغو')) {
      setPendingActionConfirm({
        title: 'لغو معامله',
        description: 'آیا از لغو دائمی این قرارداد مطمئن هستید؟ پس از لغو، امکان ادامه این قرارداد وجود نخواهد داشت.',
        previewText: `${contract.title} (${contract.contract_id})`,
        confirmLabel: 'بله، معامله لغو شود',
        tone: 'danger',
        run: async () => {
          await act.action();
          notify('قرارداد با موفقیت لغو شد', 'info');
        },
      });
      return;
    }

    if (act.label.includes('پرداخت') || act.label.includes('قفل وجه')) {
      setPendingActionConfirm({
        title: 'تایید پرداخت و قفل وجه امانی',
        description:
          'مبلغ قابل پرداخت از موجودی کیف پول شما کسر و تا پایان تحویل و تایید کار به صورت امن نزد میانجی قفل می‌ماند.',
        previewText: `${contract.title} — مبلغ قابل پرداخت: ${employerPayable.toLocaleString()} تومان`,
        confirmLabel: 'تایید و قفل وجه',
        tone: 'primary',
        run: async () => {
          await act.action();
          notify('وجه معامله با موفقیت در حساب امانت قفل شد', 'success');
        },
      });
      return;
    }

    setPendingActionConfirm({
      title: act.label,
      description: 'آیا از انجام این عملیات روی قرارداد مطمئن هستید؟',
      previewText: `${contract.title} — مبلغ: ${amountNum.toLocaleString()} تومان`,
      confirmLabel: 'تایید و ادامه',
      tone: act.variant === 'danger' ? 'danger' : 'primary',
      run: async () => {
        await act.action();
        notify('وضعیت قرارداد با موفقیت به‌روزرسانی شد', 'success');
      },
    });
  };

  const handleAttachmentSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAttachment(true);
    try {
      const uploadedUrl = await uploadMediaFile(file, file.name);
      if (uploadedUrl) {
        setAttachmentUrl(uploadedUrl);
        notify('فایل با موفقیت پیوست شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در آپلود فایل پیوست', 'error');
    } finally {
      setUploadingAttachment(false);
      e.target.value = '';
    }
  };

  const submitPendingModal = async () => {
    if (!pendingModal || !contract) return;
    if (noteInput.trim().length < 3 && !attachmentUrl) {
      notify('لطفاً توضیح کوتاه یا یک فایل پیوست ثبت کنید', 'error');
      return;
    }
    setActionBusy(true);
    try {
      if (pendingModal.milestoneId && pendingModal.milestoneAction) {
        await transitionMilestone(
          contract,
          pendingModal.milestoneId,
          pendingModal.milestoneAction,
          handleTransitionSync,
          {
            note: noteInput.trim() || undefined,
            attachment_url: attachmentUrl || undefined,
          }
        );
      } else {
        await transitionEscrowContract(
          contract,
          pendingModal.status,
          handleTransitionSync,
          false,
          {
            note: noteInput.trim() || undefined,
            attachment_url: attachmentUrl || undefined,
          }
        );
      }
      setPendingModal(null);
      setNoteInput('');
      setAttachmentUrl('');
      notify('وضعیت قرارداد و پیام سیستمی با موفقیت ثبت شد', 'success');
    } catch (err: any) {
      notify(err?.message || 'خطا در به‌روزرسانی قرارداد', 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const handleMilestoneDirectRelease = (msId: string, msTitle: string, msAmount?: number) => {
    if (!contract) return;
    setPendingActionConfirm({
      title: `آزادسازی مبلغ مرحله «${msTitle}»`,
      description:
        'با تایید شما، مبلغ این مرحله از حساب امانت آزاد و به موجودی مجری واریز می‌شود. این عملیات قابل بازگشت نیست.',
      previewText: msAmount ? `مبلغ مرحله: ${Number(msAmount).toLocaleString()} تومان` : undefined,
      confirmLabel: 'تایید و آزادسازی',
      tone: 'warning',
      run: async () => {
        await transitionMilestone(contract, msId, 'release', handleTransitionSync);
        notify(`مبلغ مرحله «${msTitle}» با موفقیت آزاد شد`, 'success');
      },
    });
  };

  const handleReviewSubmit = async () => {
    if (!contract) return;
    setSubmittingReview(true);
    try {
      await submitDealReview(contract.contract_id, reviewScore, reviewComment.trim(), handleTransitionSync);
      setReviewComment('');
      notify('امتیاز و دیدگاه شما با موفقیت ثبت شد', 'success');
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت امتیاز', 'error');
    } finally {
      setSubmittingReview(false);
    }
  };

  const formatCountdown = (iso?: string | null) => {
    if (!iso) return '';
    const diff = Math.max(0, Date.parse(iso) - nowMs);
    if (diff <= 0) return 'در آستانه آزادسازی خودکار...';
    const totalSec = Math.floor(diff / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5 h-full flex flex-col lg:max-w-6xl lg:mx-auto pb-8">
      {/* Header & Mobile Tab Switcher */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => setView('deals')}
          className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
        >
          <ChevronRight size={20} />
        </button>

        <div className="flex-1 flex justify-center lg:hidden">
          <div className="flex p-1 bg-white dark:bg-[#131924] rounded-2xl border border-slate-200/90 dark:border-white/[0.08] shadow-[0_8px_24px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
            <button
              onClick={() => setActiveTab('info')}
              className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${
                activeTab === 'info' ? 'bg-blue-600 text-white shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              جزئیات
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`px-6 py-2 rounded-xl text-[11px] font-black transition-all ${
                activeTab === 'chat' ? 'bg-blue-600 text-white shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'text-slate-600 dark:text-slate-300'
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
          {!isPendingInvite && counterpartyId && !isPendingPartyId(counterpartyId) && onOpenDirectChat && (
            <button
              onClick={() => onOpenDirectChat(counterpartyId)}
              title="گفتگوی مستقیم با طرف مقابل"
              className="h-10 px-3 rounded-xl card-obsidian flex items-center justify-center gap-1.5 text-[11px] font-black text-blue-600 dark:text-blue-400 active:scale-95"
            >
              <MessageCircle size={16} />
              <span className="hidden sm:inline">پیام مستقیم</span>
            </button>
          )}
          <button
            onClick={() => setShowQr(true)}
            className="w-10 h-10 rounded-xl card-obsidian flex items-center justify-center text-slate-700 dark:text-white active:scale-90"
            title="نمایش کد QR و لینک امضا"
          >
            <QrCode size={20} />
          </button>
        </div>
      </div>

      <div className="flex-1 lg:grid lg:grid-cols-12 lg:gap-6 min-h-0 overflow-hidden">
        {/* Info Column */}
        <div className={`lg:col-span-5 lg:flex lg:flex-col space-y-4 ${activeTab === 'info' ? 'block' : 'hidden lg:block'} overflow-y-auto pr-1`}>
          <div className="flex flex-col items-center gap-4 py-7 card-obsidian rounded-3xl relative overflow-hidden shrink-0">
            <div className="absolute top-0 left-0 w-full h-1.5 bg-slate-100 dark:bg-white/10">
              <div className="h-full bg-blue-600 dark:bg-white transition-all" style={{ width: getProgress(contract.status) }} />
            </div>
            <StatusIcon status={contract.status} />
            <div className="text-center px-4">
              <h1 className="text-lg font-black text-slate-900 dark:text-white mb-1">{contract.title}</h1>
              <span className="text-[10px] font-bold text-blue-600 dark:text-slate-300 uppercase tracking-widest">{contract.contract_id}</span>
              {isDebug && <p className="text-[10px] font-sans tabular-nums text-rose-400 mt-1">UUID: {contract.id || 'N/A'}</p>}
            </div>
            <StatusLabel status={contract.status} />
          </div>

          {(isPendingInvite || (['draft', 'pending_party_b'].includes(canonicalStatus) && contract.invite_token)) && (
            <div className="p-4 card-obsidian border-blue-500/35 dark:border-blue-400/30 space-y-3 shrink-0">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-blue-600/15 text-blue-600 dark:text-blue-300 flex items-center justify-center shrink-0">
                    <Link2 size={16} />
                  </div>
                  <div>
                    <h3 className="text-xs font-black text-slate-900 dark:text-white">
                      {isPendingInvite ? 'در انتظار پیوستن طرف مقابل (سایت یا ربات)' : 'دعوت و امضای همگام با ربات'}
                    </h3>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300 leading-snug">
                      {isPendingInvite
                        ? 'طرف دوم با لمس لینک ربات تلگرام یا اسکن QR مستقیم همین قرارداد را می‌بیند و امضا می‌کند.'
                        : 'امضا و پیگیری از طریق سایت یا ربات تلگرام میانجی کاملاً یکپارچه است.'}
                    </p>
                  </div>
                </div>
              </div>
              <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-2">
                <div className="text-right min-w-0">
                  <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300 block">کد معامله (برای مشاهده یا امضای نفر دوم)</span>
                  <span className="text-xs font-mono font-black text-slate-900 dark:text-white select-all" dir="ltr">
                    {contract.contract_id}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(String(contract.contract_id));
                      notify(`کد معامله ${contract.contract_id} کپی شد`, 'success');
                    } catch {
                      notify(String(contract.contract_id), 'info');
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 text-[10px] font-black flex items-center gap-1 shrink-0"
                >
                  <Copy size={12} />
                  <span>کپی کد</span>
                </button>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-100/80 dark:bg-black/25 border border-slate-200/70 dark:border-white/[0.08] flex items-center justify-between gap-2" dir="ltr">
                <span className="text-[10px] font-mono text-slate-700 dark:text-slate-200 truncate">{botLink}</span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(botLink);
                      notify('لینک مستقیم ربات تلگرام کپی شد', 'success');
                    } catch {
                      notify(botLink, 'info');
                    }
                  }}
                  className="px-2.5 py-1 rounded-lg bg-blue-600 text-white text-[10px] font-black shrink-0"
                >
                  کپی لینک ربات
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <a
                  href={botLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-9 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-black flex items-center justify-center gap-1 transition-colors"
                >
                  <ExternalLink size={13} />
                  <span>باز کردن در ربات</span>
                </a>
                <a
                  href={`https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(`🤝 دعوت به قرارداد امن میانجی (${contract.contract_id}): ${contract.title} — ${amountNum.toLocaleString()} تومان`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-9 rounded-xl bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-800 dark:text-white text-[11px] font-black flex items-center justify-center gap-1 transition-colors"
                >
                  <Share2 size={13} />
                  <span>اشتراک‌گذاری</span>
                </a>
                <button
                  type="button"
                  onClick={() => setShowQr(true)}
                  className="h-9 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-950 text-[11px] font-black flex items-center justify-center gap-1 transition-transform active:scale-95"
                >
                  <QrCode size={13} />
                  <span>QR و راهنما</span>
                </button>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(inviteUrl);
                    notify('لینک وب امضای قرارداد کپی شد', 'success');
                  } catch {
                    notify(inviteUrl, 'info');
                  }
                }}
                className="w-full h-8 rounded-xl bg-slate-100 dark:bg-white/5 hover:bg-slate-200 dark:hover:bg-white/10 text-slate-600 dark:text-slate-300 text-[10px] font-bold flex items-center justify-center gap-1.5"
              >
                <Copy size={12} />
                <span>کپی لینک مستقیم امضا در وب‌اپ</span>
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 shrink-0">
            <DetailItem label="بودجه پروژه" value={amountNum.toLocaleString()} unit="تومان" />
            <DetailItem label="وضعیت" value={translateStatus(contract.status)} color="text-blue-600 dark:text-blue-400" />
            <DetailItem label="دسته‌بندی" value={categoryMeta.label} />
            <DetailItem label="پرداخت‌کننده کارمزد" value={getCommissionPayerLabel(contract.commission_payer)} />
            <DetailItem
              label="کارفرما"
              value={
                <span className="inline-flex items-center gap-1.5 flex-wrap">
                  <span>{buyerLabel}</span>
                  {Number(contract.buyer_rating_count || 0) > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500">
                      <Star size={11} className="fill-amber-400 text-amber-400" />
                      {Number(contract.buyer_rating_avg || 0).toFixed(1)}
                    </span>
                  )}
                </span>
              }
            />
            <DetailItem
              label="مجری"
              value={
                <span className="inline-flex items-center gap-1.5 flex-wrap">
                  <span>{sellerLabel}</span>
                  {Number(contract.seller_rating_count || 0) > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500">
                      <Star size={11} className="fill-amber-400 text-amber-400" />
                      {Number(contract.seller_rating_avg || 0).toFixed(1)}
                    </span>
                  )}
                </span>
              }
            />
            {breakdown.feePercent > 0 && (
              <>
                <DetailItem
                  label={`کارمزد پلتفرم (${breakdown.feePercent}٪)`}
                  value={Number(contract.fee_amount ?? breakdown.totalFee).toLocaleString()}
                  unit="تومان"
                  color="text-amber-600 dark:text-amber-300"
                />
                <DetailItem
                  label="خالص دریافتی مجری"
                  value={Number(contract.net_seller_amount ?? breakdown.netSellerAmount).toLocaleString()}
                  unit="تومان"
                  color="text-emerald-600 dark:text-emerald-400"
                />
              </>
            )}
            <DetailItem
              label="مهلت تحویل و بررسی"
              value={`${contract.deadline || '۷'} روز · ${contract.inspection_hours ?? 24} ساعت بررسی`}
            />
            <DetailItem
              label="ویرایش رایگان"
              value={
                contract.free_edits_left !== undefined && contract.free_edits_total !== undefined
                  ? `${contract.free_edits_left} از ${contract.free_edits_total} باقی‌مانده`
                  : `${contract.free_edits ?? contract.revisions ?? '۰'} نوبت`
              }
            />
          </div>

          {(canonicalStatus === 'active' || canonicalStatus === 'revisions_requested') && (contract.delivery_due_at || contract.deadline) && (() => {
            const deadlineDays = Math.max(1, Math.min(365, Number(contract.deadline || 7) || 7));
            const createdMs = toMillis(contract.createdAt || contract.created_at) || nowMs;
            const dueIso = contract.delivery_due_at || new Date(createdMs + deadlineDays * 86400000).toISOString();
            const dueMs = Date.parse(dueIso);
            if (Number.isNaN(dueMs)) return null;
            const diffMs = dueMs - nowMs;
            const isOverdue = diffMs <= 0;
            const totalMin = Math.max(0, Math.floor(Math.abs(diffMs) / 60000));
            const days = Math.floor(totalMin / 1440);
            const hours = Math.floor((totalMin % 1440) / 60);
            const mins = totalMin % 60;
            return (
              <div
                className={`p-4 rounded-2xl border flex items-center justify-between gap-3 ${
                  isOverdue
                    ? 'bg-rose-500/10 border-rose-500/30'
                    : diffMs <= 24 * 3600 * 1000
                    ? 'bg-amber-500/10 border-amber-500/30'
                    : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Clock size={18} className={isOverdue ? 'text-rose-500 shrink-0' : diffMs <= 24 * 3600 * 1000 ? 'text-amber-500 shrink-0' : 'text-blue-500 shrink-0'} />
                  <div>
                    <span className="text-[11px] font-black text-slate-900 dark:text-white block">
                      {isOverdue ? 'مهلت تحویل به پایان رسیده است' : 'مهلت سررسید تحویل پروژه'}
                    </span>
                    <span className="text-[10px] text-slate-600 dark:text-slate-300">
                      {isOverdue
                        ? 'هشدار سررسید ارسال شده است؛ در چت هماهنگ یا در صورت نیاز داوری ثبت کنید.'
                        : 'یادآوری خودکار ۲۴ ساعت پیش از سررسید برای طرفین ارسال می‌شود.'}
                    </span>
                  </div>
                </div>
                <span
                  className={`text-xs font-black tabular-nums shrink-0 ${
                    isOverdue ? 'text-rose-500' : diffMs <= 24 * 3600 * 1000 ? 'text-amber-600 dark:text-amber-300' : 'text-slate-800 dark:text-white'
                  }`}
                >
                  {isOverdue ? `${days > 0 ? `${days} روز و ` : ''}${hours} ساعت تاخیر` : `${days > 0 ? `${days} روز و ` : ''}${hours} ساعت و ${mins} دقیقه`}
                </span>
              </div>
            );
          })()}

          {canonicalStatus === 'work_submitted' && !hasMilestones && contract.auto_release_at && (
            <div className="p-4 bg-blue-500/10 border border-blue-500/30 rounded-2xl flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Timer size={18} className="text-blue-600 dark:text-blue-300 shrink-0" />
                <div>
                  <span className="text-[11px] font-black text-slate-900 dark:text-white block">بازه بازرسی هوشمند کارفرما</span>
                  <span className="text-[10px] text-slate-600 dark:text-slate-300">
                    در صورت عدم ثبت اعتراض یا اصلاح تا پایان شمارشگر، وجه خودکار آزاد می‌شود.
                  </span>
                </div>
              </div>
              <span className="text-sm font-black font-mono text-blue-600 dark:text-blue-300 tabular-nums shrink-0" dir="ltr">
                {formatCountdown(contract.auto_release_at)}
              </span>
            </div>
          )}

          {hasMilestones && contract.milestones && (
            <div className="p-4 bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-2xl space-y-3 shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Layers size={15} className="text-blue-500" />
                  مراحل پرداخت قرارداد ({contract.milestones.filter((m) => normalizeMilestoneStatus(m.status) === 'completed').length}/{contract.milestones.length})
                </span>
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300">آزادسازی گام‌به‌گام</span>
              </div>
              <div className="space-y-2.5">
                {contract.milestones.map((ms, msIdx) => {
                  const msCanonical = normalizeMilestoneStatus(ms.status);
                  const { label: msStatusLabel, tone: msTone } = getMilestoneStatusMeta(ms.status);
                  const msOrder = ms.order ?? msIdx + 1;

                  return (
                    <div
                      key={ms.id}
                      className="p-3.5 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.08] space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-0.5 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[11px] font-black text-slate-900 dark:text-white">
                              {msOrder}. {ms.title}
                            </span>
                            <span className={`px-2 py-0.5 rounded-md text-[9px] font-black ${msTone}`}>
                              {msStatusLabel}
                            </span>
                          </div>
                          <span className="text-xs font-black text-emerald-600 dark:text-emerald-400 tabular-nums block">
                            {Number(ms.amount || 0).toLocaleString()} تومان
                          </span>
                        </div>
                        {msCanonical === 'work_submitted' && ms.auto_release_at && (
                          <span className="text-[11px] font-black font-mono text-amber-600 dark:text-amber-300 tabular-nums shrink-0" dir="ltr">
                            {formatCountdown(ms.auto_release_at)}
                          </span>
                        )}
                      </div>

                      {ms.delivery_note && (
                        <p className="text-[11px] text-slate-700 dark:text-slate-200 bg-white dark:bg-[#131924] p-2.5 rounded-lg border border-slate-200/60 dark:border-white/10">
                          📦 گزارش تحویل: {ms.delivery_note}
                        </p>
                      )}
                      {ms.delivery_attachment_url && (
                        <a
                          href={ms.delivery_attachment_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] font-black text-blue-600 dark:text-blue-300 hover:underline"
                        >
                          <ExternalLink size={12} />
                          مشاهده فایل پیوست مرحله
                        </a>
                      )}
                      {ms.revision_note && msCanonical !== 'completed' && (
                        <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 p-2 rounded-lg">
                          🔁 اصلاحیه درخواستی: {ms.revision_note}
                        </p>
                      )}

                      {(canonicalStatus === 'active' || canonicalStatus === 'revisions_requested') && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {isSeller && msCanonical === 'active' && (
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => {
                                setNoteInput('');
                                setAttachmentUrl('');
                                setPendingModal({
                                  status: 'work_submitted',
                                  milestoneId: ms.id,
                                  milestoneAction: 'submit',
                                  title: `تحویل مرحله ${msOrder}: ${ms.title}`,
                                  placeholder: 'توضیحات تحویل این مرحله برای کارفرما...',
                                  submitLabel: 'ارسال تحویل مرحله',
                                });
                              }}
                              className="h-9 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black active:scale-95 transition-all disabled:opacity-50"
                            >
                              تحویل مرحله
                            </button>
                          )}
                          {isBuyer && msCanonical === 'work_submitted' && (
                            <>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => handleMilestoneDirectRelease(ms.id, ms.title, Number(ms.amount || 0))}
                                className="h-9 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-black active:scale-95 transition-all disabled:opacity-50"
                              >
                                تایید و آزادسازی ({Number(ms.amount || 0).toLocaleString()} ت)
                              </button>
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => {
                                  setNoteInput('');
                                  setAttachmentUrl('');
                                  setPendingModal({
                                    status: 'active',
                                    milestoneId: ms.id,
                                    milestoneAction: 'revision',
                                    title: `درخواست اصلاح مرحله ${msOrder}`,
                                    placeholder: 'موارد نیازمند اصلاح در این مرحله را بنویسید...',
                                    submitLabel: 'ارسال درخواست اصلاح',
                                  });
                                }}
                                className="h-9 px-3.5 rounded-xl bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-slate-800 dark:text-white text-[11px] font-black active:scale-95 transition-all disabled:opacity-50"
                              >
                                درخواست اصلاح
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {insufficientForEscrow && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl space-y-3 text-right">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="space-y-1 flex-1">
                  <p className="text-xs font-black text-slate-900 dark:text-white">موجودی کیف پول برای قفل امانی کافی نیست</p>
                  <p className="text-[11px] text-slate-600 dark:text-slate-300 tabular-nums">
                    مبلغ قابل پرداخت: {employerPayable.toLocaleString()} تومان · موجودی قابل برداشت: {availableBalance.toLocaleString()} تومان · کسری: {Math.max(0, employerPayable - availableBalance).toLocaleString()} تومان
                  </p>
                </div>
              </div>
              <button
                onClick={() => setView('wallet')}
                className="w-full h-10 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all active:scale-95"
              >
                <Wallet size={15} />
                افزایش موجودی کیف پول
              </button>
            </div>
          )}

          {contract.description && (
            <div className="p-4 bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-2xl text-xs text-slate-700 dark:text-slate-200 leading-relaxed shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
              <span className="text-[10px] font-black text-blue-600 dark:text-white block mb-1">شرایط قرارداد:</span>
              {contract.description}
            </div>
          )}

          {(contract.delivery_note || contract.delivery_attachment_url) && (
            <div className="p-4 bg-purple-500/10 border border-purple-500/25 rounded-2xl text-xs space-y-2">
              <span className="text-[10px] font-black text-purple-600 dark:text-purple-300 block">گزارش و فایل تحویل کار:</span>
              {contract.delivery_note && <p className="text-slate-800 dark:text-slate-100 leading-relaxed">{contract.delivery_note}</p>}
              {contract.delivery_attachment_url && (
                <a
                  href={contract.delivery_attachment_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11px] font-black text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <ExternalLink size={13} />
                  مشاهده فایل تحویلی پیوست‌شده
                </a>
              )}
            </div>
          )}

          {contract.revision_note && (
            <div className="p-4 bg-amber-500/10 border border-amber-500/25 rounded-2xl text-xs space-y-1">
              <span className="text-[10px] font-black text-amber-600 dark:text-amber-300 block">توضیحات اصلاحیه کارفرما:</span>
              <p className="text-slate-800 dark:text-slate-100 leading-relaxed">{contract.revision_note}</p>
            </div>
          )}

          {canonicalStatus === 'completed' && (
            <div className="p-4 bg-white dark:bg-[#131924] border border-amber-500/35 rounded-2xl space-y-3 shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Star size={15} className="fill-amber-400 text-amber-400" />
                  امتیازدهی و بازخورد معامله
                </span>
                {Array.isArray(contract.reviews) && contract.reviews.length > 0 && (
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300">
                    {contract.reviews.length} نظر ثبت‌شده
                  </span>
                )}
              </div>

              {Array.isArray(contract.reviews) && contract.reviews.length > 0 && (
                <div className="space-y-2">
                  {contract.reviews.map((rev) => (
                    <div key={rev.id} className="p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/10 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-black text-slate-800 dark:text-white">{rev.reviewer_name}</span>
                        <span className="text-[11px] font-black text-amber-500 flex items-center gap-0.5">
                          <Star size={12} className="fill-amber-400 text-amber-400" />
                          {rev.score} از ۵
                        </span>
                      </div>
                      {rev.comment && <p className="text-[11px] text-slate-600 dark:text-slate-300">{rev.comment}</p>}
                    </div>
                  ))}
                </div>
              )}

              {(isBuyer || isSeller) && !(contract.reviews || []).some((r) => String(r.reviewer_id) === uid) && (
                <div className="pt-2 border-t border-slate-100 dark:border-white/10 space-y-2.5">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 block">
                    امتیاز شما به {isBuyer ? 'مجری' : 'کارفرما'}:
                  </span>
                  <div className="flex items-center gap-1.5">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setReviewScore(s)}
                        className="p-1.5 rounded-lg hover:bg-amber-500/10 transition-colors"
                      >
                        <Star
                          size={22}
                          className={s <= reviewScore ? 'fill-amber-400 text-amber-400' : 'text-slate-300 dark:text-slate-600'}
                        />
                      </button>
                    ))}
                  </div>
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    placeholder="نظر کوتاه درباره کیفیت انجام کار یا خوش‌قولی طرف مقابل (اختیاری)..."
                    className="w-full p-3 rounded-xl bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] font-sans text-[14px] font-medium text-slate-900 dark:text-white outline-none focus:border-blue-500 resize-none leading-relaxed"
                  />
                  <button
                    type="button"
                    disabled={submittingReview}
                    onClick={handleReviewSubmit}
                    className="w-full h-10 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-xl text-xs font-black active:scale-95 transition-all disabled:opacity-50"
                  >
                    {submittingReview ? 'در حال ثبت...' : 'ثبت امتیاز و نظر'}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="pt-1 space-y-2.5 shrink-0">
            <button
              onClick={scanQr}
              className="w-full h-13 bg-slate-900 dark:bg-white text-white dark:text-black border border-white/15 dark:border-white rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
            >
              <Camera size={18} />
              امضای حضوری (اسکن QR)
            </button>
            {actions.map((act, idx) => (
              <button
                key={idx}
                disabled={actionBusy}
                onClick={() => handleActionClick(act)}
                className={`w-full h-13 rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 disabled:opacity-50 ${
                  act.variant === 'primary'
                    ? 'bg-blue-600 text-white border border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
                    : act.variant === 'danger'
                    ? 'bg-rose-500/15 text-rose-500 border border-rose-400/50 dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
                    : 'bg-white dark:bg-[#131924] text-slate-800 dark:text-white border border-slate-200/90 dark:border-white/[0.08] shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
                }`}
              >
                {act.label}
              </button>
            ))}
          </div>

          {Array.isArray(contract.timeline) && contract.timeline.length > 0 && (
            <div className="p-4 bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-2xl space-y-3 shadow-[0_10px_28px_-6px_rgba(15,23,42,0.08)]">
              <span className="text-[10px] font-black text-slate-500 dark:text-slate-300 block">تاریخچه مراحل قرارداد</span>
              <div className="space-y-2.5">
                {[...contract.timeline].reverse().map((ev, i) => (
                  <div key={ev.id || i} className="flex items-start gap-2.5 text-right border-r-2 border-blue-500/40 pr-2.5">
                    <div className="flex-1 space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-black text-slate-900 dark:text-white">
                          {ev.status ? translateStatus(ev.status) : 'رویداد قرارداد'}
                          {ev.actor_name ? ` · ${ev.actor_name}` : ''}
                        </span>
                        <span className="text-[9px] text-slate-400 tabular-nums">{formatDateTimeFa(ev.timestamp)}</span>
                      </div>
                      {ev.note && <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">{ev.note}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Telegram-Style Contract Chat Column */}
        <div className={`lg:col-span-7 h-[64vh] lg:h-[72vh] ${activeTab === 'chat' ? 'block' : 'hidden lg:block'}`}>
          <TelegramChatRoom
            mode="contract"
            chatId={contract.contract_id}
            counterpartyId={counterpartyId}
            title={contract.title}
            subtitle={`${translateStatus(contract.status)} · ${amountNum.toLocaleString()} تومان`}
            avatarChar={contract.title?.[0] || 'C'}
            isOnline={canonicalStatus === 'active' || canonicalStatus === 'work_submitted' || canonicalStatus === 'revisions_requested'}
            contract={contract}
            contracts={contracts}
            user={user}
            onOpenDealById={(cid: string) => {
              const found = (contracts || []).find((c: Contract) => c.contract_id === cid);
              if (found) {
                setContract(found);
                localStorage.setItem('selected_contract', JSON.stringify(found));
              }
            }}
            onDealUpdated={handleTransitionSync}
            notify={notify}
            fullHeightClass="h-full"
          />
        </div>
      </div>

      {(isDisputedStatus(contract.status) || Boolean(contract.resolution) || Boolean(contract.appeal) || (contract.timeline || []).some((t) => t.type === 'verdict' || isDisputedStatus(t.status))) && (
        <div className="p-4 bg-white dark:bg-[#131924] border border-rose-400/50 rounded-2xl flex items-center justify-between gap-4 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white ${isDisputedStatus(contract.status) ? 'bg-rose-500' : 'bg-amber-500'}`}>
              <Gavel size={20} />
            </div>
            <div>
              <p className="text-xs font-black text-slate-900 dark:text-white">
                {isDisputedStatus(contract.status)
                  ? 'اختلاف ثبت شده است'
                  : contract.appeal?.status === 'pending'
                  ? 'درخواست تجدیدنظر در حال بررسی است'
                  : 'پرونده داوری و رأی نهایی'}
              </p>
              <p className="text-[10px] text-rose-600 dark:text-rose-300">
                {isDisputedStatus(contract.status)
                  ? contract.dispute_reason || 'در حال بررسی توسط داور میانجی'
                  : 'مشاهده جزئیات رأی داور یا ثبت درخواست تجدیدنظر'}
              </p>
            </div>
          </div>
          <button
            onClick={() => setView('dispute')}
            className="px-5 py-2.5 bg-rose-600 text-white border border-white/15 rounded-xl text-[11px] font-black active:scale-95 transition-all shrink-0"
          >
            {isDisputedStatus(contract.status) ? 'مرکز حل اختلاف' : 'پرونده داوری / تجدیدنظر'}
          </button>
        </div>
      )}

      {/* Delivery / Revision / Dispute Modal */}
      <AnimatePresence>
        {pendingModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/80 backdrop-blur-md z-[300] flex items-center justify-center p-6">
            <div className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-6 space-y-4 relative shadow-2xl">
              <button
                onClick={() => setPendingModal(null)}
                className="absolute top-5 left-5 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
              >
                <X size={18} />
              </button>
              <h3 className="text-base font-black text-slate-900 dark:text-white text-right pt-1">{pendingModal.title}</h3>
              <textarea
                rows={4}
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder={pendingModal.placeholder}
                className="w-full p-3.5 rounded-2xl bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] font-sans text-[14px] font-medium text-slate-900 dark:text-white outline-none focus:border-blue-500 resize-none leading-relaxed"
              />
              {pendingModal.status === 'work_submitted' && (
                <div className="flex items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08]">
                  <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 truncate">
                    {attachmentUrl ? 'فایل خروجی پیوست شد' : uploadingAttachment ? 'در حال آپلود...' : 'پیوست فایل تحویل (اختیاری)'}
                  </span>
                  <label className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-[10px] font-black cursor-pointer shrink-0">
                    انتخاب فایل
                    <input type="file" className="hidden" onChange={handleAttachmentSelect} disabled={uploadingAttachment} />
                  </label>
                </div>
              )}
              <button
                onClick={submitPendingModal}
                disabled={actionBusy || uploadingAttachment}
                className={`w-full h-12 rounded-xl font-black text-xs text-white transition-all active:scale-95 disabled:opacity-50 ${
                  isDisputedStatus(pendingModal.status) ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {actionBusy ? 'در حال ثبت...' : pendingModal.submitLabel}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* QR Code Modal */}
      <AnimatePresence>
        {showQr && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowQr(false)}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4 sm:p-6 overflow-y-auto"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm card-obsidian rounded-3xl p-6 text-center space-y-4 relative"
            >
              <button onClick={() => setShowQr(false)} className="absolute top-4 left-4 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white">
                <X size={18} />
              </button>
              <div className="pt-4">
                <div className="p-4 bg-white rounded-3xl inline-block shadow-lg border border-slate-100">
                  <QRCodeSVG value={inviteUrl} size={188} />
                </div>
              </div>
              <div className="space-y-1.5">
                <h3 className="text-base font-black text-slate-900 dark:text-white">کد QR و شناسه امضای قرارداد</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
                  نفر دوم می‌تواند این QR را با دوربین یا اسکنر میانجی اسکن کند، یا پیش از پیوستن، با وارد کردن کد معامله زیر جزئیات قرارداد را ببیند و امضا نماید.
                </p>
              </div>

              <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-2">
                <div className="text-right">
                  <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300 block">کد معامله</span>
                  <span className="text-xs font-mono font-black text-slate-900 dark:text-white select-all" dir="ltr">
                    {contract.contract_id}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(String(contract.contract_id));
                      notify('کد معامله کپی شد', 'success');
                    } catch {}
                  }}
                  className="h-8 px-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-[11px] font-black flex items-center gap-1"
                >
                  <Copy size={12} />
                  <span>کپی کد</span>
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(inviteUrl);
                      notify('لینک مستقیم وب کپی شد', 'success');
                    } catch {}
                  }}
                  className="h-10 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Copy size={13} />
                  <span>کپی لینک وب</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(botLink);
                      notify('لینک مستقیم ربات تلگرام کپی شد', 'success');
                    } catch {}
                  }}
                  className="h-10 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-black flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Send size={13} />
                  <span>کپی لینک ربات</span>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={Boolean(pendingActionConfirm)}
        title={pendingActionConfirm?.title || 'تایید عملیات'}
        description={pendingActionConfirm?.description}
        previewText={pendingActionConfirm?.previewText}
        confirmLabel={pendingActionConfirm?.confirmLabel || 'تایید و ادامه'}
        cancelLabel="انصراف"
        tone={pendingActionConfirm?.tone || 'primary'}
        busy={actionBusy}
        onCancel={() => {
          if (!actionBusy) setPendingActionConfirm(null);
        }}
        onConfirm={async () => {
          if (!pendingActionConfirm) return;
          setActionBusy(true);
          try {
            await pendingActionConfirm.run();
            setPendingActionConfirm(null);
          } catch (e: any) {
            notify(e?.message || 'خطا در به‌روزرسانی وضعیت قرارداد', 'error');
          } finally {
            setActionBusy(false);
          }
        }}
      />
    </motion.div>
  );
}

// --- Helpers & Small Components ---

function Sidebar({ isOpen, onClose, user, setView, onLogout, onOpenModal, onOpenQuickCall }: any) {
  const menuItems: { icon: React.ReactNode; label: string; action: () => void; badge?: string; disabled?: boolean }[] = [
    ...(user?.role === 'owner' || user?.role === 'admin'
      ? [{ icon: <Shield />, label: 'پنل مدیریت و پشتیبانی', action: () => setView('admin') }]
      : []),
    { icon: <User />, label: 'پروفایل کاربری', action: () => setView('profile') },
    { icon: <CreditCard />, label: 'تراکنش‌های مالی', action: () => setView('wallet') },
    { icon: <Sparkles />, label: 'بازارچه میانجی', action: () => setView('marketplace') },
    { icon: <Phone />, label: 'تماس صوتی و تصویری', action: () => onOpenQuickCall?.() },
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
            className="fixed top-0 right-0 bottom-0 w-[75%] max-w-xs bg-white dark:bg-[#111722] border-l border-slate-200/90 dark:border-white/[0.07] z-[1001] p-4 flex flex-col shadow-[-16px_0_40px_rgba(15,23,42,0.12)] dark:shadow-[-16px_0_40px_rgba(0,0,0,0.6)]"
          >
            <div className="flex items-center justify-between mb-6 px-1">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl overflow-hidden ring-1 ring-slate-900/10 dark:ring-white/15 bg-[#0b0f17] shrink-0">
                  <img
                    src="/pwa-192x192.png"
                    alt="میانجی"
                    className="w-full h-full object-contain"
                  />
                </div>
                <span className="font-black text-sm text-slate-900 dark:text-white transition-colors">منوی اصلی</span>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-white/[0.06] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-slate-200 active:scale-90 transition-all"
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
                      : 'hover:bg-slate-100 dark:hover:bg-white/[0.05] text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white active:scale-[0.98]'
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-lg bg-slate-50 dark:bg-white/[0.05] border border-slate-200/80 dark:border-white/[0.07] flex items-center justify-center text-blue-600 dark:text-slate-200 transition-colors ${
                      !item.disabled && 'group-hover:bg-blue-600 group-hover:text-white group-hover:border-blue-600'
                    }`}
                  >
                    {React.cloneElement(item.icon as any, { size: 16 })}
                  </div>
                  <div className="flex-1 text-right">
                    <span className="text-[11px] font-bold block leading-none">{item.label}</span>
                    {item.badge && <span className="text-[10px] font-black text-blue-500 uppercase tracking-tight mt-1 block">{item.badge}</span>}
                  </div>
                </button>
              ))}
            </div>

            <div className="pt-5 border-t border-slate-100 dark:border-white/[0.07] space-y-4">
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-[#18202e] flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black text-sm border border-white/10 overflow-hidden shrink-0">
                  {user?.avatar_url ? (
                    <img src={user.avatar_url} alt={user.full_name || 'آواتار'} className="w-full h-full object-cover" />
                  ) : (
                    user?.full_name?.[0] || 'U'
                  )}
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-black text-slate-900 dark:text-white truncate transition-colors">{user?.full_name || 'کاربر مهمان'}</p>
                  <p className="text-[9px] text-slate-500 dark:text-slate-400 font-mono" dir="ltr">
                    {user?.phone_number}
                  </p>
                </div>
              </div>
              <PWAInstallButton variant="sidebar" />
              <button
                onClick={() => {
                  onLogout();
                  onClose();
                }}
                className="w-full h-11 rounded-xl bg-rose-500/10 text-rose-500 font-bold text-xs flex items-center justify-center gap-2 active:scale-95 transition-all border border-rose-500/15"
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
    <button onClick={onClick} className={`flex flex-col items-center gap-1.5 transition-all ${active ? 'text-blue-600 dark:text-white' : 'text-slate-500 dark:text-slate-400'}`}>
      <div className={`transition-all duration-300 ${active ? 'scale-110 -translate-y-1' : 'opacity-80'}`}>{icon}</div>
      <span className={`text-[10px] font-black transition-all ${active ? 'opacity-100' : 'opacity-75'}`}>{label}</span>
      {active && <motion.div layoutId="nav-dot" className="w-1 h-1 bg-blue-600 dark:bg-white rounded-full" />}
    </button>
  );
}

function DealCard({ contract, onClick }: { contract: Contract; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full p-4 md:p-5 card-obsidian card-obsidian-interactive rounded-2xl text-right flex justify-between items-center group active:scale-[0.98]"
    >
      <div className="space-y-1 text-right min-w-0 pl-2">
        <h3 className="text-sm font-black text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-300 transition-colors truncate">{contract.title}</h3>
        <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 tabular-nums">{Number(contract.amount || 0).toLocaleString()} تومان</span>
      </div>
      <StatusLabel status={contract.status} small />
    </button>
  );
}

function DetailItem({ label, value, unit, color }: any) {
  return (
    <div className="p-4 card-obsidian">
      <span className="text-[9px] font-black text-slate-500 dark:text-slate-300 block mb-1">{label}</span>
      <div className={`text-sm font-black text-slate-900 dark:text-white ${color || ''}`}>
        {value} {unit && <span className="text-[10px] text-slate-500 dark:text-slate-300">{unit}</span>}
      </div>
    </div>
  );
}

function StatusLabel({ status, small }: { status: string; small?: boolean }) {
  const meta = getDealStatusMeta(status);
  return (
    <span className={`px-3 py-1 rounded-full ${small ? 'text-[10px]' : 'text-[11px]'} font-black uppercase tracking-wider ${meta.badgeClass}`}>
      {meta.shortLabel}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  const canonical = normalizeDealStatus(status);
  if (canonical === 'completed')
    return (
      <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center border border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.1)]">
        <Check size={32} strokeWidth={3} />
      </div>
    );
  if (['active', 'work_submitted', 'revisions_requested'].includes(canonical))
    return (
      <div className="w-16 h-16 bg-blue-600 text-white rounded-full flex items-center justify-center shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
        <Lock size={32} strokeWidth={3} />
      </div>
    );
  if (canonical === 'in_dispute')
    return (
      <div className="w-16 h-16 bg-rose-500/10 text-rose-500 rounded-full flex items-center justify-center border border-rose-500/20">
        <Gavel size={32} strokeWidth={3} />
      </div>
    );
  return (
    <div className="w-16 h-16 bg-slate-100 dark:bg-[#18202e] text-slate-500 dark:text-slate-200 rounded-full flex items-center justify-center border border-slate-200 dark:border-white/[0.08]">
      <Clock size={32} strokeWidth={3} />
    </div>
  );
}

function getProgress(status: string) {
  return getDealStatusMeta(status).progressPercent;
}

function translateStatus(status: string) {
  return getDealStatusMeta(status).label;
}

function DisputeView({ user, setView, refresh, notify }: any) {
  const [contract, setContract] = useState<any>(null);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [resolution, setResolution] = useState<any>(null);
  const [appeal, setAppeal] = useState<any>(null);
  const [appealReason, setAppealReason] = useState('');
  const [appealAttachmentUrl, setAppealAttachmentUrl] = useState('');
  const [appealUploading, setAppealUploading] = useState(false);
  const [appealBusy, setAppealBusy] = useState(false);
  const [appealReviewNote, setAppealReviewNote] = useState('');
  const [newEvidenceText, setNewEvidenceText] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [verdict, setVerdict] = useState<'refund' | 'release' | 'split'>('release');
  const [sellerPercent, setSellerPercent] = useState(50);
  const [arbitratorNote, setArbitratorNote] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('selected_contract');
    if (!saved) return;
    const c = JSON.parse(saved);
    setContract(c);
    if (c?.resolution) setResolution(c.resolution);
    if (c?.appeal) setAppeal(c.appeal);

    let cancelled = false;
    apiFetch<{ success: boolean; contract?: any; evidence?: any[]; resolution?: any; appeal?: any }>(
      `/api/disputes/${encodeURIComponent(c.contract_id)}`
    )
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          if (res.contract) {
            setContract(res.contract);
            localStorage.setItem('selected_contract', JSON.stringify(res.contract));
          }
          if (Array.isArray(res.evidence)) setEvidence(res.evidence);
          if (res.resolution || res.contract?.resolution) {
            setResolution(res.resolution || res.contract?.resolution);
          }
          if (res.appeal || res.contract?.appeal) {
            setAppeal(res.appeal || res.contract?.appeal);
          }
        }
      })
      .catch(() => {});

    const offDispute = realtimeClient.on('dispute:updated', (payload: any) => {
      const targetCid = payload?.contract_id || payload?.contractId;
      if (targetCid !== c.contract_id) return;
      const evItem = payload?.item || payload?.evidence;
      if (evItem) {
        setEvidence((prev) => (prev.some((e) => e.id === evItem.id) ? prev : [...prev, evItem]));
      }
      if (payload?.resolution) {
        setResolution(payload.resolution);
      }
      if (payload?.appeal) {
        setAppeal(payload.appeal);
      }
      if (payload?.contract) {
        setContract(payload.contract);
        localStorage.setItem('selected_contract', JSON.stringify(payload.contract));
      } else {
        const nextStatus = payload?.status || payload?.deal?.status;
        if (nextStatus) {
          setContract((prev: any) => (prev ? { ...prev, status: nextStatus } : prev));
        } else if (payload?.verdict) {
          const vStatus = payload.verdict === 'refund' ? 'cancelled' : 'completed';
          setContract((prev: any) => (prev ? { ...prev, status: vStatus } : prev));
        }
      }
    });

    return () => {
      cancelled = true;
      offDispute();
    };
  }, []);

  const submitEvidence = async (customText?: string, attachmentUrl?: string) => {
    const txt = (customText ?? newEvidenceText).trim();
    if (!txt || !contract) return;

    try {
      const res = await apiFetch<{ success: boolean; item?: any; evidence?: any[] }>(
        `/api/disputes/${encodeURIComponent(contract.contract_id)}/evidence`,
        {
          method: 'POST',
          body: JSON.stringify({ text: txt, attachment_url: attachmentUrl })
        }
      );
      if (res.success) {
        if (Array.isArray(res.evidence)) {
          setEvidence(res.evidence);
        } else if (res.item) {
          setEvidence((prev) => (prev.some((e) => e.id === res.item.id) ? prev : [...prev, res.item]));
        }
        if (!customText) setNewEvidenceText('');
        notify('گزارش شما در پرونده داوری ثبت شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت گزارش داوری', 'error');
    }
  };

  const canArbitrate = user?.role === 'owner' || user?.role === 'admin';

  const handleVerdict = async () => {
    if (!contract) return;
    setLoading(true);

    try {
      const res = await apiFetch<{ success: boolean; deal?: any; resolution?: any }>(
        `/api/disputes/${encodeURIComponent(contract.contract_id)}/verdict`,
        {
          method: 'POST',
          body: JSON.stringify({
            verdict,
            seller_percent: verdict === 'split' ? sellerPercent : verdict === 'release' ? 100 : 0,
            note: arbitratorNote.trim() || undefined,
          })
        }
      );
      if (res.deal) {
        setContract(res.deal);
        localStorage.setItem('selected_contract', JSON.stringify(res.deal));
      }
      if (res.resolution) setResolution(res.resolution);
      await refresh();
      setView('detail');
      notify('رأی داور با موفقیت ثبت و تسویه حساب انجام شد.', 'success');
    } catch (err: any) {
      notify(err?.message || 'تنها داور یا مدیر سیستم مجاز به ثبت رأی نهایی است.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitAppeal = async () => {
    if (!contract) return;
    const reason = appealReason.trim();
    if (reason.length < 10) {
      notify('لطفاً دلیل درخواست تجدیدنظر را حداقل در ۱۰ کاراکتر بنویسید', 'error');
      return;
    }
    setAppealBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; appeal?: any; contract?: any }>(
        `/api/disputes/${encodeURIComponent(contract.contract_id)}/appeal`,
        {
          method: 'POST',
          body: JSON.stringify({
            reason,
            attachment_url: appealAttachmentUrl || undefined,
          }),
        }
      );
      if (res.success && res.appeal) {
        setAppeal(res.appeal);
        if (res.contract) {
          setContract(res.contract);
          localStorage.setItem('selected_contract', JSON.stringify(res.contract));
        }
        setAppealReason('');
        setAppealAttachmentUrl('');
        await refresh();
        notify('درخواست تجدیدنظر شما با موفقیت ثبت و برای هیئت داوری ارسال شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت درخواست تجدیدنظر', 'error');
    } finally {
      setAppealBusy(false);
    }
  };

  const handleAppealDecision = async (decision: 'accepted' | 'rejected') => {
    if (!contract) return;
    const note = appealReviewNote.trim();
    if (note.length < 3) {
      notify('لطفاً شرح دلیل تصمیم هیئت داوری را بنویسید', 'error');
      return;
    }
    setAppealBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; appeal?: any; contract?: any }>(
        `/api/disputes/${encodeURIComponent(contract.contract_id)}/appeal-decision`,
        {
          method: 'POST',
          body: JSON.stringify({ decision, note }),
        }
      );
      if (res.success && res.appeal) {
        setAppeal(res.appeal);
        if (res.contract) {
          setContract(res.contract);
          localStorage.setItem('selected_contract', JSON.stringify(res.contract));
        }
        setAppealReviewNote('');
        await refresh();
        notify(decision === 'accepted' ? 'درخواست تجدیدنظر پذیرفته و در پرونده ثبت شد' : 'درخواست تجدیدنظر رد و رأی پیشین ابقا شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت تصمیم تجدیدنظر', 'error');
    } finally {
      setAppealBusy(false);
    }
  };

  if (!contract) return null;

  const isMilestoneContract = Boolean(
    (contract.staged_payment ?? contract.is_milestone) &&
      Array.isArray(contract.milestones) &&
      contract.milestones.length > 0
  );
  const remainingEscrow = isMilestoneContract
    ? contract.milestones
        .filter((m: any) => normalizeMilestoneStatus(m.status) !== 'completed')
        .reduce((acc: number, m: any) => acc + Number(m.amount || 0), 0) || Number(contract.amount || 0)
    : Number(contract.amount || 0);
  const disputeFeePercent = Math.max(0, Math.min(15, Number(contract.fee_percent || 0)));
  const previewSellerGross =
    verdict === 'refund' ? 0 : verdict === 'release' ? remainingEscrow : Math.round((remainingEscrow * sellerPercent) / 100);
  const previewBuyerRefund = Math.max(0, remainingEscrow - previewSellerGross);
  const previewFeeAmount = previewSellerGross > 0 ? Math.floor((previewSellerGross * disputeFeePercent) / 100) : 0;
  const previewSellerNet = Math.max(0, previewSellerGross - previewFeeAmount);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-4xl mx-auto pb-10">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setView('detail')}
          className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
        >
          <ChevronRight size={20} />
        </button>
        <h2 className="text-xl font-black text-slate-900 dark:text-white">مرکز حل اختلاف</h2>
      </div>

      <div className="bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-6 md:p-8 space-y-6 relative overflow-hidden shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-4 relative z-10">
          <div className="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-400/40 flex items-center justify-center text-rose-500 shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
            <Gavel size={28} />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">پرونده شماره {contract.contract_id.replace('M-', 'D-')}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300">مربوط به معامله: {contract.title}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-5 bg-slate-50 dark:bg-[#18202e] rounded-2xl border border-slate-200/70 dark:border-white/[0.08]">
            <span className="text-[10px] font-black text-slate-500 dark:text-slate-300 uppercase block mb-1">
              {isMilestoneContract ? 'مانده وجه امانی در تنازع' : 'مبلغ مورد تنازع'}
            </span>
            <span className="text-xl font-black text-slate-900 dark:text-white tabular-nums">{remainingEscrow.toLocaleString()} تومان</span>
          </div>
          <div className="p-5 bg-slate-50 dark:bg-[#18202e] rounded-2xl border border-rose-300/60 dark:border-rose-400/40">
            <span className="text-[10px] font-black text-slate-500 dark:text-slate-300 uppercase block mb-1">وضعیت فعلی</span>
            <span className="text-xs font-black text-rose-500">
              {isDisputedStatus(contract.status) ? 'در حال داوری رسمی' : translateStatus(contract.status)}
            </span>
          </div>
        </div>

        {resolution && (
          <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 space-y-2.5 text-xs">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="font-black text-emerald-700 dark:text-emerald-300">رأی نهایی داور صادر شده است</span>
              <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 tabular-nums">
                مجری: {resolution.seller_percent}٪ · کارفرما: {resolution.buyer_percent}٪
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] tabular-nums">
              <span className="text-slate-700 dark:text-slate-200">
                سهم مجری: {Number(resolution.seller_net ?? resolution.seller_net_amount ?? resolution.seller_gross ?? resolution.seller_amount ?? 0).toLocaleString()} تومان
              </span>
              <span className="text-slate-700 dark:text-slate-200">
                عودت کارفرما: {Number(resolution.buyer_refund ?? resolution.buyer_refund_amount ?? 0).toLocaleString()} تومان
              </span>
              {Number(resolution.fee_amount || 0) > 0 && (
                <span className="text-slate-700 dark:text-slate-200">
                  کارمزد پلتفرم: {Number(resolution.fee_amount).toLocaleString()} تومان
                </span>
              )}
            </div>
            {resolution.note && <p className="text-slate-700 dark:text-slate-200 pt-1">📝 دلیل رسمی حکم: {resolution.note}</p>}
            {(resolution.arbitrator_name || resolution.decided_at || resolution.resolved_at) && (
              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                صادرکننده: {resolution.arbitrator_name || 'داور میانجی'} · {formatDateTimeFa(resolution.decided_at || resolution.resolved_at)}
              </p>
            )}
          </div>
        )}

        {/* Appeal Section (after verdict) */}
        {resolution && (
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs font-black text-slate-900 dark:text-white">بخش تجدیدنظر پرونده داوری</span>
              {appeal && (
                <span
                  className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black ${
                    appeal.status === 'accepted'
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : appeal.status === 'rejected'
                      ? 'bg-rose-500/15 text-rose-500'
                      : 'bg-amber-500/15 text-amber-500'
                  }`}
                >
                  {appeal.status === 'accepted'
                    ? 'تجدیدنظر پذیرفته شد'
                    : appeal.status === 'rejected'
                    ? 'تجدیدنظر رد شد'
                    : 'در انتظار بررسی هیئت داوری'}
                </span>
              )}
            </div>

            {appeal ? (
              <div className="space-y-2 text-xs">
                <p className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  درخواست‌کننده: {appeal.requester_name} ({appeal.requester_role === 'buyer' ? 'کارفرما' : 'مجری'}) · {formatDateTimeFa(appeal.created_at)}
                </p>
                <p className="p-3 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/70 dark:border-white/10 text-slate-800 dark:text-slate-100 leading-relaxed">
                  {appeal.reason}
                </p>
                {appeal.attachment_url && (
                  <a
                    href={appeal.attachment_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[11px] font-black text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <Paperclip size={13} /> مشاهده مدرک پیوست تجدیدنظر
                  </a>
                )}
                {appeal.review_note && (
                  <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/25 space-y-1">
                    <span className="text-[10px] font-black text-blue-600 dark:text-blue-300 block">
                      نظر رسمی هیئت داوری ({appeal.reviewed_by_name || 'داور'}):
                    </span>
                    <p className="text-xs text-slate-800 dark:text-slate-100">{appeal.review_note}</p>
                  </div>
                )}

                {canArbitrate && appeal.status === 'pending' && (
                  <div className="pt-2 border-t border-slate-200/70 dark:border-white/10 space-y-2.5">
                    <textarea
                      rows={2}
                      value={appealReviewNote}
                      onChange={(e) => setAppealReviewNote(e.target.value)}
                      placeholder="متن دلیل رسمی پذیرش یا رد درخواست تجدیدنظر..."
                      className="w-full p-3 rounded-xl bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] font-sans text-[14px] font-medium text-slate-900 dark:text-white outline-none resize-none leading-relaxed"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={appealBusy}
                        onClick={() => handleAppealDecision('accepted')}
                        className="flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black active:scale-95 transition-all disabled:opacity-50"
                      >
                        پذیرش تجدیدنظر
                      </button>
                      <button
                        type="button"
                        disabled={appealBusy}
                        onClick={() => handleAppealDecision('rejected')}
                        className="flex-1 h-10 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-black active:scale-95 transition-all disabled:opacity-50"
                      >
                        رد تجدیدنظر
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              (String(user?.id) === String(contract.buyer_id) || String(user?.id) === String(contract.seller_id)) && (
                <div className="space-y-2.5">
                  <p className="text-[11px] text-slate-500 dark:text-slate-300">
                    در صورت وجود مستندات جدید یا اعتراض مستدل به رأی داور، می‌توانید یک‌بار درخواست تجدیدنظر ثبت کنید.
                  </p>
                  <textarea
                    rows={3}
                    maxLength={1500}
                    value={appealReason}
                    onChange={(e) => setAppealReason(e.target.value)}
                    placeholder="دلیل و مستندات درخواست تجدیدنظر را دقیق بنویسید (حداقل ۱۰ کاراکتر)..."
                    className="w-full p-3 rounded-xl bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] font-sans text-[14px] font-medium text-slate-900 dark:text-white outline-none resize-none leading-relaxed"
                  />
                  <div className="flex flex-wrap gap-2">
                    <input
                      id="appealFileInput"
                      type="file"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setAppealUploading(true);
                        try {
                          const url = await uploadMediaFile(file, file.name);
                          setAppealAttachmentUrl(url);
                          notify('فایل پیوست تجدیدنظر بارگذاری شد', 'success');
                        } catch (err: any) {
                          notify(err?.message || 'خطا در آپلود فایل', 'error');
                        } finally {
                          setAppealUploading(false);
                        }
                      }}
                    />
                    <button
                      type="button"
                      disabled={appealUploading}
                      onClick={() => document.getElementById('appealFileInput')?.click()}
                      className="h-10 px-4 rounded-xl bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-white flex items-center gap-1.5"
                    >
                      <Paperclip size={13} />
                      {appealUploading ? 'در حال آپلود...' : appealAttachmentUrl ? 'فایل پیوست آماده است' : 'پیوست مدرک (اختیاری)'}
                    </button>
                    <button
                      type="button"
                      disabled={appealBusy || appealUploading || appealReason.trim().length < 10}
                      onClick={handleSubmitAppeal}
                      className="flex-1 h-10 rounded-xl bg-amber-500 hover:bg-amber-600 text-black text-xs font-black active:scale-95 transition-all disabled:opacity-50"
                    >
                      {appealBusy ? 'در حال ثبت...' : 'ثبت درخواست تجدیدنظر'}
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* Evidence Timeline */}
      <div className="space-y-4">
        <h3 className="text-sm font-black text-slate-900 dark:text-white px-2">شواهد و مستندات</h3>
        <div className="bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-5 md:p-6 space-y-5 shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09),0_0_12px_rgba(255,255,255,0.85)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
          {evidence.length === 0 ? (
            <p className="text-center text-xs text-slate-400 py-4">هنوز مدرکی در پرونده ثبت نشده است.</p>
          ) : (
            evidence.map((item) => {
              const isOwn = String(item.sender_id) === String(user?.id);
              const isBuyer = String(item.sender_id) === String(contract.buyer_id);
              const isSeller = String(item.sender_id) === String(contract.seller_id);
              const roleLabel = item.sender_name || (isBuyer ? 'کارفرما' : isSeller ? 'مجری' : 'داور');
              const isImageAttachment =
                typeof item.attachment_url === 'string' &&
                /\.(png|jpe?g|webp|gif)(\?|$)/i.test(item.attachment_url);
              return (
                <div key={item.id} className={`flex flex-col gap-2 ${isOwn ? 'items-start' : 'items-end'}`}>
                  <div
                    className={`p-4 rounded-2xl text-[11px] md:text-xs leading-relaxed max-w-[90%] space-y-2 ${
                      isOwn
                        ? 'bg-blue-600 text-white border border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
                        : 'bg-slate-50 dark:bg-[#18202e] text-slate-900 dark:text-slate-100 border border-slate-200/80 dark:border-white/[0.08] shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
                    }`}
                  >
                    <p className="font-bold opacity-75 text-[10px]">{roleLabel}</p>
                    <p className="whitespace-pre-wrap">{item.text}</p>
                    {item.attachment_url && (
                      isImageAttachment ? (
                        <a href={item.attachment_url} target="_blank" rel="noopener noreferrer" className="block pt-1">
                          <img src={item.attachment_url} alt="مدرک پیوست" className="max-h-52 rounded-xl border border-white/20 object-cover" />
                        </a>
                      ) : (
                        <a
                          href={item.attachment_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-[10px] font-black underline pt-1"
                        >
                          <Paperclip size={12} /> دانلود فایل پیوست
                        </a>
                      )
                    )}
                  </div>
                </div>
              );
            })
          )}

          <div className="pt-4 border-t border-slate-100 dark:border-white/[0.08] space-y-4">
            <textarea
              value={newEvidenceText}
              onChange={(e) => setNewEvidenceText(e.target.value)}
              className="w-full h-24 bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] rounded-2xl p-4 font-sans text-[14px] font-medium text-slate-900 dark:text-white focus:border-slate-400 dark:focus:border-blue-500/50 outline-none transition-all resize-none leading-relaxed"
              placeholder="توضیحات تکمیلی یا دفاعیه خود را اینجا بنویسید..."
            />
            <div className="flex gap-2">
              <input
                id="disputeFileInput"
                type="file"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setUploadingFile(true);
                  try {
                    const url = await uploadMediaFile(file, file.name);
                    await submitEvidence(`📎 مدرک پیوست: ${file.name}`, url);
                  } catch (err: any) {
                    notify(err?.message || 'خطا در آپلود مدرک', 'error');
                  } finally {
                    setUploadingFile(false);
                  }
                }}
              />
              <button
                type="button"
                disabled={uploadingFile}
                onClick={() => document.getElementById('disputeFileInput')?.click()}
                className="flex-1 h-12 bg-white dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] text-slate-700 dark:text-white rounded-xl text-[11px] font-black flex items-center justify-center gap-2 btn-protruding disabled:opacity-50"
              >
                <Paperclip size={14} /> {uploadingFile ? 'در حال آپلود...' : 'ضمیمه فایل/تصویر'}
              </button>
              <button
                type="button"
                onClick={() => submitEvidence()}
                disabled={!newEvidenceText.trim() || uploadingFile}
                className="flex-1 h-12 bg-blue-600 text-white border border-white/15 rounded-xl text-[11px] font-black active:scale-95 transition-all shadow-lg btn-protruding disabled:opacity-50"
              >
                ارسال گزارش به داور
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Arbitrator Panel */}
      {canArbitrate && isDisputedStatus(contract.status) && (
        <div className="p-6 md:p-8 bg-white dark:bg-[#131924] border border-amber-400/50 rounded-3xl space-y-6 shadow-xl dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] relative overflow-hidden">
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
            <VerdictBtn active={verdict === 'refund'} onClick={() => setVerdict('refund')} label="برگشت کامل وجه" desc="۱۰۰٪ به حساب کارفرما" />
            <VerdictBtn active={verdict === 'release'} onClick={() => setVerdict('release')} label="تسویه کامل" desc="۱۰۰٪ به حساب مجری" />
            <VerdictBtn active={verdict === 'split'} onClick={() => setVerdict('split')} label="تقسیم درصدی وجه" desc={`سهم مجری: ${sellerPercent}٪`} />
          </div>

          {verdict === 'split' && (
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-black text-slate-900 dark:text-white tabular-nums">
                  تنظیم درصد سهم طرفین: {sellerPercent}٪ مجری / {100 - sellerPercent}٪ کارفرما
                </span>
                <div className="flex items-center gap-1.5">
                  {[30, 50, 70].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => setSellerPercent(pct)}
                      className={`h-7 px-2.5 rounded-lg text-[10px] font-black transition-all ${
                        sellerPercent === pct ? 'bg-amber-500 text-black' : 'bg-white dark:bg-[#131924] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {pct}/{100 - pct}
                    </button>
                  ))}
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={sellerPercent}
                onChange={(e) => setSellerPercent(Number(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer"
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                  خالص مجری: {previewSellerNet.toLocaleString()} ت
                </span>
                <span className="text-blue-600 dark:text-blue-300 font-bold">
                  عودت کارفرما: {previewBuyerRefund.toLocaleString()} ت
                </span>
                <span className="text-slate-500 dark:text-slate-300">
                  کارمزد ({disputeFeePercent}٪): {previewFeeAmount.toLocaleString()} ت
                </span>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300 block">توضیح و مستندات رأی داور (اختیاری)</label>
            <textarea
              rows={2}
              maxLength={800}
              value={arbitratorNote}
              onChange={(e) => setArbitratorNote(e.target.value)}
              placeholder="شرح دلیل رأی برای شفافیت طرفین معامله..."
              className="w-full p-3.5 rounded-2xl bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] font-sans text-[14px] font-medium text-slate-900 dark:text-white outline-none focus:border-amber-500 resize-none leading-relaxed"
            />
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
          ? 'bg-amber-500 border-amber-300 text-black shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08] text-slate-900 dark:text-slate-200'
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
          ? 'bg-blue-600/15 border-slate-400 dark:border-white/35 text-blue-700 dark:text-white shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
          : 'bg-white dark:bg-[#131924] border-slate-200/90 dark:border-white/[0.08] text-slate-600 dark:text-slate-200'
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
  const [savingContact, setSavingContact] = useState(false);
  const [newContact, setNewAddContact] = useState({ name: '', phone: '', category: 'طرف معامله', note: '' });
  const [lookupResult, setLookupResult] = useState<{ status: 'idle' | 'checking' | 'found' | 'not_found'; name?: string }>({ status: 'idle' });
  const [pendingDeleteContact, setPendingDeleteContact] = useState<any | null>(null);
  const [deletingContact, setDeletingContact] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ success: boolean; contacts?: any[] }>('/api/contacts')
      .then((res) => {
        if (!cancelled && res.success && Array.isArray(res.contacts)) {
          setContacts(res.contacts);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
        const data = await apiFetch<{ success: boolean; user?: any }>(
          `/api/users/lookup?phone=${encodeURIComponent(cleanPhone)}`
        );
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

  const handleAdd = async () => {
    const cleanPhone = normalizeDigits(newContact.phone).replace(/[^0-9]/g, '');
    if (!newContact.name.trim() || cleanPhone.length < 8) {
      notify('لطفاً نام و شماره تماس معتبر وارد کنید', 'error');
      return;
    }

    setSavingContact(true);
    try {
      const res = await apiFetch<{ success: boolean; contact?: any }>('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({
          full_name: newContact.name.trim(),
          phone_number: cleanPhone,
          category: newContact.category || 'طرف معامله',
          note: newContact.note.trim()
        })
      });
      if (res.success && res.contact) {
        const nextList = [res.contact, ...contacts.filter((c) => c.id !== res.contact.id)];
        setContacts(nextList);
        try {
          localStorage.setItem('mianji_contacts', JSON.stringify(nextList));
        } catch {}
        setNewAddContact({ name: '', phone: '', category: 'طرف معامله', note: '' });
        setShowAddModal(false);
        notify('مخاطب جدید در حساب شما ذخیره شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ذخیره مخاطب', 'error');
    } finally {
      setSavingContact(false);
    }
  };

  const handleDeleteContact = async (contactId: string | number) => {
    try {
      await apiFetch(`/api/contacts/${encodeURIComponent(String(contactId))}`, { method: 'DELETE' });
      const nextList = contacts.filter((c) => String(c.id) !== String(contactId));
      setContacts(nextList);
      try {
        localStorage.setItem('mianji_contacts', JSON.stringify(nextList));
      } catch {}
      notify('مخاطب حذف شد', 'info');
    } catch (err: any) {
      notify(err?.message || 'خطا در حذف مخاطب', 'error');
    }
  };

  const openContactChat = async (contact: any) => {
    try {
      const res = await apiFetch<{ success: boolean; chat?: any }>('/api/chats/direct/open', {
        method: 'POST',
        body: JSON.stringify({
          targetId: contact.target_user_id || undefined,
          phone: contact.phone_number,
          fullName: contact.full_name
        })
      });
      if (res.success && res.chat) {
        localStorage.setItem('mianji_chat_target', JSON.stringify(res.chat));
        if (onOpenChat) onOpenChat(String(res.chat.id));
        else setView('messages');
      }
    } catch (err: any) {
      notify(err?.message || 'این مخاطب هنوز عضو میانجی نیست یا امکان گفتگو با او وجود ندارد', 'error');
    }
  };

  const normalizedQuery = normalizeDigits(searchTerm).toLowerCase();
  const filtered = contacts.filter(
    (c) =>
      String(c.full_name || '').toLowerCase().includes(normalizedQuery) ||
      String(c.phone_number || '').includes(normalizedQuery) ||
      String(c.category || '').toLowerCase().includes(normalizedQuery) ||
      String(c.note || '').toLowerCase().includes(normalizedQuery)
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5 max-w-4xl mx-auto pb-24 relative">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-xl font-black text-slate-900 dark:text-white">مخاطبین من</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="h-8 px-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black flex items-center gap-1 active:scale-95 transition-all whitespace-nowrap shrink-0"
          >
            <Plus size={14} /> ایجاد مخاطب
          </button>
          <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300 tabular-nums whitespace-nowrap shrink-0">
            {filtered.length} مخاطب
          </span>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" size={18} />
        <input
          placeholder="جستجوی نام، شماره همراه یا دسته‌بندی..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="input-refined pr-12"
        />
      </div>

      <div className="bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl overflow-hidden divide-y divide-slate-100 dark:divide-white/[0.07] shadow-[0_12px_32px_-6px_rgba(15,23,42,0.09)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
        {filtered.length > 0 ? (
          filtered.map((contact) => (
            <div key={contact.id} className="p-4 md:p-5 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-white/[0.06] transition-colors relative group">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-white/[0.1] flex items-center justify-center text-blue-700 dark:text-white font-black relative border border-slate-200 dark:border-white/[0.08] shrink-0">
                {contact.full_name?.[0] || 'م'}
                <div
                  className={`absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white dark:border-[#131924] ${
                    contact.status === 'verified' ? 'bg-emerald-500' : 'bg-slate-400'
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-black text-slate-900 dark:text-white truncate">{contact.full_name}</span>
                  {contact.category && (
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300">· {contact.category}</span>
                  )}
                  {contact.status === 'verified' && (
                    <span className="text-[10px] font-black text-emerald-500 tabular-nums">· عضو میانجی</span>
                  )}
                  {contact.trust_score > 0 && (
                    <span className="text-[10px] font-black text-blue-600 dark:text-slate-200 tabular-nums">· اعتبار {contact.trust_score}٪</span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-300 font-mono" dir="ltr">
                  {contact.phone_number}
                </p>
                {contact.note && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{contact.note}</p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => openContactChat(contact)}
                  className="w-10 h-10 rounded-xl bg-blue-600 text-white border border-white/20 flex items-center justify-center hover:bg-blue-700 transition-all active:scale-90 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
                  title="ارسال پیام"
                >
                  <MessageCircle size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    localStorage.setItem('mianji_prefill_phone', contact.phone_number);
                    setView('create');
                  }}
                  className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-white/[0.1] border border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-white flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/20 transition-all active:scale-90"
                  title="معامله جدید"
                >
                  <Plus size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDeleteContact(contact)}
                  className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-400/30 text-rose-500 flex items-center justify-center hover:bg-rose-500/20 transition-all active:scale-90"
                  title="حذف مخاطب"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="py-16 px-6 text-center space-y-3">
            <div className="w-14 h-14 rounded-2xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center mx-auto text-blue-600 dark:text-white">
              <Users size={26} />
            </div>
            <p className="text-xs font-black text-slate-900 dark:text-white">
              {searchTerm.trim() ? 'مخاطبی با این مشخصات پیدا نشد' : 'هنوز مخاطبی اضافه نکرده‌اید'}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-300 max-w-xs mx-auto">
              مخاطبین پرکاربرد خود را ذخیره کنید تا در ساخت قرارداد و شروع گفتگو سریع‌تر انتخاب شوند.
            </p>
            <div className="pt-1 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black inline-flex items-center gap-1.5 active:scale-95 transition-all"
              >
                <UserPlus size={15} /> ایجاد مخاطب جدید
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom-corner Floating Add Contact Button */}
      <button
        type="button"
        onClick={() => setShowAddModal(true)}
        aria-label="ایجاد مخاطب جدید"
        title="ایجاد مخاطب جدید"
        className="fixed bottom-24 left-5 lg:bottom-8 lg:left-8 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-700 text-white border-2 border-white dark:border-slate-200/90 flex items-center justify-center shadow-[0_12px_28px_rgba(15,23,42,0.26)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:scale-90 transition-all z-40"
      >
        <UserPlus size={22} strokeWidth={2.2} />
      </button>

      {/* Create New Contact Modal (matching Create Channel layout & UX) */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowAddModal(false)}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[650] flex items-center justify-center p-5"
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              transition={{ duration: 0.16 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] rounded-3xl p-6 space-y-4 shadow-2xl dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center">
                    <UserPlus size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-900 dark:text-white">ایجاد مخاطب جدید</h3>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300">ذخیره طرف معامله در دفترچه امن میانجی</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-600 dark:text-white"
                  aria-label="بستن"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">نام و نام خانوادگی مخاطب</label>
                  <input
                    value={newContact.name}
                    onChange={(e) => setNewAddContact({ ...newContact, name: e.target.value })}
                    placeholder="مثلاً: علی رضایی"
                    className="input-refined !h-11"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">شماره همراه</label>
                    <input
                      dir="ltr"
                      inputMode="tel"
                      value={newContact.phone}
                      onChange={(e) => setNewAddContact({ ...newContact, phone: normalizeDigits(e.target.value) })}
                      placeholder="09123456789"
                      className="input-refined !h-11 text-center font-sans tabular-nums text-[14px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">دسته‌بندی / نقش</label>
                    <select
                      value={newContact.category}
                      onChange={(e) => setNewAddContact({ ...newContact, category: e.target.value })}
                      className="input-refined !h-11 text-[14px]"
                    >
                      <option value="طرف معامله">طرف معامله</option>
                      <option value="فروشنده / مجری">فروشنده / مجری</option>
                      <option value="کارفرما / خریدار">کارفرما / خریدار</option>
                      <option value="همکار">همکار</option>
                      <option value="عمومی">عمومی</option>
                    </select>
                  </div>
                </div>

                {lookupResult.status === 'checking' && (
                  <p className="text-[11px] font-bold text-blue-600 dark:text-blue-300 px-1">در حال استعلام عضویت در میانجی...</p>
                )}
                {lookupResult.status === 'found' && lookupResult.name && (
                  <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-400/50 flex items-center justify-between text-[11px]">
                    <span className="text-emerald-700 dark:text-emerald-300 font-bold">عضو میانجی: {lookupResult.name}</span>
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
                {lookupResult.status === 'not_found' && normalizeDigits(newContact.phone).replace(/[^0-9]/g, '').length >= 10 && (
                  <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 px-1">
                    این شماره هنوز در میانجی ثبت نشده؛ می‌توانید ذخیره کنید و بعداً معامله یا دعوت انجام دهید.
                  </p>
                )}

                <div className="space-y-1">
                  <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">یادداشت کوتاه (اختیاری)</label>
                  <textarea
                    rows={2}
                    maxLength={300}
                    value={newContact.note}
                    onChange={(e) => setNewAddContact({ ...newContact, note: e.target.value })}
                    placeholder="توضیح کوتاه درباره همکاری یا نوع معامله با این مخاطب..."
                    className="w-full rounded-xl p-3 font-sans text-[14px] font-medium bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white resize-none leading-relaxed"
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleAdd}
                disabled={!newContact.name.trim() || !newContact.phone.trim() || savingContact}
                className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs border border-white/25 active:scale-95 transition-all disabled:opacity-50"
              >
                {savingContact ? 'در حال ایجاد مخاطب...' : 'ساخت و ذخیره مخاطب'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={Boolean(pendingDeleteContact)}
        title="حذف مخاطب"
        description="آیا از حذف این مخاطب از دفترچه حساب خود مطمئن هستید؟"
        previewText={
          pendingDeleteContact
            ? `${pendingDeleteContact.full_name || 'مخاطب'} — ${pendingDeleteContact.phone_number || ''}`
            : undefined
        }
        confirmLabel="بله، حذف شود"
        cancelLabel="انصراف"
        tone="danger"
        busy={deletingContact}
        onCancel={() => {
          if (!deletingContact) setPendingDeleteContact(null);
        }}
        onConfirm={async () => {
          if (!pendingDeleteContact) return;
          setDeletingContact(true);
          try {
            await handleDeleteContact(pendingDeleteContact.id);
            setPendingDeleteContact(null);
          } finally {
            setDeletingContact(false);
          }
        }}
      />
    </motion.div>
  );
}

function WalletView({ user, setUser, notify, platformLimits, initialAction, onConsumeInitialAction, onOpenContract }: any) {
  const [modalMode, setModalMode] = useState<'deposit' | 'withdraw' | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [refInput, setRefInput] = useState('');
  const [sourceCardInput, setSourceCardInput] = useState('');
  const [saveCardOnWithdraw, setSaveCardOnWithdraw] = useState(true);
  const [slipImageUrl, setSlipImageUrl] = useState('');
  const [uploadingSlip, setUploadingSlip] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [pendingCancelReq, setPendingCancelReq] = useState<any | null>(null);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'deposits' | 'withdraws' | 'escrow'>('all');
  const [txSearch, setTxSearch] = useState('');
  const [ledgerTxs, setLedgerTxs] = useState<any[]>([]);
  const slipFileInputRef = useRef<HTMLInputElement | null>(null);
  const [history, setHistory] = useState<any[]>([]);

  // Saved Bank Cards / Sheba Management State inside Wallet
  const [cardModalOpen, setCardModalOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<SavedBankMethod | null>(null);
  const [cardNumberInput, setCardNumberInput] = useState('');
  const [cardHolderInput, setCardHolderInput] = useState('');
  const [cardLabelInput, setCardLabelInput] = useState('');
  const [cardMakeDefault, setCardMakeDefault] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const [confirmDeleteCardId, setConfirmDeleteCardId] = useState<string | null>(null);
  const [reopenWithdrawAfterCardAdd, setReopenWithdrawAfterCardAdd] = useState(false);

  const savedCards: SavedBankMethod[] = Array.isArray(user?.saved_cards) ? user.saved_cards : [];

  const updateSavedCardsState = (nextCards: SavedBankMethod[]) => {
    setUser?.((prev: any) => {
      if (!prev) return prev;
      const next = { ...prev, saved_cards: nextCards };
      try {
        localStorage.setItem('mianji_mock_user', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    if (!initialAction) return;
    if (initialAction === 'withdraw') {
      const def = savedCards.find((c) => c.is_default) || savedCards[0];
      setRefInput(def ? (def.type === 'card' ? formatIranianCard(def.number) : def.number) : '');
      setSaveCardOnWithdraw(true);
    } else {
      setRefInput('');
      setSourceCardInput('');
    }
    setModalMode(initialAction);
    onConsumeInitialAction?.();
  }, [initialAction]);

  useEffect(() => {
    let cancelled = false;
    const loadRequests = async () => {
      try {
        const [reqRes, txRes] = await Promise.allSettled([
          apiFetch<{
            success: boolean;
            requests?: any[];
            saved_cards?: SavedBankMethod[];
            balances?: { wallet_balance: number; escrow_locked_balance: number; pending_withdraw_total?: number };
          }>('/api/wallet/requests'),
          apiFetch<{
            success: boolean;
            transactions?: any[];
          }>('/api/wallet/transactions')
        ]);

        if (cancelled) return;
        if (reqRes.status === 'fulfilled' && reqRes.value?.success) {
          if (Array.isArray(reqRes.value.requests)) {
            setHistory(reqRes.value.requests.map((r) => ({ ...r, ref: r.ref_code || r.ref })));
          }
          if (reqRes.value.balances || Array.isArray(reqRes.value.saved_cards)) {
            const b = reqRes.value.balances;
            const syncedCards = Array.isArray(reqRes.value.saved_cards) ? reqRes.value.saved_cards : undefined;
            setUser((prev: any) => {
              if (!prev) return prev;
              const next = {
                ...prev,
                ...(b
                  ? {
                      wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
                      escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0),
                      pending_withdraw_total: Number(b.pending_withdraw_total ?? prev.pending_withdraw_total ?? 0),
                    }
                  : {}),
                ...(syncedCards ? { saved_cards: syncedCards } : {}),
              };
              try {
                localStorage.setItem('mianji_mock_user', JSON.stringify(next));
              } catch {}
              return next;
            });
          }
        }
        if (txRes.status === 'fulfilled' && txRes.value?.success && Array.isArray(txRes.value.transactions)) {
          setLedgerTxs(txRes.value.transactions);
        }
      } catch {}
    };

    loadRequests();
    const offWallet = realtimeClient.on('wallet:updated', (payload: any) => {
      if (String(payload?.userId) === String(user?.id)) {
        loadRequests();
      }
    });
    const offDeal = realtimeClient.on('deal:updated', () => {
      loadRequests();
    });
    return () => {
      cancelled = true;
      offWallet();
      offDeal();
    };
  }, [user?.id]);

  const walletBalance = Number(user?.wallet_balance ?? 0);
  const lockedBalance = Number(user?.escrow_locked_balance ?? 0);
  const pendingWithdrawFromHistory = history
    .filter((h) => h.type === 'withdraw' && h.status === 'pending')
    .reduce((sum, h) => sum + Number(h.amount || 0), 0);
  const pendingWithdrawTotal = Math.max(Number(user?.pending_withdraw_total ?? 0), pendingWithdrawFromHistory);
  const availableBalance = Math.max(0, walletBalance - lockedBalance - pendingWithdrawTotal);
  const dailyWithdrawLimit = Number(user?.daily_withdraw_limit || platformLimits?.default_daily_withdraw_limit || 0);
  const todayWithdrawn = history
    .filter(
      (h) =>
        h.type === 'withdraw' &&
        h.status !== 'rejected' &&
        h.status !== 'cancelled' &&
        new Date(h.created_at).toDateString() === new Date().toDateString()
    )
    .reduce((sum, h) => sum + Number(h.amount || 0), 0);

  const payoutCheck = React.useMemo(
    () => (modalMode === 'withdraw' && refInput.trim() ? validateIranianPayoutDestination(refInput) : null),
    [modalMode, refInput]
  );

  const isWithdrawDestNew = React.useMemo(() => {
    if (modalMode !== 'withdraw' || !payoutCheck?.valid || !payoutCheck.normalized) return false;
    return !savedCards.some((c) => String(c.number) === payoutCheck.normalized);
  }, [modalMode, payoutCheck, savedCards]);

  const cardInputValidation = React.useMemo(
    () => (!editingCard && cardNumberInput.trim() ? validateIranianPayoutDestination(cardNumberInput) : null),
    [editingCard, cardNumberInput]
  );

  const sourceCardValidation = React.useMemo(() => {
    if (modalMode !== 'deposit' || !sourceCardInput.trim()) return null;
    const digits = normalizeDigits(sourceCardInput).replace(/[^0-9]/g, '');
    if (digits.length === 16) {
      const check = isValidIranianCard(digits);
      return check.valid
        ? { valid: true, bank: detectIranianBankName(check.normalized) }
        : { valid: false, error: 'شماره کارت مبدأ ۱۶ رقمی معتبر نیست.' };
    }
    if (digits.length === 4) {
      return { valid: true, bank: null };
    }
    return { valid: false, error: '۱۶ رقم کامل کارت یا ۴ رقم آخر کارت مبدأ را وارد کنید.' };
  }, [modalMode, sourceCardInput]);

  const openAddCardModal = (fromWithdraw = false) => {
    setEditingCard(null);
    setCardNumberInput('');
    setCardHolderInput(user?.full_name || '');
    setCardLabelInput('');
    setCardMakeDefault(savedCards.length === 0);
    setReopenWithdrawAfterCardAdd(fromWithdraw);
    setCardModalOpen(true);
  };

  const openEditCardModal = (card: SavedBankMethod) => {
    setEditingCard(card);
    setCardNumberInput(card.formatted || card.number);
    setCardHolderInput(card.holder_name || user?.full_name || '');
    setCardLabelInput(card.label || '');
    setCardMakeDefault(Boolean(card.is_default));
    setReopenWithdrawAfterCardAdd(false);
    setCardModalOpen(true);
  };

  const handleSaveCardModal = async () => {
    if (editingCard) {
      setCardBusy(true);
      try {
        const res = await apiFetch<{ success: boolean; saved_cards?: SavedBankMethod[] }>(
          `/api/wallet/cards/${encodeURIComponent(editingCard.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              label: cardLabelInput.trim() || editingCard.bank_name,
              holder_name: cardHolderInput.trim(),
              is_default: cardMakeDefault,
            }),
          }
        );
        if (res?.success && Array.isArray(res.saved_cards)) {
          updateSavedCardsState(res.saved_cards);
          setCardModalOpen(false);
          setEditingCard(null);
          notify('اطلاعات کارت / شبا با موفقیت ویرایش شد', 'success');
        }
      } catch (err: any) {
        notify(err?.message || 'خطا در ویرایش کارت بانکی', 'error');
      } finally {
        setCardBusy(false);
      }
      return;
    }

    const check = validateIranianPayoutDestination(cardNumberInput);
    if (!check.valid || !check.normalized) {
      notify(check.error || 'شماره کارت یا شبا معتبر نیست', 'error');
      return;
    }
    setCardBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; card?: SavedBankMethod; saved_cards?: SavedBankMethod[] }>(
        '/api/wallet/cards',
        {
          method: 'POST',
          body: JSON.stringify({
            number: check.normalized,
            label: cardLabelInput.trim() || undefined,
            holder_name: cardHolderInput.trim() || undefined,
            is_default: cardMakeDefault,
          }),
        }
      );
      if (res?.success && Array.isArray(res.saved_cards)) {
        updateSavedCardsState(res.saved_cards);
        setCardModalOpen(false);
        setCardNumberInput('');
        setCardLabelInput('');
        if (reopenWithdrawAfterCardAdd && res.card) {
          setRefInput(res.card.type === 'card' ? formatIranianCard(res.card.number) : res.card.number);
          setModalMode('withdraw');
        }
        setReopenWithdrawAfterCardAdd(false);
        notify('شماره کارت / شبا با موفقیت به کیف پول اضافه شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ذخیره شماره کارت یا شبا', 'error');
    } finally {
      setCardBusy(false);
    }
  };

  const handleSetDefaultCard = async (cardId: string) => {
    setCardBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; saved_cards?: SavedBankMethod[] }>(
        `/api/wallet/cards/${encodeURIComponent(cardId)}/default`,
        { method: 'PATCH' }
      );
      if (res?.success && Array.isArray(res.saved_cards)) {
        updateSavedCardsState(res.saved_cards);
        notify('روش تسویه پیش‌فرض تغییر یافت', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در تنظیم کارت پیش‌فرض', 'error');
    } finally {
      setCardBusy(false);
    }
  };

  const handleDeleteSavedCard = async (cardId: string) => {
    setCardBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; saved_cards?: SavedBankMethod[] }>(
        `/api/wallet/cards/${encodeURIComponent(cardId)}`,
        { method: 'DELETE' }
      );
      if (res?.success && Array.isArray(res.saved_cards)) {
        updateSavedCardsState(res.saved_cards);
        setConfirmDeleteCardId(null);
        notify('کارت / شبا از کیف پول حذف شد', 'info');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در حذف کارت / شبا', 'error');
    } finally {
      setCardBusy(false);
    }
  };

  const handleSlipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingSlip(true);
    try {
      const uploadedUrl = await uploadMediaFile(file, file.name || 'slip-receipt.webp');
      setSlipImageUrl(uploadedUrl);
      notify('تصویر فیش با موفقیت بارگذاری شد', 'success');
    } catch (err: any) {
      notify(err?.message || 'خطا در بارگذاری تصویر فیش', 'error');
    } finally {
      setUploadingSlip(false);
      if (slipFileInputRef.current) slipFileInputRef.current.value = '';
    }
  };

  const handleWalletSubmit = async () => {
    const amt = Number(normalizeDigits(amountInput).replace(/[^0-9]/g, ''));
    if (!amt || amt < 10000) {
      notify('حداقل مبلغ تراکنش ۱۰,۰۰۰ تومان است', 'error');
      return;
    }
    if (modalMode === 'withdraw' && user?.is_withdraw_locked) {
      notify('برداشت وجه برای حساب شما محدود (قفل) شده است', 'error');
      return;
    }
    if (modalMode === 'withdraw' && dailyWithdrawLimit > 0 && todayWithdrawn + amt > dailyWithdrawLimit) {
      const remaining = Math.max(0, dailyWithdrawLimit - todayWithdrawn);
      notify(
        `سقف برداشت روزانه شما ${dailyWithdrawLimit.toLocaleString()} تومان است (باقیمانده امروز: ${remaining.toLocaleString()} تومان)`,
        'error'
      );
      return;
    }
    if (modalMode === 'withdraw' && amt > availableBalance) {
      notify('موجودی قابل برداشت کافی نیست', 'error');
      return;
    }
    let normalizedDest = refInput.trim();
    if (modalMode === 'deposit') {
      if (normalizedDest.length < 4) {
        notify('لطفاً شماره پیگیری یا کد ارجاع بانکی معتبر (حداقل ۴ کاراکتر) وارد کنید', 'error');
        return;
      }
      if (!slipImageUrl) {
        notify('لطفاً تصویر فیش واریزی خود را پیوست کنید', 'error');
        return;
      }
      if (sourceCardInput.trim() && sourceCardValidation && !sourceCardValidation.valid) {
        notify(sourceCardValidation.error || 'شماره کارت مبدأ معتبر نیست', 'error');
        return;
      }
    }
    if (modalMode === 'withdraw') {
      const destCheck = validateIranianPayoutDestination(refInput);
      if (!destCheck.valid) {
        notify(destCheck.error || 'شماره شبا یا کارت مقصد معتبر نیست', 'error');
        return;
      }
      normalizedDest = destCheck.normalized || normalizedDest;
    }

    const matchedCard =
      modalMode === 'withdraw' ? savedCards.find((c) => String(c.number) === normalizedDest) : undefined;

    setSubmitting(true);
    try {
      const res = await apiFetch<{
        success: boolean;
        request?: any;
        pending_withdraw_total?: number;
        saved_cards?: SavedBankMethod[];
        card_saved?: boolean;
      }>('/api/wallet/requests', {
        method: 'POST',
        body: JSON.stringify({
          type: modalMode,
          amount: amt,
          ref_code: normalizedDest || undefined,
          card_id: matchedCard?.id,
          holder_name: matchedCard?.holder_name || user?.full_name || undefined,
          save_card: modalMode === 'withdraw' && isWithdrawDestNew && saveCardOnWithdraw,
          source_card:
            modalMode === 'deposit' && sourceCardInput.trim()
              ? normalizeDigits(sourceCardInput).replace(/[^0-9]/g, '')
              : undefined,
          slip_image_url: modalMode === 'deposit' && slipImageUrl ? slipImageUrl : undefined,
        })
      });
      if (res.success && res.request) {
        const mapped = { ...res.request, ref: res.request.ref_code || res.request.ref };
        setHistory((prev) => [mapped, ...prev.filter((h) => h.id !== mapped.id)]);
        if (modalMode === 'withdraw') {
          setUser((prev: any) => {
            if (!prev) return prev;
            const next = {
              ...prev,
              pending_withdraw_total: Number(res.pending_withdraw_total ?? Number(prev.pending_withdraw_total ?? 0) + amt),
              ...(Array.isArray(res.saved_cards) ? { saved_cards: res.saved_cards } : {}),
            };
            try {
              localStorage.setItem('mianji_mock_user', JSON.stringify(next));
            } catch {}
            return next;
          });
        }
        notify(
          modalMode === 'deposit'
            ? 'فیش واریزی ثبت و برای تایید دستی مدیریت ارسال شد'
            : res.card_saved
            ? 'درخواست تسویه ثبت شد و کارت مقصد در کیف پول شما ذخیره گردید'
            : 'درخواست تسویه حساب ثبت و مبلغ آن تا زمان واریز رزرو شد',
          'success'
        );
        setAmountInput('');
        setRefInput('');
        setSourceCardInput('');
        setSlipImageUrl('');
        setModalMode(null);
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت درخواست مالی', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelRequest = async (reqId: string) => {
    setCancellingId(reqId);
    try {
      const res = await apiFetch<{
        success: boolean;
        request?: any;
        balances?: { wallet_balance: number; escrow_locked_balance: number; pending_withdraw_total?: number };
      }>(`/api/wallet/requests/${encodeURIComponent(reqId)}/cancel`, {
        method: 'POST',
      });
      if (res.success && res.request) {
        setHistory((prev) => prev.map((h) => (String(h.id) === String(reqId) ? { ...h, ...res.request } : h)));
        if (res.balances) {
          const b = res.balances;
          setUser((prev: any) => {
            if (!prev) return prev;
            const next = {
              ...prev,
              wallet_balance: Number(b.wallet_balance ?? prev.wallet_balance ?? 0),
              escrow_locked_balance: Number(b.escrow_locked_balance ?? prev.escrow_locked_balance ?? 0),
              pending_withdraw_total: Number(b.pending_withdraw_total ?? 0),
            };
            localStorage.setItem('mianji_mock_user', JSON.stringify(next));
            return next;
          });
        }
        notify('درخواست با موفقیت لغو و اعتبار رزروشده آزاد شد', 'info');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در لغو درخواست', 'error');
    } finally {
      setCancellingId(null);
    }
  };

  const copyDestinationText = async (txt: string, label: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      notify(`${label} کپی شد`, 'success');
    } catch {
      notify('امکان کپی خودکار وجود ندارد', 'error');
    }
  };

  const allLedgerEntries = React.useMemo(() => {
    const approvedRequestIds = new Set(
      history.filter((r) => r.status === 'approved' || r.status === 'completed').map((r) => String(r.id))
    );

    const reqItems = history.map((r) => ({
      id: `req_${r.id}`,
      rawId: String(r.id),
      source: 'request',
      type: r.type as string,
      amount: Number(r.amount || 0),
      status: r.status || 'pending',
      title: r.type === 'deposit' ? 'شارژ کیف پول (درخواست)' : 'درخواست تسویه حساب',
      subtitle:
        r.type === 'withdraw' && r.bank_name
          ? `${r.bank_name} • ${r.ref_code || r.ref}`
          : r.ref_code || r.ref || `شماره پیگیری: ${r.id}`,
      contractId: undefined as string | undefined,
      isPositive: r.type === 'deposit',
      timestamp: toMillis(r.created_at || r.createdAt),
      rawDate: r.created_at || r.createdAt,
    }));

    const txItems = ledgerTxs
      .filter((t) => {
        if ((t.type === 'deposit' || t.type === 'withdraw') && t.contract_id && approvedRequestIds.has(String(t.contract_id))) {
          return false;
        }
        return true;
      })
      .map((t) => {
        const cidMatch = typeof t.contract_id === 'string' && t.contract_id.startsWith('M-') ? t.contract_id : undefined;
        const isPos = t.type === 'deposit' || t.type === 'escrow_release' || t.type === 'admin_credit';
        const title =
          t.type === 'escrow_lock'
            ? 'قفل وجه در امانت معامله'
            : t.type === 'escrow_release'
            ? 'آزادسازی و واریز وجه معامله'
            : t.type === 'platform_fee'
            ? 'کارمزد حفاظت میانجی'
            : t.type === 'deposit'
            ? 'شارژ مستقیم کیف پول'
            : t.type === 'withdraw'
            ? 'برداشت و تسویه بانکی'
            : t.type === 'admin_credit'
            ? 'افزایش اعتبار سیستمی'
            : 'تراکنش مالی';

        return {
          id: `tx_${t.id}`,
          source: 'ledger',
          type: t.type as string,
          amount: Number(t.amount || 0),
          status: t.status || 'completed',
          title,
          subtitle: t.description || (cidMatch ? `قرارداد ${cidMatch}` : t.contract_id || t.id),
          contractId: cidMatch,
          isPositive: isPos,
          timestamp: toMillis(t.createdAt || t.created_at),
          rawDate: t.createdAt || t.created_at,
        };
      });

    return [...reqItems, ...txItems].sort((a, b) => b.timestamp - a.timestamp);
  }, [history, ledgerTxs]);

  const txTotals = React.useMemo(() => {
    let inflows = 0;
    let outflows = 0;
    for (const tx of allLedgerEntries) {
      if (tx.status === 'rejected' || tx.status === 'cancelled') continue;
      if (tx.type === 'deposit' || tx.type === 'escrow_release' || tx.type === 'admin_credit') {
        if (tx.status === 'completed' || tx.status === 'approved') inflows += tx.amount;
      } else if (tx.type === 'withdraw' || tx.type === 'escrow_lock' || tx.type === 'platform_fee') {
        outflows += tx.amount;
      }
    }
    return { inflows, outflows };
  }, [allLedgerEntries]);

  const unifiedEntries = React.useMemo(() => {
    const q = normalizeDigits(txSearch).toLowerCase();
    return allLedgerEntries.filter((tx) => {
      if (historyFilter === 'deposits' && tx.type !== 'deposit' && tx.type !== 'admin_credit') return false;
      if (historyFilter === 'withdraws' && tx.type !== 'withdraw') return false;
      if (historyFilter === 'escrow' && tx.type !== 'escrow_lock' && tx.type !== 'escrow_release' && tx.type !== 'platform_fee') return false;
      if (!q) return true;
      return (
        tx.title.toLowerCase().includes(q) ||
        String(tx.subtitle || '').toLowerCase().includes(q) ||
        String(tx.amount || '').includes(q)
      );
    });
  }, [allLedgerEntries, historyFilter, txSearch]);

  const savedOnlyCards = savedCards.filter((c) => c.type === 'card');

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-2xl mx-auto pb-24">
      <div className="flex items-center justify-between px-1">
        <div>
          <h2 className="text-xl font-black text-slate-900 dark:text-white">کیف پول من</h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">مدیریت موجودی، کارت‌های بانکی و تسویه حساب</p>
        </div>
        <div className="w-10 h-10 bg-emerald-500/10 text-emerald-500 rounded-xl flex items-center justify-center border border-emerald-500/20">
          <Wallet size={20} />
        </div>
      </div>

      <EscrowBalanceCard
        availableBalance={availableBalance}
        lockedBalance={lockedBalance}
        pendingWithdrawTotal={pendingWithdrawTotal}
        walletBalance={walletBalance}
        onDeposit={() => {
          setRefInput('');
          setSourceCardInput('');
          setModalMode('deposit');
        }}
        onWithdraw={() => {
          const def = savedCards.find((c) => c.is_default) || savedCards[0];
          setRefInput(def ? (def.type === 'card' ? formatIranianCard(def.number) : def.number) : '');
          setSaveCardOnWithdraw(true);
          setModalMode('withdraw');
        }}
      />

      {/* Saved Bank Cards & Sheba Management inside Wallet */}
      <div className="card-obsidian rounded-[1.75rem] p-4 sm:p-5 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 flex items-center justify-center shrink-0">
              <CreditCard size={18} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-black text-slate-900 dark:text-white">کارت‌ها و شباهای بانکی من</h3>
                <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/[0.06] text-[10px] font-black text-slate-500 dark:text-slate-300 tabular-nums">
                  {savedCards.length} / 10
                </span>
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                ثبت و مدیریت شماره کارت شتاب یا شبای بانکی برای تسویه سریع و واریز آسان
              </p>
            </div>
          </div>
          {savedCards.length < 10 && (
            <button
              type="button"
              onClick={() => openAddCardModal(false)}
              className="h-9 px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black flex items-center gap-1.5 shadow-sm shadow-blue-600/20 active:scale-95 transition-all shrink-0"
            >
              <Plus size={14} />
              <span>افزودن کارت</span>
            </button>
          )}
        </div>

        {savedCards.length === 0 ? (
          <div className="p-5 rounded-2xl bg-slate-50 dark:bg-[#0e1420] border border-dashed border-slate-200 dark:border-white/[0.1] text-center space-y-3">
            <div className="w-11 h-11 rounded-2xl bg-blue-600/10 text-blue-500 mx-auto flex items-center justify-center">
              <CreditCard size={20} />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-black text-slate-800 dark:text-slate-100">هنوز شماره کارت یا شبای بانکی ثبت نکرده‌اید</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed">
                با ثبت کارت بانکی ۱۶ رقمی یا شماره شبا (IR)، هنگام درخواست تسویه نیازی به وارد کردن مجدد اطلاعات بانکی نخواهید داشت.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openAddCardModal(false)}
              className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black inline-flex items-center gap-1.5 active:scale-95 transition-all"
            >
              <Plus size={14} />
              <span>ثبت اولین کارت یا شبا</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {savedCards.map((card) => {
              const displayFormatted =
                card.type === 'card'
                  ? formatIranianCard(card.number)
                  : formatShebaDisplay(card.number);
              const isConfirmingDel = confirmDeleteCardId === card.id;
              return (
                <div
                  key={card.id}
                  className={`p-3.5 rounded-2xl border transition-all flex flex-col justify-between gap-3 ${
                    card.is_default
                      ? 'bg-gradient-to-br from-blue-600/12 via-blue-500/5 to-transparent border-blue-500/45 shadow-sm'
                      : 'bg-slate-50/90 dark:bg-[#0e1420] border-slate-200/80 dark:border-white/[0.08]'
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="px-2 py-0.5 rounded-md bg-white/90 dark:bg-white/[0.07] border border-slate-200/70 dark:border-white/[0.08] text-[10px] font-black text-slate-800 dark:text-white truncate">
                          {card.bank_name || (card.type === 'sheba' ? 'حساب شبا' : 'کارت بانکی')}
                        </span>
                        <span className="text-[9px] font-bold text-slate-400 shrink-0">
                          {card.type === 'sheba' ? 'شبا' : 'شتاب'}
                        </span>
                      </div>
                      {card.is_default && (
                        <span className="px-2 py-0.5 rounded-md bg-blue-600 text-white text-[9px] font-black shrink-0">
                          کارت پیش‌فرض
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 bg-white/80 dark:bg-[#131924] rounded-xl px-2.5 py-2 border border-slate-200/70 dark:border-white/[0.07]">
                      <span
                        dir="ltr"
                        className="font-mono text-xs font-black tracking-wide text-slate-900 dark:text-white tabular-nums truncate"
                      >
                        {displayFormatted}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyDestinationText(card.number, card.type === 'sheba' ? 'شماره شبا' : 'شماره کارت')}
                        className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-white/[0.07] hover:bg-blue-600 hover:text-white text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0 transition-colors"
                        title="کپی شماره"
                      >
                        <Copy size={12} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[10px] px-0.5">
                      <span className="font-bold text-slate-600 dark:text-slate-300 truncate">
                        {card.holder_name ? `به نام: ${card.holder_name}` : card.label}
                      </span>
                      {card.holder_name && card.label && card.label !== card.bank_name && (
                        <span className="text-slate-400 truncate max-w-[45%]">{card.label}</span>
                      )}
                    </div>
                  </div>

                  {isConfirmingDel ? (
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-rose-500/20">
                      <span className="text-[10px] font-black text-rose-500">کارت حذف شود؟</span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={cardBusy}
                          onClick={() => handleDeleteSavedCard(card.id)}
                          className="h-7 px-2.5 rounded-lg bg-rose-600 text-white text-[10px] font-black disabled:opacity-50"
                        >
                          حذف قطعی
                        </button>
                        <button
                          type="button"
                          disabled={cardBusy}
                          onClick={() => setConfirmDeleteCardId(null)}
                          className="h-7 px-2.5 rounded-lg bg-slate-200 dark:bg-white/10 text-slate-700 dark:text-slate-200 text-[10px] font-black"
                        >
                          انصراف
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-1.5 pt-2 border-t border-slate-200/70 dark:border-white/[0.06]">
                      <button
                        type="button"
                        onClick={() => {
                          setRefInput(card.type === 'card' ? formatIranianCard(card.number) : card.number);
                          setSaveCardOnWithdraw(false);
                          setModalMode('withdraw');
                        }}
                        className="h-7 px-2.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-600 hover:text-white text-emerald-600 dark:text-emerald-400 text-[10px] font-black transition-colors"
                      >
                        برداشت به این حساب
                      </button>
                      <div className="flex items-center gap-1">
                        {!card.is_default && (
                          <button
                            type="button"
                            disabled={cardBusy}
                            onClick={() => handleSetDefaultCard(card.id)}
                            className="h-7 px-2 rounded-lg bg-white dark:bg-white/[0.07] border border-slate-200 dark:border-white/[0.08] text-[10px] font-black text-blue-600 dark:text-blue-300 hover:bg-blue-600 hover:text-white transition-colors"
                          >
                            پیش‌فرض
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={cardBusy}
                          onClick={() => openEditCardModal(card)}
                          className="w-7 h-7 rounded-lg bg-white dark:bg-white/[0.07] border border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300 hover:text-blue-500 flex items-center justify-center"
                          title="ویرایش عنوان / نام صاحب کارت"
                        >
                          <Edit3 size={12} />
                        </button>
                        <button
                          type="button"
                          disabled={cardBusy}
                          onClick={() => setConfirmDeleteCardId(card.id)}
                          className="w-7 h-7 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-600 hover:text-white flex items-center justify-center transition-colors"
                          title="حذف کارت"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Always-Visible Transaction & Ledger History */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div>
            <h3 className="text-sm font-black text-slate-900 dark:text-white">سابقه تراکنش‌ها و گردش حساب</h3>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">تمام واریزها، تسویه‌ها و عملیات قفل و آزادسازی امانی</p>
          </div>
          <span className="text-[11px] font-black text-slate-500 dark:text-slate-300 tabular-nums">
            {allLedgerEntries.length} تراکنش
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="p-3.5 card-obsidian flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300">مجموع واریز و دریافت</span>
            <span className="text-xs font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
              +{txTotals.inflows.toLocaleString()} ت
            </span>
          </div>
          <div className="p-3.5 card-obsidian flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300">برداشت و قفل امانی</span>
            <span className="text-xs font-black text-slate-800 dark:text-slate-200 tabular-nums">
              -{txTotals.outflows.toLocaleString()} ت
            </span>
          </div>
        </div>

        <div className="p-3 card-obsidian space-y-2.5">
          <div className="relative">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={txSearch}
              onChange={(e) => setTxSearch(e.target.value)}
              placeholder="جستجو در کد پیگیری، شناسه قرارداد (#M-...) یا مبلغ..."
              className="input-refined !h-10 pr-9 pl-7 text-[14px]"
            />
            {txSearch && (
              <button
                type="button"
                onClick={() => setTxSearch('')}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-white p-1"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {[
              { id: 'all', label: 'همه' },
              { id: 'deposits', label: 'واریزها' },
              { id: 'withdraws', label: 'تسویه و برداشت' },
              { id: 'escrow', label: 'امانی قراردادها' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setHistoryFilter(tab.id as any)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-black transition-colors whitespace-nowrap shrink-0 ${
                  historyFilter === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-100 dark:bg-white/[0.06] text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="card-obsidian rounded-[1.75rem] divide-y divide-slate-100 dark:divide-white/10 overflow-hidden">
          {unifiedEntries.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <CreditCard size={24} className="mx-auto text-slate-400 dark:text-slate-500" />
              <p className="text-xs font-black text-slate-700 dark:text-slate-200">
                {allLedgerEntries.length === 0 ? 'هنوز تراکنش مالی در این حساب ثبت نشده است' : 'تراکنشی مطابق جستجو یا فیلتر فعلی پیدا نشد'}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {allLedgerEntries.length === 0
                  ? 'با شارژ کیف پول، ثبت تسویه یا قفل امن وجه در قراردادها، جزئیات گردش حساب اینجا نمایش داده می‌شود.'
                  : 'فیلتر دسته یا متن جستجو را تغییر دهید.'}
              </p>
            </div>
          ) : (
            unifiedEntries.map((tx: any) => {
              const isOk = tx.status === 'completed' || tx.status === 'approved';
              const isRejected = tx.status === 'rejected';
              const isCancelled = tx.status === 'cancelled';
              const isPendingReq = tx.source === 'request' && tx.status === 'pending';
              const isLock = tx.type === 'escrow_lock';
              return (
                <div key={tx.id} className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs font-black text-slate-900 dark:text-white">{tx.title}</p>
                      <span
                        className={`text-xs font-black tabular-nums ${
                          isLock
                            ? 'text-amber-600 dark:text-amber-300'
                            : tx.isPositive
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-slate-700 dark:text-slate-200'
                        }`}
                        dir="ltr"
                      >
                        {tx.isPositive ? '+' : '-'}{Number(tx.amount).toLocaleString()} ت
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300 truncate">{tx.subtitle}</p>
                    <div className="flex items-center gap-2 text-[9px] text-slate-400 tabular-nums">
                      {tx.rawDate && <span>{formatDateTimeFa(tx.rawDate)}</span>}
                      {tx.contractId && onOpenContract && (
                        <button
                          type="button"
                          onClick={() => onOpenContract(tx.contractId)}
                          className="text-blue-600 dark:text-blue-300 font-black hover:underline"
                        >
                          مشاهده قرارداد {tx.contractId}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isPendingReq && tx.rawId && (
                      <button
                        type="button"
                        disabled={cancellingId === tx.rawId}
                        onClick={() => setPendingCancelReq(tx)}
                        className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 text-[10px] font-black transition-colors disabled:opacity-50"
                      >
                        {cancellingId === tx.rawId ? '...' : 'لغو درخواست'}
                      </button>
                    )}
                    <span
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-black shrink-0 ${
                        isLock
                          ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                          : isOk
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : isRejected
                          ? 'bg-rose-500/15 text-rose-500'
                          : isCancelled
                          ? 'bg-slate-200/80 dark:bg-white/10 text-slate-500 dark:text-slate-400'
                          : 'bg-amber-500/15 text-amber-500'
                      }`}
                    >
                      {isLock ? 'قفل در امانت' : isOk ? 'تایید شد' : isRejected ? 'رد شد' : isCancelled ? 'لغو شد' : 'در حال بررسی'}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Add / Edit Bank Card or Sheba Modal inside Wallet */}
      <AnimatePresence>
        {cardModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !cardBusy && setCardModalOpen(false)}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[550] flex items-center justify-center p-5"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-6 space-y-4 relative shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <button
                type="button"
                onClick={() => {
                  setCardModalOpen(false);
                  setEditingCard(null);
                  setReopenWithdrawAfterCardAdd(false);
                }}
                className="absolute top-5 left-5 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
              >
                <X size={18} />
              </button>

              <div className="text-right space-y-1 pt-1">
                <h3 className="text-base font-black text-slate-900 dark:text-white">
                  {editingCard ? 'ویرایش مشخصات کارت / شبا' : 'افزودن شماره کارت یا شبا'}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-300">
                  {editingCard
                    ? 'عنوان نمایشی، نام صاحب حساب و وضعیت پیش‌فرض را تغییر دهید'
                    : 'شماره کارت ۱۶ رقمی شتاب یا شبای ۲۴ رقمی (IR...) متعلق به خودتان را وارد کنید'}
                </p>
              </div>

              <div className="space-y-3 text-right">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300 px-1">
                    شماره کارت ۱۶ رقمی یا شماره شبا (IR)
                  </label>
                  <input
                    type="text"
                    dir="ltr"
                    disabled={Boolean(editingCard)}
                    value={cardNumberInput}
                    onChange={(e) => setCardNumberInput(formatCardInputLive(e.target.value))}
                    placeholder="6037-9911-2233-4457  یا  IR..."
                    className="input-refined text-center font-mono tabular-nums text-[14px] disabled:opacity-65"
                  />
                  {!editingCard && cardInputValidation && (
                    <p className={`text-[10px] font-bold text-center ${cardInputValidation.valid ? 'text-emerald-500' : 'text-rose-500'}`}>
                      {cardInputValidation.valid
                        ? `${cardInputValidation.kind === 'sheba' ? 'شماره شبا معتبر است' : 'شماره کارت معتبر است'}${
                            detectIranianBankName(cardInputValidation.normalized || '')
                              ? ` (${detectIranianBankName(cardInputValidation.normalized || '')})`
                              : ''
                          }`
                        : cardInputValidation.error}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300 px-1">
                    نام و نام خانوادگی صاحب کارت / حساب
                  </label>
                  <input
                    type="text"
                    value={cardHolderInput}
                    onChange={(e) => setCardHolderInput(e.target.value)}
                    placeholder="مثلاً علی محمدی (به نام خودتان)"
                    className="input-refined text-[14px]"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300 px-1">
                    عنوان دلخواه (اختیاری)
                  </label>
                  <input
                    type="text"
                    value={cardLabelInput}
                    onChange={(e) => setCardLabelInput(e.target.value)}
                    placeholder="مثلاً کارت اصلی، کارت حقوق یا بانک ملت"
                    className="input-refined text-[14px]"
                  />
                </div>

                <label className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] cursor-pointer">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-200">
                    انتخاب به‌عنوان کارت پیش‌فرض برداشت وجه
                  </span>
                  <input
                    type="checkbox"
                    checked={cardMakeDefault}
                    onChange={(e) => setCardMakeDefault(e.target.checked)}
                    className="w-4 h-4 accent-blue-600 rounded"
                  />
                </label>
              </div>

              <button
                type="button"
                disabled={cardBusy || (!editingCard && !cardInputValidation?.valid)}
                onClick={handleSaveCardModal}
                className="w-full h-12 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs shadow-lg shadow-blue-600/20 active:scale-95 transition-all disabled:opacity-50"
              >
                {cardBusy
                  ? 'در حال ذخیره...'
                  : editingCard
                  ? 'ذخیره تغییرات کارت'
                  : 'ثبت کارت در کیف پول'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {modalMode && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/80 backdrop-blur-md z-[500] flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-7 space-y-4 relative shadow-2xl dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] max-h-[90vh] overflow-y-auto">
              <button
                onClick={() => {
                  setModalMode(null);
                  setSlipImageUrl('');
                  setSourceCardInput('');
                }}
                className="absolute top-5 left-5 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
              >
                <X size={20} />
              </button>
              <div className="text-center pt-3">
                <h3 className="text-lg font-black text-slate-900 dark:text-white">
                  {modalMode === 'deposit' ? 'واریز کارت‌به‌کارت و ارسال فیش' : 'درخواست تسویه حساب'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-300 mt-1">
                  {modalMode === 'deposit'
                    ? 'ابتدا مبلغ را به کارت مقصد واریز کرده و سپس کد پیگیری و تصویر فیش را ثبت کنید'
                    : `حداکثر قابل برداشت: ${availableBalance.toLocaleString()} تومان`}
                </p>
              </div>
              {modalMode === 'deposit' && (
                platformLimits?.deposit_card_number ? (
                  <div className="p-3.5 rounded-2xl bg-blue-600/10 border border-blue-500/25 space-y-2 text-right">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-black text-blue-600 dark:text-blue-300">حساب مقصد واریز (کارت‌به‌کارت)</span>
                      {detectIranianBankName(platformLimits.deposit_card_number) && (
                        <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300">
                          {detectIranianBankName(platformLimits.deposit_card_number)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 bg-white/80 dark:bg-[#0e1420] rounded-xl px-3 py-2 border border-slate-200/80 dark:border-white/[0.08]">
                      <span dir="ltr" className="font-sans text-sm font-black tracking-wider text-slate-900 dark:text-white tabular-nums">
                        {formatIranianCard(platformLimits.deposit_card_number)}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyDestinationText(String(platformLimits.deposit_card_number).replace(/[^0-9]/g, ''), 'شماره کارت مقصد')}
                        className="h-7 px-2.5 rounded-lg bg-blue-600 text-white text-[10px] font-black flex items-center gap-1 shrink-0 active:scale-95"
                      >
                        <Copy size={11} /> کپی کارت
                      </button>
                    </div>
                    {platformLimits.deposit_card_holder && (
                      <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                        به نام: <span className="font-black">{platformLimits.deposit_card_holder}</span>
                      </p>
                    )}
                    {platformLimits.deposit_sheba && (
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span dir="ltr" className="font-sans text-[11px] text-slate-600 dark:text-slate-300 truncate tabular-nums">
                          {platformLimits.deposit_sheba}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyDestinationText(String(platformLimits.deposit_sheba), 'شماره شبا')}
                          className="text-[10px] font-black text-blue-600 dark:text-blue-400 shrink-0 hover:underline"
                        >
                          کپی شبا
                        </button>
                      </div>
                    )}
                    {platformLimits.deposit_note && (
                      <p className="text-[10px] text-slate-500 dark:text-slate-300 leading-relaxed">{platformLimits.deposit_note}</p>
                    )}
                  </div>
                ) : (
                  <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-700 dark:text-amber-300 font-bold leading-relaxed text-right">
                    شماره کارت مقصد هنوز در تنظیمات مدیریت ثبت نشده است. لطفاً پیش از واریز، شماره کارت را از پشتیبانی دریافت کنید.
                  </div>
                )
              )}
              <div className="grid grid-cols-2 gap-2">
                {[500000, 1000000, 5000000, 10000000].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setAmountInput(String(preset))}
                    className="py-2 rounded-xl bg-slate-100 dark:bg-white/10 hover:bg-blue-600 hover:text-white text-[10px] font-black text-slate-700 dark:text-slate-200 tabular-nums transition-all"
                  >
                    {preset.toLocaleString()} تومان
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                <input
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  placeholder="مبلغ به تومان (مثلا 500000)"
                  value={amountInput}
                  onChange={(e) => setAmountInput(normalizeDigits(e.target.value).replace(/[^0-9]/g, ''))}
                  className="input-refined text-center font-sans tabular-nums"
                />
                {modalMode === 'withdraw' && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] font-black text-slate-500 dark:text-slate-300">
                        {savedCards.length > 0 ? 'انتخاب سریع از کارت‌ها و شباهای من:' : 'کارت یا شبای مقصد:'}
                      </span>
                      {savedCards.length < 10 && (
                        <button
                          type="button"
                          onClick={() => {
                            setModalMode(null);
                            openAddCardModal(true);
                          }}
                          className="text-[10px] font-black text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
                        >
                          <Plus size={11} /> افزودن کارت
                        </button>
                      )}
                    </div>
                    {savedCards.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {savedCards.map((card) => {
                          const selected =
                            normalizeDigits(refInput).replace(/[^A-Za-z0-9]/g, '').toUpperCase() === card.number;
                          return (
                            <button
                              key={card.id}
                              type="button"
                              onClick={() =>
                                setRefInput(card.type === 'card' ? formatIranianCard(card.number) : card.number)
                              }
                              className={`px-2.5 py-1.5 rounded-xl text-[10px] font-black border transition-all flex items-center gap-1.5 ${
                                selected
                                  ? 'bg-blue-600 text-white border-blue-500 shadow-sm'
                                  : 'bg-slate-50 dark:bg-[#18202e] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-white/[0.08] hover:border-blue-500/50'
                              }`}
                            >
                              <CreditCard size={12} />
                              <span>{card.bank_name || card.label}</span>
                              <span dir="ltr" className="font-sans tabular-nums opacity-85">
                                {card.type === 'sheba' ? `...${card.number.slice(-6)}` : `...${card.number.slice(-4)}`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                <input
                  type="text"
                  dir="ltr"
                  placeholder={modalMode === 'deposit' ? 'شماره پیگیری / ارجاع فیش (الزامی)' : 'شماره شبا (IR...) یا کارت ۱۶ رقمی'}
                  value={refInput}
                  onChange={(e) =>
                    setRefInput(
                      modalMode === 'withdraw'
                        ? formatCardInputLive(e.target.value)
                        : normalizeDigits(e.target.value)
                    )
                  }
                  className="input-refined text-center font-sans tabular-nums"
                />
                {modalMode === 'withdraw' && payoutCheck && (
                  <p className={`text-[10px] font-bold text-center ${payoutCheck.valid ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {payoutCheck.valid
                      ? `${payoutCheck.kind === 'sheba' ? 'شماره شبا معتبر است' : 'شماره کارت بانکی معتبر است'}${
                          detectIranianBankName(payoutCheck.normalized || '')
                            ? ` (${detectIranianBankName(payoutCheck.normalized || '')})`
                            : ''
                        }`
                      : payoutCheck.error}
                  </p>
                )}
                {modalMode === 'withdraw' && isWithdrawDestNew && savedCards.length < 10 && (
                  <label className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-blue-500/10 border border-blue-500/20 cursor-pointer">
                    <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                      ذخیره این کارت/شبا در کیف پول برای برداشت‌های بعدی
                    </span>
                    <input
                      type="checkbox"
                      checked={saveCardOnWithdraw}
                      onChange={(e) => setSaveCardOnWithdraw(e.target.checked)}
                      className="w-4 h-4 accent-blue-600 rounded"
                    />
                  </label>
                )}
                {modalMode === 'deposit' && (
                  <div className="space-y-2.5">
                    <div className="space-y-1.5">
                      <span className="text-[10px] font-bold text-slate-500 dark:text-slate-300 block px-1">
                        کارت مبدأ واریز (اختیاری — برای تطبیق سریع‌تر فیش):
                      </span>
                      {savedOnlyCards.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {savedOnlyCards.map((card) => {
                            const selected =
                              normalizeDigits(sourceCardInput).replace(/[^0-9]/g, '') === card.number;
                            return (
                              <button
                                key={card.id}
                                type="button"
                                onClick={() => setSourceCardInput(formatIranianCard(card.number))}
                                className={`px-2 py-1 rounded-lg text-[10px] font-black border transition-all flex items-center gap-1 ${
                                  selected
                                    ? 'bg-blue-600 text-white border-blue-500'
                                    : 'bg-slate-50 dark:bg-[#18202e] text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/[0.08]'
                                }`}
                              >
                                <span>{card.bank_name}</span>
                                <span dir="ltr" className="tabular-nums">...{card.number.slice(-4)}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <input
                        type="text"
                        dir="ltr"
                        placeholder="۱۶ رقم یا ۴ رقم آخر کارت مبدأ (اختیاری)"
                        value={sourceCardInput}
                        onChange={(e) => setSourceCardInput(formatCardInputLive(e.target.value).slice(0, 19))}
                        className="input-refined text-center font-sans tabular-nums text-[13px]"
                      />
                      {sourceCardValidation && (
                        <p className={`text-[10px] font-bold text-center ${sourceCardValidation.valid ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {sourceCardValidation.valid
                            ? `کارت مبدأ معتبر${sourceCardValidation.bank ? ` (${sourceCardValidation.bank})` : ''}`
                            : sourceCardValidation.error}
                        </p>
                      )}
                    </div>
                    <input
                      ref={slipFileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleSlipUpload}
                      className="hidden"
                    />
                    {slipImageUrl ? (
                      <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-2">
                        <img src={slipImageUrl} alt="تصویر فیش" className="w-14 h-10 rounded-xl object-cover" />
                        <span className="text-[11px] font-bold text-emerald-500 flex-1">تصویر فیش پیوست شد</span>
                        <button
                          type="button"
                          onClick={() => setSlipImageUrl('')}
                          className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={uploadingSlip}
                        onClick={() => slipFileInputRef.current?.click()}
                        className="w-full h-11 rounded-2xl border border-dashed border-slate-300 dark:border-white/[0.08] bg-slate-50 dark:bg-[#18202e] text-xs font-bold text-slate-600 dark:text-slate-200 flex items-center justify-center gap-2 hover:border-blue-500 transition-colors"
                      >
                        <ImageIcon size={15} />
                        {uploadingSlip ? 'در حال فشرده‌سازی و آپلود...' : 'پیوست تصویر فیش واریزی (الزامی)'}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={handleWalletSubmit}
                disabled={
                  submitting ||
                  uploadingSlip ||
                  (modalMode === 'deposit' && (refInput.trim().length < 4 || !slipImageUrl))
                }
                className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white border border-white/15 rounded-2xl font-black shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:scale-95 transition-all disabled:opacity-50"
              >
                {submitting ? 'در حال ثبت...' : modalMode === 'deposit' ? 'ارسال فیش برای تایید' : 'ثبت درخواست تسویه'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={Boolean(pendingCancelReq)}
        title="لغو درخواست مالی"
        description={
          pendingCancelReq?.type === 'withdraw'
            ? 'با لغو این درخواست تسویه، عملیات واریز متوقف شده و مبلغ رزروشده به موجودی قابل برداشت شما بازمی‌گردد.'
            : 'آیا مطمئن هستید که می‌خواهید این درخواست شارژ کیف پول را لغو کنید؟'
        }
        previewText={
          pendingCancelReq
            ? `${pendingCancelReq.title} — مبلغ: ${Number(pendingCancelReq.amount || 0).toLocaleString()} تومان`
            : undefined
        }
        confirmLabel="بله، درخواست لغو شود"
        cancelLabel="انصراف"
        tone="danger"
        busy={Boolean(pendingCancelReq && cancellingId === pendingCancelReq.rawId)}
        onCancel={() => {
          if (!cancellingId) setPendingCancelReq(null);
        }}
        onConfirm={async () => {
          if (!pendingCancelReq?.rawId) return;
          await handleCancelRequest(pendingCancelReq.rawId);
          setPendingCancelReq(null);
        }}
      />
    </motion.div>
  );
}

function ProfileView({ user, setUser, contracts, setView, onLogout, onOpenModal, notify }: any) {
  const completedCount = (contracts || []).filter((c: any) => c.status === 'completed').length;
  const [recentReviews, setRecentReviews] = useState<DealReview[]>([]);
  const [ratingStats, setRatingStats] = useState({
    avg: Number(user?.rating_avg || 0),
    count: Number(user?.rating_count || 0),
  });

  // Profile Edit Modal State
  const [showEditModal, setShowEditModal] = useState(false);
  const [editName, setEditName] = useState(user?.full_name || '');
  const [editUsername, setEditUsername] = useState(user?.username || '');
  const [editAvatarUrl, setEditAvatarUrl] = useState(user?.avatar_url || '');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);

  // Saved Bank Cards/Sheba Modal State
  const [showCardsModal, setShowCardsModal] = useState(false);
  const [cardNumberInput, setCardNumberInput] = useState('');
  const [cardHolderInput, setCardHolderInput] = useState(user?.full_name || '');
  const [cardLabelInput, setCardLabelInput] = useState('');
  const [cardBusy, setCardBusy] = useState(false);
  const [pendingDeleteCard, setPendingDeleteCard] = useState<SavedBankMethod | null>(null);

  const savedCards: SavedBankMethod[] = Array.isArray(user?.saved_cards) ? user.saved_cards : [];

  const cardInputValidation = React.useMemo(
    () => (cardNumberInput.trim() ? validateIranianPayoutDestination(cardNumberInput) : null),
    [cardNumberInput]
  );

  useEffect(() => {
    setRatingStats({
      avg: Number(user?.rating_avg || 0),
      count: Number(user?.rating_count || 0),
    });
    if (!user?.id) return;
    apiFetch<{ success: boolean; rating_avg?: number; rating_count?: number; reviews?: DealReview[] }>(
      `/api/users/${encodeURIComponent(String(user.id))}/reviews`
    )
      .then((res) => {
        if (res.success) {
          setRatingStats({ avg: Number(res.rating_avg || 0), count: Number(res.rating_count || 0) });
          if (Array.isArray(res.reviews)) setRecentReviews(res.reviews);
        }
      })
      .catch(() => {});
  }, [user?.id, user?.rating_avg, user?.rating_count]);

  const openEditProfile = () => {
    setEditName(user?.full_name || '');
    setEditUsername(user?.username || '');
    setEditAvatarUrl(user?.avatar_url || '');
    setShowEditModal(true);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const url = await uploadMediaFile(file, file.name || 'avatar.webp');
      setEditAvatarUrl(url);
      notify?.('تصویر آواتار آماده ذخیره است', 'success');
    } catch (err: any) {
      notify?.(err?.message || 'خطا در آپلود آواتار', 'error');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSaveProfile = async () => {
    const cleanName = editName.trim();
    if (cleanName.length < 2) {
      notify?.('نام و نام خانوادگی باید حداقل ۲ کاراکتر باشد', 'error');
      return;
    }
    const cleanUsername = editUsername.trim().replace(/^@+/, '').toLowerCase();
    if (cleanUsername && !/^[a-z0-9_]{3,24}$/.test(cleanUsername)) {
      notify?.('نام کاربری باید ۳ تا ۲۴ کاراکتر انگلیسی، عدد یا _ باشد', 'error');
      return;
    }

    setSavingProfile(true);
    try {
      const res = await apiFetch<{ success: boolean; user?: any }>('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          full_name: cleanName,
          username: cleanUsername || null,
          avatar_url: editAvatarUrl || '',
        }),
      });
      if (res?.success && res.user) {
        setUser?.((prev: any) => {
          const next = { ...prev, ...res.user };
          try {
            localStorage.setItem('mianji_mock_user', JSON.stringify(next));
          } catch {}
          return next;
        });
        setShowEditModal(false);
        notify?.('اطلاعات پروفایل با موفقیت ذخیره شد', 'success');
      }
    } catch (err: any) {
      notify?.(err?.message || 'خطا در ذخیره پروفایل', 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleAddSavedCard = async () => {
    const check = validateIranianPayoutDestination(cardNumberInput);
    if (!check.valid || !check.normalized) {
      notify?.(check.error || 'شماره کارت یا شبا معتبر نیست', 'error');
      return;
    }
    setCardBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; saved_cards?: SavedBankMethod[] }>('/api/profile/cards', {
        method: 'POST',
        body: JSON.stringify({
          number: check.normalized,
          label: cardLabelInput.trim() || undefined,
          holder_name: cardHolderInput.trim() || undefined,
        }),
      });
      if (res?.success && Array.isArray(res.saved_cards)) {
        setUser?.((prev: any) => {
          const next = { ...prev, saved_cards: res.saved_cards };
          try {
            localStorage.setItem('mianji_mock_user', JSON.stringify(next));
          } catch {}
          return next;
        });
        setCardNumberInput('');
        setCardLabelInput('');
        notify?.('روش تسویه بانکی با موفقیت ذخیره شد', 'success');
      }
    } catch (err: any) {
      notify?.(err?.message || 'خطا در ذخیره شماره کارت یا شبا', 'error');
    } finally {
      setCardBusy(false);
    }
  };

  const handleSetDefaultCard = async (cardId: string) => {
    setCardBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; saved_cards?: SavedBankMethod[] }>(
        `/api/profile/cards/${encodeURIComponent(cardId)}/default`,
        { method: 'PATCH' }
      );
      if (res?.success && Array.isArray(res.saved_cards)) {
        setUser?.((prev: any) => {
          const next = { ...prev, saved_cards: res.saved_cards };
          try {
            localStorage.setItem('mianji_mock_user', JSON.stringify(next));
          } catch {}
          return next;
        });
        notify?.('روش تسویه پیش‌فرض تغییر یافت', 'success');
      }
    } catch (err: any) {
      notify?.(err?.message || 'خطا در تنظیم کارت پیش‌فرض', 'error');
    } finally {
      setCardBusy(false);
    }
  };

  const handleDeleteSavedCard = async (cardId: string) => {
    setCardBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; saved_cards?: SavedBankMethod[] }>(
        `/api/profile/cards/${encodeURIComponent(cardId)}`,
        { method: 'DELETE' }
      );
      if (res?.success && Array.isArray(res.saved_cards)) {
        setUser?.((prev: any) => {
          const next = { ...prev, saved_cards: res.saved_cards };
          try {
            localStorage.setItem('mianji_mock_user', JSON.stringify(next));
          } catch {}
          return next;
        });
        notify?.('کارت / شبا از حساب شما حذف شد', 'info');
      }
    } catch (err: any) {
      notify?.(err?.message || 'خطا در حذف کارت / شبا', 'error');
    } finally {
      setCardBusy(false);
    }
  };

  const profileMenu = [
    { icon: <Wallet size={16} />, label: 'مدیریت کیف پول', desc: 'شارژ و برداشت موجودی', action: () => setView('wallet') },
    {
      icon: <CreditCard size={16} />,
      label: 'کارت‌ها و شباهای بانکی',
      desc: 'مدیریت حساب‌های مقصد تسویه سریع',
      badge: savedCards.length > 0 ? `${savedCards.length} روش ثبت‌شده` : 'ثبت نشده',
      badgeColor: savedCards.length > 0 ? 'text-blue-500' : 'text-slate-400',
      action: () => setShowCardsModal(true),
    },
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
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-4 max-w-2xl mx-auto pb-24">
      <div className="card-refined p-6 md:p-7 flex flex-col items-center text-center space-y-4 relative">
        <button
          type="button"
          onClick={openEditProfile}
          className="absolute top-4 left-4 h-9 px-3 rounded-xl bg-slate-100 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] text-[11px] font-black text-slate-700 dark:text-slate-200 flex items-center gap-1.5 hover:border-blue-500/40 active:scale-95 transition-all"
        >
          <Edit3 size={13} />
          <span>ویرایش پروفایل</span>
        </button>

        <div className="relative cursor-pointer" onClick={openEditProfile}>
          <div className="w-20 h-20 rounded-2xl bg-blue-600 flex items-center justify-center text-white font-black text-2xl shadow-lg border-4 border-white dark:border-[#0b0f17] overflow-hidden">
            {user?.avatar_url ? (
              <img src={user.avatar_url} alt={user.full_name || 'آواتار'} className="w-full h-full object-cover" />
            ) : (
              user?.full_name?.[0] || 'U'
            )}
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-emerald-500 rounded-full border-4 border-white dark:border-[#0b0f17] flex items-center justify-center text-white shadow-md">
            <ShieldCheck size={12} fill="currentColor" />
          </div>
        </div>
        <div className="relative z-10 space-y-1">
          <h2 className="text-lg font-black text-slate-900 dark:text-white">{user?.full_name || 'کاربر مهمان'}</h2>
          {user?.username && (
            <p className="text-xs font-mono font-bold text-blue-600 dark:text-blue-400" dir="ltr">
              @{user.username}
            </p>
          )}
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono" dir="ltr">
            {user?.phone_number || '09xxxxxxxxx'}
          </p>
        </div>
        <span className="text-[10px] font-black text-blue-600 dark:text-slate-400 uppercase tracking-widest">
          {user?.role === 'owner' ? 'Platform Owner' : user?.role === 'admin' ? 'Platform Admin' : 'Verified Member'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="card-refined p-4 space-y-1.5">
          <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase block">احراز هویت</span>
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={14} className="text-blue-500 shrink-0" fill="currentColor" />
            <span className="text-xs md:text-sm font-black text-slate-900 dark:text-white truncate">{user?.kyc_status === 'verified' ? 'تایید شده' : 'در بررسی'}</span>
          </div>
        </div>
        <div className="card-refined p-4 space-y-1.5">
          <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase block">معاملات موفق</span>
          <div className="flex items-center gap-1.5">
            <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
            <span className="text-xs md:text-sm font-black text-slate-900 dark:text-white tabular-nums">{completedCount}</span>
          </div>
        </div>
        <div className="card-refined p-4 space-y-1.5">
          <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase block">امتیاز کاربران</span>
          <div className="flex items-center gap-1.5">
            <Star size={14} className="fill-amber-400 text-amber-400 shrink-0" />
            <span className="text-xs md:text-sm font-black text-slate-900 dark:text-white tabular-nums">
              {ratingStats.count > 0 ? `${ratingStats.avg.toFixed(1)} (${ratingStats.count})` : '—'}
            </span>
          </div>
        </div>
      </div>

      {recentReviews.length > 0 && (
        <div className="card-refined p-5 space-y-3">
          <h3 className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
            <Star size={14} className="fill-amber-400 text-amber-400" />
            بازخوردهای اخیر طرفین معامله
          </h3>
          <div className="space-y-2">
            {recentReviews.slice(0, 5).map((rev) => (
              <div key={rev.id} className="p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.06] space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-black text-slate-800 dark:text-white">{rev.reviewer_name}</span>
                  <span className="font-black text-amber-500 tabular-nums">{rev.score} ★</span>
                </div>
                {rev.comment && <p className="text-[11px] text-slate-600 dark:text-slate-300">{rev.comment}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card-refined divide-y divide-slate-100 dark:divide-white/[0.06]">
        {profileMenu.map((item, idx) => (
          <button
            key={idx}
            onClick={item.action}
            className="w-full p-4 md:p-4.5 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-all active:bg-slate-100 dark:active:bg-white/[0.06] text-right group"
          >
            <div className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-white/[0.05] border border-slate-200/80 dark:border-white/[0.07] flex items-center justify-center text-blue-600 dark:text-slate-200 group-hover:bg-blue-600 group-hover:text-white group-hover:border-blue-600 transition-colors shrink-0">
              {item.icon}
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-black text-slate-900 dark:text-white">{item.label}</span>
                {item.badge && <span className={`text-[9px] font-black uppercase tracking-widest ${item.badgeColor}`}>{item.badge}</span>}
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">{item.desc}</p>
            </div>
            <ChevronLeft size={16} className="text-slate-400 dark:text-slate-500 group-hover:-translate-x-1 transition-transform" />
          </button>
        ))}
      </div>

      <PWAInstallButton variant="card" />

      <button
        onClick={onLogout}
        className="w-full h-12 rounded-2xl bg-rose-500/10 text-rose-500 font-black flex items-center justify-center gap-3 active:scale-95 transition-all border border-rose-500/20 hover:bg-rose-500/15"
      >
        <LogOut size={18} /> خروج از حساب کاربری
      </button>

      <div className="text-center">
        <p className="text-[9px] text-slate-500 uppercase tracking-widest font-bold">Mianji Escrow v2.4.0</p>
      </div>

      {/* Edit Profile Modal */}
      <AnimatePresence>
        {showEditModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !savingProfile && setShowEditModal(false)}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1100] flex items-center justify-center p-5"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-6 space-y-5 relative shadow-2xl"
            >
              <button
                type="button"
                onClick={() => setShowEditModal(false)}
                className="absolute top-5 left-5 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
              >
                <X size={18} />
              </button>

              <div className="text-right space-y-1">
                <h3 className="text-base font-black text-slate-900 dark:text-white">ویرایش مشخصات پروفایل</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-300">نام نمایشی، نام کاربری و تصویر پروفایل خود را به‌روزرسانی کنید</p>
              </div>

              <div className="flex flex-col items-center gap-3">
                <input
                  ref={avatarFileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarUpload}
                  className="hidden"
                />
                <div className="w-20 h-20 rounded-[1.5rem] bg-blue-600 text-white flex items-center justify-center font-black text-2xl overflow-hidden border-2 border-slate-200 dark:border-white/[0.08] shadow-lg">
                  {editAvatarUrl ? (
                    <img src={editAvatarUrl} alt="آواتار" className="w-full h-full object-cover" />
                  ) : (
                    (editName.trim()?.[0] || user?.full_name?.[0] || 'U')
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={uploadingAvatar}
                    onClick={() => avatarFileInputRef.current?.click()}
                    className="h-9 px-3.5 rounded-xl bg-slate-100 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] text-xs font-black text-slate-800 dark:text-white flex items-center gap-1.5 active:scale-95 transition-all"
                  >
                    <Camera size={14} />
                    <span>{uploadingAvatar ? 'در حال آپلود...' : 'انتخاب تصویر آواتار'}</span>
                  </button>
                  {editAvatarUrl && (
                    <button
                      type="button"
                      onClick={() => setEditAvatarUrl('')}
                      className="h-9 px-3 rounded-xl bg-rose-500/10 text-rose-500 border border-rose-500/25 text-xs font-black"
                    >
                      حذف تصویر
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-3 text-right">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300 px-1">نام و نام خانوادگی</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="نام کامل شما..."
                    className="input-refined text-[14px]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300 px-1">نام کاربری (اختیاری - انگلیسی)</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())}
                    placeholder="mianji_user"
                    className="input-refined text-[14px] font-sans text-left"
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={savingProfile || uploadingAvatar}
                onClick={handleSaveProfile}
                className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs active:scale-95 transition-all disabled:opacity-50"
              >
                {savingProfile ? 'در حال ذخیره...' : 'ذخیره تغییرات پروفایل'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Saved Bank Cards / Sheba Modal */}
      <AnimatePresence>
        {showCardsModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !cardBusy && setShowCardsModal(false)}
            className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1100] flex items-center justify-center p-5"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-6 space-y-4 relative shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <button
                type="button"
                onClick={() => setShowCardsModal(false)}
                className="absolute top-5 left-5 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
              >
                <X size={18} />
              </button>

              <div className="text-right space-y-1">
                <h3 className="text-base font-black text-slate-900 dark:text-white">کارت‌ها و شباهای بانکی من</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-300">برای ثبت سریع درخواست تسویه حساب، شماره کارت ۱۶ رقمی یا شبای خود را ذخیره کنید</p>
              </div>

              <div className="space-y-2.5">
                {savedCards.length === 0 ? (
                  <div className="p-5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.08] text-center text-xs text-slate-500 dark:text-slate-300">
                    هنوز کارت یا شبای بانکی ذخیره نشده است.
                  </div>
                ) : (
                  savedCards.map((c) => (
                    <div
                      key={c.id}
                      className={`p-3.5 rounded-2xl border flex items-center justify-between gap-2 ${
                        c.is_default
                          ? 'bg-blue-600/10 border-blue-500/45'
                          : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08]'
                      }`}
                    >
                      <div className="min-w-0 space-y-1 text-right">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-black text-slate-900 dark:text-white">{c.bank_name || c.label}</span>
                          {c.label && c.label !== c.bank_name && (
                            <span className="text-[10px] text-slate-500 dark:text-slate-300">({c.label})</span>
                          )}
                          {c.is_default && (
                            <span className="px-2 py-0.5 rounded-md bg-blue-600 text-white text-[9px] font-black">پیش‌فرض</span>
                          )}
                        </div>
                        <p dir="ltr" className="text-xs font-mono text-slate-700 dark:text-slate-200 truncate">
                          {c.type === 'card' ? formatIranianCard(c.number) : formatShebaDisplay(c.number)}
                        </p>
                        {c.holder_name && (
                          <p className="text-[10px] text-slate-400">به نام: {c.holder_name}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {!c.is_default && (
                          <button
                            type="button"
                            disabled={cardBusy}
                            onClick={() => handleSetDefaultCard(c.id)}
                            className="h-8 px-2.5 rounded-lg bg-white dark:bg-white/10 border border-slate-200 dark:border-white/[0.08] text-[10px] font-black text-blue-600 dark:text-white"
                          >
                            پیش‌فرض
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={cardBusy}
                          onClick={() => setPendingDeleteCard(c)}
                          className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center"
                          title="حذف"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="pt-3 border-t border-slate-200/80 dark:border-white/[0.08] space-y-2.5 text-right">
                <span className="text-xs font-black text-slate-900 dark:text-white block">افزودن کارت یا شبا جدید</span>
                <input
                  type="text"
                  dir="ltr"
                  value={cardNumberInput}
                  onChange={(e) => setCardNumberInput(formatCardInputLive(e.target.value))}
                  placeholder="شماره کارت ۱۶ رقمی یا IR + 24 رقم شبا"
                  className="input-refined text-center font-sans tabular-nums text-[14px]"
                />
                {cardInputValidation && (
                  <p className={`text-[10px] font-bold text-center ${cardInputValidation.valid ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {cardInputValidation.valid
                      ? `${cardInputValidation.kind === 'sheba' ? 'شماره شبا معتبر است' : 'شماره کارت معتبر است'}${
                          detectIranianBankName(cardInputValidation.normalized || '')
                            ? ` (${detectIranianBankName(cardInputValidation.normalized || '')})`
                            : ''
                        }`
                      : cardInputValidation.error}
                  </p>
                )}
                <input
                  type="text"
                  value={cardHolderInput}
                  onChange={(e) => setCardHolderInput(e.target.value)}
                  placeholder="نام صاحب کارت / حساب (مثلاً علی محمدی)"
                  className="input-refined text-[14px]"
                />
                <input
                  type="text"
                  value={cardLabelInput}
                  onChange={(e) => setCardLabelInput(e.target.value)}
                  placeholder="عنوان دلخواه (مثلاً کارت اصلی یا حساب کاری)"
                  className="input-refined text-[14px]"
                />
                <button
                  type="button"
                  disabled={cardBusy || !cardInputValidation?.valid}
                  onClick={handleAddSavedCard}
                  className="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs active:scale-95 transition-all disabled:opacity-50"
                >
                  {cardBusy ? 'در حال ثبت...' : 'افزودن به روش‌های تسویه'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={Boolean(pendingDeleteCard)}
        title="حذف کارت / شبا بانکی"
        description="آیا از حذف این روش تسویه از حساب خود مطمئن هستید؟"
        previewText={
          pendingDeleteCard
            ? `${pendingDeleteCard.bank_name || pendingDeleteCard.label || 'حساب بانکی'} — ${
                pendingDeleteCard.type === 'card'
                  ? formatIranianCard(pendingDeleteCard.number)
                  : formatShebaDisplay(pendingDeleteCard.number)
              }`
            : undefined
        }
        confirmLabel="بله، حذف شود"
        cancelLabel="انصراف"
        tone="danger"
        busy={cardBusy}
        onCancel={() => {
          if (!cardBusy) setPendingDeleteCard(null);
        }}
        onConfirm={async () => {
          if (!pendingDeleteCard) return;
          await handleDeleteSavedCard(pendingDeleteCard.id);
          setPendingDeleteCard(null);
        }}
      />
    </motion.div>
  );
}

function SupportView({ user, setView, notify, botUsername }: any) {
  const cleanBotUsername = String(botUsername || 'mianji_ir_bot').replace(/^@/, '');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tickets, setTickets] = useState<any[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ success: boolean; tickets?: any[] }>('/api/support/tickets')
      .then((res) => {
        if (!cancelled && res.success && Array.isArray(res.tickets)) {
          setTickets(res.tickets);
        }
      })
      .catch(() => {});

    const offTicket = realtimeClient.on('ticket:updated', (payload: any) => {
      if (!payload?.ticket) return;
      const t = payload.ticket;
      if (String(t.user_id) !== String(user?.id)) return;
      setTickets((prev) => {
        const exists = prev.some((x) => x.id === t.id);
        return exists ? prev.map((x) => (x.id === t.id ? t : x)) : [t, ...prev];
      });
    });

    return () => {
      cancelled = true;
      offTicket();
    };
  }, [user?.id]);

  const submitTicket = async () => {
    if (!subject.trim() || !message.trim()) {
      notify('لطفاً موضوع و متن پیام را وارد کنید', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; ticket?: any }>('/api/support/tickets', {
        method: 'POST',
        body: JSON.stringify({ subject: subject.trim(), message: message.trim() })
      });
      if (res.success && res.ticket) {
        setTickets((prev) => [res.ticket, ...prev.filter((t) => t.id !== res.ticket.id)]);
        setSubject('');
        setMessage('');
        notify('تیکت پشتیبانی ثبت و به تیم پشتیبانی ارسال شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت تیکت پشتیبانی', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 max-w-2xl mx-auto pb-24">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">مرکز پشتیبانی آنلاین</h2>
            <p className="text-[10px] text-blue-600 dark:text-slate-300 font-bold">پاسخگویی سریع تیم میانجی</p>
          </div>
        </div>
        <a
          href={`https://t.me/${cleanBotUsername}`}
          target="_blank"
          rel="noopener noreferrer"
          className="h-9 px-4 bg-blue-600 text-white border border-white/15 rounded-xl text-xs font-black flex items-center gap-1.5 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
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
          className="w-full h-28 bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200/80 dark:border-white/[0.08] rounded-2xl p-4 font-sans text-[14px] font-medium text-slate-900 dark:text-white outline-none focus:border-slate-400 dark:focus:border-blue-500/50 resize-none leading-relaxed"
        />
        <button
          onClick={submitTicket}
          disabled={submitting}
          className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white border border-white/15 rounded-xl font-black text-xs active:scale-95 transition-all shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] disabled:opacity-50"
        >
          {submitting ? 'در حال ارسال...' : 'ارسال تیکت پشتیبانی'}
        </button>
      </div>

      {tickets.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-black text-slate-900 dark:text-white px-2">تیکت‌های ارسالی</h3>
          {tickets.map((t) => (
            <div key={t.id} className="card-refined p-5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-900 dark:text-white">{t.subject}</span>
                <span className={`text-[10px] font-black ${t.status === 'resolved' ? 'text-emerald-500' : 'text-amber-500'}`}>
                  {t.status === 'resolved' ? 'پاسخ داده شده' : 'در انتظار بررسی'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">{t.message}</p>
              {t.reply && (
                <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-700 dark:text-emerald-300 leading-relaxed">
                  <span className="font-black block text-[10px] mb-1">پاسخ پشتیبانی:</span>
                  {t.reply}
                </div>
              )}
              <p className="text-[9px] text-slate-400 font-mono">{t.id} • {formatDateTimeFa(t.created_at)}</p>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// --- Web QR Scanner & Contract Code Lookup Modal ---
function QrScannerModal({ onClose, onScan }: { onClose: () => void; onScan: (res: string) => void }) {
  const [manualInput, setManualInput] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [scanError, setScanError] = useState('');
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const tg = typeof window !== 'undefined' ? (window as any).Telegram?.WebApp : undefined;
  const hasTelegramScanner = Boolean(tg?.showScanQrPopup);

  const stopCamera = async () => {
    const inst = scannerRef.current;
    if (!inst) return;
    try {
      if (inst.isScanning) {
        await inst.stop();
      }
    } catch {}
    try {
      inst.clear();
    } catch {}
    scannerRef.current = null;
    setCameraActive(false);
    setCameraStarting(false);
  };

  useEffect(() => {
    return () => {
      void stopCamera();
    };
  }, []);

  const handleParsedResult = async (raw: string) => {
    const extracted = extractDealInviteFromQr(raw);
    if (!extracted?.contractId) {
      setScanError('کد یا لینک قرارداد معتبر تشخیص داده نشد. مثال: DEV-0508-4821');
      return;
    }
    setScanError('');
    await stopCamera();
    onScan(raw);
  };

  const startCameraScan = async () => {
    setScanError('');
    setCameraStarting(true);
    try {
      await stopCamera();
      const qr = new Html5Qrcode('qr-reader');
      scannerRef.current = qr;
      await qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decodedText) => {
          void handleParsedResult(decodedText);
        },
        () => {}
      );
      setCameraActive(true);
    } catch {
      setScanError('دسترسی به دوربین در دسترس نیست. می‌توانید عکس QR را انتخاب کنید یا کد معامله را پایین وارد نمایید.');
      setCameraActive(false);
    } finally {
      setCameraStarting(false);
    }
  };

  const handleGalleryPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setScanError('');
    try {
      await stopCamera();
      const qr = new Html5Qrcode('qr-reader-file-helper');
      const result = await qr.scanFile(file, false);
      qr.clear();
      await handleParsedResult(result);
    } catch {
      setScanError('در تصویر انتخاب‌شده کد QR خوانا پیدا نشد. مطمئن شوید تصویر واضح است یا کد معامله را دستی وارد کنید.');
    }
  };

  const handleTelegramQr = () => {
    if (!tg?.showScanQrPopup) return;
    setScanError('');
    tg.showScanQrPopup({ text: 'کد QR قرارداد میانجی را اسکن کنید' }, (text: string) => {
      const extracted = extractDealInviteFromQr(text);
      if (extracted?.contractId) {
        tg.closeScanQrPopup?.();
        void handleParsedResult(text);
        return true;
      }
      return false;
    });
  };

  const submitManualCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) {
      setScanError('لطفاً کد معامله (مثل DEV-0508-4821) یا لینک دعوت را وارد کنید.');
      return;
    }
    void handleParsedResult(manualInput);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/85 backdrop-blur-xl z-[300] flex items-center justify-center p-4 sm:p-6 overflow-y-auto"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-5 sm:p-6 space-y-4 relative shadow-2xl dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
      >
        <button
          type="button"
          onClick={() => {
            void stopCamera();
            onClose();
          }}
          className="absolute top-4 left-4 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white z-10"
        >
          <X size={18} />
        </button>

        <div className="text-right space-y-1 pt-1 pl-10">
          <h3 className="text-lg font-black text-slate-900 dark:text-white">اسکن QR یا ورود کد قرارداد</h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
            پیش از پیوستن نفر دوم، جزئیات کامل قرارداد را ببینید و در صورت تایید امضا کنید.
          </p>
        </div>

        {/* Step-by-step quick guide */}
        <div className="p-3 rounded-2xl bg-blue-500/10 border border-blue-500/20 space-y-1.5 text-right text-[11px] text-slate-700 dark:text-slate-200">
          <p className="font-black text-blue-600 dark:text-blue-300">راهنمای سریع مشاهده و امضا:</p>
          <p>۱. دوربین را روی کد QR قرارداد بگیرید، عکس QR را از گالری انتخاب کنید یا کد معامله را پایین بنویسید.</p>
          <p>۲. اطلاعات مبلغ، مراحل و توضیحات پیش از عضویت به شما نمایش داده می‌شود.</p>
          <p>۳. می‌توانید مستقیم امضا کنید یا فقط برای گفتگو به پیش‌نویس بپیوندید.</p>
        </div>

        {/* Camera / Gallery / Telegram Big Easy Buttons */}
        <div className="space-y-2">
          {hasTelegramScanner && (
            <button
              type="button"
              onClick={handleTelegramQr}
              className="w-full h-11 rounded-2xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-black flex items-center justify-center gap-2 shadow-md active:scale-[0.98] transition-all"
            >
              <QrCode size={16} />
              <span>اسکن سریع با دوربین تلگرام</span>
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            {!cameraActive ? (
              <button
                type="button"
                disabled={cameraStarting}
                onClick={startCameraScan}
                className="h-11 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all disabled:opacity-60"
              >
                <Camera size={16} />
                <span>{cameraStarting ? 'در حال اتصال...' : 'اسکن با دوربین'}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void stopCamera()}
                className="h-11 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-black flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all"
              >
                <X size={16} />
                <span>توقف دوربین</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="h-11 rounded-2xl bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 border border-slate-200/80 dark:border-white/[0.08] text-slate-800 dark:text-white text-xs font-black flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all"
            >
              <ImageIcon size={16} />
              <span>انتخاب عکس از گالری</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleGalleryPick}
              className="hidden"
            />
          </div>
        </div>

        {/* Camera Viewport */}
        <div className={cameraActive || cameraStarting ? 'block' : 'hidden'}>
          <div id="qr-reader" className="overflow-hidden rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-black min-h-[220px]" />
          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold text-center mt-1.5">
            کد QR را داخل کادر نگه دارید تا خودکار شناسایی شود
          </p>
        </div>
        <div id="qr-reader-file-helper" className="hidden" />

        {/* Direct Contract Code / Invite Link Entry */}
        <form onSubmit={submitManualCode} className="pt-2 border-t border-slate-200/80 dark:border-white/[0.08] space-y-2.5 text-right">
          <label className="block text-xs font-black text-slate-800 dark:text-slate-100">
            یا وارد کردن دستی کد معامله / لینک دعوت:
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              dir="ltr"
              value={manualInput}
              onChange={(e) => {
                setManualInput(e.target.value);
                if (scanError) setScanError('');
              }}
              placeholder="مثال: DEV-0508-4821"
              className="flex-1 h-11 px-3.5 rounded-xl bg-slate-50 dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.1] text-slate-900 dark:text-white text-xs font-mono font-bold outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              className="h-11 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black shrink-0 active:scale-95 transition-all"
            >
              مشاهده و امضا
            </button>
          </div>
        </form>

        {scanError && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-[11px] font-bold text-rose-600 dark:text-rose-300 text-right leading-relaxed">
            {scanError}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// --- Open-Invite Link / QR Sign Modal ---
function InviteSignModal({
  target,
  isAuthenticated,
  user,
  notify,
  onRequireAuth,
  onClose,
  onSigned,
  onOpenDealDetail,
}: {
  target: { contractId: string; token?: string; deferredForAuth?: boolean };
  isAuthenticated: boolean;
  user: UserProfile | null;
  notify: (msg: string, type?: 'success' | 'error' | 'info') => void;
  onRequireAuth: () => void;
  onClose: () => void;
  onSigned: (deal: any) => void | Promise<void>;
  onOpenDealDetail?: (contractId: string) => void;
}) {
  const [preview, setPreview] = useState<DealInvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    fetchDealInvitePreview(target.contractId, target.token)
      .then((data) => {
        if (!active) return;
        setPreview(data);
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message || 'امکان دریافت اطلاعات قرارداد وجود ندارد.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [target.contractId, target.token, isAuthenticated, user?.id]);

  const handleAction = async (mode: 'join_and_sign' | 'join_only') => {
    if (!isAuthenticated) {
      onRequireAuth();
      return;
    }
    setSubmitting(true);
    try {
      const updated = await claimAndSignDeal(target.contractId, target.token, mode);
      notify(
        mode === 'join_and_sign'
          ? 'قرارداد با موفقیت امضا و به نام شما ثبت شد'
          : 'به پیش‌نویس قرارداد پیوستید',
        'success'
      );
      await onSigned(updated);
    } catch (err: any) {
      notify(err?.message || 'خطا در امضای قرارداد', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const categoryLabel = getCategoryMeta(preview?.category).label;

  const roleLabel =
    preview?.missing_role === 'buyer'
      ? 'خریدار / کارفرما (پرداخت‌کننده وجه)'
      : preview?.missing_role === 'seller'
      ? 'فروشنده / مجری (تحویل‌دهنده)'
      : String(user?.id || '') === String(preview?.buyer_id || '')
      ? 'خریدار / کارفرما'
      : 'فروشنده / مجری';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-[320] flex items-center justify-center p-4 sm:p-6 overflow-y-auto"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 12, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, y: 12, opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-3xl bg-white dark:bg-[#0d121c] border border-slate-200 dark:border-white/[0.08] p-6 sm:p-7 space-y-5 relative shadow-2xl"
      >
        <button
          onClick={onClose}
          className="absolute top-5 left-5 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 pt-1">
          <div className="w-11 h-11 rounded-2xl bg-blue-600/15 border border-blue-500/25 flex items-center justify-center text-blue-500 shrink-0">
            <ShieldCheck size={22} />
          </div>
          <div>
            <span className="text-[10px] font-black text-blue-500 uppercase tracking-wider block">دعوت امضای قرارداد امن</span>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">
              قرارداد {target.contractId}
            </h3>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center space-y-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400">در حال دریافت جزئیات قرارداد...</p>
          </div>
        ) : error ? (
          <div className="p-5 rounded-2xl bg-rose-500/10 border border-rose-500/25 text-center space-y-3">
            <AlertCircle size={28} className="text-rose-500 mx-auto" />
            <p className="text-xs font-bold text-rose-500 leading-relaxed">{error}</p>
            <button
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl bg-slate-200 dark:bg-white/10 text-xs font-black text-slate-800 dark:text-white"
            >
              بستن
            </button>
          </div>
        ) : preview ? (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#131926] border border-slate-200/80 dark:border-white/12 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 block">{categoryLabel}</span>
                  <h4 className="text-sm font-black text-slate-900 dark:text-white mt-0.5">{preview.title}</h4>
                </div>
                <span className="text-sm font-black text-blue-500 shrink-0">
                  {Number(preview.amount || 0).toLocaleString()} تومان
                </span>
              </div>

              {preview.description && (
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-3 border-t border-slate-200/70 dark:border-white/10 pt-2.5">
                  {preview.description}
                </p>
              )}

              <div className="grid grid-cols-2 gap-2.5 pt-1 text-[11px]">
                <div className="p-2.5 rounded-xl bg-white dark:bg-black/25 border border-slate-200/70 dark:border-white/10">
                  <span className="text-[9px] text-slate-400 block">ایجادکننده</span>
                  <span className="font-bold text-slate-800 dark:text-white">{preview.creator_name || 'کاربر میانجی'}</span>
                </div>
                <div className="p-2.5 rounded-xl bg-white dark:bg-black/25 border border-slate-200/70 dark:border-white/10">
                  <span className="text-[9px] text-slate-400 block">نقش شما در معامله</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">{roleLabel}</span>
                </div>
                <div className="p-2.5 rounded-xl bg-white dark:bg-black/25 border border-slate-200/70 dark:border-white/10">
                  <span className="text-[9px] text-slate-400 block">مهلت تحویل</span>
                  <span className="font-bold text-slate-800 dark:text-white">{preview.deadline || 'توافقی'}</span>
                </div>
                <div className="p-2.5 rounded-xl bg-white dark:bg-black/25 border border-slate-200/70 dark:border-white/10">
                  <span className="text-[9px] text-slate-400 block">مهلت بررسی / اصلاحات</span>
                  <span className="font-bold text-slate-800 dark:text-white">
                    {preview.inspection_hours || 48} ساعت • {preview.revisions || '۲ بار'}
                  </span>
                </div>
              </div>

              {(preview.staged_payment ?? preview.is_milestone) && Array.isArray(preview.milestones) && preview.milestones.length > 0 && (
                <div className="pt-2 border-t border-slate-200/70 dark:border-white/10 space-y-1.5">
                  <span className="text-[10px] font-black text-slate-500 dark:text-slate-400 block">
                    پرداخت مرحله‌ای ({preview.milestones.length} مرحله)
                  </span>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {preview.milestones.map((m: any, idx: number) => (
                      <div key={m.id || idx} className="flex items-center justify-between text-[11px] text-slate-700 dark:text-slate-300">
                        <span>{idx + 1}. {m.title}</span>
                        <span className="font-bold">{Number(m.amount || 0).toLocaleString()} ت</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {['completed', 'cancelled'].includes(normalizeDealStatus(preview.status)) ? (
              <div className="p-3.5 rounded-2xl bg-slate-100 dark:bg-white/5 text-center text-xs font-bold text-slate-500">
                این قرارداد پیش‌تر مختومه شده است.
              </div>
            ) : preview.is_caller_creator ? (
              <div className="space-y-3">
                <div className="p-3.5 rounded-2xl bg-blue-500/10 border border-blue-500/25 text-xs font-bold text-blue-600 dark:text-blue-400 leading-relaxed">
                  شما ایجادکننده این قرارداد هستید. کد معامله یا لینک امضا را برای طرف مقابل بفرستید تا پیش از پیوستن آن را مشاهده و امضا کند.
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(preview.contract_id);
                      notify('کد معامله کپی شد', 'success');
                    }}
                    className="h-11 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-black flex items-center justify-center gap-1.5"
                  >
                    <Copy size={14} />
                    <span>کپی کد ({preview.contract_id})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const url = buildDealInviteUrl(preview.contract_id, target.token);
                      navigator.clipboard?.writeText(url);
                      notify('لینک دعوت امضای قرارداد کپی شد', 'success');
                    }}
                    className="h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center justify-center gap-1.5"
                  >
                    <Copy size={14} />
                    <span>کپی لینک امضا</span>
                  </button>
                </div>
                {onOpenDealDetail && (
                  <button
                    type="button"
                    onClick={() => onOpenDealDetail(preview.contract_id)}
                    className="w-full h-10 rounded-xl bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-800 dark:text-white text-xs font-black"
                  >
                    مشاهده صفحه کامل قرارداد
                  </button>
                )}
              </div>
            ) : !isAuthenticated ? (
              <div className="space-y-3">
                <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-[11px] font-bold text-amber-600 dark:text-amber-400 leading-relaxed">
                  برای امضای قانونی و ثبت نهایی این قرارداد به نام خودتان، ابتدا وارد حساب میانجی شوید (پس از ورود همین صفحه به‌صورت خودکار باز می‌شود).
                </div>
                <button
                  onClick={onRequireAuth}
                  className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center justify-center gap-2 shadow-lg shadow-blue-600/25"
                >
                  <ShieldCheck size={16} />
                  <span>ورود و ادامه برای امضای قرارداد</span>
                </button>
              </div>
            ) : preview.can_claim_and_sign ? (
              <div className="space-y-2.5">
                <button
                  disabled={submitting}
                  onClick={() => handleAction('join_and_sign')}
                  className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/25 disabled:opacity-50"
                >
                  <CheckCircle2 size={16} />
                  <span>
                    {submitting
                      ? 'در حال ثبت امضا...'
                      : preview.missing_role !== null
                      ? 'تایید، عضویت و امضای نهایی قرارداد'
                      : 'امضا و تایید قرارداد'}
                  </span>
                </button>
                {preview.missing_role !== null && ['draft', 'pending_party_b'].includes(normalizeDealStatus(preview.status)) && (
                  <button
                    disabled={submitting}
                    onClick={() => handleAction('join_only')}
                    className="w-full h-10 rounded-xl bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-800 dark:text-white text-[11px] font-bold disabled:opacity-50"
                  >
                    فقط پیوستن به پیش‌نویس (بررسی بیشتر در چت)
                  </button>
                )}
              </div>
            ) : (
              <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-center text-xs font-bold text-amber-600 dark:text-amber-400">
                جایگاه طرف مقابل این قرارداد پیش‌تر تکمیل شده است.
              </div>
            )}
          </div>
        ) : null}
      </motion.div>
    </motion.div>
  );
}

// --- Unified Platform Info Modal ---
function PlatformModal({
  type,
  user,
  setUser,
  isDarkMode,
  setIsDarkMode,
  isDebug,
  onToggleDebug,
  pushPermission,
  notifPrefs,
  pushSubCount,
  pushActive,
  onEnablePush,
  onDisablePush,
  onUpdateNotifPrefs,
  onTestPush,
  onSwitchType,
  onClose,
  notify,
  botUsername,
}: any) {
  const cleanBotUsername = String(botUsername || 'mianji_ir_bot').replace(/^@/, '');
  const botLink = `https://t.me/${cleanBotUsername}`;
  const [kycFullName, setKycFullName] = useState(user?.full_name || '');
  const [kycNationalId, setKycNationalId] = useState(user?.national_id || '');
  const [kycBankCard, setKycBankCard] = useState(user?.kyc_bank_card || '');
  const [kycCardUrl, setKycCardUrl] = useState(user?.kyc_id_card_url || '');
  const [kycSelfieUrl, setKycSelfieUrl] = useState(user?.kyc_selfie_url || '');
  const [kycMatchState, setKycMatchState] = useState<{ status?: string; note?: string } | null>(
    user?.kyc_match_status ? { status: user.kyc_match_status, note: user.kyc_match_note } : null
  );
  const [kycCheckingMatch, setKycCheckingMatch] = useState(false);
  const [kycUploading, setKycUploading] = useState<'card' | 'selfie' | null>(null);
  const [kycSubmitting, setKycSubmitting] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionBusyId, setSessionBusyId] = useState<string | null>(null);
  const [pendingRevokeConfirm, setPendingRevokeConfirm] = useState<
    { type: 'single'; session: any } | { type: 'others' } | null
  >(null);
  const kycFileInputRef = useRef<HTMLInputElement | null>(null);
  const kycSelfieInputRef = useRef<HTMLInputElement | null>(null);

  const loadActiveSessions = async () => {
    setSessionsLoading(true);
    try {
      const res = await apiFetch<{ success: boolean; sessions?: any[] }>('/api/auth/sessions');
      if (res?.success && Array.isArray(res.sessions)) {
        setSessions(res.sessions);
      }
    } catch {
      // Keep current list on transient error
    } finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => {
    if (type === 'security') {
      void loadActiveSessions();
    }
  }, [type]);

  const handleRevokeSession = async (sessionId: string) => {
    setSessionBusyId(sessionId);
    try {
      const res = await apiFetch<{ success: boolean }>(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      if (res?.success) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        notify('نشست دستگاه مورد نظر با موفقیت بسته شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در بستن نشست', 'error');
    } finally {
      setSessionBusyId(null);
    }
  };

  const handleRevokeOtherSessions = async () => {
    setSessionBusyId('__others__');
    try {
      const res = await apiFetch<{ success: boolean; sessionToken?: string; revokedCount?: number }>(
        '/api/auth/sessions/revoke-others',
        { method: 'POST' }
      );
      if (res?.success) {
        if (res.sessionToken) {
          localStorage.setItem('mianji_session_token', res.sessionToken);
          realtimeClient.updateSessionToken(res.sessionToken);
        }
        await loadActiveSessions();
        notify('تمامی نشست‌های دیگر با موفقیت بسته شدند', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در بستن سایر نشست‌ها', 'error');
    } finally {
      setSessionBusyId(null);
    }
  };

  const nidValidation = React.useMemo(
    () => (kycNationalId.trim() ? isValidIranianNationalId(kycNationalId) : null),
    [kycNationalId]
  );

  const cardValidation = React.useMemo(() => {
    const cleaned = normalizeDigits(kycBankCard).replace(/[^0-9]/g, '');
    if (!cleaned) return null;
    const res = isValidIranianCard(cleaned);
    return {
      ...res,
      bankName: detectIranianBankName(cleaned),
    };
  }, [kycBankCard]);

  const copyText = async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      notify('لینک با موفقیت کپی شد', 'success');
    } catch {
      notify('کپی انجام نشد', 'error');
    }
  };

  const handleKycImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: 'card' | 'selfie') => {
    const file = e.target.files?.[0];
    if (!file) return;
    setKycUploading(target);
    try {
      const url = await uploadMediaFile(file, file.name || `kyc-${target}.webp`);
      if (target === 'card') {
        setKycCardUrl(url);
        notify('تصویر کارت ملی بارگذاری شد', 'success');
      } else {
        setKycSelfieUrl(url);
        notify('تصویر سلفی همراه با کارت ملی بارگذاری شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در بارگذاری تصویر', 'error');
    } finally {
      setKycUploading(null);
      if (target === 'card' && kycFileInputRef.current) kycFileInputRef.current.value = '';
      if (target === 'selfie' && kycSelfieInputRef.current) kycSelfieInputRef.current.value = '';
    }
  };

  const handleCheckIdentityMatch = async () => {
    const check = isValidIranianNationalId(kycNationalId);
    if (!check.valid) {
      notify(check.error || 'کد ملی واردشده معتبر نیست', 'error');
      return;
    }
    setKycCheckingMatch(true);
    try {
      const res = await apiFetch<{ success: boolean; status?: string; matched?: boolean; note?: string; user?: any }>(
        '/api/kyc/check-match',
        {
          method: 'POST',
          body: JSON.stringify({ national_id: check.normalized }),
        }
      );
      if (res.success) {
        setKycMatchState({ status: res.status, note: res.note });
        if (res.user) {
          setUser?.((prev: any) => {
            const next = { ...prev, ...res.user };
            localStorage.setItem('mianji_mock_user', JSON.stringify(next));
            return next;
          });
        }
        notify(res.note || 'نتیجه بررسی کد ملی دریافت شد', res.matched ? 'success' : 'error');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در بررسی اعتبار و یکتایی کد ملی', 'error');
    } finally {
      setKycCheckingMatch(false);
    }
  };

  const handleSubmitKyc = async () => {
    const check = isValidIranianNationalId(kycNationalId);
    if (!check.valid) {
      notify(check.error || 'کد ملی واردشده معتبر نیست', 'error');
      return;
    }
    if (kycFullName.trim().length < 2) {
      notify('نام و نام خانوادگی را کامل وارد کنید', 'error');
      return;
    }
    const cardCheck = isValidIranianCard(kycBankCard);
    if (!cardCheck.valid) {
      notify('لطفاً شماره کارت بانکی ۱۶ رقمی معتبر به نام خودتان وارد کنید', 'error');
      return;
    }
    if (!kycCardUrl) {
      notify('لطفاً تصویر کارت ملی خود را آپلود کنید', 'error');
      return;
    }
    if (!kycSelfieUrl) {
      notify('لطفاً تصویر سلفی همراه با کارت ملی را آپلود کنید', 'error');
      return;
    }
    setKycSubmitting(true);
    try {
      const res = await apiFetch<{ success: boolean; user?: any; match?: { status?: string; note?: string } }>('/api/kyc/submit', {
        method: 'POST',
        body: JSON.stringify({
          national_id: check.normalized,
          full_name: kycFullName.trim(),
          card_number: cardCheck.normalized,
          id_card_image_url: kycCardUrl,
          selfie_image_url: kycSelfieUrl,
        }),
      });
      if (res.success && res.user) {
        if (res.match) setKycMatchState(res.match);
        setUser?.((prev: any) => {
          const next = { ...prev, ...res.user };
          localStorage.setItem('mianji_mock_user', JSON.stringify(next));
          return next;
        });
        notify('مدارک هویتی و شماره کارت با موفقیت ثبت و برای بررسی دستی مدیریت ارسال شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت اطلاعات احراز هویت', 'error');
    } finally {
      setKycSubmitting(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1100] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-7 space-y-6 relative shadow-2xl dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-6 left-6 w-10 h-10 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white">
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
            <div className="w-14 h-14 bg-slate-100 dark:bg-white/10 text-blue-600 dark:text-white border border-slate-200/80 dark:border-white/[0.08] rounded-2xl flex items-center justify-center mx-auto">
              <Users size={26} />
            </div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white">معرفی میانجی به دوستان</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">برای انجام معاملات امن با همکاران و مشتریان خود، لینک ربات میانجی را برای آن‌ها ارسال کنید.</p>
            <div className="p-3 bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] rounded-2xl font-mono text-xs text-blue-600 dark:text-white" dir="ltr">
              {botLink}
            </div>
            <button onClick={() => copyText(botLink)} className="w-full h-12 bg-blue-600 text-white border border-white/15 rounded-xl font-black text-xs flex items-center justify-center gap-2 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
              <Copy size={16} /> کپی لینک دعوت
            </button>
          </div>
        )}

        {type === 'settings' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">تنظیمات پنل</h3>
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] rounded-2xl">
              <span className="text-xs font-bold text-slate-900 dark:text-white">حالت شب (Dark Mode)</span>
              <button onClick={() => setIsDarkMode(!isDarkMode)} className="px-4 py-1.5 rounded-xl bg-blue-600 text-white border border-white/15 text-[11px] font-black">
                {isDarkMode ? 'فعال' : 'غیرفعال'}
              </button>
            </div>
            <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] rounded-2xl">
              <span className="text-xs font-bold text-slate-900 dark:text-white">حالت عیب‌یابی (Debug)</span>
              <button onClick={onToggleDebug} className={`px-4 py-1.5 rounded-xl text-[11px] font-black border ${isDebug ? 'bg-amber-500 text-black border-amber-300' : 'bg-white dark:bg-white/10 text-slate-600 dark:text-slate-200 border-slate-200/80 dark:border-white/[0.08]'}`}>
                {isDebug ? 'فعال' : 'غیرفعال'}
              </button>
            </div>
          </div>
        )}

        {type === 'about' && (
          <div className="space-y-4 text-center pt-2">
            <div className="rounded-2xl bg-gradient-to-b from-[#06080d] via-[#040509] to-[#020305] border border-white/[0.08] py-5 px-4 flex flex-col items-center">
              <img
                src="/assets/aistudio/________________47d33e49.webp"
                alt="میانجی"
                referrerPolicy="no-referrer"
                className="h-18 w-auto object-contain mb-1.5"
              />
              <span className="text-[10px] font-mono text-slate-400 mt-0.5">Version 2.4.0</span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed text-right">
              میانجی یک بستر هوشمند واسطه‌گری مالی (Escrow) است که مبلغ قرارداد را تا زمان تحویل و تایید کامل طرفین در حساب امانت قفل می‌کند و با تکیه بر گفتگوهای مستند و احراز تلگرامی، ریسک معاملات فریلنسری و آنلاین را به صفر می‌رساند.
            </p>
            <div className="grid grid-cols-2 gap-2.5 text-right text-[11px]">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.06]">
                <p className="font-black text-slate-900 dark:text-white">امانت امن وجه</p>
                <p className="text-slate-500 dark:text-slate-400 mt-0.5">آزادسازی فقط پس از تایید</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.06]">
                <p className="font-black text-slate-900 dark:text-white">داوری مستند</p>
                <p className="text-slate-500 dark:text-slate-400 mt-0.5">بررسی بر اساس چت قرارداد</p>
              </div>
            </div>
            {onSwitchType && (
              <button
                type="button"
                onClick={() => onSwitchType('rules')}
                className="w-full h-11 rounded-xl bg-slate-100 dark:bg-white/[0.06] hover:bg-slate-200 dark:hover:bg-white/[0.1] text-slate-800 dark:text-white text-xs font-black transition-all"
              >
                مطالعه قوانین و مقررات میانجی
              </button>
            )}
          </div>
        )}

        {type === 'support' && (
          <div className="space-y-4 text-right pt-2">
            <div className="flex items-center gap-3 pl-10">
              <div className="w-11 h-11 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <MessageSquare size={20} />
              </div>
              <div>
                <h3 className="text-base font-black text-slate-900 dark:text-white">پشتیبانی و راهنمای ورود</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">پاسخگویی مستقیم از طریق ربات رسمی</p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              <p>برای دریافت کد تایید، حل مشکل ورود یا ارتباط با تیم پشتیبانی، ربات تلگرام میانجی را باز کنید و شماره خود را به اشتراک بگذارید.</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                کاربران دارای حساب می‌توانند پس از ورود، از بخش پشتیبانی داخل پنل تیکت مستقیم ثبت کنند.
              </p>
            </div>

            <a
              href={botLink}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-xs flex items-center justify-center gap-2 transition-all active:scale-95"
            >
              <Send size={15} className="-rotate-45" />
              <span>باز کردن ربات تلگرام (@{cleanBotUsername})</span>
            </a>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => copyText(`@${cleanBotUsername}`)}
                className="h-10 rounded-xl bg-slate-100 dark:bg-white/[0.06] hover:bg-slate-200 dark:hover:bg-white/[0.1] text-slate-800 dark:text-slate-200 text-[11px] font-black flex items-center justify-center gap-1.5 transition-all"
              >
                <Copy size={14} />
                <span>کپی آیدی ربات</span>
              </button>
              {onSwitchType && (
                <button
                  type="button"
                  onClick={() => onSwitchType('rules')}
                  className="h-10 rounded-xl bg-slate-100 dark:bg-white/[0.06] hover:bg-slate-200 dark:hover:bg-white/[0.1] text-slate-800 dark:text-slate-200 text-[11px] font-black flex items-center justify-center gap-1.5 transition-all"
                >
                  <FileText size={14} />
                  <span>قوانین و راهنما</span>
                </button>
              )}
            </div>
          </div>
        )}

        {type === 'kyc' && (
          <div className="space-y-4 text-right pt-2">
            <div className="flex items-center justify-between pl-12">
              <h3 className="text-lg font-black text-slate-900 dark:text-white">احراز هویت واقعی (KYC)</h3>
              <span
                className={`px-2.5 py-1 rounded-xl text-[10px] font-black ${
                  user?.kyc_status === 'verified'
                    ? 'bg-emerald-500/15 text-emerald-500'
                    : user?.kyc_status === 'rejected'
                    ? 'bg-rose-500/15 text-rose-500'
                    : 'bg-amber-500/15 text-amber-500'
                }`}
              >
                {user?.kyc_status === 'verified'
                  ? 'تایید شده'
                  : user?.kyc_status === 'rejected'
                  ? 'نیاز به اصلاح'
                  : user?.kyc_submitted_at
                  ? 'در انتظار بررسی'
                  : 'تکمیل نشده'}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
              برای افزایش امنیت معاملات، کد ملی، شماره کارت بانکی به نام خودتان، تصویر کارت ملی و سلفی را ثبت کنید.
            </p>
            {user?.kyc_status === 'rejected' && user?.kyc_reject_reason && (
              <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-500 font-bold">
                دلیل رد: {user.kyc_reject_reason}
              </div>
            )}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">نام و نام خانوادگی مطابق کارت ملی</label>
                <input
                  type="text"
                  value={kycFullName}
                  disabled={user?.kyc_status === 'verified'}
                  onChange={(e) => setKycFullName(e.target.value)}
                  className="input-refined text-[14px] disabled:opacity-60"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">کد ملی ۱۰ رقمی (بررسی یکتایی و تطابق دستی)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    dir="ltr"
                    inputMode="numeric"
                    maxLength={10}
                    value={kycNationalId}
                    disabled={user?.kyc_status === 'verified'}
                    onChange={(e) => {
                      setKycNationalId(normalizeDigits(e.target.value).replace(/[^0-9]/g, '').slice(0, 10));
                      setKycMatchState(null);
                    }}
                    placeholder="0012345678"
                    className="input-refined flex-1 text-center font-sans tabular-nums tracking-widest disabled:opacity-60"
                  />
                  {user?.kyc_status !== 'verified' && (
                    <button
                      type="button"
                      disabled={kycCheckingMatch || !nidValidation?.valid}
                      onClick={handleCheckIdentityMatch}
                      className="h-12 px-3.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-black text-[11px] font-black shrink-0 active:scale-95 transition-all disabled:opacity-40"
                    >
                      {kycCheckingMatch ? 'بررسی...' : 'بررسی یکتابودن'}
                    </button>
                  )}
                </div>
                {nidValidation && (
                  <p className={`text-[10px] font-bold ${nidValidation.valid ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {nidValidation.valid ? 'فرمت کد ملی صحیح است' : nidValidation.error}
                  </p>
                )}
                {kycMatchState?.note && (
                  <p className={`text-[10px] font-bold px-2.5 py-1.5 rounded-xl ${
                    kycMatchState.status === 'matched'
                      ? 'bg-emerald-500/10 text-emerald-500'
                      : kycMatchState.status === 'mismatch'
                      ? 'bg-rose-500/10 text-rose-500'
                      : 'bg-amber-500/10 text-amber-500'
                  }`}>
                    {kycMatchState.note}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-500 dark:text-slate-300">شماره کارت بانکی به نام خود شخص (۱۶ رقم)</label>
                <input
                  type="text"
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={19}
                  value={formatIranianCard(kycBankCard)}
                  disabled={user?.kyc_status === 'verified'}
                  onChange={(e) => setKycBankCard(normalizeDigits(e.target.value).replace(/[^0-9]/g, '').slice(0, 16))}
                  placeholder="6037-99xx-xxxx-xxxx"
                  className="input-refined text-center font-sans tabular-nums tracking-wider disabled:opacity-60"
                />
                {cardValidation && (
                  <p className={`text-[10px] font-bold ${cardValidation.valid ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {cardValidation.valid
                      ? `کارت معتبر${cardValidation.bankName ? ` · ${cardValidation.bankName}` : ''}`
                      : 'شماره کارت ۱۶ رقمی معتبر نیست'}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <input
                  ref={kycFileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleKycImageUpload(e, 'card')}
                  className="hidden"
                />
                {kycCardUrl ? (
                  <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-2">
                    <img src={kycCardUrl} alt="تصویر کارت ملی" className="w-16 h-11 rounded-xl object-cover" />
                    <span className="text-[11px] font-bold text-emerald-500 flex-1">تصویر کارت ملی آماده بررسی</span>
                    {user?.kyc_status !== 'verified' && (
                      <button
                        type="button"
                        onClick={() => setKycCardUrl('')}
                        className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ) : (
                  user?.kyc_status !== 'verified' && (
                    <button
                      type="button"
                      disabled={kycUploading !== null}
                      onClick={() => kycFileInputRef.current?.click()}
                      className="w-full h-11 rounded-2xl border border-dashed border-slate-300 dark:border-white/[0.08] bg-slate-50 dark:bg-[#18202e] text-xs font-bold text-slate-600 dark:text-slate-200 flex items-center justify-center gap-2 hover:border-blue-500 transition-colors"
                    >
                      <ImageIcon size={15} />
                      {kycUploading === 'card' ? 'در حال بارگذاری...' : 'آپلود تصویر کارت ملی (الزامی)'}
                    </button>
                  )
                )}
              </div>

              <div className="space-y-2">
                <input
                  ref={kycSelfieInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleKycImageUpload(e, 'selfie')}
                  className="hidden"
                />
                {kycSelfieUrl ? (
                  <div className="p-2.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-2">
                    <img src={kycSelfieUrl} alt="تصویر سلفی" className="w-16 h-11 rounded-xl object-cover" />
                    <span className="text-[11px] font-bold text-emerald-500 flex-1">تصویر سلفی با کارت ملی آماده بررسی</span>
                    {user?.kyc_status !== 'verified' && (
                      <button
                        type="button"
                        onClick={() => setKycSelfieUrl('')}
                        className="w-8 h-8 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ) : (
                  user?.kyc_status !== 'verified' && (
                    <button
                      type="button"
                      disabled={kycUploading !== null}
                      onClick={() => kycSelfieInputRef.current?.click()}
                      className="w-full h-11 rounded-2xl border border-dashed border-slate-300 dark:border-white/[0.08] bg-slate-50 dark:bg-[#18202e] text-xs font-bold text-slate-600 dark:text-slate-200 flex items-center justify-center gap-2 hover:border-blue-500 transition-colors"
                    >
                      <Camera size={15} />
                      {kycUploading === 'selfie' ? 'در حال بارگذاری...' : 'آپلود سلفی همراه با کارت ملی (الزامی)'}
                    </button>
                  )
                )}
              </div>

              <p className="text-[11px] text-slate-500 dark:text-slate-300">
                شماره همراه ثبت‌شده: <span dir="ltr" className="font-mono">{user?.phone_number}</span>
              </p>
            </div>
            {user?.kyc_status !== 'verified' && (
              <button
                type="button"
                disabled={kycSubmitting || kycUploading !== null}
                onClick={handleSubmitKyc}
                className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs active:scale-95 transition-all disabled:opacity-50"
              >
                {kycSubmitting ? 'در حال ثبت...' : 'ارسال مدارک به صف بررسی احراز هویت'}
              </button>
            )}
          </div>
        )}

        {type === 'notif_prefs' && (
          <div className="space-y-4 text-right pt-2">
            <h3 className="text-lg font-black text-slate-900 dark:text-white">تنظیمات اعلان لحظه‌ای</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 leading-relaxed">
              علاوه بر پیام‌رسان تلگرام، می‌توانید اعلان‌های مرورگر را برای تغییر وضعیت معاملات و پیام‌های جدید فعال کنید.
            </p>

            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-700 dark:text-slate-200">وضعیت مجوز مرورگر</span>
                <span
                  className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black ${
                    pushPermission === 'granted'
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : pushPermission === 'denied'
                      ? 'bg-rose-500/15 text-rose-500'
                      : 'bg-amber-500/15 text-amber-500'
                  }`}
                >
                  {pushPermission === 'granted'
                    ? 'مجاز'
                    : pushPermission === 'denied'
                    ? 'مسدود'
                    : pushPermission === 'unsupported'
                    ? 'پشتیبانی نمی‌شود'
                    : 'در انتظار تایید'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-300">
                <span>دستگاه‌های ثبت‌شده در سرور</span>
                <span className="font-mono font-bold">{pushSubCount} دستگاه</span>
              </div>

              <div className="flex gap-2 pt-1">
                {pushPermission === 'granted' && pushActive ? (
                  <button
                    type="button"
                    disabled={pushBusy}
                    onClick={async () => {
                      setPushBusy(true);
                      await onDisablePush?.();
                      setPushBusy(false);
                    }}
                    className="flex-1 h-10 rounded-xl bg-rose-500/15 text-rose-500 border border-rose-500/30 text-xs font-black active:scale-95 transition-all"
                  >
                    غیرفعال‌سازی روی این مرورگر
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pushBusy || pushPermission === 'unsupported'}
                    onClick={async () => {
                      setPushBusy(true);
                      await onEnablePush?.();
                      setPushBusy(false);
                    }}
                    className="flex-1 h-10 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black active:scale-95 transition-all disabled:opacity-50"
                  >
                    فعال‌سازی اعلان در این مرورگر
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-2">
              {[
                { key: 'deals_enabled', label: 'تغییرات وضعیت و تایید معاملات' },
                { key: 'messages_enabled', label: 'پیام‌های جدید در چت مستقیم و قراردادها' },
                { key: 'channels_enabled', label: 'پست‌های جدید کانال‌های اطلاع‌رسانی' },
                { key: 'foreground_alerts', label: 'نمایش اعلان دسکتاپ هنگام باز بودن سایت' },
              ].map((item) => (
                <label
                  key={item.key}
                  className="p-3.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/[0.08] flex items-center justify-between cursor-pointer"
                >
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{item.label}</span>
                  <input
                    type="checkbox"
                    checked={Boolean((notifPrefs || DEFAULT_NOTIFICATION_PREFS)[item.key as keyof NotificationPreferences])}
                    onChange={(e) => onUpdateNotifPrefs?.({ [item.key]: e.target.checked })}
                    className="w-4 h-4 accent-blue-600 cursor-pointer"
                  />
                </label>
              ))}
            </div>

            <button
              type="button"
              onClick={onTestPush}
              className="w-full h-11 rounded-xl bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] text-xs font-black text-slate-800 dark:text-white hover:border-blue-500/50 active:scale-95 transition-all"
            >
              ارسال اعلان آزمایشی
            </button>
          </div>
        )}

        {type === 'security' && (
          <div className="space-y-4 text-right pt-2">
            <div className="space-y-1 pl-10">
              <h3 className="text-lg font-black text-slate-900 dark:text-white">امنیت و نشست‌های فعال</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">
                ورود دو مرحله‌ای از طریق ربات رسمی تلگرام میانجی فعال است و هر کد تایید تنها یک‌بار و تا ۱۵ دقیقه معتبر است.
              </p>
            </div>

            <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/25 flex items-center gap-2.5 text-xs text-emerald-700 dark:text-emerald-300 font-bold">
              <ShieldCheck size={18} className="shrink-0" />
              <span>محافظت نشست امضاشده (HMAC) و کنترل دسترسی دستگاه‌ها فعال است.</span>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-slate-900 dark:text-white">دستگاه‌های متصل ({sessions.length})</span>
                {sessions.some((s) => !s.is_current) && (
                  <button
                    type="button"
                    disabled={sessionBusyId === '__others__'}
                    onClick={() => setPendingRevokeConfirm({ type: 'others' })}
                    className="h-8 px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-500 border border-rose-500/30 text-[10px] font-black active:scale-95 transition-all disabled:opacity-50"
                  >
                    {sessionBusyId === '__others__' ? 'در حال خروج...' : 'خروج از همه نشست‌های دیگر'}
                  </button>
                )}
              </div>

              {sessionsLoading ? (
                <div className="space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-16 rounded-2xl bg-slate-100 dark:bg-white/5 animate-pulse" />
                  ))}
                </div>
              ) : sessions.length === 0 ? (
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-[#18202e] text-center text-xs text-slate-500 dark:text-slate-300">
                  اطلاعاتی از نشست‌های فعال در دسترس نیست.
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
                  {sessions.map((s) => {
                    const isMobile = /Android|iPhone|iPad|موبایل/i.test(`${s.device_label || ''} ${s.platform || ''}`);
                    return (
                      <div
                        key={s.id}
                        className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                          s.is_current
                            ? 'bg-blue-600/10 border-blue-500/40'
                            : 'bg-slate-50 dark:bg-[#18202e] border-slate-200/80 dark:border-white/[0.08]'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-xl bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-blue-600 dark:text-white shrink-0">
                            {isMobile ? <Smartphone size={17} /> : <Monitor size={17} />}
                          </div>
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-xs font-black text-slate-900 dark:text-white truncate">
                                {s.device_label || 'مرورگر وب'}
                              </span>
                              {s.is_current && (
                                <span className="px-2 py-0.5 rounded-md bg-emerald-500 text-white text-[9px] font-black">
                                  نشست فعلی
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-300">
                              <span dir="ltr" className="font-mono">{s.ip_masked || '—'}</span>
                              <span>·</span>
                              <span>{formatDateTimeFa(s.last_seen_at || s.created_at)}</span>
                            </div>
                          </div>
                        </div>

                        {!s.is_current && (
                          <button
                            type="button"
                            disabled={sessionBusyId === s.id}
                            onClick={() => setPendingRevokeConfirm({ type: 'single', session: s })}
                            className="h-8 px-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border border-rose-500/25 text-[10px] font-black shrink-0 disabled:opacity-50"
                          >
                            {sessionBusyId === s.id ? '...' : 'خروج'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(pendingRevokeConfirm)}
        title={
          pendingRevokeConfirm?.type === 'others'
            ? 'خروج از تمامی نشست‌های دیگر'
            : 'قطع دسترسی دستگاه'
        }
        description={
          pendingRevokeConfirm?.type === 'others'
            ? 'تمامی دستگاه‌های دیگر از حساب کاربری شما خارج می‌شوند و تنها همین دستگاه متصل باقی می‌ماند.'
            : 'نشست این دستگاه بسته شده و برای استفاده مجدد نیاز به ورود دوباره دارد.'
        }
        previewText={
          pendingRevokeConfirm?.type === 'single'
            ? `${pendingRevokeConfirm.session?.device_label || 'مرورگر وب'}${
                pendingRevokeConfirm.session?.ip_masked ? ` (${pendingRevokeConfirm.session.ip_masked})` : ''
              }`
            : undefined
        }
        confirmLabel="بله، خروج از نشست"
        cancelLabel="انصراف"
        tone="danger"
        icon="logout"
        busy={Boolean(sessionBusyId)}
        onCancel={() => {
          if (!sessionBusyId) setPendingRevokeConfirm(null);
        }}
        onConfirm={async () => {
          if (!pendingRevokeConfirm) return;
          if (pendingRevokeConfirm.type === 'others') {
            await handleRevokeOtherSessions();
          } else {
            await handleRevokeSession(pendingRevokeConfirm.session.id);
          }
          setPendingRevokeConfirm(null);
        }}
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
  const markAsRead = async (id: string) => {
    const next = notifications.map((n) => (n.id === id ? { ...n, is_read: true } : n));
    setNotifications(next);
    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ id })
      });
    } catch {}
  };

  const markAllAsRead = async () => {
    const next = notifications.map((n) => ({ ...n, is_read: true }));
    setNotifications(next);
    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({})
      });
    } catch {}
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-20">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-95 transition-all shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">اعلان‌ها</h2>
            <p className="text-[10px] text-blue-600 dark:text-slate-300 uppercase tracking-widest font-bold">Notifications</p>
          </div>
        </div>
        {notifications.some((n) => !n.is_read) && (
          <button onClick={markAllAsRead} className="text-xs font-bold text-blue-600 dark:text-white px-3 py-1.5 bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-xl shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
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
                  !n.is_read ? 'bg-blue-600 text-white shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'bg-slate-50 dark:bg-white/[0.1] border border-slate-200/80 dark:border-white/[0.08] text-blue-500 dark:text-white'
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

function AdminPanelView({
  user,
  contracts,
  platformStats,
  persistenceStatus,
  onPersistenceUpdated,
  setView,
  notify,
  onImpersonate,
  onLimitsUpdated
}: {
  user: UserProfile | null;
  contracts: Contract[];
  platformStats?: { total_fees_collected: number };
  persistenceStatus?: {
    mode: 'firestore' | 'local_disk' | 'memory_ephemeral';
    firebaseAdminReady: boolean;
    projectId: string;
    databaseId: string;
    credentialSource: string;
    credentialDetail?: string;
    lastError: string | null;
    verifiedAt: string | null;
  } | null;
  onPersistenceUpdated?: (p: any) => void;
  setView: (v: View) => void;
  notify: (m: string, t?: ToastState['type']) => void;
  onImpersonate: (payload: { user: any; customToken?: string | null; sessionToken?: string | null }) => Promise<void>;
  onLimitsUpdated: (limits: PlatformLimits) => void;
}) {
  const [activeTab, setActiveTab] = useState<'manage_users' | 'kyc' | 'support' | 'finance' | 'deals' | 'users'>('manage_users');
  const [supportInquiries, setSupportInquiries] = useState<any[]>([]);
  const [manualSlips, setManualSlips] = useState<any[]>([]);
  const [financeFilter, setFinanceFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [kycUsers, setKycUsers] = useState<any[]>([]);
  const [kycFilter, setKycFilter] = useState<'pending' | 'verified' | 'rejected' | 'all'>('pending');
  const [feeSummary, setFeeSummary] = useState<{
    platform_fee_percent: number;
    total_fees_collected: number;
    recent_fee_transactions: any[];
  } | null>(null);
  const [allDeals, setAllDeals] = useState<Contract[]>(contracts);
  const [replyMap, setReplyMap] = useState<Record<string, string>>({});
  const [kycReasonMap, setKycReasonMap] = useState<Record<string, string>>({});
  const [previewSlipUrl, setPreviewSlipUrl] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingSlipConfirm, setPendingSlipConfirm] = useState<{ slip: any; decision: 'approved' | 'rejected' } | null>(null);
  const [pendingKycConfirm, setPendingKycConfirm] = useState<{ user: any; decision: 'verified' | 'rejected' } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [localPersistence, setLocalPersistence] = useState(persistenceStatus || null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const [adminPerms, setAdminPerms] = useState({ manage_support: true, manage_finance: true });

  const isOwner = user?.role === 'owner';
  const dbStatus = localPersistence || persistenceStatus;

  useEffect(() => {
    if (persistenceStatus) setLocalPersistence(persistenceStatus);
  }, [persistenceStatus]);

  useEffect(() => {
    setAllDeals(contracts);
  }, [contracts]);

  useEffect(() => {
    let cancelled = false;
    const loadAdminFeeds = async () => {
      const [supRes, finRes, dealsRes, usersRes, feeRes, limRes] = await Promise.allSettled([
        apiFetch<{ success: boolean; tickets?: any[] }>('/api/support/tickets?scope=admin'),
        apiFetch<{ success: boolean; requests?: any[] }>('/api/wallet/requests?scope=admin'),
        apiFetch<{ success: boolean; deals?: Contract[] }>('/api/deals?scope=all'),
        apiFetch<{ success: boolean; users?: any[] }>('/api/admin/users'),
        apiFetch<{ success: boolean; platform_fee_percent: number; total_fees_collected: number; recent_fee_transactions: any[] }>('/api/admin/finance/summary'),
        apiFetch<{ success: boolean; persistence?: any }>('/api/limits/effective'),
      ]);
      if (cancelled) return;
      if (supRes.status === 'fulfilled' && supRes.value?.success && Array.isArray(supRes.value.tickets)) {
        setSupportInquiries(supRes.value.tickets);
      }
      if (finRes.status === 'fulfilled' && finRes.value?.success && Array.isArray(finRes.value.requests)) {
        setManualSlips(finRes.value.requests);
      }
      if (dealsRes.status === 'fulfilled' && dealsRes.value?.success && Array.isArray(dealsRes.value.deals)) {
        setAllDeals(dealsRes.value.deals);
      }
      if (usersRes.status === 'fulfilled' && usersRes.value?.success && Array.isArray(usersRes.value.users)) {
        setKycUsers(usersRes.value.users.filter((u) => Boolean(u.national_id || u.kyc_id_card_url || u.kyc_selfie_url || u.kyc_bank_card || u.kyc_submitted_at)));
      }
      if (feeRes.status === 'fulfilled' && feeRes.value?.success) {
        setFeeSummary(feeRes.value);
      }
      if (limRes.status === 'fulfilled' && limRes.value?.success && limRes.value.persistence) {
        setLocalPersistence(limRes.value.persistence);
        onPersistenceUpdated?.(limRes.value.persistence);
      }
    };

    loadAdminFeeds();

    const offTicket = realtimeClient.on('ticket:updated', (payload: any) => {
      if (!payload?.ticket) return;
      const t = payload.ticket;
      setSupportInquiries((prev) => {
        const exists = prev.some((x) => x.id === t.id);
        return exists ? prev.map((x) => (x.id === t.id ? t : x)) : [t, ...prev];
      });
    });

    const offWallet = realtimeClient.on('wallet:updated', (payload: any) => {
      if (!payload?.request) return;
      const r = payload.request;
      setManualSlips((prev) => {
        const exists = prev.some((x) => x.id === r.id);
        return exists ? prev.map((x) => (x.id === r.id ? r : x)) : [r, ...prev];
      });
    });

    const offKyc = realtimeClient.on('kyc:updated', (payload: any) => {
      if (!payload?.user) return;
      const u = payload.user;
      setKycUsers((prev) => {
        const exists = prev.some((x) => x.id === u.id);
        return exists ? prev.map((x) => (x.id === u.id ? u : x)) : [u, ...prev];
      });
    });

    const offDeal = realtimeClient.on('deal:updated', (payload: any) => {
      if (!payload?.contract) return;
      const d = payload.contract as Contract;
      setAllDeals((prev) => {
        const exists = prev.some((x) => x.contract_id === d.contract_id);
        return exists ? prev.map((x) => (x.contract_id === d.contract_id ? d : x)) : [d, ...prev];
      });
    });

    return () => {
      cancelled = true;
      offTicket();
      offWallet();
      offKyc();
      offDeal();
    };
  }, []);

  const handleResolveSupport = async (id: string) => {
    const reply = (replyMap[id] || '').trim() || 'بررسی و تایید شد.';

    setBusyId(id);
    try {
      const res = await apiFetch<{ success: boolean; ticket?: any }>(
        `/api/admin/support/tickets/${encodeURIComponent(id)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({ reply })
        }
      );
      if (res.success && res.ticket) {
        setSupportInquiries((prev) => prev.map((s) => (s.id === id ? res.ticket : s)));
        setReplyMap((prev) => ({ ...prev, [id]: '' }));
        notify('پاسخ تیکت برای کاربر ارسال شد', 'success');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ارسال پاسخ پشتیبانی', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSlipDecision = async (id: string, decision: 'approved' | 'rejected') => {
    setBusyId(id);
    try {
      const res = await apiFetch<{ success: boolean; request?: any }>(
        `/api/admin/wallet-requests/${encodeURIComponent(id)}/decide`,
        {
          method: 'POST',
          body: JSON.stringify({ decision })
        }
      );
      if (res.success && res.request) {
        setManualSlips((prev) => prev.map((s) => (s.id === id ? res.request : s)));
        notify(
          decision === 'approved' ? 'درخواست مالی تایید و موجودی کاربر به‌روزرسانی شد' : 'درخواست مالی رد شد',
          decision === 'approved' ? 'success' : 'info'
        );
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در ثبت تصمیم مالی', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleKycAdminDecision = async (targetId: string, decision: 'verified' | 'rejected') => {
    setBusyId(targetId);
    try {
      const res = await apiFetch<{ success: boolean; user?: any }>(
        `/api/admin/users/${encodeURIComponent(targetId)}/kyc-decide`,
        {
          method: 'POST',
          body: JSON.stringify({
            decision,
            reason: decision === 'rejected' ? (kycReasonMap[targetId] || '').trim() : '',
          }),
        }
      );
      if (res.success && res.user) {
        setKycUsers((prev) => prev.map((u) => (u.id === targetId ? res.user : u)));
        notify(decision === 'verified' ? 'کد ملی و احراز هویت کاربر تایید شد' : 'درخواست احراز هویت رد شد', decision === 'verified' ? 'success' : 'info');
      }
    } catch (err: any) {
      notify(err?.message || 'خطا در بررسی احراز هویت', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleExportBackup = async () => {
    setBackupBusy(true);
    try {
      const res = await apiFetch<{ success: boolean; backup?: any; error?: string }>('/api/admin/backup/export');
      if (!res?.success || !res.backup) {
        throw new Error(res?.error || 'خطا در دریافت نسخه پشتیبان');
      }
      const blob = new Blob([JSON.stringify(res.backup, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mianji-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify('فایل پشتیبان دیتابیس با موفقیت دانلود شد', 'success');
    } catch (err: any) {
      notify(err?.message || 'خطا در دانلود نسخه پشتیبان', 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBackupBusy(true);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const res = await apiFetch<{ success: boolean; imported?: Record<string, number>; persistence?: any; error?: string }>(
        '/api/admin/backup/import',
        {
          method: 'POST',
          body: JSON.stringify({ backup: parsed?.backup || parsed }),
        }
      );
      if (!res?.success) {
        throw new Error(res?.error || 'خطا در بازیابی فایل پشتیبان');
      }
      if (res.persistence) {
        setLocalPersistence(res.persistence);
        onPersistenceUpdated?.(res.persistence);
      }
      const counts = res.imported || {};
      notify(
        `بازیابی انجام شد (${counts.users || 0} کاربر، ${counts.deals || 0} قرارداد، ${counts.walletRequests || 0} درخواست مالی)`,
        'success'
      );
      const [dealsRes, finRes, supRes] = await Promise.allSettled([
        apiFetch<{ success: boolean; deals?: Contract[] }>('/api/deals?scope=all'),
        apiFetch<{ success: boolean; requests?: any[] }>('/api/wallet/requests?scope=admin'),
        apiFetch<{ success: boolean; tickets?: any[] }>('/api/support/tickets?scope=admin'),
      ]);
      if (dealsRes.status === 'fulfilled' && dealsRes.value?.success && Array.isArray(dealsRes.value.deals)) {
        setAllDeals(dealsRes.value.deals);
      }
      if (finRes.status === 'fulfilled' && finRes.value?.success && Array.isArray(finRes.value.requests)) {
        setManualSlips(finRes.value.requests);
      }
      if (supRes.status === 'fulfilled' && supRes.value?.success && Array.isArray(supRes.value.tickets)) {
        setSupportInquiries(supRes.value.tickets);
      }
    } catch (err: any) {
      notify(err?.message || 'فایل پشتیبان نامعتبر است یا خطایی رخ داد', 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 pb-24">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-95 transition-all shadow-[0_8px_22px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white">پنل مدیریت و پشتیبانی</h2>
            <p className="text-[10px] text-blue-600 dark:text-slate-300 uppercase tracking-widest font-bold">{isOwner ? 'مالک کل (Owner)' : 'ادمین سیستم (Admin)'}</p>
          </div>
        </div>
      </div>

      {dbStatus && (
        <div
          className={`rounded-2xl border p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
            dbStatus.mode === 'firestore'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200'
              : dbStatus.mode === 'local_disk'
              ? 'bg-amber-500/10 border-amber-500/35 text-amber-950 dark:text-amber-200'
              : 'bg-rose-500/10 border-rose-500/35 text-rose-950 dark:text-rose-200'
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                dbStatus.mode === 'firestore'
                  ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300'
                  : dbStatus.mode === 'local_disk'
                  ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300'
                  : 'bg-rose-500/20 text-rose-600 dark:text-rose-300'
              }`}
            >
              {dbStatus.mode === 'firestore' ? <Database size={20} /> : <AlertTriangle size={20} />}
            </div>
            <div className="space-y-1 text-right">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-black">
                  {dbStatus.mode === 'firestore'
                    ? 'اتصال دائمی Firestore برقرار است'
                    : dbStatus.mode === 'local_disk'
                    ? 'هشدار: سرور روی حافظه دیسک محلی است (کلید Admin فایربیس تنظیم نشده)'
                    : 'هشدار فوری: سرور در حالت موقت حافظه RAM است'}
                </span>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-sans font-bold bg-black/10 dark:bg-white/10">
                  {dbStatus.projectId} / {dbStatus.databaseId}
                  {dbStatus.credentialDetail ? ` (${dbStatus.credentialDetail})` : ''}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed opacity-90">
                {dbStatus.mode === 'firestore'
                  ? 'تمامی قراردادها، موجودی‌ها، کاربران و تراکنش‌ها مستقیم روی Firestore مشترک با ربات ذخیره می‌شوند و با آپدیت یا دیپلوی مجدد پاک نخواهند شد.'
                  : 'در آپدیت/ری‌استارت عادی روی همین دیسک اطلاعات حفظ می‌شود، اما با «Clear & Deploy» یا کانتینر جدید پاک خواهد شد. برای ماندگاری ۱۰۰٪ دائمی در Firestore، فایل JSON کلید سرویس‌اکانت را در بخش Secret Files رندر (مسیر /etc/secrets/) یا متغیر FIREBASE_SERVICE_ACCOUNT_JSON قرار دهید.'}
              </p>
              {dbStatus.lastError && dbStatus.mode !== 'firestore' && (
                <p className="text-[10px] font-sans opacity-75 break-all">جزئیات فنی: {dbStatus.lastError}</p>
              )}
            </div>
          </div>

          {isOwner && (
            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <input
                ref={backupInputRef}
                type="file"
                accept="application/json,.json"
                onChange={handleImportBackupFile}
                className="hidden"
              />
              <button
                type="button"
                disabled={backupBusy}
                onClick={handleExportBackup}
                className="h-9 px-3.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-[11px] font-black flex items-center gap-1.5 active:scale-95 transition-all disabled:opacity-50"
              >
                <Download size={14} />
                دانلود بکاپ (JSON)
              </button>
              <button
                type="button"
                disabled={backupBusy}
                onClick={() => backupInputRef.current?.click()}
                className="h-9 px-3.5 rounded-xl bg-white/80 dark:bg-white/10 border border-slate-300 dark:border-white/20 text-slate-900 dark:text-white text-[11px] font-black flex items-center gap-1.5 active:scale-95 transition-all disabled:opacity-50"
              >
                <Upload size={14} />
                بازیابی بکاپ
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2.5">
        <button
          onClick={() => setActiveTab('manage_users')}
          className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
            activeTab === 'manage_users' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'card-refined text-slate-900 dark:text-slate-200'
          }`}
        >
          <Users size={20} />
          <div>
            <span className="text-xs font-black block">کاربران و لیمیت</span>
            <span className="text-[9px] opacity-80">جستجو، بلاک، ورود</span>
          </div>
        </button>
        <button
          onClick={() => setActiveTab('kyc')}
          className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
            activeTab === 'kyc' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'card-refined text-slate-900 dark:text-slate-200'
          }`}
        >
          <ShieldCheck size={20} />
          <div>
            <span className="text-xs font-black block">تایید کد ملی</span>
            <span className="text-[9px] opacity-80">{kycUsers.filter((u) => u.kyc_status === 'pending').length} در انتظار</span>
          </div>
        </button>
        <button
          onClick={() => setActiveTab('support')}
          className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
            activeTab === 'support' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'card-refined text-slate-900 dark:text-slate-200'
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
            activeTab === 'finance' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'card-refined text-slate-900 dark:text-slate-200'
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
            activeTab === 'deals' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'card-refined text-slate-900 dark:text-slate-200'
          }`}
        >
          <ClipboardList size={20} />
          <div>
            <span className="text-xs font-black block">نظارت بر معاملات</span>
            <span className="text-[9px] opacity-80">{allDeals.length} قرارداد</span>
          </div>
        </button>
        {isOwner && (
          <button
            onClick={() => setActiveTab('users')}
            className={`p-4 rounded-2xl border text-right transition-all flex items-center gap-3 ${
              activeTab === 'users' ? 'bg-blue-600 text-white border-white/15 shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]' : 'card-refined text-slate-900 dark:text-slate-200'
            }`}
          >
            <Shield size={20} />
            <div>
              <span className="text-xs font-black block">دسترسی ادمین‌ها</span>
              <span className="text-[9px] opacity-80">کنترل مالک</span>
            </div>
          </button>
        )}
      </div>

      {activeTab === 'manage_users' && (
        <AdminUserManager
          currentUser={user}
          notify={notify}
          onImpersonate={onImpersonate}
          onLimitsUpdated={onLimitsUpdated}
        />
      )}

      {activeTab === 'kyc' && (() => {
        const filteredKyc = kycFilter === 'all' ? kycUsers : kycUsers.filter((u) => u.kyc_status === kycFilter);
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <h3 className="text-sm font-black text-slate-900 dark:text-white">صف بررسی و تایید مدارک احراز هویت (KYC)</h3>
              <div className="flex items-center gap-1.5 flex-wrap">
                {[
                  { id: 'pending', label: `در انتظار (${kycUsers.filter((u) => u.kyc_status === 'pending').length})` },
                  { id: 'verified', label: `تایید شده (${kycUsers.filter((u) => u.kyc_status === 'verified').length})` },
                  { id: 'rejected', label: `رد شده (${kycUsers.filter((u) => u.kyc_status === 'rejected').length})` },
                  { id: 'all', label: `همه (${kycUsers.length})` },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setKycFilter(f.id as any)}
                    className={`h-8 px-3 rounded-xl text-[10px] font-black transition-all ${
                      kycFilter === f.id
                        ? 'bg-blue-600 text-white shadow'
                        : 'bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              {filteredKyc.length === 0 ? (
                <div className="card-refined p-10 text-center text-xs font-bold text-slate-500">درخواست احراز هویتی در این بخش یافت نشد</div>
              ) : (
                filteredKyc.map((ku) => (
                  <div key={ku.id} className="card-refined p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="flex items-center gap-2 shrink-0">
                        {ku.kyc_id_card_url && (
                          <button
                            type="button"
                            onClick={() => setPreviewSlipUrl(ku.kyc_id_card_url)}
                            className="rounded-xl overflow-hidden border border-slate-200 dark:border-white/[0.08] text-center"
                            title="مشاهده تصویر کارت ملی"
                          >
                            <img src={ku.kyc_id_card_url} alt="کارت ملی" className="w-16 h-12 object-cover" />
                            <span className="text-[10px] font-bold block bg-slate-100 dark:bg-white/10 py-0.5 text-slate-600 dark:text-slate-300">کارت ملی</span>
                          </button>
                        )}
                        {ku.kyc_selfie_url && (
                          <button
                            type="button"
                            onClick={() => setPreviewSlipUrl(ku.kyc_selfie_url)}
                            className="rounded-xl overflow-hidden border border-blue-400/50 text-center"
                            title="مشاهده سلفی با کارت ملی"
                          >
                            <img src={ku.kyc_selfie_url} alt="سلفی" className="w-16 h-12 object-cover" />
                            <span className="text-[10px] font-bold block bg-blue-500/15 py-0.5 text-blue-600 dark:text-blue-300">سلفی</span>
                          </button>
                        )}
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-sm font-black text-slate-900 dark:text-white">{ku.full_name || ku.id}</h4>
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-black ${
                              ku.kyc_status === 'verified'
                                ? 'bg-emerald-500/15 text-emerald-500'
                                : ku.kyc_status === 'rejected'
                                ? 'bg-rose-500/15 text-rose-500'
                                : 'bg-amber-500/15 text-amber-500'
                            }`}
                          >
                            {ku.kyc_status === 'verified' ? 'تایید شده' : ku.kyc_status === 'rejected' ? 'رد شده' : 'در انتظار بررسی'}
                          </span>
                          {ku.kyc_match_status && (
                            <span
                              className={`px-2 py-0.5 rounded-md text-[10px] font-black ${
                                ku.kyc_match_status === 'matched'
                                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                                  : ku.kyc_match_status === 'mismatch'
                                  ? 'bg-rose-500/10 text-rose-500'
                                  : 'bg-amber-500/10 text-amber-500'
                              }`}
                            >
                              {ku.kyc_match_status === 'matched' ? 'کد ملی معتبر و یکتا ✓ (بررسی دستی)' : ku.kyc_match_status === 'mismatch' ? 'عدم انطباق ✕' : 'نیازمند بررسی دستی'}
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-sans tabular-nums font-bold text-blue-600 dark:text-blue-300">
                          کد ملی: {ku.national_id || 'ثبت نشده'} • {ku.phone_number || ''}
                        </p>
                        {ku.kyc_bank_card && (
                          <p className="text-[11px] font-sans tabular-nums text-slate-600 dark:text-slate-300">
                            کارت بانکی: {formatIranianCard(ku.kyc_bank_card)} {ku.kyc_bank_name ? `(${ku.kyc_bank_name})` : ''}
                          </p>
                        )}
                        {ku.kyc_submitted_at && (
                          <span className="text-[10px] text-slate-400 block">زمان ارسال: {formatDateTimeFa(ku.kyc_submitted_at)}</span>
                        )}
                      </div>
                    </div>
                    {ku.kyc_status === 'pending' && (
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                        <input
                          type="text"
                          placeholder="علت رد (در صورت رد)..."
                          value={kycReasonMap[ku.id] || ''}
                          onChange={(e) => setKycReasonMap((p) => ({ ...p, [ku.id]: e.target.value }))}
                          className="input-refined !h-10 text-[14px] sm:w-44"
                        />
                        <button
                          type="button"
                          disabled={busyId === ku.id}
                          onClick={() => setPendingKycConfirm({ user: ku, decision: 'verified' })}
                          className="h-10 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black active:scale-95 transition-all disabled:opacity-50"
                        >
                          تایید هویت
                        </button>
                        <button
                          type="button"
                          disabled={busyId === ku.id}
                          onClick={() => setPendingKycConfirm({ user: ku, decision: 'rejected' })}
                          className="h-10 px-4 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-black active:scale-95 transition-all disabled:opacity-50"
                        >
                          رد
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })()}

      {activeTab === 'support' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-black text-slate-900 dark:text-white">پیام‌ها و مشکلات کاربران (پشتیبانی زنده)</h3>
          </div>
          <div className="space-y-3">
            {supportInquiries.length === 0 ? (
              <div className="card-refined p-10 text-center text-xs font-bold text-slate-500">هیچ تیکت پشتیبانی ثبت نشده است</div>
            ) : (
              supportInquiries.map((item) => (
                <div key={item.id} className="card-refined p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-blue-600/10 text-blue-500 flex items-center justify-center font-black text-sm">
                        {(item.user_name || 'ک')[0]}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-slate-900 dark:text-white">
                          {item.user_name || 'کاربر میانجی'} {item.phone ? `(${item.phone})` : ''}
                        </h4>
                        <span className="text-[10px] text-slate-500 dark:text-slate-400">{formatDateTimeFa(item.created_at)}</span>
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
                  {item.subject && <p className="text-xs font-black text-slate-800 dark:text-slate-100">{item.subject}</p>}
                  <div className="p-4 bg-slate-50 dark:bg-[#18202e] rounded-2xl text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                    {item.message || item.text}
                  </div>
                  {item.reply && (
                    <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-300">
                      <span className="font-black text-[10px] block mb-1">پاسخ ثبت‌شده:</span>
                      {item.reply}
                    </div>
                  )}
                  {item.status === 'pending' && (
                    <div className="flex items-center gap-2 pt-2">
                      <input
                        type="text"
                        placeholder="پاسخ به کاربر..."
                        className="input-refined flex-1 !h-11 text-[14px]"
                        value={replyMap[item.id] || ''}
                        onChange={(e) => setReplyMap((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      />
                      <button
                        disabled={busyId === item.id}
                        onClick={() => handleResolveSupport(item.id)}
                        className="h-11 px-5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-black shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:scale-95 transition-all disabled:opacity-50"
                      >
                        ارسال پاسخ و حل مشکل
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'finance' && (() => {
        const filteredSlips =
          financeFilter === 'all'
            ? manualSlips
            : financeFilter === 'rejected'
            ? manualSlips.filter((s) => s.status === 'rejected' || s.status === 'cancelled')
            : manualSlips.filter((s) => s.status === financeFilter);
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <h3 className="text-sm font-black text-slate-900 dark:text-white">بررسی فیش‌های واریزی و درخواست‌های برداشت دستی</h3>
              <div className="px-3.5 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-xs font-black text-emerald-600 dark:text-emerald-300 tabular-nums">
                کل کارمزد دریافتی پلتفرم: {Number(feeSummary?.total_fees_collected ?? platformStats?.total_fees_collected ?? 0).toLocaleString()} تومان
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap px-1">
              {[
                { id: 'pending', label: `در انتظار (${manualSlips.filter((s) => s.status === 'pending').length})` },
                { id: 'approved', label: `تایید شده (${manualSlips.filter((s) => s.status === 'approved').length})` },
                { id: 'rejected', label: `رد و لغو شده (${manualSlips.filter((s) => s.status === 'rejected' || s.status === 'cancelled').length})` },
                { id: 'all', label: `همه (${manualSlips.length})` },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFinanceFilter(f.id as any)}
                  className={`h-8 px-3 rounded-xl text-[10px] font-black transition-all ${
                    financeFilter === f.id
                      ? 'bg-blue-600 text-white shadow'
                      : 'bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {feeSummary && feeSummary.recent_fee_transactions.length > 0 && (
              <div className="card-refined p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-black text-slate-900 dark:text-white">دفترچه درآمد کارمزد پلتفرم ({feeSummary.platform_fee_percent}٪)</span>
                  <span className="text-[10px] text-slate-400">{feeSummary.recent_fee_transactions.length} تراکنش اخیر</span>
                </div>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {feeSummary.recent_fee_transactions.slice(0, 8).map((ft: any) => (
                    <div key={ft.id} className="flex items-center justify-between text-[11px] p-2.5 rounded-xl bg-slate-50 dark:bg-[#18202e]">
                      <span className="text-slate-700 dark:text-slate-200 truncate flex-1 pl-2">{ft.description || `کارمزد ${ft.contract_id}`}</span>
                      <span className="font-black text-emerald-600 dark:text-emerald-400 tabular-nums shrink-0">
                        +{Number(ft.amount || 0).toLocaleString()} تومان
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-3">
              {filteredSlips.length === 0 ? (
                <div className="card-refined p-10 text-center text-xs font-bold text-slate-500">درخواست مالی در این بخش ثبت نشده است</div>
              ) : (
                filteredSlips.map((slip) => (
                  <div key={slip.id} className="card-refined p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-start gap-3">
                      {slip.slip_image_url && (
                        <button
                          type="button"
                          onClick={() => setPreviewSlipUrl(slip.slip_image_url)}
                          className="shrink-0 rounded-xl overflow-hidden border border-slate-200 dark:border-white/[0.08]"
                          title="مشاهده تصویر فیش"
                        >
                          <img src={slip.slip_image_url} alt="فیش" className="w-16 h-12 object-cover" />
                        </button>
                      )}
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`px-2.5 py-0.5 rounded-md text-[10px] font-black uppercase ${
                              slip.type === 'deposit' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'
                            }`}
                          >
                            {slip.type === 'deposit' ? 'واریز (فیش)' : 'برداشت وجه'}
                          </span>
                          <span className="text-xs font-bold text-slate-500 dark:text-slate-300 font-sans tabular-nums">
                            {slip.type === 'withdraw' ? 'مقصد:' : 'کد پیگیری:'}{' '}
                            {slip.type === 'withdraw' && slip.payout_kind === 'card'
                              ? formatIranianCard(slip.ref_code)
                              : slip.ref_code}
                          </span>
                          {slip.ref_code && (
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard?.writeText(String(slip.ref_code)).then(() => notify('کد / مقصد کپی شد', 'success')).catch(() => {});
                              }}
                              className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-white/10 text-[10px] font-black text-slate-600 dark:text-slate-200 hover:bg-blue-600 hover:text-white transition-colors"
                            >
                              کپی
                            </button>
                          )}
                        </div>
                        <h4 className="text-sm font-black text-slate-900 dark:text-white">
                          {slip.user_name || slip.user_id} — <span className="text-blue-500">{Number(slip.amount).toLocaleString()} تومان</span>
                        </h4>
                        {(slip.bank_name || slip.holder_name || slip.source_card) && (
                          <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold text-slate-500 dark:text-slate-300">
                            {slip.bank_name && <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-500">{slip.bank_name}</span>}
                            {slip.holder_name && <span>به نام: {slip.holder_name}</span>}
                            {slip.source_card && (
                              <span dir="ltr" className="font-mono text-slate-600 dark:text-slate-200">
                                کارت مبدأ: {slip.source_card}
                                {slip.source_bank_name ? ` (${slip.source_bank_name})` : ''}
                              </span>
                            )}
                          </div>
                        )}
                        <span className="text-[9px] text-slate-400 block">{formatDateTimeFa(slip.created_at)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {slip.status === 'pending' ? (
                        <>
                          <button
                            disabled={busyId === slip.id}
                            onClick={() => setPendingSlipConfirm({ slip, decision: 'approved' })}
                            className="h-10 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black shadow-md shadow-emerald-600/20 active:scale-95 transition-all disabled:opacity-50"
                          >
                            تایید و اعمال
                          </button>
                          <button
                            disabled={busyId === slip.id}
                            onClick={() => setPendingSlipConfirm({ slip, decision: 'rejected' })}
                            className="h-10 px-4 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-black shadow-md shadow-rose-600/20 active:scale-95 transition-all disabled:opacity-50"
                          >
                            رد درخواست
                          </button>
                        </>
                      ) : (
                        <span
                          className={`px-3 py-1 rounded-xl text-xs font-bold ${
                            slip.status === 'approved'
                              ? 'bg-emerald-500/10 text-emerald-500'
                              : slip.status === 'cancelled'
                              ? 'bg-slate-200/80 dark:bg-white/10 text-slate-500 dark:text-slate-300'
                              : 'bg-rose-500/10 text-rose-500'
                          }`}
                        >
                          {slip.status === 'approved' ? 'تایید و اعمال شد' : slip.status === 'cancelled' ? 'لغو توسط کاربر' : 'رد شد'}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })()}

      {previewSlipUrl && (
        <div
          onClick={() => setPreviewSlipUrl(null)}
          className="fixed inset-0 bg-black/85 backdrop-blur-md z-[1300] flex items-center justify-center p-6"
        >
          <div className="relative max-w-xl w-full bg-white dark:bg-[#131924] rounded-3xl p-4 border border-white/20" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setPreviewSlipUrl(null)}
              className="w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 flex items-center justify-center text-slate-800 dark:text-white mb-3"
            >
              <X size={18} />
            </button>
            <img src={previewSlipUrl} alt="پیش‌نمایش مدرک" className="w-full max-h-[75vh] object-contain rounded-2xl" />
          </div>
        </div>
      )}

      {activeTab === 'deals' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-black text-slate-900 dark:text-white">نظارت بر تمامی معاملات پلتفرم</h3>
          </div>
          <div className="space-y-3">
            {allDeals.length > 0 ? (
              allDeals.map((c) => (
                <div
                  key={c.id || c.contract_id}
                  onClick={() => {
                    localStorage.setItem('selected_contract', JSON.stringify(c));
                    setView(isDisputedStatus(c.status) || c.appeal || c.resolution ? 'dispute' : 'detail');
                  }}
                  className="card-refined p-5 flex items-center justify-between gap-4 cursor-pointer hover:border-blue-500/40 transition-all"
                >
                  <div>
                    <h4 className="text-sm font-black text-slate-900 dark:text-white">{c.title}</h4>
                    <span className="text-[10px] text-slate-500">
                      شناسه: {c.contract_id} | دسته: {getCategoryMeta(c.category).label} | مبلغ: {Number(c.amount || 0).toLocaleString()} تومان | کارفرما: {c.buyer_fullname || c.buyer_id || 'در انتظار'} | مجری: {c.seller_fullname || c.seller_id || 'در انتظار'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusLabel status={c.status} />
                    {isDisputedStatus(c.status) && (
                      <span className="px-2.5 py-1 rounded-full bg-rose-600 text-white text-[9px] font-black">داوری</span>
                    )}
                    {c.appeal?.status === 'pending' && (
                      <span className="px-2.5 py-1 rounded-full bg-amber-500 text-black text-[9px] font-black">تجدیدنظر باز</span>
                    )}
                  </div>
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
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">به عنوان مالک کل، می‌توانید سطوح دسترسی بخش‌های پشتیبانی و مالی را برای ادمین‌ها تنظیم کنید.</p>
          </div>

          <div className="space-y-4">
            <label className="p-4 bg-slate-50 dark:bg-[#18202e] rounded-2xl flex items-center justify-between cursor-pointer">
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">بخش پشتیبانی و پاسخ به تیکت‌ها</h4>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">دسترسی ادمین به چت‌ها و حل مشکلات کاربران</span>
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
            <label className="p-4 bg-slate-50 dark:bg-[#18202e] rounded-2xl flex items-center justify-between cursor-pointer">
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-white">بخش بررسی فیش‌ها و درخواست‌های مالی</h4>
                <span className="text-[10px] text-slate-500 dark:text-slate-400">دسترسی ادمین به تایید/رد واریزی و برداشت‌ها</span>
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

      <ConfirmDialog
        open={Boolean(pendingSlipConfirm)}
        title={
          pendingSlipConfirm?.decision === 'approved'
            ? 'تایید و اعمال درخواست مالی'
            : 'رد درخواست مالی'
        }
        description={
          pendingSlipConfirm?.decision === 'approved'
            ? pendingSlipConfirm?.slip?.type === 'deposit'
              ? 'با تایید این فیش واریزی، مبلغ به موجودی کیف پول کاربر اضافه می‌شود.'
              : 'با تایید این درخواست برداشت، مبلغ از حساب کاربر کسر و تسویه نهایی ثبت می‌شود.'
            : 'آیا از رد این درخواست مالی مطمئن هستید؟'
        }
        previewText={
          pendingSlipConfirm?.slip
            ? `${pendingSlipConfirm.slip.user_name || pendingSlipConfirm.slip.user_id} — ${
                pendingSlipConfirm.slip.type === 'deposit' ? 'واریز' : 'برداشت'
              } ${Number(pendingSlipConfirm.slip.amount || 0).toLocaleString()} تومان`
            : undefined
        }
        confirmLabel={pendingSlipConfirm?.decision === 'approved' ? 'بله، تایید و اعمال' : 'بله، رد شود'}
        cancelLabel="انصراف"
        tone={pendingSlipConfirm?.decision === 'approved' ? 'primary' : 'danger'}
        busy={Boolean(pendingSlipConfirm && busyId === pendingSlipConfirm.slip.id)}
        onCancel={() => {
          if (!busyId) setPendingSlipConfirm(null);
        }}
        onConfirm={async () => {
          if (!pendingSlipConfirm) return;
          await handleSlipDecision(pendingSlipConfirm.slip.id, pendingSlipConfirm.decision);
          setPendingSlipConfirm(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingKycConfirm)}
        title={
          pendingKycConfirm?.decision === 'verified'
            ? 'تایید نهایی احراز هویت (KYC)'
            : 'رد درخواست احراز هویت'
        }
        description={
          pendingKycConfirm?.decision === 'verified'
            ? 'آیا مدارک و تطابق هویتی این کاربر را تایید می‌کنید؟'
            : 'آیا مطمئن هستید که می‌خواهید درخواست احراز هویت این کاربر را رد کنید؟'
        }
        previewText={
          pendingKycConfirm?.user
            ? `${pendingKycConfirm.user.full_name || pendingKycConfirm.user.id}${
                pendingKycConfirm.user.national_id ? ` — کد ملی: ${pendingKycConfirm.user.national_id}` : ''
              }`
            : undefined
        }
        confirmLabel={pendingKycConfirm?.decision === 'verified' ? 'بله، تایید هویت' : 'بله، رد شود'}
        cancelLabel="انصراف"
        tone={pendingKycConfirm?.decision === 'verified' ? 'primary' : 'danger'}
        busy={Boolean(pendingKycConfirm && busyId === pendingKycConfirm.user.id)}
        onCancel={() => {
          if (!busyId) setPendingKycConfirm(null);
        }}
        onConfirm={async () => {
          if (!pendingKycConfirm) return;
          await handleKycAdminDecision(pendingKycConfirm.user.id, pendingKycConfirm.decision);
          setPendingKycConfirm(null);
        }}
      />
    </motion.div>
  );
}

// --- Mianji Escrow Marketplace (Templates & Guaranteed Categories) ---
const MARKETPLACE_TEMPLATES = [
  {
    id: 'tpl_web_app',
    category: 'توسعه و فناوری',
    title: 'طراحی و پیاده‌سازی وب‌سایت یا اپلیکیشن اختصاصی',
    suggestedAmount: 18000000,
    feePayer: 'split' as const,
    icon: <Code size={20} />,
    terms:
      'تحویل کد منبع کامل روی گیت‌هاب، نصب روی سرور کارفرما، ریسپانسیو موبایل و ۳ روز پشتیبانی پس از تحویل نهایی با ضمانت امانت میانجی.',
    milestones: [
      { title: 'طراحی رابط کاربری و تایید طرح اولیه', percent: 30 },
      { title: 'پیاده‌سازی نسخه آزمایشی و پنل مدیریت', percent: 40 },
      { title: 'تحویل سورس نهایی و راه‌اندازی روی دامنه', percent: 30 },
    ],
  },
  {
    id: 'tpl_design_brand',
    category: 'طراحی و گرافیک',
    title: 'طراحی هویت بصری، لوگو و UI/UX محصول',
    suggestedAmount: 7500000,
    feePayer: 'buyer' as const,
    icon: <Palette size={20} />,
    terms:
      'ارائه حداقل ۲ اتود اولیه، اصلاحات تا ۲ مرحله، و تحویل فایل‌های لایه‌باز Figma / AI / SVG با کیفیت چاپ و وب.',
    milestones: [
      { title: 'ارائه اتودهای اولیه و انتخاب مسیر طراحی', percent: 40 },
      { title: 'تکمیل پکیج و تحویل فایل‌های لایه‌باز', percent: 60 },
    ],
  },
  {
    id: 'tpl_digital_goods',
    category: 'کالای دیجیتال',
    title: 'خرید و فروش لپ‌تاپ، موبایل یا تجهیزات دیجیتال',
    suggestedAmount: 35000000,
    feePayer: 'split' as const,
    icon: <ShoppingBag size={20} />,
    terms:
      'ضمانت اصالت و سلامت فنی کالا، ثبت شماره سریال در چت قرارداد، و مهلت ۴۸ ساعته تست کالا توسط خریدار پیش از آزادسازی وجه امانی.',
    milestones: [],
  },
  {
    id: 'tpl_channel_account',
    category: 'اکانت و رسانه',
    title: 'انتقال مالکیت کانال تلگرام، پیج اینستاگرام یا دامنه',
    suggestedAmount: 12000000,
    feePayer: 'split' as const,
    icon: <Globe size={20} />,
    terms:
      'انتقال کامل مالکیت به ایمیل/سیم‌کارت خریدار، تغییر رمز دومرحله‌ای و تایید عدم وجود محدودیت یا اخطار پیش از آزادسازی وجه.',
    milestones: [],
  },
  {
    id: 'tpl_consulting',
    category: 'خدمات تخصصی',
    title: 'قرارداد سئو، تولید محتوا و کمپین تبلیغاتی',
    suggestedAmount: 9000000,
    feePayer: 'buyer' as const,
    icon: <Briefcase size={20} />,
    terms:
      'تحویل گزارش فنی کلمات کلیدی، انتشار محتوای تاییدشده و گزارش پیشرفت ماهانه بر اساس شاخص‌های توافق‌شده در قرارداد.',
    milestones: [
      { title: 'آنالیز فنی و تدوین استراتژی', percent: 40 },
      { title: 'اجرا و تحویل گزارش نهایی', percent: 60 },
    ],
  },
];

function MarketplaceView({ setView, notify }: { setView: (v: View) => void; notify: any }) {
  const [catFilter, setCatFilter] = useState<string>('همه');
  const [search, setSearch] = useState('');

  const categories = ['همه', 'توسعه و فناوری', 'طراحی و گرافیک', 'کالای دیجیتال', 'اکانت و رسانه', 'خدمات تخصصی'];

  const filtered = MARKETPLACE_TEMPLATES.filter((t) => {
    if (catFilter !== 'همه' && t.category !== catFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return t.title.toLowerCase().includes(q) || t.terms.toLowerCase().includes(q) || t.category.toLowerCase().includes(q);
  });

  const handleUseTemplate = (tpl: (typeof MARKETPLACE_TEMPLATES)[number]) => {
    try {
      const payload: any = {
        title: tpl.title,
        amount: String(tpl.suggestedAmount),
        fee_payer: tpl.feePayer,
        terms: tpl.terms,
      };
      if (tpl.milestones.length >= 2) {
        payload.milestones = tpl.milestones.map((m) => ({
          title: m.title,
          amount: Math.round((tpl.suggestedAmount * m.percent) / 100),
        }));
      }
      localStorage.setItem('mianji_create_template', JSON.stringify(payload));
      setView('create');
      notify('الگوی معامله انتخاب شد. مشخصات طرف مقابل را وارد کنید.', 'info');
    } catch {
      setView('create');
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 max-w-4xl mx-auto pb-20">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setView('dashboard')}
            className="w-10 h-10 rounded-xl bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all"
          >
            <ChevronRight size={20} />
          </button>
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
              <Sparkles size={18} className="text-blue-600 dark:text-blue-400" />
              بازارچه الگوهای معامله امن میانجی
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-300">شروع سریع قرارداد استاندارد با شرایط حقوقی آماده و مراحل امانی</p>
          </div>
        </div>
      </div>

      <div className="card-refined p-4 space-y-3">
        <div className="relative">
          <Search size={15} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جستجو در الگوهای قرارداد (طراحی، کالا، اکانت، سایت...)"
            className="input-refined !h-10 pr-10 text-[14px]"
          />
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCatFilter(cat)}
              className={`px-3 py-1.5 rounded-xl text-[11px] font-black whitespace-nowrap shrink-0 transition-all ${
                catFilter === cat
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-white/15'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((tpl) => (
          <div key={tpl.id} className="card-obsidian rounded-[1.75rem] p-5 flex flex-col justify-between gap-4">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="w-11 h-11 rounded-2xl bg-blue-600/15 text-blue-600 dark:text-blue-300 flex items-center justify-center shrink-0">
                  {tpl.icon}
                </div>
                <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/10 text-[10px] font-black text-slate-600 dark:text-slate-200">
                  {tpl.category}
                </span>
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-black text-slate-900 dark:text-white leading-snug">{tpl.title}</h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-300 leading-relaxed">{tpl.terms}</p>
              </div>
              {tpl.milestones.length > 0 && (
                <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/70 dark:border-white/10 space-y-1">
                  <span className="text-[10px] font-black text-blue-600 dark:text-blue-300 block">
                    دارای {tpl.milestones.length} مرحله پرداخت امانی پیشنهادی
                  </span>
                  {tpl.milestones.map((m, i) => (
                    <div key={i} className="flex items-center justify-between text-[10px] text-slate-600 dark:text-slate-300">
                      <span className="truncate">{i + 1}. {m.title}</span>
                      <span className="font-mono font-bold shrink-0 mr-2">{m.percent}٪</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-white/10 flex items-center justify-between gap-3">
              <div>
                <span className="text-[9px] font-bold text-slate-400 block">مبلغ پایه پیشنهادی</span>
                <span className="text-xs font-black text-slate-900 dark:text-white tabular-nums">
                  {tpl.suggestedAmount.toLocaleString()} تومان
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleUseTemplate(tpl)}
                className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all shrink-0"
              >
                <Plus size={14} />
                <span>ایجاد معامله با این الگو</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

// --- Quick Call Picker Modal (Sidebar Voice & Video Call Entry) ---
function QuickCallModal({ user, contracts, onClose, onStartCall }: any) {
  const [targets, setTargets] = useState<Array<{
    uid: string;
    targetUserId: string;
    name: string;
    subtitle: string;
    scope: 'direct' | 'contract';
    chatId: string;
    online?: boolean;
  }>>([]);
  const [search, setSearch] = useState('');
  const [loadingList, setLoadingList] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const myId = String(user?.id || '');
    const map = new Map<string, any>();

    for (const c of contracts || []) {
      const amBuyer = String(c.buyer_id) === myId;
      const peerId = amBuyer ? String(c.seller_id || '') : String(c.buyer_id || '');
      const peerName = amBuyer ? c.seller_name || 'مجری معامله' : c.buyer_name || 'کارفرما';
      if (peerId && peerId !== myId && !isPendingPartyId(peerId) && !map.has(peerId)) {
        map.set(peerId, {
          uid: `user_${peerId}`,
          targetUserId: peerId,
          name: peerName,
          subtitle: `قرارداد: ${c.title || c.contract_id}`,
          scope: 'contract' as const,
          chatId: String(c.contract_id),
          online: realtimeClient.isUserOnline(peerId),
        });
      }
    }

    Promise.allSettled([
      apiFetch<{ success: boolean; chats?: any[] }>('/api/chats/direct'),
      apiFetch<{ success: boolean; contacts?: any[] }>('/api/contacts'),
    ])
      .then(([chatsRes, contactsRes]) => {
        if (cancelled) return;
        if (chatsRes.status === 'fulfilled' && Array.isArray(chatsRes.value?.chats)) {
          for (const d of chatsRes.value.chats) {
            const peerId = String(d.counterparty_id || '');
            if (peerId && peerId !== myId && !isPendingPartyId(peerId)) {
              map.set(peerId, {
                uid: `user_${peerId}`,
                targetUserId: peerId,
                name: d.full_name || d.phone_number || 'کاربر میانجی',
                subtitle: d.is_support ? 'پشتیبانی رسمی' : d.phone_number || 'گفتگوی مستقیم',
                scope: 'direct' as const,
                chatId: String(d.id),
                online: Boolean(d.online || realtimeClient.isUserOnline(peerId)),
              });
            }
          }
        }
        if (contactsRes.status === 'fulfilled' && Array.isArray(contactsRes.value?.contacts)) {
          for (const cnt of contactsRes.value.contacts) {
            const peerId = String(cnt.target_user_id || '');
            if (peerId && peerId !== myId && !isPendingPartyId(peerId) && !map.has(peerId)) {
              map.set(peerId, {
                uid: `user_${peerId}`,
                targetUserId: peerId,
                name: cnt.full_name || cnt.phone_number,
                subtitle: cnt.phone_number || 'مخاطب ذخیره‌شده',
                scope: 'direct' as const,
                chatId: String(cnt.id),
                online: realtimeClient.isUserOnline(peerId),
              });
            }
          }
        }
        setTargets(Array.from(map.values()));
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, contracts]);

  const filtered = targets.filter((t) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.subtitle.toLowerCase().includes(q);
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1100] flex items-center justify-center p-5"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl p-6 space-y-4 relative shadow-2xl max-h-[85vh] flex flex-col"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 left-5 w-9 h-9 rounded-full bg-slate-100 dark:bg-white/10 border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white"
        >
          <X size={18} />
        </button>

        <div className="text-right space-y-1 pl-10">
          <h3 className="text-base font-black text-slate-900 dark:text-white">تماس صوتی و تصویری امن</h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-300">طرف مقابل را برای برقراری تماس مستقیم WebRTC انتخاب کنید</p>
        </div>

        <div className="relative">
          <Search size={15} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جستجوی نام یا شماره..."
            className="input-refined !h-10 pr-10 text-[14px]"
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 min-h-[160px] max-h-[340px]">
          {loadingList ? (
            <div className="py-10 text-center text-xs text-slate-400">در حال بارگذاری مخاطبین آنلاین...</div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-300 leading-relaxed">
              هنوز طرف معامله یا مخاطب عضو میانجی برای تماس پیدا نشد. از بخش پیام‌رسان یا مخاطبین گفتگویی آغاز کنید.
            </div>
          ) : (
            filtered.map((t) => (
              <div
                key={t.uid}
                className="p-3 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative w-10 h-10 rounded-full bg-blue-600/15 text-blue-600 dark:text-blue-300 flex items-center justify-center font-black text-sm shrink-0">
                    {t.name[0] || 'U'}
                    {t.online && (
                      <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white dark:border-[#18202e]" />
                    )}
                  </div>
                  <div className="min-w-0 text-right">
                    <p className="text-xs font-black text-slate-900 dark:text-white truncate">{t.name}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300 truncate">{t.subtitle}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() =>
                      onStartCall({
                        targetUserId: t.targetUserId,
                        targetName: t.name,
                        mode: 'audio',
                        scope: t.scope,
                        chatId: t.chatId,
                      })
                    }
                    className="w-9 h-9 rounded-xl bg-emerald-500/15 hover:bg-emerald-600 text-emerald-600 hover:text-white border border-emerald-500/30 flex items-center justify-center transition-colors"
                    title="تماس صوتی"
                  >
                    <Phone size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onStartCall({
                        targetUserId: t.targetUserId,
                        targetName: t.name,
                        mode: 'video',
                        scope: t.scope,
                        chatId: t.chatId,
                      })
                    }
                    className="w-9 h-9 rounded-xl bg-blue-600/15 hover:bg-blue-600 text-blue-600 dark:text-blue-300 hover:text-white border border-blue-500/30 flex items-center justify-center transition-colors"
                    title="تماس تصویری"
                  >
                    <Video size={15} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </motion.div>
  );
}

// --- Active WebRTC Audio/Video Call Overlay ---
function CallOverlayModal({
  call,
  localStream,
  remoteStream,
  muted,
  cameraOff,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleCamera,
}: any) {
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream || null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream || null;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream || null;
    }
  }, [localStream]);

  useEffect(() => {
    if (call.status !== 'connected') {
      setElapsedSec(0);
      return;
    }
    const id = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [call.status]);

  const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const secs = String(elapsedSec % 60).padStart(2, '0');

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-[#0b0f17]/92 backdrop-blur-xl z-[1400] flex items-center justify-center p-4"
    >
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      <div className="w-full max-w-md bg-[#0e1420] border border-white/20 rounded-3xl p-6 text-white shadow-2xl flex flex-col items-center justify-between gap-6 relative overflow-hidden min-h-[420px]">
        <div className="w-full flex items-center justify-between text-xs text-slate-300">
          <span className="flex items-center gap-1.5 font-black text-emerald-400">
            <ShieldCheck size={14} /> تماس رمزنگاری‌شده همتابه‌همتا
          </span>
          <span className="font-mono text-[11px]">
            {call.mode === 'video' ? 'تماس تصویری' : 'تماس صوتی'}
          </span>
        </div>

        {call.mode === 'video' ? (
          <div className="relative w-full aspect-[4/3] rounded-2xl bg-black/60 border border-white/15 overflow-hidden flex items-center justify-center">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />
            {call.status !== 'connected' && (
              <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-2">
                <div className="w-16 h-16 rounded-full bg-blue-600 flex items-center justify-center font-black text-2xl">
                  {call.peerName?.[0] || 'U'}
                </div>
                <span className="text-sm font-black">{call.peerName}</span>
                <span className="text-xs text-slate-300">
                  {call.status === 'ringing'
                    ? call.direction === 'incoming'
                      ? 'تماس تصویری ورودی...'
                      : 'در حال زنگ خوردن...'
                    : 'در حال برقراری ارتباط...'}
                </span>
              </div>
            )}
            {localStream && (
              <video
                ref={localVideoRef}
                muted
                autoPlay
                playsInline
                className={`absolute bottom-3 left-3 w-24 h-32 rounded-xl object-cover border-2 border-white/40 bg-black shadow-lg ${
                  cameraOff ? 'opacity-20' : ''
                }`}
              />
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-6">
            <div className="relative">
              <div className="w-24 h-24 rounded-full bg-blue-600 flex items-center justify-center font-black text-3xl shadow-2xl border-4 border-white/25">
                {call.peerName?.[0] || 'U'}
              </div>
              {call.status === 'ringing' && (
                <span className="absolute -inset-2 rounded-full border-2 border-blue-400/50 animate-ping" />
              )}
            </div>
            <div className="text-center space-y-1">
              <h3 className="text-lg font-black">{call.peerName}</h3>
              <p className="text-xs text-slate-300 font-mono">
                {call.status === 'connected'
                  ? `${mins}:${secs}`
                  : call.status === 'connecting'
                  ? 'در حال برقراری ارتباط...'
                  : call.direction === 'incoming'
                  ? 'تماس صوتی ورودی...'
                  : 'در حال زنگ خوردن...'}
              </p>
            </div>
          </div>
        )}

        <div className="w-full flex items-center justify-center gap-4">
          {call.direction === 'incoming' && call.status === 'ringing' ? (
            <>
              <button
                type="button"
                onClick={onAccept}
                className="w-14 h-14 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white flex items-center justify-center shadow-lg active:scale-90 transition-all"
                title="پاسخ"
              >
                <PhoneIncoming size={24} />
              </button>
              <button
                type="button"
                onClick={onReject}
                className="w-14 h-14 rounded-full bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center shadow-lg active:scale-90 transition-all"
                title="رد تماس"
              >
                <PhoneOff size={24} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onToggleMute}
                className={`w-12 h-12 rounded-full border flex items-center justify-center transition-all ${
                  muted ? 'bg-amber-500 text-black border-amber-300' : 'bg-white/10 text-white border-white/25'
                }`}
                title={muted ? 'وصل میکروفون' : 'قطع میکروفون'}
              >
                {muted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
              {call.mode === 'video' && (
                <button
                  type="button"
                  onClick={onToggleCamera}
                  className={`w-12 h-12 rounded-full border flex items-center justify-center transition-all ${
                    cameraOff ? 'bg-amber-500 text-black border-amber-300' : 'bg-white/10 text-white border-white/25'
                  }`}
                  title={cameraOff ? 'روشن کردن دوربین' : 'خاموش کردن دوربین'}
                >
                  {cameraOff ? <VideoOff size={20} /> : <Video size={20} />}
                </button>
              )}
              <button
                type="button"
                onClick={onEnd}
                className="w-14 h-14 rounded-full bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center shadow-lg active:scale-90 transition-all"
                title="قطع تماس"
              >
                <PhoneOff size={24} />
              </button>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
