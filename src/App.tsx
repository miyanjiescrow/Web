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
import { supabase } from './lib/supabase';

// --- Types ---
type View = 'auth' | 'dashboard' | 'deals' | 'create' | 'wallet' | 'profile' | 'detail' | 'dispute' | 'support' | 'notifications' | 'contacts' | 'support_detail';

interface UserProfile {
  id: number; // Telegram ID (BIGINT)
  full_name: string | null;
  phone_number: string | null;
  national_id: string | null;
  role: string | null;
  wallet_balance: number;
  escrow_locked_balance: number;
  kyc_status: 'pending' | 'verified' | 'rejected' | 'not_started';
  sheba: string | null;
}

interface Contract {
  contract_id: string;
  title: string;
  amount: number;
  buyer_id: number;
  seller_id: number;
  status: 'draft' | 'awaiting_payment' | 'active' | 'work_submitted' | 'completed' | 'cancelled' | 'disputed';
  milestones: any;
  delivery_files: any;
  deadline: string | null;
  created_at?: string;
  buyer?: UserProfile;
  seller?: UserProfile;
}

interface Transaction {
  id: number;
  user_id: number;
  contract_id: string | null;
  amount: number;
  type: 'deposit' | 'withdraw' | 'escrow_lock' | 'escrow_release' | 'fee';
  status: 'pending' | 'completed' | 'failed';
  description: string | null;
  created_at: string;
}

interface Message {
  id: string;
  contract_id: string;
  sender_id: number;
  message_text: string;
  attachment_url: string | null;
  is_system: boolean;
  created_at: string;
}

interface Notification {
  id: number;
  user_id: number;
  title: string;
  body: string;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

interface SupportTicket {
  id: string;
  user_id: number;
  subject: string;
  status: 'open' | 'replied' | 'closed';
  priority: 'low' | 'medium' | 'high';
  created_at: string;
  updated_at: string;
}

interface SupportMessage {
  id: string;
  ticket_id: string;
  sender_id: number;
  message_text: string;
  is_admin_reply: boolean;
  created_at: string;
}

interface UserContact {
  id: number;
  user_id: number;
  contact_user_id: number;
  nickname: string | null;
  status: 'active' | 'blocked';
  created_at: string;
  contact?: UserProfile;
}

// --- Main App ---
export default function App() {
  const [view, setView] = useState<View>('auth');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  const [contracts, setContracts] = useState<Contract[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [userContacts, setUserContacts] = useState<UserContact[]>([]);
  const [supportTickets, setSupportTickets] = useState<SupportTicket[]>([]);
  const [selectedContract, setSelectedContract] = useState<Contract | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem('mianji_theme') as 'light' | 'dark';
    if (savedTheme) {
      setTheme(savedTheme);
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(savedTheme);
    }

    const checkSession = async () => {
      const savedUser = localStorage.getItem('mianji_user');
      if (savedUser) {
        const parsedUser = JSON.parse(savedUser) as UserProfile;
        setUser(parsedUser);
        setIsAuthenticated(true);
        setView('dashboard');
        setupListeners(parsedUser.id);
      }
    };
    checkSession();
  }, []);

