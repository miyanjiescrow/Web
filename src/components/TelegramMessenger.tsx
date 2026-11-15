import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search, ChevronRight, Send, Paperclip, Mic, Check, CheckCheck,
  Image as ImageIcon, FileText, Camera, X, Pencil, Reply, Copy,
  Pin, Trash2, ArrowDown, Shield, ShieldCheck, MessageCircle,
  Sparkles, Plus, Play, Pause, Smile, Square, Megaphone,
  Eye, BadgeCheck, Users, BellOff, Bell, Share2, UserPlus,
  Forward, Phone, Video
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch, uploadMediaFile } from '../lib/apiClient';
import { realtimeClient } from '../services/realtimeClient';
import { getEscrowActions } from '../services/escrowService';
import {
  normalizeDigits,
  getDealStatusMeta,
  normalizeDealStatus,
  isUserDealBuyer,
  isPendingPartyId,
} from '../lib/dealSync';

const toMs = (ts: any): number => {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts?.toMillis === 'function') return ts.toMillis();
  if (typeof ts?.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts?.seconds === 'number') return ts.seconds * 1000;
  const parsed = Date.parse(String(ts));
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatTimeFa = (ts: any): string => {
  const ms = toMs(ts);
  if (!ms) return 'اکنون';
  return new Date(ms).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
};

const formatDayChipFa = (ts: any): string => {
  const ms = toMs(ts);
  if (!ms) return 'امروز';
  const d = new Date(ms);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfMsg) / 86400000);
  if (diffDays === 0) return 'امروز';
  if (diffDays === 1) return 'دیروز';
  return d.toLocaleDateString('fa-IR', { month: 'long', day: 'numeric' });
};

const formatListTimeFa = (ts: any): string => {
  const ms = toMs(ts);
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });
};

const translateStatusShort = (status: string) => getDealStatusMeta(status).shortLabel;

const QUICK_EMOJIS = ['👍', '🙏', '✅', '❤️', '🤝', '🔥', '👌', '✨'];
const CHANNEL_REACTIONS = ['👍', '❤️', '🔥', '✅'];

export interface ChatMessageItem {
  id: string;
  sender_id: string | number;
  text: string;
  type: 'text' | 'image' | 'voice' | 'file' | 'deal';
  attachment_url?: string;
  created_at: any;
  pending?: boolean;
  read?: boolean;
  read_by?: string[];
  edited_at?: string;
  reactions?: Record<string, string[]>;
  is_system?: boolean;
  deal_id?: string;
  deal_snapshot?: {
    contract_id: string;
    title: string;
    amount: number;
    status: string;
    buyer_id?: string;
    seller_id?: string;
    buyer_name?: string;
    seller_name?: string;
  };
  reply_to?: {
    id: string;
    sender_name: string;
    text: string;
  } | null;
  forwarded_from?: {
    sender_name: string;
    source_title?: string;
  } | null;
}

export interface DirectChatContact {
  id: string | number;
  counterparty_id?: string;
  full_name: string;
  phone_number: string;
  last_msg?: string;
  time?: string;
  unread?: number;
  online?: boolean;
  is_support?: boolean;
}

export interface ChannelItem {
  channel_id: string;
  handle: string;
  title: string;
  description: string;
  owner_id: string;
  owner_name: string;
  category: string;
  is_verified: boolean;
  subscribers_count: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelPostItem {
  id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  text: string;
  message_type: 'text' | 'image' | 'voice' | 'file';
  attachment_url?: string;
  views: number;
  silent?: boolean;
  reactions?: Record<string, string[]>;
  created_at: string;
}

const DEFAULT_CHANNELS: ChannelItem[] = [
  {
    channel_id: 'ch_mianji_official',
    handle: 'mianji_official',
    title: 'کانال رسمی میانجی',
    description: 'اطلاعیه‌های رسمی، آپدیت‌های امنیتی و اخبار پلتفرم معاملات امانی میانجی',
    owner_id: 'u_admin_owner',
    owner_name: 'تیم میانجی',
    category: 'رسمی',
    is_verified: true,
    subscribers_count: 12450,
    createdAt: new Date(Date.now() - 86400000 * 14).toISOString(),
    updatedAt: new Date(Date.now() - 3600000 * 2).toISOString()
  },
  {
    channel_id: 'ch_mianji_academy',
    handle: 'mianji_academy',
    title: 'آکادمی معاملات امن',
    description: 'راهنمای قراردادنویسی حرفه‌ای، نکات جلوگیری از کلاهبرداری و چک‌لیست‌های تحویل کار',
    owner_id: 'u_admin_owner',
    owner_name: 'آکادمی میانجی',
    category: 'آموزش',
    is_verified: true,
    subscribers_count: 5820,
    createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 3600000 * 5).toISOString()
  }
];

const DEFAULT_CHANNEL_POSTS: Record<string, ChannelPostItem[]> = {
  ch_mianji_official: [
    {
      id: 'post_official_1',
      channel_id: 'ch_mianji_official',
      author_id: 'u_admin_owner',
      author_name: 'تیم میانجی',
      text: '🔐 به کانال رسمی میانجی خوش آمدید!\n\nتمام اطلاعیه‌های مهم سیستم Escrow، به‌روزرسانی‌های کیف پول و هشدارهای امنیتی معاملات آنلاین در این کانال منتشر می‌شود.',
      message_type: 'text',
      views: 11840,
      created_at: new Date(Date.now() - 86400000 * 3).toISOString()
    },
    {
      id: 'post_official_2',
      channel_id: 'ch_mianji_official',
      author_id: 'u_admin_owner',
      author_name: 'تیم میانجی',
      text: '⚡ بخش کانال‌ها در پیام‌رسان میانجی فعال شد:\nاز امروز می‌توانید اخبار رسمی را دنبال کنید و یا کانال اختصاصی خود را بسازید.',
      message_type: 'text',
      views: 9420,
      created_at: new Date(Date.now() - 3600000 * 2).toISOString()
    }
  ],
  ch_mianji_academy: [
    {
      id: 'post_academy_1',
      channel_id: 'ch_mianji_academy',
      author_id: 'u_admin_owner',
      author_name: 'آکادمی میانجی',
      text: '✅ چک‌لیست طلایی قبل از قفل وجه:\n۱. تمام جزئیات تحویل و تعداد اصلاحات را شفاف در توضیحات معامله ثبت کنید.\n۲. فایل‌ها و تاییدیه‌ها را فقط در چت داخل قرارداد ارسال نمایید.',
      message_type: 'text',
      views: 4910,
      created_at: new Date(Date.now() - 86400000 * 2).toISOString()
    }
  ]
};

// --- Lightweight Memoized Voice Player ---
const TgVoicePlayer = React.memo(function TgVoicePlayer({
  url,
  isOwn
}: {
  url: string;
  isOwn: boolean;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [durationStr, setDurationStr] = useState('0:00');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) {
        const mins = Math.floor(audio.duration / 60);
        const secs = Math.floor(audio.duration % 60);
        setDurationStr(`${mins}:${secs < 10 ? '0' : ''}${secs}`);
      }
    };
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
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  };

  return (
    <div className="flex items-center gap-2.5 py-0.5 min-w-[175px]">
      <button
        type="button"
        onClick={toggle}
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-transform active:scale-90 ${
          isOwn
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'bg-blue-600 text-white shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
        }`}
      >
        {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
      <div className="flex-1 space-y-1">
        <div className={`h-1.5 w-full rounded-full overflow-hidden ${isOwn ? 'bg-white/25' : 'bg-blue-100 dark:bg-white/15'}`}>
          <div
            className={`h-full transition-all duration-100 ${isOwn ? 'bg-white' : 'bg-blue-600 dark:bg-sky-400'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] font-sans opacity-85 tabular-nums">
          <span>پیام صوتی</span>
          <span>{durationStr}</span>
        </div>
      </div>
    </div>
  );
});