  const setupListeners = async (userId: number) => {
    const fetchInitialData = async () => {
      const { data: userData } = await supabase.from('users').select('*').eq('id', userId).single();
      if (userData) setUser(userData);

      const { data: contractData } = await supabase
        .from('contracts')
        .select('*, buyer:buyer_id(*), seller:seller_id(*)')
        .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
        .order('created_at', { ascending: false });
      if (contractData) setContracts(contractData);

      const { data: notifyData } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (notifyData) setNotifications(notifyData);

      const { data: contactData_res } = await supabase
        .from('user_contacts')
        .select('*, contact:contact_user_id(*)')
        .eq('user_id', userId);
      if (contactData_res) setUserContacts(contactData_res);

      const { data: ticketData } = await supabase
        .from('support_tickets')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });
      if (ticketData) setSupportTickets(ticketData);
    };

    await fetchInitialData();

    const userChannel = supabase
      .channel(`user-updates-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users', filter: `id=eq.${userId}` }, (payload) => {
        setUser(payload.new as UserProfile);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contracts' }, async () => {
        const { data } = await supabase
          .from('contracts')
          .select('*, buyer:buyer_id(*), seller:seller_id(*)')
          .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
          .order('created_at', { ascending: false });
        if (data) setContracts(data);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, (payload) => {
        setNotifications(prev => [payload.new as Notification, ...prev]);
      })
      .subscribe();

    return () => { supabase.removeChannel(userChannel); };
  };

  const handleLogin = async (phone: string) => {
    try {
      const { data, error } = await supabase.from('users').select('*').eq('phone_number', phone).single();
      if (error || !data) {
        alert('کاربری با این شماره یافت نشد. لطفاً ابتدا در ربات تلگرام ثبت‌نام کنید.');
        return;
      }
      localStorage.setItem('mianji_user', JSON.stringify(data));
      setUser(data);
      setIsAuthenticated(true);
      setView('dashboard');
      setupListeners(data.id);
    } catch (error) { console.error("Login error:", error); }
  };

  const handleLogout = () => {
    localStorage.removeItem('mianji_user');
    setIsAuthenticated(false);
    setUser(null);
    setView('auth');
  };

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('mianji_theme', newTheme);
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(newTheme);
  };

  const isLight = theme === 'light';

  return (
    <div className={`min-h-screen ${theme} transition-colors duration-500 font-sans`} dir="rtl">
      <div className={`min-h-screen ${isLight ? 'bg-white text-slate-900' : 'bg-[#08090a] text-slate-200'} relative overflow-x-hidden`}>
        
        {/* Mock Status Bar */}
        <div className="fixed top-0 left-0 right-0 h-6 z-[100] flex items-center justify-between px-6 text-[10px] font-bold text-slate-400 pointer-events-none">
           <div>9:22</div>
           <div className="flex items-center gap-1.5">
              <Activity size={10} />
              <Radio size={10} />
              <Shield size={10} />
           </div>
        </div>

        {isAuthenticated && view !== 'auth' && (
          <header className={`sticky top-0 z-50 ${isLight ? 'bg-white/80 border-slate-200' : 'bg-[#08090a]/80 border-white/5'} backdrop-blur-md border-b h-16 flex items-center justify-between px-6`}>
            <div className="flex items-center gap-3">
               <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-sm">
                  <Shield size={20} strokeWidth={2.5} />
               </div>
               <div className="flex flex-col">
                  <span className={`font-bold text-lg tracking-tight ${isLight ? 'text-slate-900' : 'text-white'} leading-none`}>میانجی</span>
                  <span className={`text-[9px] font-medium ${isLight ? 'text-slate-400' : 'text-slate-500'} uppercase tracking-wider`}>Escrow Network</span>
               </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button onClick={toggleTheme} className={`w-10 h-10 rounded-xl ${isLight ? 'bg-white border-slate-200 text-slate-600 shadow-sm' : 'bg-white/5 border-white/10 text-blue-400'} border flex items-center justify-center active:scale-90 transition-all`}>
                {isLight ? <Moon size={20} /> : <Sun size={20} />}
              </button>
              <IconButton icon={<Bell size={20} />} dot theme={theme} onClick={() => setView('notifications')} />
              <button onClick={() => setView('profile')} className={`w-10 h-10 rounded-xl ${isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-white/5 border-white/10'} border flex items-center justify-center active:scale-90 transition-all`}>
                 <User size={20} className={isLight ? 'text-slate-600' : 'text-slate-400'} />
              </button>
            </div>
          </header>
        )}

        <main className={`max-w-md mx-auto min-h-screen relative z-10 ${isAuthenticated ? 'px-4 pt-3 pb-24' : ''}`}>
          <AnimatePresence mode="wait">
            {view === 'auth' && <AuthView onLogin={handleLogin} theme={theme} />}
            {view === 'dashboard' && <DashboardView setView={setView} contracts={contracts} user={user} theme={theme} onSelect={(c) => { setSelectedContract(c); setView('detail'); }} />}
            {view === 'deals' && <DealsView contracts={contracts} theme={theme} onSelect={(c) => { setSelectedContract(c); setView('detail'); }} />}
            {view === 'wallet' && <WalletView user={user} theme={theme} />}
            {view === 'detail' && selectedContract && <DealDetailView contract={selectedContract} user={user} onBack={() => setView('dashboard')} theme={theme} />}
            {view === 'profile' && <ProfileView user={user} onLogout={handleLogout} theme={theme} />}
            {view === 'notifications' && <NotificationsView notifications={notifications} theme={theme} onBack={() => setView('dashboard')} />}
            {view === 'support' && <SupportView tickets={supportTickets} theme={theme} onBack={() => setView('dashboard')} onSelect={(t) => { setSelectedTicket(t); setView('support_detail'); }} setView={setView} />}
            {view === 'support_detail' && selectedTicket && <SupportDetailView ticket={selectedTicket} user={user} theme={theme} onBack={() => setView('support')} />}
            {view === 'contacts' && <ContactsView theme={theme} contacts={userContacts} onBack={() => setView('dashboard')} setView={setView} />}
            {view === 'create' && <CreateDealView user={user} theme={theme} onBack={() => setView('dashboard')} onSuccess={() => setView('deals')} />}
          </AnimatePresence>
        </main>

        {isAuthenticated && view !== 'auth' && (
          <nav className="nav-capsule">
            <NavButton active={view === 'contacts'} onClick={() => setView('contacts')} icon={<MessageSquare size={22} />} label="گفتگو" theme={theme} />
            <NavButton active={view === 'support'} onClick={() => setView('support')} icon={<HelpCircle size={22} />} label="پشتیبانی" theme={theme} />
            <div className="flex flex-col items-center -translate-y-4">
              <button onClick={() => setView('create')} className={`w-14 h-14 bg-blue-600 text-white rounded-full flex items-center justify-center active:scale-90 transition-all shadow-xl shadow-blue-600/30 border-[4px] ${isLight ? 'border-white' : 'border-[#08090a]'}`}>
                <Plus size={28} strokeWidth={3} />
              </button>
              <span className={`text-[10px] font-bold mt-1 ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>ایجاد معامله</span>
            </div>
            <NavButton active={view === 'deals'} onClick={() => setView('deals')} icon={<ClipboardList size={22} />} label="معاملات" theme={theme} />
            <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')} icon={<Home size={22} />} label="خانه" theme={theme} />
          </nav>
        )}
      </div>
    </div>
  );
}

// --- Views ---

function AuthView({ onLogin, theme }: { onLogin: (phone: string) => void, theme: string }) {
  const [phone, setPhone] = useState('');
  const isLight = theme === 'light';
  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="min-h-[80vh] flex flex-col justify-center p-8 text-center">
      <div className="mb-12">
        <div className="w-16 h-16 bg-blue-600 rounded-2xl mx-auto flex items-center justify-center text-white shadow-lg mb-6"><Shield size={32} /></div>
        <h1 className={`text-3xl font-black ${isLight ? 'text-slate-900' : 'text-white'} mb-3`}>میانجی</h1>
        <p className="text-slate-500 text-[13px] font-medium leading-relaxed">سامانه هوشمند واسطه‌گری امن و اسکرو</p>
      </div>
      <div className={`p-8 space-y-6 rounded-[2.5rem] ${isLight ? 'bg-slate-50 border border-slate-200' : 'bg-white/5 border border-white/10'}`}>
        <div className="space-y-4 text-right">
          <label className="text-[11px] font-bold text-blue-500 uppercase px-1">شماره همراه ربات تلگرام</label>
          <input type="tel" placeholder="0912..." value={phone} onChange={(e) => setPhone(e.target.value)} className={`w-full h-14 rounded-2xl text-center text-xl font-black outline-none border transition-all ${isLight ? 'bg-white border-slate-200 focus:border-blue-500' : 'bg-black/20 border-white/10 text-white focus:border-blue-500'}`} />
          <button onClick={() => onLogin(phone)} disabled={!phone} className="btn-primary w-full h-14 shadow-xl shadow-blue-600/20">ورود به پنل کاربری</button>
        </div>
      </div>
    </motion.div>
  );
}

function DashboardView({ setView, onSelect, contracts, user, theme }: { setView: (v: View) => void, onSelect: (c: Contract) => void, contracts: Contract[], user: UserProfile | null, theme: string }) {
  const activeContracts = contracts.filter(c => ['active', 'awaiting_payment', 'work_submitted', 'disputed'].includes(c.status));
  const isLight = theme === 'light';
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <motion.div 
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.98 }}
        onClick={() => setView('wallet')}
        className="w-full p-8 rounded-[2.5rem] bg-[#0a0b0d] border border-[#1a1c21] relative overflow-hidden group cursor-pointer transition-all shadow-2xl mb-4"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/10 blur-[80px] rounded-full -translate-y-1/2 translate-x-1/2 group-hover:bg-emerald-500/20 transition-all duration-500" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-amber-500/10 blur-[80px] rounded-full translate-y-1/2 -translate-x-1/2 group-hover:bg-amber-500/20 transition-all duration-500" />
        <div className="relative z-10 flex flex-col items-center text-center space-y-7">
           <div className="flex items-center justify-center gap-3">
              <div className="w-12 h-12 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center border border-emerald-500/20"><Wallet size={24} /></div>
              <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest">موجودی کیف پول</span>
           </div>
           <div className="space-y-1">
              <div className="flex items-baseline justify-center gap-2">
                 <span className="text-5xl font-black text-white tabular-nums tracking-tighter group-hover:text-emerald-400 transition-colors">{user?.wallet_balance.toLocaleString() || '۰'}</span>
                 <span className="text-sm font-bold text-amber-500 uppercase">T</span>
              </div>
           </div>
           <div className="flex gap-3 w-full pt-2">
              <button onClick={(e) => { e.stopPropagation(); setView('wallet'); }} className="flex-1 h-13 bg-white/5 hover:bg-white/10 text-white rounded-2xl text-[12px] font-bold border border-white/5 transition-all">تراکنش‌ها</button>
              <button onClick={(e) => { e.stopPropagation(); setView('wallet'); }} className="flex-1 h-13 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl text-[12px] font-bold shadow-lg shadow-emerald-600/30 transition-all">برداشت</button>
           </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-4 gap-2">
         <IconAction icon={<LayoutGrid size={24} />} label="پشتیبانی" onClick={() => setView('support')} theme={theme} />
         <IconAction icon={<Bell size={24} />} label="اعلان‌ها" onClick={() => setView('notifications')} theme={theme} />
         <IconAction icon={<Wallet size={24} />} label="کیف پول" onClick={() => setView('wallet')} theme={theme} />
         <IconAction icon={<ClipboardList size={24} />} label="معاملات" onClick={() => setView('deals')} theme={theme} />
      </div>

      <div className="space-y-4 pt-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
             <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
             <h2 className={`text-[13px] font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>معاملات در جریان</h2>
          </div>
          <button onClick={() => setView('deals')} className="text-[11px] font-bold text-slate-400 hover:text-blue-500">مشاهده همه</button>
        </div>
        <div className="space-y-2">
          {activeContracts.length > 0 ? activeContracts.map(c => <DealCard key={c.contract_id} contract={c} theme={theme} onClick={() => onSelect(c)} />) : (
            <div className={`p-8 text-center rounded-[2rem] border-2 border-dashed ${isLight ? 'border-slate-200 text-slate-400' : 'border-white/5 text-slate-600'}`}>
              <Layers size={32} className="mx-auto mb-3 opacity-20" />
              <p className="text-[11px] font-bold">معامله فعالی یافت نشد</p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function DealsView({ contracts, theme, onSelect }: { contracts: Contract[], theme: string, onSelect: (c: Contract) => void }) {
  const isLight = theme === 'light';
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-1">
        <h2 className={`text-xl font-black ${isLight ? 'text-slate-900' : 'text-white'} tracking-tighter`}>لیست معاملات</h2>
        <button className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400 border border-white/5"><Filter size={18} /></button>
      </div>
      <div className="space-y-3">
        {contracts.map(c => <DealCard key={c.contract_id} contract={c} theme={theme} onClick={() => onSelect(c)} />)}
      </div>
    </div>
  );
}

function DealCard({ contract, theme, onClick }: { contract: Contract, theme: string, onClick: () => void }) {
  const isLight = theme === 'light';
  return (
    <motion.button 
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`w-full p-5 rounded-3xl border text-right transition-all group relative overflow-hidden ${isLight ? 'bg-white border-slate-100 hover:border-blue-500/30' : 'bg-white/5 border-white/5 hover:bg-white/10'}`}
    >
      <div className="flex justify-between items-start mb-4">
         <div className="space-y-1">
            <span className="text-[9px] font-bold text-blue-500 uppercase tracking-widest">{contract.contract_id}</span>
            <h3 className={`text-[14px] font-black ${isLight ? 'text-slate-900' : 'text-white'} truncate max-w-[150px]`}>{contract.title}</h3>
         </div>
         <StatusLabel status={contract.status} />
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-white/5">
         <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-white/5 flex items-center justify-center text-slate-400"><User size={14} /></div>
            <span className="text-[10px] font-bold text-slate-500 truncate max-w-[80px]">{(contract as any).seller?.full_name || 'کاربر میانجی'}</span>
         </div>
         <div className={`text-[14px] font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>{contract.amount.toLocaleString()} <span className="text-[9px] text-slate-500 font-bold uppercase">T</span></div>
      </div>
    </motion.button>
  );
}

function DealDetailView({ contract, user, onBack, theme }: { contract: Contract, user: UserProfile | null, onBack: () => void, theme: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'details' | 'chat'>('details');
  const isLight = theme === 'light';

  useEffect(() => {
    const fetchMsgs = async () => {
      const { data } = await supabase.from('contract_messages').select('*').eq('contract_id', contract.contract_id).order('created_at', { ascending: true });
      if (data) setMessages(data);
    };
    fetchMsgs();
    const sub = supabase.channel(`deal-${contract.contract_id}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'contract_messages', filter: `contract_id=eq.${contract.contract_id}` }, (p) => {
      setMessages(prev => [...prev, p.new as Message]);
    }).subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [contract.contract_id]);

  const sendMsg = async () => {
    if (!newMessage.trim() || !user) return;
    const { error } = await supabase.from('contract_messages').insert({ contract_id: contract.contract_id, sender_id: user.id, message_text: newMessage });
    if (!error) setNewMessage('');
  };

  const steps = [
    { label: 'امضای طرفین', done: true },
    { label: 'پرداخت امن', done: ['active', 'work_submitted', 'completed'].includes(contract.status) },
    { label: 'تحویل پروژه', done: ['work_submitted', 'completed'].includes(contract.status) },
    { label: 'تسویه نهایی', done: contract.status === 'completed' },
  ];

  return (
    <div className="space-y-4 pb-4 h-full">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400"><ChevronRight size={20} /></button>
        <div className={`flex p-1 rounded-xl ${isLight ? 'bg-slate-100' : 'bg-white/5'}`}>
           <button onClick={() => setActiveTab('details')} className={`px-5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${activeTab === 'details' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-500'}`}>جزئیات</button>
           <button onClick={() => setActiveTab('chat')} className={`px-5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${activeTab === 'chat' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-500'}`}>گفتگو</button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'details' ? (
          <motion.div key="details" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className={`p-6 rounded-[2rem] border ${isLight ? 'bg-white border-slate-100' : 'bg-white/5 border-white/5'}`}>
              <div className="flex items-center justify-between px-2">
                 {steps.map((s, i) => (
                   <div key={i} className="flex flex-col items-center gap-2 relative">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all ${s.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-700 text-slate-500'}`}>
                         {s.done ? <CheckCircle2 size={16} /> : <span className="text-[10px] font-black">{i + 1}</span>}
                      </div>
                      <span className={`text-[8px] font-bold ${s.done ? 'text-emerald-500' : 'text-slate-500'}`}>{s.label}</span>
                   </div>
                 ))}
              </div>
            </div>

            <div className={`p-6 rounded-[2.5rem] space-y-4 relative overflow-hidden border ${isLight ? 'bg-white border-slate-200' : 'card-granite border-white/5'}`}>
               <div className="flex justify-between items-start">
                  <div className="space-y-1">
                     <span className="text-[9px] font-bold text-blue-500 uppercase">ID: {contract.contract_id}</span>
                     <h1 className={`text-xl font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>{contract.title}</h1>
                  </div>
                  <StatusLabel status={contract.status} />
               </div>
               <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className={`p-3 rounded-2xl border ${isLight ? 'bg-slate-50 border-slate-100' : 'bg-white/5 border-white/5'}`}>
                     <span className="text-[9px] text-slate-500 block mb-1">کارفرما</span>
                     <span className="text-[11px] font-bold text-slate-300">{(contract as any).buyer?.full_name || 'ناشناس'}</span>
                  </div>
                  <div className={`p-3 rounded-2xl border ${isLight ? 'bg-slate-50 border-slate-100' : 'bg-white/5 border-white/5'}`}>
                     <span className="text-[9px] text-slate-500 block mb-1">مجری</span>
                     <span className="text-[11px] font-bold text-slate-300">{(contract as any).seller?.full_name || 'ناشناس'}</span>
                  </div>
               </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
               <div className={`p-4 rounded-3xl border text-center ${isLight ? 'bg-white border-slate-200' : 'bg-white/5 border-white/5'}`}>
                  <span className="text-[9px] font-black text-slate-500 uppercase block mb-1">بودجه کل</span>
                  <div className={`text-lg font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>{contract.amount.toLocaleString()} <span className="text-[9px] text-slate-500 uppercase">T</span></div>
               </div>
               <div className={`p-4 rounded-3xl border text-center ${isLight ? 'bg-white border-slate-200' : 'bg-white/5 border-white/5'}`}>
                  <span className="text-[9px] font-black text-slate-500 uppercase block mb-1">وضعیت پرداخت</span>
                  <div className={`text-[11px] font-bold ${contract.status === 'awaiting_payment' ? 'text-amber-500' : 'text-emerald-500'}`}>
                    {contract.status === 'awaiting_payment' ? 'منتظر واریز' : 'پرداخت شده'}
                  </div>
               </div>
            </div>

            <div className="pt-2 space-y-2">
               {user?.id === contract.buyer_id && contract.status === 'awaiting_payment' && <button className="btn-primary w-full h-14 bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20">پرداخت امن وجه</button>}
               {user?.id === contract.seller_id && contract.status === 'active' && <button className="btn-primary w-full h-14 shadow-blue-600/20">ارسال و تحویل پروژه</button>}
               <button className="w-full h-12 rounded-xl text-rose-500 font-bold text-[11px] hover:bg-rose-500/5 transition-all">گزارش اختلاف</button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="chat" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col h-[70vh] bg-black/20 rounded-[2.5rem] border border-white/5 overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
               {messages.map(m => (
                 <div key={m.id} className={`flex ${m.sender_id === user?.id ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[80%] p-4 rounded-2xl text-[12px] leading-relaxed shadow-sm ${m.sender_id === user?.id ? 'bg-blue-600 text-white rounded-br-none' : 'bg-white/5 text-slate-200 border border-white/5 rounded-bl-none'}`}>
                      {m.message_text}
                      <div className="text-[8px] mt-1 opacity-50 text-left">{new Date(m.created_at).toLocaleTimeString('fa-IR')}</div>
                    </div>
                 </div>
               ))}
            </div>
            <div className="p-4 bg-white/5 border-t border-white/5 flex gap-2">
               <input className="flex-1 bg-black/40 border border-white/5 rounded-2xl px-5 text-[12px] text-white outline-none focus:border-blue-500/50" placeholder="پیام خود را بنویسید..." value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyPress={e => e.key === 'Enter' && sendMsg()} />
               <button onClick={sendMsg} className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-xl shadow-blue-600/20"><Send size={18} /></button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CreateDealView({ user, onBack, onSuccess, theme }: { user: UserProfile | null, onBack: () => void, onSuccess: () => void, theme: string }) {
  const [formData, setFormData] = useState({ title: '', amount: '', duration: '7', description: '', revisions: '2', feePayment: 'half', category: 'design', role: 'seller' });
  const [loading, setLoading] = useState(false);
  const isLight = theme === 'light';

  const handleSubmit = async () => {
    if (!formData.title || !formData.amount || !user) return;
    setLoading(true);
    try {
      const { error } = await supabase.from('contracts').insert({
        contract_id: `ES-${Math.floor(1000 + Math.random() * 9000)}`,
        title: formData.title,
        amount: Number(formData.amount),
        buyer_id: formData.role === 'buyer' ? user.id : 0,
        seller_id: formData.role === 'seller' ? user.id : 0,
        status: 'draft',
        milestones: formData,
        deadline: new Date(Date.now() + Number(formData.duration)*86400000).toISOString()
      });
      if (error) throw error;
      onSuccess();
    } catch (err) { alert('خطا در ثبت قرارداد'); } finally { setLoading(false); }
  };

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-center justify-between">
         <button onClick={onBack} className={`w-10 h-10 rounded-xl bg-white/5 border border-white/5 flex items-center justify-center text-slate-500`}><ChevronRight size={20} /></button>
         <h1 className={`text-lg font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>ایجاد معامله جدید</h1>
         <div className="w-10" />
      </div>

      <div className={`p-6 rounded-[2rem] border space-y-6 ${isLight ? 'bg-white border-slate-200' : 'bg-white/5 border-white/10'}`}>
         <div className="space-y-4 text-right">
            <div className="space-y-2">
               <label className="label-refined">عنوان پروژه</label>
               <input className="input-refined" placeholder="مثلا: طراحی لوگو" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} />
            </div>
            <div className="space-y-2">
               <label className="label-refined">مبلغ (تومان)</label>
               <input type="number" className="input-refined" placeholder="0" value={formData.amount} onChange={e => setFormData({...formData, amount: e.target.value})} />
            </div>
            <div className="space-y-2">
               <label className="label-refined">توضیحات و تعهدات (ملاک داوری)</label>
               <textarea className="input-refined h-32 py-3 resize-none" placeholder="شرح کامل پروژه..." value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} />
            </div>
            <button onClick={handleSubmit} disabled={loading} className="btn-primary w-full h-14 shadow-xl shadow-blue-600/20">{loading ? 'در حال ثبت...' : 'تایید و ایجاد معامله'}</button>
         </div>
      </div>
    </div>
  );
}

function SupportView({ tickets, theme, onBack, onSelect, setView }: { tickets: SupportTicket[], theme: string, onBack: () => void, onSelect: (t: SupportTicket) => void, setView: (v: View) => void }) {
  const isLight = theme === 'light';
  const [showCreate, setShowCreate] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400"><ChevronRight size={20} /></button>
        <h2 className={`text-lg font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>پشتیبانی</h2>
      </div>
      <button onClick={() => setShowCreate(true)} className="w-full h-14 bg-blue-600 text-white rounded-2xl flex items-center justify-center gap-2 font-bold shadow-xl shadow-blue-600/20"><Plus size={20} /> تیکت جدید</button>
      <div className="space-y-3">
        {tickets.map(t => (
          <button key={t.id} onClick={() => onSelect(t)} className={`w-full p-5 rounded-2xl border text-right flex items-center justify-between ${isLight ? 'bg-white border-slate-100' : 'bg-white/5 border-white/5'}`}>
            <div className="flex items-center gap-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${t.status === 'open' ? 'bg-blue-600/10 text-blue-500' : 'bg-emerald-600/10 text-emerald-500'}`}><MessageSquare size={18} /></div>
              <div className="text-right">
                <h4 className={`text-[14px] font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>{t.subject}</h4>
                <span className="text-[10px] text-slate-500">{new Date(t.created_at).toLocaleDateString('fa-IR')}</span>
              </div>
            </div>
            <ChevronLeft size={16} className="text-slate-500" />
          </button>
        ))}
      </div>
      {showCreate && (
         <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm p-4 flex items-center justify-center">
            <div className={`w-full max-w-sm ${isLight ? 'bg-white' : 'card-granite'} p-6 rounded-[2rem] space-y-6`}>
               <h3 className="text-lg font-black text-right">ارسال تیکت</h3>
               <div className="space-y-4 text-right">
                  <input className="input-refined" placeholder="موضوع" value={subject} onChange={e => setSubject(e.target.value)} />
                  <textarea className="input-refined h-32 py-3" placeholder="متن پیام" value={message} onChange={e => setMessage(e.target.value)} />
               </div>
               <button onClick={() => { alert('ثبت شد'); setShowCreate(false); }} className="btn-primary w-full h-12">ثبت</button>
               <button onClick={() => setShowCreate(false)} className="w-full text-xs text-slate-500">انصراف</button>
            </div>
         </div>
      )}
    </div>
  );
}

function SupportDetailView({ ticket, user, theme, onBack }: { ticket: SupportTicket, user: UserProfile | null, theme: string, onBack: () => void }) {
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const isLight = theme === 'light';

  useEffect(() => {
    const fetchMsgs = async () => {
      const { data } = await supabase.from('support_messages').select('*').eq('ticket_id', ticket.id).order('created_at', { ascending: true });
      if (data) setMessages(data);
    };
    fetchMsgs();
  }, [ticket.id]);

  const sendMsg = async () => {
    if (!newMessage.trim() || !user) return;
    const { error } = await supabase.from('support_messages').insert({ ticket_id: ticket.id, sender_id: user.id, message_text: newMessage });
    if (!error) {
      setMessages([...messages, { id: Math.random().toString(), ticket_id: ticket.id, sender_id: user.id, message_text: newMessage, is_admin_reply: false, created_at: new Date().toISOString() }]);
      setNewMessage('');
    }
  };

  return (
    <div className="flex flex-col h-[85vh]">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400"><ChevronRight size={20} /></button>
        <h2 className={`text-lg font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>{ticket.subject}</h2>
      </div>
      <div className="flex-1 overflow-y-auto space-y-4 p-2">
        {messages.map(m => (
          <div key={m.id} className={`flex ${m.is_admin_reply ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-4 rounded-2xl text-[12px] leading-relaxed ${m.is_admin_reply ? 'bg-blue-600 text-white rounded-br-none' : 'bg-white/5 text-slate-200 border border-white/5 rounded-bl-none'}`}>{m.message_text}</div>
          </div>
        ))}
      </div>
      <div className="p-4 bg-white/5 border border-white/5 rounded-3xl mt-4 flex items-center gap-3">
        <input className="flex-1 bg-transparent text-[13px] outline-none text-right" placeholder="پاسخ..." value={newMessage} onChange={e => setNewMessage(e.target.value)} />
        <button onClick={sendMsg} className="w-10 h-10 bg-blue-600 text-white rounded-xl flex items-center justify-center shadow-lg"><Send size={18} /></button>
      </div>
    </div>
  );
}

function ContactsView({ theme, contacts, onBack, setView }: { theme: string, contacts: UserContact[], onBack: () => void, setView: (v: View) => void }) {
  const isLight = theme === 'light';
  const [showAdd, setShowAdd] = useState(false);
  const [phone, setPhone] = useState('');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400"><ChevronRight size={20} /></button>
        <h2 className={`text-lg font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>مخاطبین</h2>
      </div>
      <button onClick={() => setShowAdd(true)} className="w-full h-14 bg-emerald-600 text-white rounded-2xl flex items-center justify-center gap-2 font-bold shadow-xl shadow-emerald-600/20"><PlusCircle size={20} /> افزودن مخاطب</button>
      <div className="space-y-3">
        {contacts.map(c => (
          <div key={c.id} className={`w-full p-4 rounded-2xl border flex items-center justify-between ${isLight ? 'bg-white border-slate-100' : 'bg-white/5 border-white/5'}`}>
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-blue-600/10 text-blue-500 flex items-center justify-center"><User size={24} /></div>
              <div className="text-right">
                <h4 className={`text-[14px] font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>{c.nickname || c.contact?.full_name || 'ناشناس'}</h4>
                <p className="text-[10px] text-slate-500">{c.contact?.phone_number}</p>
              </div>
            </div>
            <button onClick={() => setView('create')} className="w-9 h-9 rounded-xl bg-blue-600/10 text-blue-500 flex items-center justify-center"><Plus size={18} /></button>
          </div>
        ))}
      </div>
      {showAdd && (
         <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm p-4 flex items-center justify-center">
            <div className={`w-full max-w-sm ${isLight ? 'bg-white' : 'card-granite'} p-6 rounded-[2rem] space-y-6`}>
               <h3 className="text-lg font-black text-right">افزودن</h3>
               <input className="input-refined text-center" placeholder="0912..." value={phone} onChange={e => setPhone(e.target.value)} />
               <button onClick={() => { alert('ثبت شد'); setShowAdd(false); }} className="btn-primary w-full">ثبت</button>
               <button onClick={() => setShowAdd(false)} className="w-full text-xs text-slate-500">انصراف</button>
            </div>
         </div>
      )}
    </div>
  );
}

function WalletViewMain({ user, theme }: { user: UserProfile | null, theme: string }) {
   // Legacy or extra view? I'll keep it simple and just use WalletView
   return <WalletView user={user} theme={theme} />;
}

function WalletView({ user, theme }: { user: UserProfile | null, theme: string }) {
  const isLight = theme === 'light';
  return (
    <div className="space-y-6">
      <div className="card-granite p-8 space-y-6 bg-gradient-to-br from-slate-900 to-black border-white/10">
         <div className="text-center space-y-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em]">موجودی کل کیف پول</span>
            <div className="text-4xl font-black text-white tabular-nums tracking-tighter">{user?.wallet_balance.toLocaleString() || '۰'} <span className="text-sm font-bold text-emerald-500">تومان</span></div>
         </div>
         <div className="grid grid-cols-2 gap-3">
            <div className="bg-white/5 p-4 rounded-2xl border border-white/5 text-center">
               <span className="text-[9px] text-slate-500 block mb-1">موجودی آزاد</span>
               <span className="text-[14px] font-black text-emerald-400">{(user?.wallet_balance || 0).toLocaleString()}</span>
            </div>
            <div className="bg-white/5 p-4 rounded-2xl border border-white/5 text-center">
               <span className="text-[9px] text-slate-500 block mb-1">در امانت (قفل شده)</span>
               <span className="text-[14px] font-black text-amber-500">{(user?.escrow_locked_balance || 0).toLocaleString()}</span>
            </div>
         </div>
      </div>
      <div className="space-y-3">
         <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest px-1">تراکنش‌های اخیر</h3>
         <div className="text-center py-12 text-slate-500 text-[11px]">تراکنشی برای نمایش وجود ندارد.</div>
      </div>
    </div>
  );
}

function ProfileView({ user, onLogout, theme }: { user: UserProfile | null, onLogout: () => void, theme: string }) {
  const isLight = theme === 'light';
  return (
    <div className="space-y-6">
      <div className="text-center space-y-4 pt-4">
        <div className="w-24 h-24 rounded-full bg-blue-600/10 border-4 border-white/5 mx-auto flex items-center justify-center text-blue-500 shadow-2xl shadow-blue-600/20"><User size={48} /></div>
        <div className="space-y-1">
          <h2 className={`text-2xl font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>{user?.full_name || 'کاربر میانجی'}</h2>
          <p className="text-slate-500 text-sm font-medium">{user?.phone_number || 'بدون شماره'}</p>
        </div>
      </div>
      <div className="space-y-2">
         <ProfileMenuItem icon={<Shield size={18} />} label="احراز هویت (KYC)" value={user?.kyc_status === 'verified' ? 'تایید شده' : 'تایید نشده'} color="text-blue-500" theme={theme} />
         <ProfileMenuItem icon={<CreditCard size={18} />} label="اطلاعات بانکی" theme={theme} />
         <button onClick={onLogout} className="w-full flex items-center justify-between p-5 rounded-2xl bg-rose-600/10 text-rose-500 group hover:bg-rose-600 hover:text-white transition-all mt-4">
            <div className="flex items-center gap-4"><LogOut size={20} /><span className="text-sm font-bold">خروج از حساب</span></div>
            <ChevronLeft size={16} />
         </button>
      </div>
    </div>
  );
}

function ProfileMenuItem({ icon, label, value, color, theme }: { icon: React.ReactNode, label: string, value?: string, color?: string, theme: string }) {
  const isLight = theme === 'light';
  return (
    <button className={`w-full flex items-center justify-between p-5 rounded-2xl border transition-all ${isLight ? 'bg-white border-slate-100 hover:border-blue-500/30' : 'bg-white/5 border-white/5 hover:bg-white/10'}`}>
      <div className="flex items-center gap-4 text-right">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isLight ? 'bg-slate-50 text-slate-500' : 'bg-white/5 text-slate-400'}`}>{icon}</div>
        <span className={`text-[13px] font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {value && <span className={`text-[11px] font-bold ${color || 'text-slate-500'}`}>{value}</span>}
        <ChevronLeft size={16} className="text-slate-500" />
      </div>
    </button>
  );
}

function NotificationsView({ notifications, theme, onBack }: { notifications: Notification[], theme: string, onBack: () => void }) {
  const isLight = theme === 'light';
  return (
    <div className="space-y-4">
       <div className="flex items-center gap-3 mb-2">
         <button onClick={onBack} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-slate-400"><ChevronRight size={20} /></button>
         <h2 className={`text-lg font-black ${isLight ? 'text-slate-900' : 'text-white'}`}>اعلان‌ها</h2>
       </div>
       <div className="space-y-3">
          {notifications.map(n => (
            <div key={n.id} className={`p-5 rounded-3xl border text-right space-y-2 ${isLight ? 'bg-white border-slate-100' : 'bg-white/5 border-white/5'}`}>
               <div className="flex items-center justify-between">
                  <h4 className={`text-[13px] font-bold ${isLight ? 'text-slate-900' : 'text-white'}`}>{n.title}</h4>
                  <span className="text-[9px] text-slate-500">{new Date(n.created_at).toLocaleDateString('fa-IR')}</span>
               </div>
               <p className="text-[11px] text-slate-500 leading-relaxed">{n.body}</p>
            </div>
          ))}
       </div>
    </div>
  );
}

function StatusLabel({ status }: { status: string }) {
  const config: Record<string, { label: string, color: string }> = {
    draft: { label: 'پیش‌نویس', color: 'bg-slate-500/20 text-slate-400' },
    awaiting_payment: { label: 'در انتظار واریز', color: 'bg-amber-500/20 text-amber-500' },
    active: { label: 'در حال اجرا', color: 'bg-blue-500/20 text-blue-500' },
    work_submitted: { label: 'تحویل داده شده', color: 'bg-purple-500/20 text-purple-500' },
    completed: { label: 'تکمیل شده', color: 'bg-emerald-500/20 text-emerald-500' },
    cancelled: { label: 'لغو شده', color: 'bg-rose-500/20 text-rose-500' },
    disputed: { label: 'دارای اختلاف', color: 'bg-rose-600/20 text-rose-600' }
  };
  const { label, color } = config[status] || config.draft;
  return <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-wider ${color}`}>{label}</span>;
}

function NavButton({ active, icon, label, onClick, theme }: { active: boolean, icon: React.ReactNode, label: string, onClick: () => void, theme: string }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 transition-all ${active ? 'text-blue-500' : 'text-slate-500 hover:text-slate-400'}`}>
      <div className={`transition-transform ${active ? 'scale-110 -translate-y-1' : ''}`}>{icon}</div>
      <span className="text-[9px] font-bold">{label}</span>
    </button>
  );
}

function IconButton({ icon, dot, theme, onClick }: { icon: React.ReactNode, dot?: boolean, theme: string, onClick?: () => void }) {
  return (
    <button onClick={onClick} className={`w-10 h-10 rounded-xl ${theme === 'dark' ? 'bg-white/5 border-white/10 text-slate-400' : 'bg-white border-slate-200 text-slate-600 shadow-sm'} border flex items-center justify-center relative active:scale-90 transition-all`}>
      {icon}{dot && <div className="absolute top-2 right-2 w-2 h-2 bg-blue-500 rounded-full border-2 border-[#08090a]" />}
    </button>
  );
}

function IconAction({ icon, label, onClick, theme }: { icon: React.ReactNode, label: string, onClick: () => void, theme: string }) {
  const isLight = theme === 'light';
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-2 p-4 rounded-[2rem] transition-all group ${isLight ? 'bg-slate-50 hover:bg-blue-50' : 'bg-white/5 hover:bg-white/10'}`}>
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${isLight ? 'bg-white text-blue-600 shadow-sm group-hover:shadow-md' : 'bg-[#08090a] text-slate-400 group-hover:text-blue-400'}`}>{icon}</div>
      <span className={`text-[10px] font-black ${isLight ? 'text-slate-600' : 'text-slate-500'}`}>{label}</span>
    </button>
  );
}