// --- Isolated Composer Bar (Typing only re-renders this tiny component -> ZERO LAG) ---
const TelegramComposer = React.memo(function TelegramComposer({
  replyTo,
  onCancelReply,
  editingMsg,
  onCancelEdit,
  onConfirmEdit,
  onSendText,
  onSendFile,
  onSendVoice,
  onOpenDealShare,
  onTyping,
  notify,
  placeholder = 'پیام...',
  extraToggle
}: {
  replyTo: { id: string; sender_name: string; text: string } | null;
  onCancelReply: () => void;
  editingMsg?: ChatMessageItem | null;
  onCancelEdit?: () => void;
  onConfirmEdit?: (msgId: string, newText: string) => void;
  onSendText: (text: string) => void;
  onSendFile: (file: File, type: 'image' | 'file') => void;
  onSendVoice: (blobUrl: string, blob?: Blob) => void;
  onOpenDealShare?: () => void;
  onTyping?: (isTyping: boolean) => void;
  notify?: (m: string, t?: 'success' | 'error' | 'info') => void;
  placeholder?: string;
  extraToggle?: React.ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [showAttachments, setShowAttachments] = useState(false);
  const [showEmojiBar, setShowEmojiBar] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    if (editingMsg) {
      setDraft(editingMsg.text || '');
      setTimeout(() => textareaRef.current?.focus(), 30);
    }
  }, [editingMsg]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [draft]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      onTyping?.(false);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
          mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
        } catch {}
      }
    };
  }, [onTyping]);

  const handleDraftChange = (val: string) => {
    setDraft(val);
    if (onTyping && !editingMsg) {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (val.trim().length > 0) {
        onTyping(true);
        typingTimerRef.current = setTimeout(() => {
          onTyping(false);
        }, 1800);
      } else {
        onTyping(false);
      }
    }
  };

  const submitDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    onTyping?.(false);
    if (editingMsg && onConfirmEdit) {
      onConfirmEdit(editingMsg.id, trimmed);
    } else {
      onSendText(trimmed);
    }
    setDraft('');
    setShowEmojiBar(false);
    setShowAttachments(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitDraft();
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      }
      setIsRecording(false);
      setRecSeconds(0);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      audioChunksRef.current = [];
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        if (audioChunksRef.current.length === 0) return;
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const localUrl = URL.createObjectURL(blob);
        onSendVoice(localUrl, blob);
      };
      mr.start();
      setIsRecording(true);
      setRecSeconds(0);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch {
      notify?.('دسترسی به میکروفون توسط مرورگر مسدود است', 'error');
    }
  };

  return (
    <div className="relative bg-white/95 dark:bg-[#131924]/95 backdrop-blur-md border-t border-slate-200 dark:border-white/[0.08] px-2.5 py-2 md:px-3.5 md:py-2.5 z-20">
      {/* Edit Preview Strip */}
      <AnimatePresence>
        {editingMsg && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.14 }}
            className="mb-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-400/35 rounded-xl flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Pencil size={14} className="text-amber-600 dark:text-amber-300 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-black text-amber-700 dark:text-amber-300">در حال ویرایش پیام</p>
                <p className="text-[11px] text-slate-700 dark:text-slate-200 truncate">{editingMsg.text}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setDraft('');
                onCancelEdit?.();
              }}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 dark:text-slate-300 hover:text-rose-500 shrink-0"
              aria-label="لغو ویرایش"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reply Preview Strip */}
      <AnimatePresence>
        {replyTo && !editingMsg && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.14 }}
            className="mb-2 px-3 py-1.5 bg-slate-50 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] rounded-xl flex items-center justify-between gap-3 shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Reply size={14} className="text-blue-600 dark:text-sky-300 shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-black text-blue-600 dark:text-sky-300 truncate">{replyTo.sender_name}</p>
                <p className="text-[11px] text-slate-700 dark:text-slate-200 truncate">{replyTo.text}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelReply}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 dark:text-slate-300 hover:text-rose-500 shrink-0"
              aria-label="لغو پاسخ"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quick Emoji Strip */}
      <AnimatePresence>
        {showEmojiBar && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.14 }}
            className="mb-2 p-1.5 bg-white dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] rounded-xl flex items-center justify-around shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
          >
            {QUICK_EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => {
                  setDraft((prev) => prev + em);
                  textareaRef.current?.focus();
                }}
                className="w-9 h-9 rounded-lg hover:bg-slate-100 dark:hover:bg-white/15 text-lg flex items-center justify-center active:scale-90 transition-transform"
              >
                {em}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Attachment Sheet */}
      <AnimatePresence>
        {showAttachments && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            className={`absolute bottom-[calc(100%+8px)] left-3 right-3 bg-white dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] rounded-2xl p-3 grid ${onOpenDealShare ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'} gap-2.5 shadow-[0_14px_34px_rgba(15,23,42,0.14)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] z-30`}
          >
            <button
              type="button"
              onClick={() => document.getElementById('tg-img-input')?.click()}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-slate-50 dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-blue-600 dark:text-white active:scale-95 transition-all"
            >
              <ImageIcon size={18} />
              <span className="text-[11px] font-black">گالری عکس</span>
            </button>
            <button
              type="button"
              onClick={() => document.getElementById('tg-file-input')?.click()}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-slate-50 dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-blue-600 dark:text-white active:scale-95 transition-all"
            >
              <FileText size={18} />
              <span className="text-[11px] font-black">سند و فایل</span>
            </button>
            <button
              type="button"
              onClick={() => document.getElementById('tg-cam-input')?.click()}
              className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-slate-50 dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-blue-600 dark:text-white active:scale-95 transition-all"
            >
              <Camera size={18} />
              <span className="text-[11px] font-black">دوربین</span>
            </button>
            {onOpenDealShare && (
              <button
                type="button"
                onClick={() => {
                  setShowAttachments(false);
                  onOpenDealShare();
                }}
                className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-400/35 text-blue-700 dark:text-sky-300 active:scale-95 transition-all"
              >
                <ShieldCheck size={18} />
                <span className="text-[11px] font-black">کارت معامله</span>
              </button>
            )}
            <input
              id="tg-img-input"
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  onSendFile(f, 'image');
                  setShowAttachments(false);
                }
                e.target.value = '';
              }}
            />
            <input
              id="tg-file-input"
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  onSendFile(f, 'file');
                  setShowAttachments(false);
                }
                e.target.value = '';
              }}
            />
            <input
              id="tg-cam-input"
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  onSendFile(f, 'image');
                  setShowAttachments(false);
                }
                e.target.value = '';
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Composer Row */}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => {
            setShowAttachments((v) => !v);
            setShowEmojiBar(false);
          }}
          className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border transition-all active:scale-90 ${
            showAttachments
              ? 'bg-blue-600 text-white border-white/30 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
              : 'bg-slate-50 dark:bg-[#18202e] border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-white shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
          }`}
          aria-label="پیوست فایل"
        >
          <Paperclip size={18} />
        </button>

        {isRecording ? (
          <div className="flex-1 h-11 px-4 rounded-xl bg-rose-500/15 border border-rose-400/60 flex items-center justify-between text-rose-600 dark:text-rose-300">
            <div className="flex items-center gap-2 text-xs font-black">
              <Mic size={16} />
              <span>در حال ضبط صدا...</span>
            </div>
            <span className="font-sans text-xs font-black tabular-nums">
              {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, '0')}
            </span>
          </div>
        ) : (
          <div className="flex-1 bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] rounded-2xl px-3 py-1.5 flex items-end gap-2 focus-within:border-blue-500/60 dark:focus-within:border-blue-500/50 shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] transition-colors">
            <button
              type="button"
              onClick={() => {
                setShowEmojiBar((v) => !v);
                setShowAttachments(false);
              }}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 dark:text-slate-300 hover:text-blue-600 dark:hover:text-white shrink-0 mb-0.5"
              aria-label="ایموجی"
            >
              <Smile size={18} />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="bg-transparent border-0 shadow-none focus:ring-0 focus:border-0 flex-1 resize-none outline-none text-[14px] font-medium leading-6 py-1 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-400 max-h-28 scrollbar-hide"
            />
            {extraToggle}
          </div>
        )}

        {draft.trim() ? (
          <button
            type="button"
            onClick={submitDraft}
            className="w-11 h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-white/25 flex items-center justify-center shrink-0 shadow-[0_6px_18px_rgba(15,23,42,0.16)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:scale-90 transition-all"
            aria-label="ارسال پیام"
          >
            <Send size={18} />
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleRecording}
            className={`w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 active:scale-90 transition-all ${
              isRecording
                ? 'bg-rose-600 text-white border-rose-300 shadow-[0_6px_20px_rgba(244,63,94,0.45)]'
                : 'bg-slate-50 dark:bg-[#18202e] border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-white shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
            }`}
            aria-label={isRecording ? 'توقف و ارسال صدا' : 'ضبط پیام صوتی'}
          >
            {isRecording ? <Square size={15} fill="currentColor" /> : <Mic size={18} />}
          </button>
        )}
      </div>
    </div>
  );
});

// --- Memoized Individual Message Bubble ---
const MESSAGE_QUICK_REACTIONS = ['👍', '❤️', '✅', '🙏', '🔥'];

const TelegramBubble = React.memo(function TelegramBubble({
  msg,
  isOwn,
  currentUserId,
  isFirstInGroup,
  isLastInGroup,
  isHighlighted,
  isMenuOpen,
  onSelect,
  onReply,
  onEdit,
  onForward,
  onReact,
  onCopy,
  onPin,
  onDelete,
  onJumpToMessage,
  onPreviewImg,
  onOpenDealById,
  canDelete
}: {
  msg: ChatMessageItem;
  isOwn: boolean;
  currentUserId?: string;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  isHighlighted: boolean;
  isMenuOpen: boolean;
  onSelect: (id: string) => void;
  onReply: (m: ChatMessageItem) => void;
  onEdit: (m: ChatMessageItem) => void;
  onForward?: (m: ChatMessageItem) => void;
  onReact: (id: string, emoji: string) => void;
  onCopy: (text: string) => void;
  onPin: (m: ChatMessageItem) => void;
  onDelete: (id: string) => void;
  onJumpToMessage: (id: string) => void;
  onPreviewImg: (url: string) => void;
  onOpenDealById?: (contractId: string) => void;
  canDelete: boolean;
}) {
  if (msg.is_system) {
    return (
      <div id={`tg-msg-${msg.id}`} className="flex flex-col items-center my-2.5 px-2">
        <div className="max-w-[92%] sm:max-w-[78%] px-3.5 py-2 rounded-2xl bg-slate-100/95 dark:bg-[#182030] border border-slate-200/90 dark:border-white/[0.08] text-center space-y-1.5">
          <p className="text-[11px] font-bold text-slate-700 dark:text-slate-100 whitespace-pre-wrap leading-relaxed">
            {msg.text}
          </p>
          {msg.attachment_url && (
            <a
              href={msg.attachment_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-600/10 text-blue-600 dark:text-sky-300 text-[10px] font-black"
            >
              <FileText size={12} /> مشاهده فایل پیوست تحویل
            </a>
          )}
          <span className="block text-[9px] font-mono text-slate-400 dark:text-slate-400 tabular-nums">
            {formatTimeFa(msg.created_at)}
          </span>
        </div>
      </div>
    );
  }

  const bubbleRadius = isOwn
    ? `rounded-2xl ${isFirstInGroup ? 'rounded-tr-2xl' : 'rounded-tr-md'} ${isLastInGroup ? 'rounded-br-[4px]' : 'rounded-br-md'}`
    : `rounded-2xl ${isFirstInGroup ? 'rounded-tl-2xl' : 'rounded-tl-md'} ${isLastInGroup ? 'rounded-bl-[4px]' : 'rounded-bl-md'}`;

  const reactionEntries = Object.entries(msg.reactions || {}).filter(([, users]) => Array.isArray(users) && users.length > 0);
  const isReadByOther =
    Boolean(msg.read) ||
    (Array.isArray(msg.read_by) && msg.read_by.some((rid) => String(rid) !== String(msg.sender_id)));

  return (
    <div
      id={`tg-msg-${msg.id}`}
      className={`flex flex-col ${isOwn ? 'items-start' : 'items-end'} ${isFirstInGroup ? 'mt-2.5' : 'mt-0.5'} group relative`}
    >
      <div
        onClick={() => onSelect(msg.id)}
        className={`relative max-w-[84%] sm:max-w-[74%] px-3.5 py-2 text-[13px] leading-relaxed cursor-pointer transition-all ${bubbleRadius} ${
          isHighlighted ? 'ring-2 ring-amber-400 scale-[1.01]' : ''
        } ${
          isOwn
            ? 'bg-blue-600 text-white border border-white/25 shadow-[0_6px_18px_rgba(15,23,42,0.14)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
            : 'bg-white dark:bg-[#19202e] text-slate-900 dark:text-white border border-slate-200 dark:border-white/[0.08] shadow-[0_6px_18px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
        }`}
      >
        {msg.forwarded_from && (
          <div
            className={`mb-1.5 flex items-center gap-1.5 text-[10px] font-black ${
              isOwn ? 'text-blue-100' : 'text-blue-600 dark:text-sky-300'
            }`}
          >
            <Forward size={11} className="shrink-0" />
            <span className="truncate">
              فوروارد شده از {msg.forwarded_from.sender_name}
              {msg.forwarded_from.source_title ? ` (${msg.forwarded_from.source_title})` : ''}
            </span>
          </div>
        )}

        {msg.reply_to && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onJumpToMessage(msg.reply_to!.id);
            }}
            className={`w-full text-right mb-1.5 px-2.5 py-1 rounded-lg border-r-2 transition-colors ${
              isOwn
                ? 'bg-white/15 border-white/80 text-white hover:bg-white/25'
                : 'bg-slate-100 dark:bg-white/10 border-slate-400 dark:border-white/60 text-slate-900 dark:text-white hover:bg-slate-200/70'
            }`}
          >
            <p className="text-[10px] font-black truncate">{msg.reply_to.sender_name}</p>
            <p className="text-[10px] opacity-85 truncate">{msg.reply_to.text}</p>
          </button>
        )}

        {msg.type === 'deal' && msg.deal_snapshot && (
          <div
            onClick={(e) => e.stopPropagation()}
            className={`mb-1.5 p-3 rounded-xl border space-y-2 min-w-[215px] ${
              isOwn
                ? 'bg-white/15 border-white/25 text-white'
                : 'bg-slate-50 dark:bg-[#131924] border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white'
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="font-mono font-bold opacity-85" dir="ltr">
                {msg.deal_snapshot.contract_id}
              </span>
              <span className="font-black">
                {translateStatusShort(msg.deal_snapshot.status)}
              </span>
            </div>
            <p className="text-xs font-black leading-snug">{msg.deal_snapshot.title}</p>
            <div className="flex items-baseline gap-1 text-sm font-black tabular-nums">
              <span>{Number(msg.deal_snapshot.amount || 0).toLocaleString()}</span>
              <span className="text-[10px] font-bold opacity-80">تومان</span>
            </div>
            {onOpenDealById && (
              <button
                type="button"
                onClick={() => onOpenDealById(msg.deal_snapshot!.contract_id)}
                className={`w-full h-8 rounded-lg text-[11px] font-black flex items-center justify-center gap-1.5 transition-all active:scale-95 ${
                  isOwn
                    ? 'bg-white text-blue-700 hover:bg-blue-50'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                <ShieldCheck size={13} />
                <span>مشاهده و اقدام معامله</span>
              </button>
            )}
          </div>
        )}

        {msg.type === 'image' && msg.attachment_url && (
          <img
            src={msg.attachment_url}
            alt={msg.text || 'تصویر پیوست'}
            referrerPolicy="no-referrer"
            onClick={(e) => {
              e.stopPropagation();
              onPreviewImg(msg.attachment_url!);
            }}
            className="rounded-xl mb-1.5 max-h-64 w-auto object-cover cursor-zoom-in border border-white/20"
          />
        )}

        {msg.type === 'voice' && msg.attachment_url && (
          <TgVoicePlayer url={msg.attachment_url} isOwn={isOwn} />
        )}

        {msg.type === 'file' && (
          <a
            href={msg.attachment_url || '#'}
            download={msg.text}
            onClick={(e) => e.stopPropagation()}
            className={`flex items-center gap-2.5 p-2.5 rounded-xl border mb-1 ${
              isOwn
                ? 'bg-white/15 border-white/25 text-white hover:bg-white/20'
                : 'bg-slate-50 dark:bg-white/10 border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white'
            }`}
          >
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
              <FileText size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-black truncate">{msg.text}</p>
              <p className="text-[10px] opacity-80">دانلود فایل</p>
            </div>
          </a>
        )}

        {(msg.type === 'text' || !msg.type) && (
          <p className="whitespace-pre-wrap break-words">{msg.text}</p>
        )}

        <div
          className={`flex items-center justify-end gap-1 mt-1 text-[10px] font-sans tabular-nums ${
            isOwn ? 'text-blue-100' : 'text-slate-500 dark:text-slate-300'
          }`}
        >
          {msg.edited_at && <span className="font-sans text-[10px] opacity-85">ویرایش‌شده</span>}
          <span>{formatTimeFa(msg.created_at)}</span>
          {isOwn &&
            (msg.pending ? (
              <Check size={11} strokeWidth={2.5} className="opacity-75" />
            ) : (
              <CheckCheck
                size={13}
                strokeWidth={2.5}
                className={isReadByOther ? 'text-sky-200' : 'text-blue-200/75'}
                aria-label={isReadByOther ? 'خوانده شده' : 'ارسال شده'}
              />
            ))}
        </div>
      </div>

      {reactionEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mt-1">
          {reactionEntries.map(([emoji, users]) => {
            const mine = currentUserId ? users.includes(String(currentUserId)) : false;
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(msg.id, emoji)}
                className={`h-6 px-2 rounded-full text-[11px] font-bold flex items-center gap-1 border transition-transform active:scale-90 ${
                  mine
                    ? 'bg-blue-600 text-white border-blue-500'
                    : 'bg-white dark:bg-[#19202e] text-slate-800 dark:text-slate-100 border-slate-200 dark:border-white/[0.08]'
                }`}
              >
                <span>{emoji}</span>
                <span className="font-mono text-[10px] tabular-nums">{users.length}</span>
              </button>
            );
          })}
        </div>
      )}

      <AnimatePresence>
        {isMenuOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: -4 }}
            transition={{ duration: 0.12 }}
            className="mt-1 flex flex-col gap-1 p-1.5 bg-white dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] rounded-xl shadow-xl dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] z-20"
          >
            <div className="flex items-center gap-1 px-1 pb-1 border-b border-slate-100 dark:border-white/10">
              {MESSAGE_QUICK_REACTIONS.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => onReact(msg.id, em)}
                  className="w-7 h-7 rounded-lg hover:bg-slate-100 dark:hover:bg-white/15 text-sm flex items-center justify-center active:scale-90 transition-transform"
                >
                  {em}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <button
                type="button"
                onClick={() => onReply(msg)}
                className="px-2.5 py-1.5 rounded-lg text-[10px] font-black text-blue-700 dark:text-sky-300 hover:bg-blue-50 dark:hover:bg-white/10 flex items-center gap-1"
              >
                <Reply size={12} /> پاسخ
              </button>
              {isOwn && msg.type === 'text' && (
                <button
                  type="button"
                  onClick={() => onEdit(msg)}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-black text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/15 flex items-center gap-1"
                >
                  <Pencil size={12} /> ویرایش
                </button>
              )}
              {msg.type === 'text' && (
                <button
                  type="button"
                  onClick={() => onCopy(msg.text)}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-black text-slate-700 dark:text-white hover:bg-slate-100 dark:hover:bg-white/10 flex items-center gap-1"
                >
                  <Copy size={12} /> کپی
                </button>
              )}
              {onForward && (
                <button
                  type="button"
                  onClick={() => onForward(msg)}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-black text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 flex items-center gap-1"
                >
                  <Forward size={12} /> فوروارد
                </button>
              )}
              <button
                type="button"
                onClick={() => onPin(msg)}
                className="px-2.5 py-1.5 rounded-lg text-[10px] font-black text-amber-600 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/15 flex items-center gap-1"
              >
                <Pin size={12} /> سنجاق
              </button>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(msg.id)}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] font-black text-rose-600 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-500/15 flex items-center gap-1"
                >
                  <Trash2 size={12} /> حذف
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// --- Complete Telegram-Grade Chat Room (supports Direct & Contract chats) ---
export const TelegramChatRoom = React.memo(function TelegramChatRoom({
  mode,
  chatId,
  title,
  subtitle,
  avatarChar,
  isOnline,
  isSupport,
  counterpartyId,
  contract,
  contracts,
  user,
  onBack,
  onOpenDealDetail,
  onOpenDealById,
  onDealUpdated,
  onStartDealWithContact,
  onChatUpdated,
  onForwardMessage,
  onStartCall,
  notify,
  fullHeightClass = 'h-full'
}: {
  mode: 'direct' | 'contract';
  chatId: string;
  title: string;
  subtitle: string;
  avatarChar: string;
  isOnline?: boolean;
  isSupport?: boolean;
  counterpartyId?: string;
  contract?: any;
  contracts?: any[];
  user: any;
  onBack?: () => void;
  onOpenDealDetail?: () => void;
  onOpenDealById?: (contractId: string) => void;
  onDealUpdated?: (updatedContract: any, balances?: any) => void | Promise<void>;
  onStartDealWithContact?: () => void;
  onChatUpdated?: (lastMsg: string, time: string) => void;
  onForwardMessage?: (msg: ChatMessageItem, sourceTitle: string) => void;
  onStartCall?: (opts: { targetUserId: string; targetName: string; mode: 'audio' | 'video'; scope: 'direct' | 'contract'; chatId: string }) => void;
  notify?: (m: string, t?: 'success' | 'error' | 'info') => void;
  fullHeightClass?: string;
}) {
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [replyTo, setReplyTo] = useState<{ id: string; sender_name: string; text: string } | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessageItem | null>(null);
  const [showDealPicker, setShowDealPicker] = useState(false);
  const [escrowBusy, setEscrowBusy] = useState(false);
  const [pinnedMsg, setPinnedMsg] = useState<{ id: string; text: string } | null>(null);
  const [selectedMsgId, setSelectedMsgId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [remoteTypingName, setRemoteTypingName] = useState<string | null>(null);
  const [liveOnline, setLiveOnline] = useState<boolean>(Boolean(isOnline));

  const listRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const remoteTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageKey = mode === 'direct' ? `mianji_direct_msgs_${chatId}` : `mianji_mock_messages_${chatId}`;
  const pinKey = `mianji_pin_${mode}_${chatId}`;
  const roomKey = `${mode}:${chatId}`;

  useEffect(() => {
    setLiveOnline(Boolean(isOnline) || Boolean(counterpartyId && realtimeClient.isUserOnline(counterpartyId)));
  }, [isOnline, counterpartyId]);

  useEffect(() => {
    setSelectedMsgId(null);
    setReplyTo(null);
    setEditingMsg(null);
    setShowDealPicker(false);
    setChatSearch('');
    setShowSearch(false);
    setRemoteTypingName(null);

    try {
      const savedPin = localStorage.getItem(pinKey);
      setPinnedMsg(savedPin ? JSON.parse(savedPin) : null);
    } catch {
      setPinnedMsg(null);
    }

    try {
      const cached = localStorage.getItem(storageKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        setMessages(
          parsed.map((m: any) => ({
            id: String(m.id),
            sender_id: m.sender_id,
            text: m.text ?? m.message_text ?? '',
            type: m.type ?? m.message_type ?? 'text',
            attachment_url: m.attachment_url,
            created_at: m.created_at,
            edited_at: m.edited_at,
            reactions: m.reactions,
            read_by: m.read_by,
            read: m.read,
            is_system: m.is_system,
            deal_id: m.deal_id,
            deal_snapshot: m.deal_snapshot,
            reply_to: m.reply_to || null,
            forwarded_from: m.forwarded_from || null
          }))
        );
      } else if (mode === 'direct' && isSupport) {
        setMessages([
          {
            id: 'welcome_1',
            sender_id: 0,
            text: 'سلام! به پشتیبانی آنلاین میانجی خوش آمدید. چطور می‌تونم کمکتون کنم؟',
            type: 'text',
            created_at: new Date(Date.now() - 120000).toISOString()
          }
        ]);
      } else {
        setMessages([]);
      }
    } catch {
      setMessages([]);
    }

    let cancelled = false;
    const markRoomRead = () => {
      apiFetch(`/api/chats/${mode}/${encodeURIComponent(chatId)}/read`, { method: 'POST' }).catch(() => {});
    };

    apiFetch<{ success: boolean; messages: ChatMessageItem[]; pinned?: { id: string; text: string } | null }>(
      `/api/chats/${mode}/${encodeURIComponent(chatId)}/messages`
    )
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data?.messages)) {
          if (data.messages.length > 0) {
            setMessages(data.messages);
            try {
              localStorage.setItem(storageKey, JSON.stringify(data.messages));
            } catch {}
          } else if (mode === 'direct' && isSupport) {
            setMessages([
              {
                id: 'welcome_1',
                sender_id: 0,
                text: 'سلام! به پشتیبانی آنلاین میانجی خوش آمدید. چطور می‌تونم کمکتون کنم؟',
                type: 'text',
                created_at: new Date(Date.now() - 120000).toISOString()
              }
            ]);
          } else {
            setMessages([]);
          }
        }
        if (data?.pinned !== undefined) {
          setPinnedMsg(data.pinned || null);
          try {
            if (data.pinned) localStorage.setItem(pinKey, JSON.stringify(data.pinned));
            else localStorage.removeItem(pinKey);
          } catch {}
        }
        markRoomRead();
      })
      .catch(() => {});

    realtimeClient.subscribeRoom(roomKey);

    const offMsg = realtimeClient.on('chat:message', (payload: any) => {
      if (payload?.room !== roomKey || !payload?.message) return;
      const incoming = payload.message as ChatMessageItem;
      setMessages((prev) => {
        if (prev.some((m) => String(m.id) === String(incoming.id))) return prev;
        const next = [...prev, incoming];
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
      if (String(incoming.sender_id) !== String(user?.id)) {
        markRoomRead();
      }
      setRemoteTypingName(null);
      isAtBottomRef.current = true;
    });

    const offEdited = realtimeClient.on('chat:edited', (payload: any) => {
      if (payload?.room !== roomKey || !payload?.messageId) return;
      setMessages((prev) => {
        const next = prev.map((m) =>
          String(m.id) === String(payload.messageId)
            ? { ...m, text: payload.text, edited_at: payload.edited_at || new Date().toISOString() }
            : m
        );
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    });

    const offReacted = realtimeClient.on('chat:reacted', (payload: any) => {
      if (payload?.room !== roomKey || !payload?.messageId) return;
      setMessages((prev) => {
        const next = prev.map((m) =>
          String(m.id) === String(payload.messageId) ? { ...m, reactions: payload.reactions || {} } : m
        );
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    });

    const offRead = realtimeClient.on('chat:read', (payload: any) => {
      if (payload?.room !== roomKey || String(payload?.readerId) === String(user?.id)) return;
      setMessages((prev) => {
        const next = prev.map((m) => {
          if (String(m.sender_id) !== String(user?.id)) return m;
          const prevReadBy = Array.isArray(m.read_by) ? m.read_by : [];
          const nextReadBy = prevReadBy.includes(String(payload.readerId))
            ? prevReadBy
            : [...prevReadBy, String(payload.readerId)];
          return { ...m, read: true, read_by: nextReadBy };
        });
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    });

    const offDel = realtimeClient.on('chat:deleted', (payload: any) => {
      if (payload?.room !== roomKey || !payload?.messageId) return;
      setMessages((prev) => {
        const next = prev.filter((m) => String(m.id) !== String(payload.messageId));
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    });

    const offPin = realtimeClient.on('chat:pinned', (payload: any) => {
      if (payload?.room !== roomKey) return;
      setPinnedMsg(payload.pinned || null);
      try {
        if (payload.pinned) localStorage.setItem(pinKey, JSON.stringify(payload.pinned));
        else localStorage.removeItem(pinKey);
      } catch {}
    });

    const offTyping = realtimeClient.on('typing:update', (payload: any) => {
      if (payload?.room !== roomKey || String(payload?.userId) === String(user?.id)) return;
      if (remoteTypingTimerRef.current) clearTimeout(remoteTypingTimerRef.current);
      if (payload.isTyping) {
        setRemoteTypingName(payload.fullName || title || 'کاربر');
        remoteTypingTimerRef.current = setTimeout(() => setRemoteTypingName(null), 3500);
      } else {
        setRemoteTypingName(null);
      }
    });

    const offPresenceSnap = realtimeClient.on('presence:snapshot', () => {
      if (counterpartyId && !isSupport) {
        setLiveOnline(realtimeClient.isUserOnline(counterpartyId));
      }
    });

    const offPresenceUpd = realtimeClient.on('presence:update', (payload: any) => {
      if (counterpartyId && !isSupport && String(payload?.userId) === String(counterpartyId)) {
        setLiveOnline(Boolean(payload?.online));
      }
    });

    return () => {
      cancelled = true;
      if (remoteTypingTimerRef.current) clearTimeout(remoteTypingTimerRef.current);
      realtimeClient.unsubscribeRoom(roomKey);
      offMsg();
      offEdited();
      offReacted();
      offRead();
      offDel();
      offPin();
      offTyping();
      offPresenceSnap();
      offPresenceUpd();
    };
  }, [mode, chatId, roomKey, storageKey, pinKey, isSupport, title, counterpartyId, user?.id]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, chatId]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distFromBottom < 120;
    setShowScrollDown(distFromBottom > 180);
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowScrollDown(false);
  };

  const jumpToMessage = useCallback((id: string) => {
    const targetEl = document.getElementById(`tg-msg-${id}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedId(id);
      setTimeout(() => setHighlightedId(null), 1500);
    }
  }, []);

  const persistDirectChatsMeta = useCallback(
    (lastText: string, isoTime: string) => {
      try {
        const raw = localStorage.getItem('mianji_direct_chats');
        const list: DirectChatContact[] = raw ? JSON.parse(raw) : [];
        const idx = list.findIndex((c) => String(c.id) === String(chatId));
        if (idx >= 0) {
          list[idx] = { ...list[idx], last_msg: lastText, time: isoTime, unread: 0 };
          localStorage.setItem('mianji_direct_chats', JSON.stringify(list));
          window.dispatchEvent(new Event('mianji_chats_updated'));
        }
      } catch {}
      onChatUpdated?.(lastText, isoTime);
    },
    [chatId, onChatUpdated]
  );

  const sendPayload = useCallback(
    async (text: string, type: ChatMessageItem['type'], attachmentUrl?: string, dealObj?: any) => {
      if (!user) return;
      const nowIso = new Date().toISOString();
      const tempId = `${mode}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const previewLabel =
        type === 'image'
          ? '📷 تصویر'
          : type === 'voice'
          ? '🎤 پیام صوتی'
          : type === 'file'
          ? `📎 ${text}`
          : type === 'deal'
          ? `🛡️ کارت معامله: ${dealObj?.title || text}`
          : text;

      const currentReply = replyTo;
      const optimistic: ChatMessageItem = {
        id: tempId,
        sender_id: String(user.id),
        text,
        type,
        attachment_url: attachmentUrl,
        ...(dealObj
          ? {
              deal_id: String(dealObj.contract_id),
              deal_snapshot: {
                contract_id: String(dealObj.contract_id),
                title: dealObj.title,
                amount: Number(dealObj.amount || 0),
                status: dealObj.status,
                buyer_id: dealObj.buyer_id,
                seller_id: dealObj.seller_id,
                buyer_name: dealObj.buyer_name,
                seller_name: dealObj.seller_name,
              },
            }
          : {}),
        created_at: nowIso,
        pending: true,
        reply_to: currentReply
      };

      setMessages((prev) => [...prev, optimistic]);
      setReplyTo(null);
      isAtBottomRef.current = true;
      if (mode === 'direct') {
        persistDirectChatsMeta(previewLabel, nowIso);
      }

      try {
        const res = await apiFetch<{ success: boolean; message: ChatMessageItem }>(
          `/api/chats/${mode}/${encodeURIComponent(chatId)}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({
              text,
              type,
              attachment_url: attachmentUrl,
              reply_to: currentReply,
              ...(dealObj ? { deal_id: String(dealObj.contract_id) } : {}),
            })
          }
        );
        if (res?.message) {
          setMessages((prev) => {
            const withoutDup = prev.filter((m) => String(m.id) !== String(res.message.id));
            const next = withoutDup.map((m) => (m.id === tempId ? { ...res.message, pending: false } : m));
            try {
              localStorage.setItem(storageKey, JSON.stringify(next));
            } catch {}
            return next;
          });
        }
      } catch (err: any) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        notify?.(err?.message || 'ارسال پیام به سرور با خطا مواجه شد', 'error');
      }
    },
    [user, mode, chatId, replyTo, storageKey, persistDirectChatsMeta, notify]
  );

  const handleSendText = useCallback((txt: string) => sendPayload(txt, 'text'), [sendPayload]);

  const handleSendDealCard = useCallback(
    (dealObj: any) => {
      setShowDealPicker(false);
      sendPayload(
        `معامله امن: ${dealObj.title} (${Number(dealObj.amount || 0).toLocaleString()} تومان)`,
        'deal',
        undefined,
        dealObj
      );
    },
    [sendPayload]
  );

  const handleSendFile = useCallback(
    async (file: File, type: 'image' | 'file') => {
      try {
        notify?.('در حال آپلود فایل...', 'info');
        const uploadedUrl = await uploadMediaFile(file, file.name);
        await sendPayload(file.name, type, uploadedUrl);
      } catch (err: any) {
        notify?.(err?.message || 'آپلود فایل ناموفق بود', 'error');
      }
    },
    [sendPayload, notify]
  );

  const handleSendVoice = useCallback(
    async (localUrl: string, blob?: Blob) => {
      if (!blob) {
        await sendPayload('پیام صوتی', 'voice', localUrl);
        return;
      }
      try {
        const uploadedUrl = await uploadMediaFile(blob, `voice-${Date.now()}.webm`);
        await sendPayload('پیام صوتی', 'voice', uploadedUrl);
      } catch (err: any) {
        notify?.(err?.message || 'آپلود پیام صوتی ناموفق بود', 'error');
      }
    },
    [sendPayload, notify]
  );

  const handleTyping = useCallback(
    (isTyping: boolean) => {
      realtimeClient.sendTyping(roomKey, isTyping, user?.full_name || 'کاربر');
    },
    [roomKey, user?.full_name]
  );

  const handleSelectMsg = useCallback((id: string) => {
    setSelectedMsgId((prev) => (prev === id ? null : id));
  }, []);

  const handleReplyMsg = useCallback(
    (m: ChatMessageItem) => {
      const isOwn = String(m.sender_id) === String(user?.id);
      setEditingMsg(null);
      setReplyTo({
        id: m.id,
        sender_name: isOwn ? 'شما' : title,
        text: m.type === 'text' ? m.text : m.type === 'image' ? '📷 تصویر' : m.type === 'voice' ? '🎤 پیام صوتی' : `📎 ${m.text}`
      });
      setSelectedMsgId(null);
    },
    [user?.id, title]
  );

  const handleEditMsg = useCallback((m: ChatMessageItem) => {
    setReplyTo(null);
    setEditingMsg(m);
    setSelectedMsgId(null);
  }, []);

  const handleForwardMsg = useCallback(
    (m: ChatMessageItem) => {
      setSelectedMsgId(null);
      onForwardMessage?.(m, title);
    },
    [onForwardMessage, title]
  );

  const handleConfirmEdit = useCallback(
    async (msgId: string, newText: string) => {
      const editedAt = new Date().toISOString();
      setMessages((prev) => {
        const next = prev.map((m) => (String(m.id) === String(msgId) ? { ...m, text: newText, edited_at: editedAt } : m));
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
      setEditingMsg(null);
      try {
        await apiFetch(`/api/chats/${mode}/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msgId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ text: newText })
        });
      } catch (err: any) {
        notify?.(err?.message || 'خطا در ویرایش پیام', 'error');
      }
    },
    [storageKey, mode, chatId, notify]
  );

  const handleReactMsg = useCallback(
    async (msgId: string, emoji: string) => {
      const uid = String(user?.id || '');
      setSelectedMsgId(null);
      setMessages((prev) => {
        const next = prev.map((m) => {
          if (String(m.id) !== String(msgId)) return m;
          const reactions: Record<string, string[]> = { ...(m.reactions || {}) };
          const curUsers = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
          if (curUsers.includes(uid)) {
            const filtered = curUsers.filter((u) => u !== uid);
            if (filtered.length > 0) reactions[emoji] = filtered;
            else delete reactions[emoji];
          } else {
            reactions[emoji] = [...curUsers, uid];
          }
          return { ...m, reactions };
        });
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
      apiFetch(`/api/chats/${mode}/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msgId)}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji })
      }).catch(() => {});
    },
    [user?.id, storageKey, mode, chatId]
  );

  const handleCopyMsg = useCallback(
    (txt: string) => {
      navigator.clipboard?.writeText(txt).then(() => notify?.('متن پیام کپی شد', 'success')).catch(() => {});
      setSelectedMsgId(null);
    },
    [notify]
  );

  const handlePinMsg = useCallback(
    (m: ChatMessageItem) => {
      const pinData = {
        id: m.id,
        text: m.type === 'text' ? m.text : m.type === 'image' ? '📷 تصویر سنجاق‌شده' : `📎 ${m.text}`
      };
      setPinnedMsg(pinData);
      try {
        localStorage.setItem(pinKey, JSON.stringify(pinData));
      } catch {}
      setSelectedMsgId(null);
      apiFetch(`/api/chats/${mode}/${encodeURIComponent(chatId)}/pin`, {
        method: 'POST',
        body: JSON.stringify(pinData)
      }).catch(() => {});
      notify?.('پیام در بالای گفتگو سنجاق شد', 'info');
    },
    [pinKey, mode, chatId, notify]
  );

  const handleDeleteMsg = useCallback(
    (id: string) => {
      setMessages((prev) => {
        const next = prev.filter((m) => String(m.id) !== String(id));
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
      setSelectedMsgId(null);
      apiFetch(`/api/chats/${mode}/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      }).catch(() => {});
    },
    [storageKey, mode, chatId]
  );

  const shareableDeals = useMemo(() => {
    const list = Array.isArray(contracts) ? contracts : [];
    if (!counterpartyId) return list;
    const matched = list.filter(
      (c) => String(c.buyer_id) === String(counterpartyId) || String(c.seller_id) === String(counterpartyId)
    );
    return matched.length > 0 ? matched : list;
  }, [contracts, counterpartyId]);

  const quickEscrowActions = useMemo(() => {
    if (mode !== 'contract' || !contract || !user?.id) return [];
    return getEscrowActions(
      contract,
      user,
      async (updatedDeal, balances) => {
        await onDealUpdated?.(updatedDeal, balances);
      },
      false
    ).filter((a) => a.variant === 'primary');
  }, [mode, contract, user, onDealUpdated]);

  const visibleMessages = useMemo(() => {
    const q = chatSearch.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => (m.text || '').toLowerCase().includes(q));
  }, [messages, chatSearch]);

  return (
    <div
      className={`flex flex-col bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-2xl md:rounded-3xl overflow-hidden relative shadow-[0_10px_30px_-6px_rgba(15,23,42,0.10)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] ${fullHeightClass}`}
    >
      {/* Header */}
      <div className="h-15 px-3 md:px-4 bg-white/95 dark:bg-[#181f2c]/95 backdrop-blur-md border-b border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-2 shrink-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0 shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
              aria-label="بازگشت"
            >
              <ChevronRight size={20} />
            </button>
          )}

          <div className="relative shrink-0">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-black text-sm shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] ${
                mode === 'contract'
                  ? 'bg-blue-600'
                  : isSupport
                  ? 'bg-emerald-600'
                  : 'bg-blue-600'
              }`}
            >
              {mode === 'contract' ? <Shield size={18} /> : avatarChar}
            </div>
            {(liveOnline || isOnline) && (
              <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white dark:border-[#181f2c]" />
            )}
          </div>

          <div className="min-w-0 text-right">
            <h3 className="text-sm font-black text-slate-900 dark:text-white truncate">{title}</h3>
            <p
              className={`text-[11px] font-bold truncate ${
                remoteTypingName
                  ? 'text-emerald-600 dark:text-emerald-400 animate-pulse'
                  : liveOnline || isOnline
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-blue-600 dark:text-sky-300'
              }`}
            >
              {remoteTypingName ? 'در حال نوشتن...' : subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onStartCall && counterpartyId && !isSupport && !String(counterpartyId).startsWith('pending_') && (
            <>
              <button
                type="button"
                onClick={() =>
                  onStartCall({
                    targetUserId: String(counterpartyId),
                    targetName: title,
                    mode: 'audio',
                    scope: mode,
                    chatId,
                  })
                }
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] text-emerald-600 dark:text-emerald-400 flex items-center justify-center transition-all active:scale-90"
                title="تماس صوتی"
                aria-label="تماس صوتی"
              >
                <Phone size={16} />
              </button>
              <button
                type="button"
                onClick={() =>
                  onStartCall({
                    targetUserId: String(counterpartyId),
                    targetName: title,
                    mode: 'video',
                    scope: mode,
                    chatId,
                  })
                }
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] text-blue-600 dark:text-sky-300 flex items-center justify-center transition-all active:scale-90"
                title="تماس تصویری"
                aria-label="تماس تصویری"
              >
                <Video size={16} />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => {
              setShowSearch((v) => !v);
              setChatSearch('');
            }}
            className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl border flex items-center justify-center transition-all active:scale-90 ${
              showSearch
                ? 'bg-blue-600 text-white border-white/30'
                : 'bg-slate-50 dark:bg-[#1c2536] border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-white'
            }`}
            aria-label="جستجو در گفتگو"
          >
            <Search size={17} />
          </button>

          {mode === 'contract' && onOpenDealDetail && (
            <button
              type="button"
              onClick={onOpenDealDetail}
              className="h-9 sm:h-10 px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-white/25 text-[11px] font-black flex items-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
            >
              <ShieldCheck size={14} />
              <span>قرارداد</span>
            </button>
          )}

          {mode === 'direct' && onStartDealWithContact && !isSupport && (
            <button
              type="button"
              onClick={onStartDealWithContact}
              className="h-9 sm:h-10 px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-white/25 text-[11px] font-black flex items-center gap-1.5 active:scale-95 transition-all whitespace-nowrap shrink-0"
            >
              <Sparkles size={14} />
              <span className="hidden sm:inline">معامله امن</span>
              <span className="sm:hidden">معامله</span>
            </button>
          )}
        </div>
      </div>

      {/* Expandable Search Bar */}
      <AnimatePresence>
        {showSearch && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-3 py-2 bg-slate-50 dark:bg-[#181f2c] border-b border-slate-200 dark:border-white/[0.08] z-10"
          >
            <div className="relative">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" />
              <input
                autoFocus
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                placeholder="جستجو در پیام‌های این گفتگو..."
                className="w-full h-9 pr-9 pl-8 rounded-xl text-[14px] font-medium bg-white dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white outline-none"
              />
              {chatSearch && (
                <button
                  type="button"
                  onClick={() => setChatSearch('')}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pinned Banner */}
      {(pinnedMsg || (mode === 'contract' && contract)) && (
        <div className="px-3.5 py-2 bg-slate-50 dark:bg-[#181f2c] border-b border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-3 z-10">
          <button
            type="button"
            onClick={() => {
              if (pinnedMsg) jumpToMessage(pinnedMsg.id);
              else onOpenDealDetail?.();
            }}
            className="flex items-center gap-2.5 min-w-0 text-right flex-1"
          >
            <div className="w-0.5 h-7 bg-blue-600 dark:bg-sky-400 rounded-full shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] font-black text-blue-600 dark:text-sky-300">
                {pinnedMsg ? 'پیام سنجاق‌شده' : `قرارداد امانی · ${translateStatusShort(contract.status)}`}
              </p>
              <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate tabular-nums">
                {pinnedMsg ? pinnedMsg.text : `${Number(contract.amount || 0).toLocaleString()} تومان`}
              </p>
            </div>
          </button>
          {pinnedMsg && (
            <button
              type="button"
              onClick={() => {
                setPinnedMsg(null);
                localStorage.removeItem(pinKey);
                apiFetch(`/api/chats/${mode}/${encodeURIComponent(chatId)}/pin`, {
                  method: 'POST',
                  body: JSON.stringify({})
                }).catch(() => {});
              }}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 dark:text-slate-300 hover:text-rose-500 shrink-0"
              aria-label="حذف سنجاق"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Quick Inline Escrow Action Strip for Contract Rooms */}
      {mode === 'contract' && contract && quickEscrowActions.length > 0 && (
        <div className="px-3.5 py-2 bg-blue-50/75 dark:bg-blue-500/10 border-b border-blue-200/70 dark:border-blue-400/25 flex items-center justify-between gap-2 z-10">
          <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200 truncate">
            مرحله فعلی: {translateStatusShort(contract.status)}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {quickEscrowActions.slice(0, 1).map((act, idx) => (
              <button
                key={idx}
                type="button"
                disabled={escrowBusy}
                onClick={async () => {
                  setEscrowBusy(true);
                  try {
                    await act.action();
                    notify?.('وضعیت معامله با موفقیت به‌روزرسانی شد', 'success');
                  } catch (e: any) {
                    notify?.(e?.message || 'خطا در به‌روزرسانی معامله', 'error');
                  } finally {
                    setEscrowBusy(false);
                  }
                }}
                className="h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-black transition-all active:scale-95 disabled:opacity-50 whitespace-nowrap"
              >
                {escrowBusy ? 'در حال انجام...' : act.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Message List */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 md:px-5 py-3 scrollbar-hide relative bg-white dark:bg-[#080b10] tg-wallpaper"
      >
        {visibleMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-10 px-4">
            <div className="w-14 h-14 rounded-2xl bg-white dark:bg-[#19202e] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-blue-600 dark:text-white mb-3 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
              <MessageCircle size={26} />
            </div>
            <p className="text-xs font-black text-slate-900 dark:text-white">
              {chatSearch ? 'پیامی با این عبارت پیدا نشد' : 'هنوز پیامی ارسال نشده است'}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-300 mt-1">
              {chatSearch ? 'عبارت دیگری جستجو کنید' : 'اولین پیام خود را با سرعت و امنیت بنویسید'}
            </p>
          </div>
        ) : (
          visibleMessages.map((msg, idx) => {
            const isOwn = String(msg.sender_id) === String(user?.id);
            const prev = idx > 0 ? visibleMessages[idx - 1] : null;
            const next = idx < visibleMessages.length - 1 ? visibleMessages[idx + 1] : null;

            const currentDay = formatDayChipFa(msg.created_at);
            const prevDay = prev ? formatDayChipFa(prev.created_at) : null;
            const showDateChip = idx === 0 || currentDay !== prevDay;

            const prevSameSender =
              !showDateChip &&
              prev &&
              !prev.is_system &&
              !msg.is_system &&
              String(prev.sender_id) === String(msg.sender_id) &&
              Math.abs(toMs(msg.created_at) - toMs(prev.created_at)) < 180000;

            const nextDay = next ? formatDayChipFa(next.created_at) : null;
            const nextSameSender =
              next &&
              !next.is_system &&
              !msg.is_system &&
              nextDay === currentDay &&
              String(next.sender_id) === String(msg.sender_id) &&
              Math.abs(toMs(next.created_at) - toMs(msg.created_at)) < 180000;

            return (
              <React.Fragment key={msg.id}>
                {showDateChip && (
                  <div className="flex justify-center my-3 sticky top-1 z-10 pointer-events-none">
                    <span className="px-3 py-0.5 rounded-full text-[10px] font-black bg-white/95 dark:bg-[#19202e]/95 text-slate-700 dark:text-white border border-slate-200 dark:border-white/[0.08] backdrop-blur-md shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
                      {currentDay}
                    </span>
                  </div>
                )}

                <TelegramBubble
                  msg={msg}
                  isOwn={isOwn}
                  currentUserId={String(user?.id || '')}
                  isFirstInGroup={!prevSameSender}
                  isLastInGroup={!nextSameSender}
                  isHighlighted={highlightedId === msg.id}
                  isMenuOpen={selectedMsgId === msg.id}
                  onSelect={handleSelectMsg}
                  onReply={handleReplyMsg}
                  onEdit={handleEditMsg}
                  onForward={onForwardMessage ? handleForwardMsg : undefined}
                  onReact={handleReactMsg}
                  onCopy={handleCopyMsg}
                  onPin={handlePinMsg}
                  onDelete={handleDeleteMsg}
                  onJumpToMessage={jumpToMessage}
                  onPreviewImg={setPreviewImg}
                  onOpenDealById={onOpenDealById || (onOpenDealDetail ? () => onOpenDealDetail() : undefined)}
                  canDelete={isOwn || user?.role === 'owner' || user?.role === 'admin'}
                />
              </React.Fragment>
            );
          })
        )}

        <AnimatePresence>
          {showScrollDown && (
            <motion.button
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              type="button"
              onClick={scrollToBottom}
              className="sticky bottom-3 mr-auto w-10 h-10 rounded-full bg-white dark:bg-[#19202e] border border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-white flex items-center justify-center shadow-lg dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:scale-90 transition-transform z-20"
              aria-label="رفتن به آخرین پیام"
            >
              <ArrowDown size={18} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <TelegramComposer
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editingMsg={editingMsg}
        onCancelEdit={() => setEditingMsg(null)}
        onConfirmEdit={handleConfirmEdit}
        onSendText={handleSendText}
        onSendFile={handleSendFile}
        onSendVoice={handleSendVoice}
        onOpenDealShare={shareableDeals.length > 0 && !isSupport ? () => setShowDealPicker(true) : undefined}
        onTyping={handleTyping}
        notify={notify}
      />

      {/* Share Deal Card Modal */}
      <AnimatePresence>
        {showDealPicker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowDealPicker(false)}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[350] flex items-end sm:items-center justify-center p-4"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] rounded-3xl p-5 space-y-3 max-h-[75vh] flex flex-col"
            >
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-black text-slate-900 dark:text-white">ارسال کارت معامله در گفتگو</h4>
                <button
                  type="button"
                  onClick={() => setShowDealPicker(false)}
                  className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-white/10 flex items-center justify-center"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2">
                {shareableDeals.map((d: any) => (
                  <button
                    key={d.contract_id}
                    type="button"
                    onClick={() => handleSendDealCard(d)}
                    className="w-full p-3.5 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] hover:border-blue-500 text-right flex items-center justify-between gap-3 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-black text-slate-900 dark:text-white truncate">{d.title}</p>
                      <p className="text-[10px] text-slate-500 dark:text-slate-300 mt-0.5 tabular-nums">
                        {d.contract_id} · {translateStatusShort(d.status)}
                      </p>
                    </div>
                    <span className="text-xs font-black text-blue-600 dark:text-sky-300 tabular-nums shrink-0">
                      {Number(d.amount || 0).toLocaleString()} ت
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {previewImg && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setPreviewImg(null)}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[350] flex items-center justify-center p-6"
          >
            <button
              type="button"
              onClick={() => setPreviewImg(null)}
              className="absolute top-6 left-6 w-11 h-11 rounded-full bg-white/15 border border-white/30 text-white flex items-center justify-center"
            >
              <X size={20} />
            </button>
            <img src={previewImg} alt="پیش‌نمایش تصویر" className="max-w-full max-h-[85vh] rounded-2xl shadow-2xl" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// --- Telegram-Grade Broadcast Channel Room ---
export const TelegramChannelRoom = React.memo(function TelegramChannelRoom({
  channel,
  user,
  isSubscribed,
  onToggleSubscribe,
  onBack,
  onChannelUpdated,
  onForwardPost,
  notify,
  fullHeightClass = 'h-full'
}: {
  channel: ChannelItem;
  user: any;
  isSubscribed: boolean;
  onToggleSubscribe: (channelId: string) => void;
  onBack?: () => void;
  onChannelUpdated?: (channelId: string, lastText: string, time: string) => void;
  onForwardPost?: (post: ChannelPostItem, channelTitle: string) => void;
  notify?: (m: string, t?: 'success' | 'error' | 'info') => void;
  fullHeightClass?: string;
}) {
  const [posts, setPosts] = useState<ChannelPostItem[]>([]);
  const [reactionsMap, setReactionsMap] = useState<Record<string, Record<string, number>>>({});
  const [myReactionMap, setMyReactionMap] = useState<Record<string, string | null>>({});
  const [showSearch, setShowSearch] = useState(false);
  const [postSearch, setPostSearch] = useState('');
  const [isMuted, setIsMuted] = useState(() => {
    try {
      return localStorage.getItem(`mianji_ch_mute_${channel.channel_id}`) === 'true';
    } catch {
      return false;
    }
  });
  const [silentBroadcast, setSilentBroadcast] = useState(false);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isChannelAdmin =
    String(channel.owner_id) === String(user?.id) ||
    user?.role === 'owner' ||
    user?.role === 'admin';

  const postsStorageKey = `mianji_channel_posts_${channel.channel_id}`;
  const reactionStorageKey = `mianji_channel_reacts_${channel.channel_id}`;

  useEffect(() => {
    setShowSearch(false);
    setPostSearch('');

    // Load local reactions
    try {
      const savedReacts = localStorage.getItem(reactionStorageKey);
      if (savedReacts) {
        const parsed = JSON.parse(savedReacts);
        setReactionsMap(parsed.counts || {});
        setMyReactionMap(parsed.mine || {});
      } else {
        setReactionsMap({});
        setMyReactionMap({});
      }
    } catch {
      setReactionsMap({});
      setMyReactionMap({});
    }

    // Load cached posts first for instant zero-latency render
    try {
      const cached = localStorage.getItem(postsStorageKey);
      if (cached) {
        setPosts(JSON.parse(cached));
      } else if (DEFAULT_CHANNEL_POSTS[channel.channel_id]) {
        setPosts(DEFAULT_CHANNEL_POSTS[channel.channel_id]);
        localStorage.setItem(postsStorageKey, JSON.stringify(DEFAULT_CHANNEL_POSTS[channel.channel_id]));
      } else {
        setPosts([
          {
            id: `post_init_${channel.channel_id}`,
            channel_id: channel.channel_id,
            author_id: channel.owner_id,
            author_name: channel.owner_name,
            text: `📢 به کانال «${channel.title}» خوش آمدید!\n${channel.description}`,
            message_type: 'text',
            views: Math.max(1, channel.subscribers_count),
            created_at: channel.createdAt
          }
        ]);
      }
    } catch {}

    // Fetch live posts from server / Firestore Admin bridge
    fetch(`/api/channels/${encodeURIComponent(channel.channel_id)}/posts`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.posts) && data.posts.length > 0) {
          setPosts((prev) => {
            const byId = new Map<string, ChannelPostItem>();
            prev.forEach((p) => byId.set(p.id, p));
            data.posts.forEach((p: ChannelPostItem) => byId.set(p.id, p));
            const merged = Array.from(byId.values()).sort((a, b) => toMs(a.created_at) - toMs(b.created_at));
            try {
              localStorage.setItem(postsStorageKey, JSON.stringify(merged));
            } catch {}
            return merged;
          });
        }
      })
      .catch(() => {});

    const chRoom = `channel:${channel.channel_id}`;
    realtimeClient.subscribeRoom(chRoom);
    const offPost = realtimeClient.on('channel:post', (payload: any) => {
      if (payload?.channelId !== channel.channel_id || !payload?.post) return;
      const incoming = payload.post as ChannelPostItem;
      setPosts((prev) => {
        if (prev.some((p) => p.id === incoming.id)) return prev;
        const next = [...prev, incoming];
        try {
          localStorage.setItem(postsStorageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    });

    const offPostUpd = realtimeClient.on('channel:post_updated', (payload: any) => {
      if (payload?.channelId !== channel.channel_id || !payload?.post) return;
      const incoming = payload.post as ChannelPostItem;
      setPosts((prev) => {
        const next = prev.map((p) => (p.id === incoming.id ? incoming : p));
        try {
          localStorage.setItem(postsStorageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    });

    const offPostDel = realtimeClient.on('channel:post_deleted', (payload: any) => {
      if (payload?.channelId !== channel.channel_id || !payload?.postId) return;
      setPosts((prev) => {
        const next = prev.filter((p) => p.id !== payload.postId);
        try {
          localStorage.setItem(postsStorageKey, JSON.stringify(next));
        } catch {}
        return next;
      });
    });

    return () => {
      realtimeClient.unsubscribeRoom(chRoom);
      offPost();
      offPostUpd();
      offPostDel();
    };
  }, [channel.channel_id, channel.title, channel.description, channel.owner_id, channel.owner_name, channel.subscribers_count, channel.createdAt, postsStorageKey, reactionStorageKey]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [posts.length, channel.channel_id]);

  const publishPost = async (text: string, type: ChannelPostItem['message_type'], attachmentUrl?: string) => {
    if (!user) return;
    const nowIso = new Date().toISOString();
    const tempId = `post_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const optimistic: ChannelPostItem = {
      id: tempId,
      channel_id: channel.channel_id,
      author_id: String(user.id),
      author_name: user.full_name || channel.title,
      text,
      message_type: type,
      attachment_url: attachmentUrl,
      views: 1,
      silent: silentBroadcast,
      reactions: {},
      created_at: nowIso
    };

    setPosts((prev) => {
      const next = [...prev, optimistic];
      try {
        localStorage.setItem(postsStorageKey, JSON.stringify(next));
      } catch {}
      return next;
    });

    const preview = type === 'image' ? '📷 تصویر جدید در کانال' : type === 'voice' ? '🎤 ویس جدید در کانال' : type === 'file' ? `📎 ${text}` : text;
    onChannelUpdated?.(channel.channel_id, preview, nowIso);

    try {
      const data = await apiFetch<{ success: boolean; post: ChannelPostItem }>(
        `/api/channels/${encodeURIComponent(channel.channel_id)}/posts`,
        {
          method: 'POST',
          body: JSON.stringify({
            text,
            message_type: type,
            attachment_url: attachmentUrl,
            silent: silentBroadcast
          })
        }
      );
      if (data?.success && data.post) {
        setPosts((prev) => {
          const deduped = prev.filter((p) => p.id !== data.post.id);
          const next = deduped.map((p) => (p.id === tempId ? data.post : p));
          try {
            localStorage.setItem(postsStorageKey, JSON.stringify(next));
          } catch {}
          return next;
        });
      }
    } catch (err: any) {
      notify?.(err?.message || 'خطا در انتشار پست کانال', 'error');
    }
  };

  const toggleReaction = (postId: string, emoji: string) => {
    const uid = String(user?.id || '');
    const currentMine = myReactionMap[postId] || null;
    const postCounts = { ...(reactionsMap[postId] || {}) };
    if (currentMine) {
      postCounts[currentMine] = Math.max(0, (postCounts[currentMine] || 1) - 1);
    }
    const nextMine = currentMine === emoji ? null : emoji;
    if (nextMine) {
      postCounts[nextMine] = (postCounts[nextMine] || 0) + 1;
    }

    const nextCounts = { ...reactionsMap, [postId]: postCounts };
    const nextMineMap = { ...myReactionMap, [postId]: nextMine };
    setReactionsMap(nextCounts);
    setMyReactionMap(nextMineMap);

    setPosts((prev) =>
      prev.map((p) => {
        if (p.id !== postId) return p;
        const r = { ...(p.reactions || {}) };
        const hadSame = Array.isArray(r[emoji]) && r[emoji].includes(uid);
        for (const k of Object.keys(r)) {
          r[k] = (r[k] || []).filter((u) => u !== uid);
          if (r[k].length === 0) delete r[k];
        }
        if (!hadSame && uid) r[emoji] = [...(r[emoji] || []), uid];
        return { ...p, reactions: r };
      })
    );

    try {
      localStorage.setItem(reactionStorageKey, JSON.stringify({ counts: nextCounts, mine: nextMineMap }));
    } catch {}

    apiFetch(`/api/channels/${encodeURIComponent(channel.channel_id)}/posts/${encodeURIComponent(postId)}/react`, {
      method: 'POST',
      body: JSON.stringify({ emoji })
    }).catch(() => {});
  };

  const deletePost = (postId: string) => {
    setPosts((prev) => {
      const next = prev.filter((p) => p.id !== postId);
      try {
        localStorage.setItem(postsStorageKey, JSON.stringify(next));
      } catch {}
      return next;
    });
    apiFetch(`/api/channels/${encodeURIComponent(channel.channel_id)}/posts/${encodeURIComponent(postId)}`, {
      method: 'DELETE'
    }).catch(() => {});
  };

  const shareChannel = () => {
    const shareText = `https://t.me/mianji_ir_bot?start=channel_${channel.handle || channel.channel_id}`;
    navigator.clipboard?.writeText(shareText).then(() => notify?.('لینک دعوت کانال کپی شد', 'success')).catch(() => {});
  };

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    try {
      localStorage.setItem(`mianji_ch_mute_${channel.channel_id}`, String(next));
    } catch {}
    notify?.(next ? 'اعلان‌های کانال بی‌صدا شد' : 'اعلان‌های کانال فعال شد', 'info');
  };

  const visiblePosts = useMemo(() => {
    const q = postSearch.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter((p) => (p.text || '').toLowerCase().includes(q));
  }, [posts, postSearch]);

  return (
    <div
      className={`flex flex-col bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-2xl md:rounded-3xl overflow-hidden relative shadow-[0_10px_30px_-6px_rgba(15,23,42,0.10)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] ${fullHeightClass}`}
    >
      {/* Channel Header */}
      <div className="h-15 px-3 md:px-4 bg-white/95 dark:bg-[#181f2c]/95 backdrop-blur-md border-b border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-2 shrink-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all shrink-0"
              aria-label="بازگشت"
            >
              <ChevronRight size={20} />
            </button>
          )}

          <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
            <Megaphone size={18} />
          </div>

          <div className="min-w-0 text-right">
            <div className="flex items-center gap-1 min-w-0">
              <h3 className="text-sm font-black text-slate-900 dark:text-white truncate">{channel.title}</h3>
              {channel.is_verified && <BadgeCheck size={15} className="text-blue-500 dark:text-sky-400 shrink-0" />}
            </div>
            <p className="text-[11px] font-bold text-slate-500 dark:text-slate-300 truncate tabular-nums">
              {Number(channel.subscribers_count || 1).toLocaleString('fa-IR')} عضو · @{channel.handle || 'channel'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setShowSearch((v) => !v);
              setPostSearch('');
            }}
            className={`w-10 h-10 rounded-xl border flex items-center justify-center transition-all active:scale-90 ${
              showSearch
                ? 'bg-blue-600 text-white border-white/30'
                : 'bg-slate-50 dark:bg-[#1c2536] border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-white'
            }`}
            aria-label="جستجو در کانال"
          >
            <Search size={17} />
          </button>
          <button
            type="button"
            onClick={shareChannel}
            className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-700 dark:text-white active:scale-90 transition-all"
            aria-label="اشتراک‌گذاری کانال"
          >
            <Share2 size={16} />
          </button>
        </div>
      </div>

      {/* Expandable Search */}
      <AnimatePresence>
        {showSearch && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-3 py-2 bg-slate-50 dark:bg-[#181f2c] border-b border-slate-200 dark:border-white/[0.08] z-10"
          >
            <div className="relative">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" />
              <input
                autoFocus
                value={postSearch}
                onChange={(e) => setPostSearch(e.target.value)}
                placeholder="جستجو در اطلاعیه‌های این کانال..."
                className="w-full h-9 pr-9 pl-8 rounded-xl text-[14px] font-medium bg-white dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white outline-none"
              />
              {postSearch && (
                <button
                  type="button"
                  onClick={() => setPostSearch('')}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Channel Info Strip */}
      <div className="px-4 py-2 bg-slate-50 dark:bg-[#181f2c] border-b border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium text-slate-600 dark:text-slate-200 truncate">{channel.description}</p>
        <span className="text-[10px] font-black text-blue-600 dark:text-sky-300 shrink-0">{channel.category || 'عمومی'}</span>
      </div>

      {/* Broadcast Feed */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-3 md:px-6 py-4 space-y-3 scrollbar-hide bg-white dark:bg-[#080b10] tg-wallpaper"
      >
        {visiblePosts.map((post) => {
          const uid = String(user?.id || '');
          const serverReacts = post.reactions || {};
          const localReacts = reactionsMap[post.id] || {};
          const mine =
            Object.entries(serverReacts).find(([, users]) => Array.isArray(users) && users.includes(uid))?.[0] ||
            myReactionMap[post.id];
          return (
            <div
              key={post.id}
              className="max-w-xl bg-white dark:bg-[#19202e] border border-slate-200 dark:border-white/[0.08] rounded-2xl p-4 space-y-2.5 shadow-[0_8px_24px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-black text-blue-600 dark:text-sky-300 truncate">{channel.title}</span>
                  {channel.is_verified && <BadgeCheck size={14} className="text-blue-500 dark:text-sky-400 shrink-0" />}
                  {post.silent && <BellOff size={12} className="text-slate-400 dark:text-slate-300 shrink-0" />}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-mono text-slate-500 dark:text-slate-300 tabular-nums">
                    {formatTimeFa(post.created_at)}
                  </span>
                  {isChannelAdmin && (
                    <button
                      type="button"
                      onClick={() => deletePost(post.id)}
                      className="text-slate-400 hover:text-rose-500 transition-colors"
                      title="حذف پست"
                      aria-label="حذف پست"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>

              {post.message_type === 'image' && post.attachment_url && (
                <img
                  src={post.attachment_url}
                  alt={post.text || 'تصویر کانال'}
                  referrerPolicy="no-referrer"
                  onClick={() => setPreviewImg(post.attachment_url!)}
                  className="rounded-xl max-h-72 w-auto object-cover cursor-zoom-in border border-slate-200 dark:border-white/[0.08]"
                />
              )}

              {post.message_type === 'voice' && post.attachment_url && (
                <TgVoicePlayer url={post.attachment_url} isOwn={false} />
              )}

              {post.message_type === 'file' && (
                <a
                  href={post.attachment_url || '#'}
                  download={post.text}
                  className="flex items-center gap-2.5 p-2.5 rounded-xl bg-slate-50 dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white"
                >
                  <FileText size={16} className="text-blue-600 dark:text-sky-300 shrink-0" />
                  <span className="text-xs font-bold truncate">{post.text}</span>
                </a>
              )}

              {(post.message_type === 'text' || !post.message_type) && (
                <p className="text-[13px] leading-relaxed text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words">
                  {post.text}
                </p>
              )}

              {/* Reactions & Views Footer */}
              <div className="pt-1.5 border-t border-slate-100 dark:border-white/[0.08] flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  {CHANNEL_REACTIONS.map((em) => {
                    const serverCount = Array.isArray(serverReacts[em]) ? serverReacts[em].length : 0;
                    const count = serverCount > 0 ? serverCount : Number(localReacts[em] || 0);
                    const active = mine === em;
                    return (
                      <button
                        key={em}
                        type="button"
                        onClick={() => toggleReaction(post.id, em)}
                        className={`h-7 px-2 rounded-lg text-[11px] font-bold flex items-center gap-1 border transition-all active:scale-90 ${
                          active
                            ? 'bg-blue-600 text-white border-blue-500 dark:border-white/40'
                            : 'bg-slate-50 dark:bg-[#131924] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/40'
                        }`}
                      >
                        <span>{em}</span>
                        {count > 0 && <span className="font-mono text-[10px] tabular-nums">{count}</span>}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-3 text-[10px] font-mono text-slate-500 dark:text-slate-300 tabular-nums">
                  {onForwardPost && (
                    <button
                      type="button"
                      onClick={() => onForwardPost(post, channel.title)}
                      className="hover:text-blue-600 dark:hover:text-white flex items-center gap-1"
                    >
                      <Forward size={12} /> فوروارد
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(post.text).then(() => notify?.('متن پست کپی شد', 'success')).catch(() => {});
                    }}
                    className="hover:text-blue-600 dark:hover:text-white flex items-center gap-1"
                  >
                    <Copy size={12} /> کپی
                  </button>
                  <span className="flex items-center gap-1">
                    <Eye size={12} /> {Number(post.views || 1).toLocaleString('fa-IR')}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Bar: Owner Broadcast Composer OR Subscriber Action Bar */}
      {isChannelAdmin ? (
        <TelegramComposer
          replyTo={null}
          onCancelReply={() => {}}
          onSendText={(txt) => publishPost(txt, 'text')}
          onSendFile={async (file, type) => {
            try {
              const url = await uploadMediaFile(file, file.name);
              publishPost(file.name, type, url);
            } catch (err: any) {
              notify?.(err?.message || 'آپلود فایل ناموفق بود', 'error');
            }
          }}
          onSendVoice={async (url, blob) => {
            if (blob) {
              try {
                const uploaded = await uploadMediaFile(blob, `channel-voice-${Date.now()}.webm`);
                publishPost('پیام صوتی کانال', 'voice', uploaded);
                return;
              } catch {}
            }
            publishPost('پیام صوتی کانال', 'voice', url);
          }}
          notify={notify}
          placeholder="انتشار پست جدید در کانال..."
          extraToggle={
            <button
              type="button"
              onClick={() => setSilentBroadcast((v) => !v)}
              title={silentBroadcast ? 'انتشار بی‌صدا فعال است' : 'انتشار با اعلان'}
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mb-0.5 transition-colors ${
                silentBroadcast
                  ? 'bg-amber-500/20 text-amber-600 dark:text-amber-300'
                  : 'text-slate-400 dark:text-slate-300 hover:text-blue-600 dark:hover:text-white'
              }`}
            >
              {silentBroadcast ? <BellOff size={16} /> : <Bell size={16} />}
            </button>
          }
        />
      ) : (
        <div className="px-4 py-3 bg-white dark:bg-[#181f2c] border-t border-slate-200 dark:border-white/[0.08] flex items-center justify-between gap-3">
          {!isSubscribed ? (
            <button
              type="button"
              onClick={() => onToggleSubscribe(channel.channel_id)}
              className="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs flex items-center justify-center gap-2 border border-white/20 active:scale-95 transition-all"
            >
              <Plus size={16} /> عضویت در کانال
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={toggleMute}
                className="flex-1 h-11 rounded-xl bg-slate-100 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] text-slate-800 dark:text-white font-black text-xs flex items-center justify-center gap-2 active:scale-95 transition-all"
              >
                {isMuted ? <Bell size={16} /> : <BellOff size={16} />}
                <span>{isMuted ? 'فعال‌سازی اعلان' : 'بی‌صدا کردن'}</span>
              </button>
              <button
                type="button"
                onClick={() => onToggleSubscribe(channel.channel_id)}
                className="h-11 px-4 rounded-xl bg-rose-500/10 border border-rose-400/40 text-rose-600 dark:text-rose-300 font-black text-xs active:scale-95 transition-all whitespace-nowrap shrink-0"
              >
                خروج از کانال
              </button>
            </>
          )}
        </div>
      )}

      <AnimatePresence>
        {previewImg && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setPreviewImg(null)}
            className="fixed inset-0 bg-black/90 backdrop-blur-md z-[350] flex items-center justify-center p-6"
          >
            <button
              type="button"
              onClick={() => setPreviewImg(null)}
              className="absolute top-6 left-6 w-11 h-11 rounded-full bg-white/15 border border-white/30 text-white flex items-center justify-center"
            >
              <X size={20} />
            </button>
            <img src={previewImg} alt="پیش‌نمایش تصویر" className="max-w-full max-h-[85vh] rounded-2xl shadow-2xl" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

// --- Telegram Messenger Hub (Chats + Deals + Channels + Bottom Pencil FAB) ---
export function TelegramMessagesHub({
  user,
  contracts,
  setView,
  notify,
  activeMobileChat,
  setActiveMobileChat,
  onOpenDealById,
  onDealUpdated,
  onStartCall,
}: {
  user: any;
  contracts: any[];
  setView: (v: any) => void;
  notify?: (m: string, t?: 'success' | 'error' | 'info') => void;
  activeMobileChat: { type: 'direct' | 'contract' | 'channel'; id: string } | null;
  setActiveMobileChat: React.Dispatch<React.SetStateAction<{ type: 'direct' | 'contract' | 'channel'; id: string } | null>>;
  onOpenDealById?: (contractId: string) => void;
  onDealUpdated?: (updatedContract: any, balances?: any) => void | Promise<void>;
  onStartCall?: (opts: { targetUserId: string; targetName: string; mode: 'audio' | 'video'; scope: 'direct' | 'contract'; chatId: string }) => void;
}) {
  const [directChats, setDirectChats] = useState<DirectChatContact[]>([]);
  const [contractUnreadMap, setContractUnreadMap] = useState<Record<string, number>>({});
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const activeChatRef = useRef(activeMobileChat);
  activeChatRef.current = activeMobileChat;
  const [subscribedIds, setSubscribedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('mianji_subscribed_channels');
      return saved ? JSON.parse(saved) : ['ch_mianji_official', 'ch_mianji_academy'];
    } catch {
      return ['ch_mianji_official', 'ch_mianji_academy'];
    }
  });
  const [folder, setFolder] = useState<'all' | 'direct' | 'contracts' | 'channels' | 'unread'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showNewChatSheet, setShowNewChatSheet] = useState(false);
  const [showCreateChannelModal, setShowCreateChannelModal] = useState(false);
  const [showCreateContactModal, setShowCreateContactModal] = useState(false);

  const [contacts, setContacts] = useState<any[]>([]);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [isLookingUp, setIsLookingUp] = useState(false);

  // Create contact form state (matches Create Channel modal pattern)
  const [cntName, setCntName] = useState('');
  const [cntPhone, setCntPhone] = useState('');
  const [cntCategory, setCntCategory] = useState('طرف معامله');
  const [cntNote, setCntNote] = useState('');
  const [isCreatingContact, setIsCreatingContact] = useState(false);
  const [cntLookup, setCntLookup] = useState<{ status: 'idle' | 'checking' | 'found' | 'not_found'; name?: string }>({ status: 'idle' });

  // Create channel form state
  const [chTitle, setChTitle] = useState('');
  const [chHandle, setChHandle] = useState('');
  const [chDesc, setChDesc] = useState('');
  const [chCategory, setChCategory] = useState('کسب‌وکار');
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);

  const [forwardPayload, setForwardPayload] = useState<{
    text: string;
    type: ChatMessageItem['type'];
    attachment_url?: string;
    deal_id?: string;
    forwarded_from: { sender_name: string; source_title?: string };
  } | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [isForwarding, setIsForwarding] = useState(false);

  const loadChatsAndContacts = useCallback(() => {
    apiFetch<{ success: boolean; chats: DirectChatContact[] }>('/api/chats/direct')
      .then((res) => {
        if (Array.isArray(res?.chats)) {
          setDirectChats(res.chats);
          try {
            localStorage.setItem('mianji_direct_chats', JSON.stringify(res.chats));
          } catch {}
        }
      })
      .catch(() => {
        try {
          const saved = localStorage.getItem('mianji_direct_chats');
          if (saved) setDirectChats(JSON.parse(saved));
        } catch {}
      });

    apiFetch<{ success: boolean; contacts: any[] }>('/api/contacts')
      .then((res) => {
        if (Array.isArray(res?.contacts)) {
          setContacts(res.contacts);
          try {
            localStorage.setItem('mianji_contacts', JSON.stringify(res.contacts));
          } catch {}
        }
      })
      .catch(() => {
        try {
          const savedContacts = localStorage.getItem('mianji_contacts');
          if (savedContacts) setContacts(JSON.parse(savedContacts));
        } catch {}
      });

    try {
      const savedChannels = localStorage.getItem('mianji_channels');
      if (savedChannels) {
        setChannels(JSON.parse(savedChannels));
      } else {
        setChannels(DEFAULT_CHANNELS);
        localStorage.setItem('mianji_channels', JSON.stringify(DEFAULT_CHANNELS));
      }
    } catch {
      setChannels(DEFAULT_CHANNELS);
    }
  }, []);

  useEffect(() => {
    loadChatsAndContacts();
    // Sync latest channels from server
    fetch('/api/channels')
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.channels) && data.channels.length > 0) {
          setChannels((prev) => {
            const byId = new Map<string, ChannelItem>();
            prev.forEach((c) => byId.set(c.channel_id, c));
            data.channels.forEach((c: ChannelItem) => byId.set(c.channel_id, c));
            const merged = Array.from(byId.values());
            try {
              localStorage.setItem('mianji_channels', JSON.stringify(merged));
            } catch {}
            return merged;
          });
        }
      })
      .catch(() => {});

    const handler = () => loadChatsAndContacts();
    window.addEventListener('mianji_chats_updated', handler);

    const offMsg = realtimeClient.on('chat:message', (payload: any) => {
      if (!payload?.message) return;
      const m = payload.message as ChatMessageItem;
      const previewText =
        m.type === 'image'
          ? '📷 تصویر'
          : m.type === 'voice'
          ? '🎤 پیام صوتی'
          : m.type === 'file'
          ? `📎 ${m.text}`
          : m.type === 'deal'
          ? `🛡️ کارت معامله`
          : m.text;
      const curOpen = activeChatRef.current;
      const isFromMe = String(m.sender_id) === String(user?.id);
      if (payload.scope === 'direct') {
        const isCurrentlyOpen = curOpen?.type === 'direct' && String(curOpen.id) === String(payload.chatId);
        setDirectChats((prev) => {
          const exists = prev.some((c) => String(c.id) === String(payload.chatId));
          if (!exists) {
            loadChatsAndContacts();
            return prev;
          }
          return prev.map((c) =>
            String(c.id) === String(payload.chatId)
              ? {
                  ...c,
                  last_msg: previewText,
                  time: m.created_at || new Date().toISOString(),
                  unread: isCurrentlyOpen || isFromMe ? 0 : Number(c.unread || 0) + 1
                }
              : c
          );
        });
      } else if (payload.scope === 'contract') {
        try {
          const key = `mianji_mock_messages_${payload.chatId}`;
          const prevRaw = localStorage.getItem(key);
          const prevArr = prevRaw ? JSON.parse(prevRaw) : [];
          if (!prevArr.some((x: any) => String(x.id) === String(m.id))) {
            localStorage.setItem(key, JSON.stringify([...prevArr, m]));
          }
        } catch {}
        const isCurrentlyOpen = curOpen?.type === 'contract' && String(curOpen.id) === String(payload.chatId);
        if (!isCurrentlyOpen && !isFromMe) {
          setContractUnreadMap((prev) => ({
            ...prev,
            [String(payload.chatId)]: (prev[String(payload.chatId)] ?? 0) + 1
          }));
        }
      }
    });

    const offRead = realtimeClient.on('chat:read', (payload: any) => {
      if (String(payload?.readerId) !== String(user?.id)) return;
      if (payload.scope === 'direct') {
        setDirectChats((prev) =>
          prev.map((c) => (String(c.id) === String(payload.chatId) ? { ...c, unread: 0 } : c))
        );
      } else if (payload.scope === 'contract') {
        setContractUnreadMap((prev) => ({ ...prev, [String(payload.chatId)]: 0 }));
      }
    });

    const offPresenceSnap = realtimeClient.on('presence:snapshot', () => {
      setDirectChats((prev) =>
        prev.map((c) => ({
          ...c,
          online: Boolean(c.is_support || (c.counterparty_id && realtimeClient.isUserOnline(c.counterparty_id)))
        }))
      );
    });

    const offPresenceUpd = realtimeClient.on('presence:update', (payload: any) => {
      setDirectChats((prev) =>
        prev.map((c) =>
          c.counterparty_id && String(c.counterparty_id) === String(payload?.userId)
            ? { ...c, online: Boolean(payload?.online) }
            : c
        )
      );
    });

    return () => {
      window.removeEventListener('mianji_chats_updated', handler);
      offMsg();
      offRead();
      offPresenceSnap();
      offPresenceUpd();
    };
  }, [loadChatsAndContacts, user?.id]);

  const unifiedChats = useMemo(() => {
    const q = normalizeDigits(searchTerm).toLowerCase();

    const contractItems = (contracts || []).map((c: any) => {
      let lastText = `معامله ${translateStatusShort(c.status)} · ${Number(c.amount || 0).toLocaleString()} تومان`;
      let lastTime = c.updatedAt || c.createdAt || c.created_at;
      try {
        const cached = localStorage.getItem(`mianji_mock_messages_${c.contract_id}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          const last = parsed[parsed.length - 1];
          if (last) {
            lastText = last.message_text || last.text || lastText;
            lastTime = last.created_at || lastTime;
          }
        }
      } catch {}

      const cid = String(c.contract_id);
      const isBuyer = isUserDealBuyer(c, user);
      const rawCounterparty = isBuyer ? c.seller_id : c.buyer_id;
      const counterpartyId = isPendingPartyId(rawCounterparty) ? '' : String(rawCounterparty || '');
      const unread = contractUnreadMap[cid] !== undefined ? contractUnreadMap[cid] : Number(c.unread_count || 0);
      const canonicalSt = normalizeDealStatus(c.status);

      return {
        uid: `contract_${cid}`,
        id: cid,
        counterpartyId,
        type: 'contract' as const,
        title: c.title,
        subtitle: `${translateStatusShort(c.status)} · ${Number(c.amount || 0).toLocaleString()} تومان`,
        lastMsg: lastText,
        time: lastTime,
        unread,
        online:
          (Boolean(counterpartyId) && realtimeClient.isUserOnline(counterpartyId)) ||
          canonicalSt === 'active' ||
          canonicalSt === 'work_submitted' ||
          canonicalSt === 'revisions_requested',
        isSupport: false,
        isVerified: false,
        raw: c
      };
    });

    const directItems = (directChats || []).map((d) => ({
      uid: `direct_${d.id}`,
      id: String(d.id),
      counterpartyId: d.counterparty_id,
      type: 'direct' as const,
      title: d.full_name,
      subtitle: d.is_support ? 'پشتیبانی رسمی · آنلاین' : d.phone_number,
      lastMsg: d.last_msg || 'گفتگوی مستقیم',
      time: d.time,
      unread: Number(d.unread || 0),
      online: Boolean(d.online || d.is_support || (d.counterparty_id && realtimeClient.isUserOnline(d.counterparty_id))),
      isSupport: Boolean(d.is_support),
      isVerified: Boolean(d.is_support),
      raw: d
    }));

    const channelItems = (channels || []).map((ch) => {
      let lastText = ch.description;
      let lastTime = ch.updatedAt || ch.createdAt;
      try {
        const cached = localStorage.getItem(`mianji_channel_posts_${ch.channel_id}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          const last = parsed[parsed.length - 1];
          if (last) {
            lastText = last.text || lastText;
            lastTime = last.created_at || lastTime;
          }
        }
      } catch {}

      return {
        uid: `channel_${ch.channel_id}`,
        id: ch.channel_id,
        counterpartyId: undefined,
        type: 'channel' as const,
        title: ch.title,
        subtitle: `${Number(ch.subscribers_count || 1).toLocaleString('fa-IR')} عضو · @${ch.handle}`,
        lastMsg: lastText,
        time: lastTime,
        unread: 0,
        online: false,
        isSupport: false,
        isVerified: Boolean(ch.is_verified),
        raw: ch
      };
    });

    return [...channelItems, ...directItems, ...contractItems]
      .filter((item) => {
        if (folder === 'contracts' && item.type !== 'contract') return false;
        if (folder === 'direct' && item.type !== 'direct') return false;
        if (folder === 'channels' && item.type !== 'channel') return false;
        if (folder === 'unread' && item.unread <= 0) return false;
        if (!q) return true;
        return (
          item.title.toLowerCase().includes(q) ||
          item.lastMsg.toLowerCase().includes(q) ||
          item.id.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => toMs(b.time) - toMs(a.time));
  }, [contracts, directChats, channels, folder, searchTerm, user?.id]);

  const activeChatObj = useMemo(() => {
    if (!activeMobileChat) return null;
    return (
      unifiedChats.find((c) => c.type === activeMobileChat.type && String(c.id) === String(activeMobileChat.id)) || null
    );
  }, [unifiedChats, activeMobileChat]);

  const openConversation = useCallback(
    (item: (typeof unifiedChats)[number]) => {
      if (item.type === 'direct') {
        try {
          const updated = directChats.map((d) => (String(d.id) === String(item.id) ? { ...d, unread: 0 } : d));
          setDirectChats(updated);
          localStorage.setItem('mianji_direct_chats', JSON.stringify(updated));
          localStorage.setItem('mianji_chat_target', JSON.stringify(item.raw));
        } catch {}
      } else if (item.type === 'contract') {
        setContractUnreadMap((prev) => ({ ...prev, [String(item.id)]: 0 }));
        localStorage.setItem('selected_contract', JSON.stringify(item.raw));
      }
      setActiveMobileChat({ type: item.type, id: item.id });
    },
    [directChats, setActiveMobileChat]
  );

  const startChatWithTarget = useCallback(
    async (contact: { id?: any; target_user_id?: string; full_name: string; phone_number: string }) => {
      let chatRecord: DirectChatContact | null = null;

      try {
        const res = await apiFetch<{ success: boolean; chat: DirectChatContact }>('/api/chats/direct/open', {
          method: 'POST',
          body: JSON.stringify({
            targetId: contact.target_user_id || contact.id,
            phone: contact.phone_number,
            fullName: contact.full_name
          })
        });
        if (res?.chat) chatRecord = res.chat;
      } catch (err: any) {
        notify?.(err?.message || 'امکان شروع گفتگو وجود ندارد', 'error');
        return;
      }

      if (!chatRecord) return;

      setDirectChats((prev) => {
        const filtered = prev.filter((c) => String(c.id) !== String(chatRecord!.id));
        const nextList = [chatRecord!, ...filtered];
        try {
          localStorage.setItem('mianji_direct_chats', JSON.stringify(nextList));
        } catch {}
        return nextList;
      });
      try {
        localStorage.setItem('mianji_chat_target', JSON.stringify(chatRecord));
      } catch {}
      setShowNewChatSheet(false);
      setNewName('');
      setNewPhone('');
      setActiveMobileChat({ type: 'direct', id: String(chatRecord.id) });
    },
    [setActiveMobileChat, notify]
  );

  const handleCreateCustomChat = async () => {
    const cleanPhone = normalizeDigits(newPhone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      notify?.('شماره همراه معتبر (حداقل ۱۰ رقم) وارد کنید', 'error');
      return;
    }

    let resolvedName = newName.trim();
    let targetUserId: string | undefined;
    setIsLookingUp(true);
    try {
      const data = await apiFetch<{ success: boolean; user?: any }>(
        `/api/users/lookup?phone=${encodeURIComponent(cleanPhone)}`
      );
      if (data?.success && data?.user) {
        if (!resolvedName && data.user.full_name) resolvedName = data.user.full_name;
        if (data.user.id) targetUserId = String(data.user.id);
      }
    } catch {}
    setIsLookingUp(false);

    const finalName = resolvedName || `کاربر ${cleanPhone.slice(-4)}`;
    if (!contacts.some((c) => c.phone_number === cleanPhone)) {
      try {
        const saved = await apiFetch<{ success: boolean; contact: any }>('/api/contacts', {
          method: 'POST',
          body: JSON.stringify({ full_name: finalName, phone_number: cleanPhone })
        });
        if (saved?.contact) {
          setContacts((prev) => [saved.contact, ...prev]);
        }
      } catch {}
    }

    await startChatWithTarget({ id: targetUserId, target_user_id: targetUserId, full_name: finalName, phone_number: cleanPhone });
  };

  const handleCreateChannel = async () => {
    const cleanTitle = chTitle.trim();
    if (cleanTitle.length < 2) {
      notify?.('لطفاً نام کانال را وارد کنید', 'error');
      return;
    }
    setIsCreatingChannel(true);
    const nowIso = new Date().toISOString();
    const fallbackId = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const cleanHandle = chHandle.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() || `mianji_${fallbackId.slice(-4)}`;

    let createdChannel: ChannelItem = {
      channel_id: fallbackId,
      handle: cleanHandle,
      title: cleanTitle,
      description: chDesc.trim() || 'کانال اطلاع‌رسانی در پیام‌رسان میانجی',
      owner_id: String(user?.id || 'u_guest'),
      owner_name: user?.full_name || 'مدیر کانال',
      category: chCategory,
      is_verified: false,
      subscribers_count: 1,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    try {
      const data = await apiFetch<{ success: boolean; channel: ChannelItem }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          title: cleanTitle,
          handle: cleanHandle,
          description: chDesc.trim(),
          category: chCategory
        })
      });
      if (data?.success && data.channel) {
        createdChannel = data.channel;
      }
    } catch {}

    const nextChannels = [createdChannel, ...channels];
    setChannels(nextChannels);
    try {
      localStorage.setItem('mianji_channels', JSON.stringify(nextChannels));
      const nextSubs = Array.from(new Set([...subscribedIds, createdChannel.channel_id]));
      setSubscribedIds(nextSubs);
      localStorage.setItem('mianji_subscribed_channels', JSON.stringify(nextSubs));
    } catch {}

    setIsCreatingChannel(false);
    setShowCreateChannelModal(false);
    setChTitle('');
    setChHandle('');
    setChDesc('');
    setFolder('channels');
    setActiveMobileChat({ type: 'channel', id: createdChannel.channel_id });
    notify?.('کانال جدید با موفقیت ساخته شد', 'success');
  };

  useEffect(() => {
    if (!showCreateContactModal) {
      setCntLookup({ status: 'idle' });
      return;
    }
    const cleanPhone = normalizeDigits(cntPhone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      setCntLookup({ status: 'idle' });
      return;
    }
    const timer = setTimeout(async () => {
      setCntLookup({ status: 'checking' });
      try {
        const data = await apiFetch<{ success: boolean; user?: any }>(
          `/api/users/lookup?phone=${encodeURIComponent(cleanPhone)}`
        );
        if (data?.success && data?.user) {
          setCntLookup({ status: 'found', name: data.user.full_name });
        } else {
          setCntLookup({ status: 'not_found' });
        }
      } catch {
        setCntLookup({ status: 'not_found' });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [cntPhone, showCreateContactModal]);

  const handleCreateContact = async () => {
    const cleanName = cntName.trim();
    const cleanPhone = normalizeDigits(cntPhone).replace(/[^0-9]/g, '');
    if (!cleanName || cleanPhone.length < 8) {
      notify?.('لطفاً نام و شماره همراه معتبر وارد کنید', 'error');
      return;
    }

    setIsCreatingContact(true);
    try {
      const res = await apiFetch<{ success: boolean; contact?: any }>('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({
          full_name: cleanName,
          phone_number: cleanPhone,
          category: cntCategory || 'طرف معامله',
          note: cntNote.trim()
        })
      });
      if (res?.success && res.contact) {
        const nextList = [res.contact, ...contacts.filter((c) => c.id !== res.contact.id)];
        setContacts(nextList);
        try {
          localStorage.setItem('mianji_contacts', JSON.stringify(nextList));
        } catch {}
        setShowCreateContactModal(false);
        setCntName('');
        setCntPhone('');
        setCntCategory('طرف معامله');
        setCntNote('');
        setShowNewChatSheet(true);
        notify?.('مخاطب جدید با موفقیت ساخته شد', 'success');
      }
    } catch (err: any) {
      notify?.(err?.message || 'خطا در ایجاد مخاطب', 'error');
    } finally {
      setIsCreatingContact(false);
    }
  };

  const handleToggleSubscribe = useCallback(
    async (channelId: string) => {
      const isSub = subscribedIds.includes(channelId);
      const nextSubs = isSub ? subscribedIds.filter((id) => id !== channelId) : [...subscribedIds, channelId];
      setSubscribedIds(nextSubs);
      try {
        localStorage.setItem('mianji_subscribed_channels', JSON.stringify(nextSubs));
      } catch {}

      setChannels((prev) => {
        const next = prev.map((c) =>
          c.channel_id === channelId
            ? { ...c, subscribers_count: Math.max(1, c.subscribers_count + (isSub ? -1 : 1)) }
            : c
        );
        try {
          localStorage.setItem('mianji_channels', JSON.stringify(next));
        } catch {}
        return next;
      });

      apiFetch(`/api/channels/${encodeURIComponent(channelId)}/subscribe`, {
        method: 'POST',
        body: JSON.stringify({ subscribed: !isSub })
      }).catch(() => {});

      notify?.(isSub ? 'از کانال خارج شدید' : 'عضویت شما در کانال ثبت شد', 'info');
    },
    [subscribedIds, notify]
  );

  const handleChannelUpdated = useCallback((channelId: string, _lastText: string, time: string) => {
    setChannels((prev) => {
      const next = prev.map((c) => (c.channel_id === channelId ? { ...c, updatedAt: time } : c));
      try {
        localStorage.setItem('mianji_channels', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const forwardTargets = useMemo(() => {
    const q = forwardSearch.trim().toLowerCase();
    const list: Array<{ uid: string; type: 'direct' | 'contract'; id: string; title: string; subtitle: string }> = [];
    for (const d of directChats || []) {
      list.push({
        uid: `direct_${d.id}`,
        type: 'direct',
        id: String(d.id),
        title: d.full_name || d.phone_number || 'گفتگوی مستقیم',
        subtitle: d.is_support ? 'پشتیبانی رسمی' : d.phone_number || 'چت شخصی',
      });
    }
    for (const c of contracts || []) {
      const amBuyer = String(c.buyer_id) === String(user?.id);
      const otherName = amBuyer ? c.seller_name || 'فروشنده' : c.buyer_name || 'خریدار';
      list.push({
        uid: `contract_${c.id}`,
        type: 'contract',
        id: String(c.id),
        title: c.title || `معامله #${c.id}`,
        subtitle: `گفتگوی قرارداد · ${otherName}`,
      });
    }
    if (!q) return list;
    return list.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q)
    );
  }, [directChats, contracts, user?.id, forwardSearch]);

  const handleForwardToTarget = useCallback(
    async (target: { type: 'direct' | 'contract'; id: string; title: string }) => {
      if (!forwardPayload || isForwarding) return;
      setIsForwarding(true);
      try {
        const res = await apiFetch<{ success: boolean; message?: ChatMessageItem }>(
          `/api/chats/${target.type}/${encodeURIComponent(target.id)}/messages`,
          {
            method: 'POST',
            body: JSON.stringify({
              text: forwardPayload.text || 'پیام فوروارد شده',
              type: forwardPayload.type || 'text',
              attachment_url: forwardPayload.attachment_url,
              deal_id: forwardPayload.deal_id,
              forwarded_from: forwardPayload.forwarded_from,
            }),
          }
        );

        if (!res?.success) {
          throw new Error('ارسال ناموفق بود');
        }

        if (target.type === 'direct') {
          setDirectChats((prev) => {
            const updated = prev.map((d) =>
              String(d.id) === String(target.id)
                ? {
                    ...d,
                    last_msg: forwardPayload.text || 'پیام فوروارد شده',
                    time: new Date().toISOString(),
                    unread: 0,
                  }
                : d
            );
            try {
              localStorage.setItem('mianji_direct_chats', JSON.stringify(updated));
            } catch {}
            return updated;
          });
        }

        setForwardPayload(null);
        setForwardSearch('');
        setActiveMobileChat({ type: target.type, id: target.id });
        notify?.(`پیام به «${target.title}» فوروارد شد`, 'success');
      } catch (err: any) {
        notify?.(err?.message || 'خطا در فوروارد پیام', 'error');
      } finally {
        setIsForwarding(false);
      }
    },
    [forwardPayload, isForwarding, notify, setActiveMobileChat]
  );

  const folderTabs = [
    { key: 'all', label: 'همه' },
    { key: 'direct', label: 'شخصی' },
    { key: 'channels', label: 'کانال‌ها' },
    { key: 'contracts', label: 'معاملات' },
    { key: 'unread', label: 'خوانده‌نشده' }
  ] as const;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="lg:grid lg:grid-cols-12 lg:gap-5 lg:h-[calc(100vh-8.5rem)] lg:min-h-[560px]"
    >
      {/* Pane 1: Chat & Channel List */}
      <div
        className={`lg:col-span-5 xl:col-span-4 flex flex-col relative bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-2xl md:rounded-3xl overflow-hidden shadow-[0_10px_30px_-6px_rgba(15,23,42,0.10)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] ${
          activeMobileChat ? 'hidden lg:flex' : 'flex min-h-[72vh] lg:min-h-0'
        }`}
      >
        {/* Top Messenger Header + Search */}
        <div className="p-3.5 md:p-4 border-b border-slate-200 dark:border-white/[0.08] space-y-3 bg-white dark:bg-[#181f2c]">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-black text-slate-900 dark:text-white">پیام‌رسان و کانال‌ها</h2>
            <div className="flex items-center gap-2">
              {folder === 'channels' && (
                <button
                  type="button"
                  onClick={() => setShowCreateChannelModal(true)}
                  className="h-8 px-2.5 rounded-lg bg-blue-600 text-white text-[11px] font-black flex items-center gap-1 active:scale-95 transition-all whitespace-nowrap shrink-0"
                >
                  <Plus size={14} /> ساخت کانال
                </button>
              )}
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-300 tabular-nums whitespace-nowrap shrink-0">
                {unifiedChats.length} مورد
              </span>
            </div>
          </div>

          <div className="relative">
            <Search size={15} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="جستجو در چت‌ها، کانال‌ها و معاملات..."
              className="w-full h-10 pr-10 pl-8 rounded-xl text-[14px] font-medium bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-400 outline-none focus:border-blue-500/60 dark:focus:border-blue-500/50"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm('')}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-300"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Folder Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pt-0.5">
            {folderTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFolder(tab.key)}
                className={`px-3 py-1.5 rounded-xl text-[11px] font-black whitespace-nowrap shrink-0 transition-all border ${
                  folder === tab.key
                    ? 'bg-blue-600 text-white border-white/25 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]'
                    : 'bg-slate-50 dark:bg-[#1c2536] border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-slate-100 hover:border-slate-300 dark:hover:border-white/40'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Conversations + Channels List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.07] scrollbar-hide pb-20">
          {unifiedChats.length > 0 ? (
            unifiedChats.map((item) => {
              const isSelected =
                activeMobileChat?.type === item.type && String(activeMobileChat?.id) === String(item.id);
              return (
                <button
                  key={item.uid}
                  type="button"
                  onClick={() => openConversation(item)}
                  className={`w-full px-3.5 py-3 flex items-center gap-3 text-right transition-colors active:scale-[0.99] ${
                    isSelected
                      ? 'bg-blue-50/70 dark:bg-white/[0.12]'
                      : 'hover:bg-slate-50 dark:hover:bg-white/[0.06]'
                  }`}
                >
                  <div className="relative shrink-0">
                    <div
                      className={`w-12 h-12 rounded-full flex items-center justify-center font-black text-base text-white shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] ${
                        item.type === 'channel'
                          ? 'bg-indigo-600'
                          : item.type === 'contract'
                          ? 'bg-blue-600'
                          : item.isSupport
                          ? 'bg-emerald-600'
                          : 'bg-blue-700'
                      }`}
                    >
                      {item.type === 'channel' ? (
                        <Megaphone size={20} />
                      ) : item.type === 'contract' ? (
                        <Shield size={20} />
                      ) : (
                        item.title[0]
                      )}
                    </div>
                    {item.online && (
                      <span className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-white dark:border-[#131924]" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="text-[13px] font-black text-slate-900 dark:text-white truncate">
                          {item.title}
                        </span>
                        {item.isVerified && <BadgeCheck size={14} className="text-blue-500 dark:text-sky-400 shrink-0" />}
                        {item.type === 'channel' && (
                          <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-300 shrink-0">
                            · کانال
                          </span>
                        )}
                        {item.type === 'contract' && (
                          <span className="text-[10px] font-bold text-blue-600 dark:text-sky-300 shrink-0">
                            · قرارداد
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-slate-500 dark:text-slate-300 shrink-0 tabular-nums">
                        {formatListTimeFa(item.time)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-600 dark:text-slate-300 truncate">{item.lastMsg}</p>
                      {item.unread > 0 ? (
                        <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[10px] font-black flex items-center justify-center shrink-0 tabular-nums dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
                          {item.unread}
                        </span>
                      ) : item.type === 'channel' ? (
                        <Users size={13} className="text-slate-400 dark:text-slate-300 shrink-0" />
                      ) : (
                        <CheckCheck size={14} className="text-blue-500 dark:text-sky-400 shrink-0" />
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="py-16 px-6 text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center mx-auto text-blue-600 dark:text-white">
                {folder === 'channels' ? <Megaphone size={26} /> : <MessageCircle size={26} />}
              </div>
              <p className="text-xs font-black text-slate-900 dark:text-white">
                {folder === 'channels' ? 'کانالی پیدا نشد' : 'گفتگویی در این بخش نیست'}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-300">
                برای شروع چت یا ساخت کانال، دکمه مداد در پایین را لمس کنید
              </p>
            </div>
          )}
        </div>

        {/* Telegram Pencil FAB */}
        <button
          type="button"
          onClick={() => setShowNewChatSheet(true)}
          title="شروع گفتگو یا کانال جدید"
          aria-label="شروع گفتگو یا کانال جدید"
          className="fixed bottom-24 left-5 lg:absolute lg:bottom-5 lg:left-5 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-700 text-white border-2 border-white dark:border-white/90 flex items-center justify-center shadow-[0_10px_28px_rgba(15,23,42,0.22)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:scale-90 transition-all z-40"
        >
          <Pencil size={22} strokeWidth={2.4} />
        </button>
      </div>

      {/* Pane 2: Active Room (Chat or Channel) */}
      <div
        className={`lg:col-span-7 xl:col-span-8 flex flex-col ${
          activeMobileChat ? 'flex h-[calc(100vh-7.5rem)] lg:h-full' : 'hidden lg:flex lg:h-full'
        }`}
      >
        {activeChatObj ? (
          activeChatObj.type === 'channel' ? (
            <TelegramChannelRoom
              channel={activeChatObj.raw as ChannelItem}
              user={user}
              isSubscribed={subscribedIds.includes(activeChatObj.id)}
              onToggleSubscribe={handleToggleSubscribe}
              onBack={() => setActiveMobileChat(null)}
              onChannelUpdated={handleChannelUpdated}
              onForwardPost={(post, channelTitle) => {
                setForwardSearch('');
                setForwardPayload({
                  text: post.text,
                  type: post.message_type,
                  attachment_url: post.attachment_url,
                  forwarded_from: {
                    sender_name: post.author_name || channelTitle,
                    source_title: channelTitle,
                  },
                });
              }}
              notify={notify}
              fullHeightClass="h-full"
            />
          ) : (
            <TelegramChatRoom
              mode={activeChatObj.type}
              chatId={activeChatObj.id}
              title={activeChatObj.title}
              subtitle={activeChatObj.subtitle}
              avatarChar={activeChatObj.title[0] || 'M'}
              isOnline={activeChatObj.online}
              isSupport={activeChatObj.isSupport}
              counterpartyId={activeChatObj.counterpartyId}
              contract={activeChatObj.type === 'contract' ? activeChatObj.raw : undefined}
              contracts={contracts}
              user={user}
              onBack={() => setActiveMobileChat(null)}
              onOpenDealById={onOpenDealById}
              onDealUpdated={onDealUpdated}
              onStartCall={onStartCall}
              onForwardMessage={(msg, sourceTitle) => {
                setForwardSearch('');
                const isOwn = String(msg.sender_id) === String(user?.id);
                setForwardPayload({
                  text: msg.text,
                  type: msg.type,
                  attachment_url: msg.attachment_url,
                  deal_id: msg.deal_id,
                  forwarded_from: {
                    sender_name: msg.forwarded_from?.sender_name || (isOwn ? (user?.full_name || 'شما') : sourceTitle),
                    source_title: activeChatObj.type === 'contract' ? sourceTitle : undefined,
                  },
                });
              }}
              onOpenDealDetail={
                activeChatObj.type === 'contract'
                  ? () => {
                      localStorage.setItem('selected_contract', JSON.stringify(activeChatObj.raw));
                      setView('detail');
                    }
                  : undefined
              }
              onStartDealWithContact={
                activeChatObj.type === 'direct'
                  ? () => {
                      localStorage.setItem('mianji_prefill_phone', activeChatObj.raw.phone_number || '');
                      setView('create');
                    }
                  : undefined
              }
              notify={notify}
              fullHeightClass="h-full"
            />
          )
        ) : (
          <div className="h-full bg-white dark:bg-[#131924] border border-slate-200/90 dark:border-white/[0.08] rounded-3xl flex flex-col items-center justify-center text-center p-8 shadow-[0_10px_30px_-6px_rgba(15,23,42,0.10)] dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
            <div className="w-16 h-16 rounded-full bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-blue-600 dark:text-white mb-4 dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
              <MessageCircle size={30} />
            </div>
            <h3 className="text-base font-black text-slate-900 dark:text-white">پیام‌رسان و کانال‌های میانجی</h3>
            <p className="text-xs text-slate-500 dark:text-slate-300 mt-2 max-w-xs leading-relaxed">
              یکی از گفتگوها یا کانال‌ها را انتخاب کنید یا با دکمه مداد در پایین، چت یا کانال جدید بسازید.
            </p>
            <div className="mt-5 flex items-center gap-2.5 flex-wrap justify-center">
              <button
                type="button"
                onClick={() => setShowNewChatSheet(true)}
                className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white border border-white/25 text-xs font-black flex items-center gap-2 shadow-md dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:scale-95 transition-all"
              >
                <Pencil size={15} /> گفتگوی جدید
              </button>
              <button
                type="button"
                onClick={() => setShowCreateChannelModal(true)}
                className="h-11 px-5 rounded-xl bg-slate-100 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] text-slate-800 dark:text-white text-xs font-black flex items-center gap-2 active:scale-95 transition-all"
              >
                <Megaphone size={15} /> ساخت کانال
              </button>
            </div>
          </div>
        )}
      </div>

      {/* New Chat & Channel Action Bottom Sheet */}
      <AnimatePresence>
        {showNewChatSheet && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowNewChatSheet(false)}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[600] flex items-end sm:items-center justify-center sm:p-6"
          >
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-md bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] rounded-t-[2rem] sm:rounded-3xl p-5 md:p-6 space-y-4 shadow-2xl dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] max-h-[85vh] flex flex-col"
            >
              <div className="w-10 h-1 bg-slate-200 dark:bg-white/30 rounded-full mx-auto sm:hidden" />

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-sm dark:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]">
                    <Pencil size={17} />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-900 dark:text-white">شروع پیام یا کانال</h3>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300">انتخاب مخاطب، شماره جدید یا ساخت کانال</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNewChatSheet(false)}
                  className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-600 dark:text-white"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Quick Create Contact & Channel Shortcuts */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewChatSheet(false);
                    setShowCreateContactModal(true);
                  }}
                  className="p-3 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] flex items-center gap-2.5 hover:bg-slate-100 dark:hover:bg-[#1c2536] transition-colors text-right"
                >
                  <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
                    <UserPlus size={16} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-black text-slate-900 dark:text-white truncate">ایجاد مخاطب</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300 truncate">ذخیره فرد جدید</p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowNewChatSheet(false);
                    setShowCreateChannelModal(true);
                  }}
                  className="p-3 rounded-2xl bg-slate-50 dark:bg-[#18202e] border border-slate-200 dark:border-white/[0.08] flex items-center gap-2.5 hover:bg-slate-100 dark:hover:bg-[#1c2536] transition-colors text-right"
                >
                  <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0">
                    <Megaphone size={16} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-black text-slate-900 dark:text-white truncate">ایجاد کانال</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300 truncate">انتشار اطلاعیه</p>
                  </div>
                </button>
              </div>

              {/* Quick Start by Phone */}
              <div className="p-3.5 bg-slate-50 dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] rounded-2xl space-y-2.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    dir="ltr"
                    inputMode="tel"
                    value={newPhone}
                    onChange={(e) => setNewPhone(normalizeDigits(e.target.value))}
                    placeholder="09123456789"
                    className="h-10 px-3 rounded-xl text-[14px] font-medium tabular-nums text-center bg-white dark:bg-[#19202e] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white"
                  />
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="نام مخاطب (اختیاری)"
                    className="h-10 px-3 rounded-xl text-[14px] font-medium bg-white dark:bg-[#19202e] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white"
                  />
                </div>
                <button
                  type="button"
                  disabled={isLookingUp}
                  onClick={handleCreateCustomChat}
                  className="w-full h-10 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-black flex items-center justify-center gap-2 border border-white/20 active:scale-95 transition-all disabled:opacity-60"
                >
                  <MessageCircle size={15} />
                  {isLookingUp ? 'در حال جستجو...' : 'شروع چت با این شماره'}
                </button>
              </div>

              {/* Saved Contacts List */}
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-white/[0.07] scrollbar-hide max-h-52">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => startChatWithTarget(c)}
                    className="w-full py-2.5 px-2 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-white/[0.06] rounded-xl transition-colors text-right"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] text-blue-700 dark:text-white font-black flex items-center justify-center shrink-0">
                        {c.full_name?.[0] || 'U'}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-black text-slate-900 dark:text-white truncate">{c.full_name}</p>
                        <p className="text-[10px] font-mono text-slate-500 dark:text-slate-300" dir="ltr">
                          {c.phone_number}
                        </p>
                      </div>
                    </div>
                    <span className="text-[11px] font-black text-blue-600 dark:text-sky-300 shrink-0">گفتگو</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  setShowNewChatSheet(false);
                  setView('create');
                }}
                className="w-full h-11 rounded-xl bg-slate-50 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] text-slate-800 dark:text-white text-xs font-black flex items-center justify-center gap-2 active:scale-95 transition-all"
              >
                <Plus size={15} /> ایجاد معامله امن جدید
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Create New Channel Modal */}
      <AnimatePresence>
        {showCreateChannelModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowCreateChannelModal(false)}
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
                  <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
                    <Megaphone size={18} />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-900 dark:text-white">ایجاد کانال جدید</h3>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300">فضای انتشار اخبار و محتوای اختصاصی</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCreateChannelModal(false)}
                  className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-600 dark:text-white"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">نام کانال</label>
                  <input
                    value={chTitle}
                    onChange={(e) => setChTitle(e.target.value)}
                    placeholder="مثلاً: اطلاع‌رسانی پروژه و طراحی"
                    className="input-refined !h-11"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">شناسه (انگلیسی)</label>
                    <input
                      dir="ltr"
                      value={chHandle}
                      onChange={(e) => setChHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                      placeholder="my_channel"
                      className="input-refined !h-11 text-center text-[14px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">دسته‌بندی</label>
                    <select
                      value={chCategory}
                      onChange={(e) => setChCategory(e.target.value)}
                      className="input-refined !h-11 text-[14px]"
                    >
                      <option value="کسب‌وکار">کسب‌وکار</option>
                      <option value="فریلنسری">فریلنسری</option>
                      <option value="آموزش">آموزش</option>
                      <option value="خبری">خبری</option>
                      <option value="عمومی">عمومی</option>
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">توضیحات کانال</label>
                  <textarea
                    rows={2}
                    value={chDesc}
                    onChange={(e) => setChDesc(e.target.value)}
                    placeholder="توضیح کوتاه درباره هدف و محتوای کانال..."
                    className="w-full rounded-xl p-3 text-[14px] font-medium bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white resize-none"
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={isCreatingChannel || !chTitle.trim()}
                onClick={handleCreateChannel}
                className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs border border-white/25 active:scale-95 transition-all disabled:opacity-50"
              >
                {isCreatingChannel ? 'در حال ساخت کانال...' : 'ساخت و انتشار کانال'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Create New Contact Modal (Matches Create Channel Modal) */}
      <AnimatePresence>
        {showCreateContactModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowCreateContactModal(false)}
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
                  onClick={() => setShowCreateContactModal(false)}
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
                    value={cntName}
                    onChange={(e) => setCntName(e.target.value)}
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
                      value={cntPhone}
                      onChange={(e) => setCntPhone(normalizeDigits(e.target.value))}
                      placeholder="09123456789"
                      className="input-refined !h-11 text-center tabular-nums text-[14px]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">دسته‌بندی / نقش</label>
                    <select
                      value={cntCategory}
                      onChange={(e) => setCntCategory(e.target.value)}
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
                {cntLookup.status === 'checking' && (
                  <p className="text-[11px] font-bold text-blue-600 dark:text-blue-300 px-1">در حال استعلام عضویت در میانجی...</p>
                )}
                {cntLookup.status === 'found' && cntLookup.name && (
                  <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-400/50 flex items-center justify-between text-[11px]">
                    <span className="text-emerald-700 dark:text-emerald-300 font-bold">عضو میانجی: {cntLookup.name}</span>
                    {!cntName.trim() && (
                      <button
                        type="button"
                        onClick={() => setCntName(cntLookup.name || '')}
                        className="text-blue-600 dark:text-white font-black underline"
                      >
                        درج نام
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-[11px] font-black text-slate-700 dark:text-slate-200 px-1 block">یادداشت کوتاه (اختیاری)</label>
                  <textarea
                    rows={2}
                    maxLength={300}
                    value={cntNote}
                    onChange={(e) => setCntNote(e.target.value)}
                    placeholder="توضیح کوتاه درباره همکاری یا نوع معامله با این مخاطب..."
                    className="w-full rounded-xl p-3 text-[14px] font-medium bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-slate-900 dark:text-white resize-none"
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={isCreatingContact || !cntName.trim() || !cntPhone.trim()}
                onClick={handleCreateContact}
                className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-xs border border-white/25 active:scale-95 transition-all disabled:opacity-50"
              >
                {isCreatingContact ? 'در حال ایجاد مخاطب...' : 'ساخت و ذخیره مخاطب'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Forward Destination Picker Modal */}
      <AnimatePresence>
        {forwardPayload && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !isForwarding && setForwardPayload(null)}
            className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[620] flex items-end sm:items-center justify-center sm:p-6"
          >
            <motion.div
              initial={{ y: 36, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 36, opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full sm:max-w-md bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] rounded-t-[2rem] sm:rounded-3xl p-5 md:p-6 space-y-4 shadow-2xl max-h-[85vh] flex flex-col"
            >
              <div className="w-10 h-1 bg-slate-200 dark:bg-white/30 rounded-full mx-auto sm:hidden" />

              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-sm">
                    <Forward size={17} />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-900 dark:text-white">فوروارد پیام به گفتگو</h3>
                    <p className="text-[10px] text-slate-500 dark:text-slate-300">
                      مبدأ: {forwardPayload.forwarded_from.sender_name}
                      {forwardPayload.forwarded_from.source_title ? ` (${forwardPayload.forwarded_from.source_title})` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isForwarding}
                  onClick={() => setForwardPayload(null)}
                  className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-[#1c2536] border border-slate-200 dark:border-white/[0.08] flex items-center justify-center text-slate-600 dark:text-white"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-xs text-slate-700 dark:text-slate-200 line-clamp-2">
                {forwardPayload.text || 'پیام رسانه‌ای'}
              </div>

              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 dark:text-slate-300 absolute right-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={forwardSearch}
                  onChange={(e) => setForwardSearch(e.target.value)}
                  placeholder="جستجوی مخاطب یا معامله..."
                  className="w-full h-10 pr-10 pl-3 rounded-xl bg-[#f8fafc] dark:bg-[#0e1420] border border-slate-200 dark:border-white/[0.08] text-[14px] font-medium text-slate-900 dark:text-white placeholder:text-slate-400"
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-1.5 min-h-[160px] max-h-[320px] pr-0.5">
                {forwardTargets.length === 0 ? (
                  <div className="text-center py-8 text-xs text-slate-500 dark:text-slate-300">
                    گفتگویی با این مشخصات یافت نشد.
                  </div>
                ) : (
                  forwardTargets.map((target) => (
                    <button
                      key={target.uid}
                      type="button"
                      disabled={isForwarding}
                      onClick={() => handleForwardToTarget(target)}
                      className="w-full p-3 rounded-xl bg-slate-50 dark:bg-[#18202e] hover:bg-blue-50 dark:hover:bg-[#1c2536] border border-slate-200/80 dark:border-white/[0.08] flex items-center justify-between gap-3 transition-colors text-right disabled:opacity-60"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-blue-600/15 text-blue-600 dark:text-blue-300 flex items-center justify-center font-black text-sm shrink-0">
                          {target.type === 'contract' ? <Shield size={17} /> : target.title[0] || 'M'}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-black text-slate-900 dark:text-white truncate">{target.title}</p>
                          <p className="text-[10px] text-slate-500 dark:text-slate-300 truncate">{target.subtitle}</p>
                        </div>
                      </div>
                      <span className="text-[11px] font-black text-blue-600 dark:text-blue-300 shrink-0 flex items-center gap-1">
                        {isForwarding ? '...' : 'ارسال'}
                        <Send size={13} />
                      </span>
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
