-- ============================================================================
-- Mianji (میانجی) — Complete Unified PostgreSQL Schema for Supabase
-- Shared 100% between Website Backend (server.ts) & Telegram Bot
-- Run this script once in Supabase SQL Editor (Project -> SQL Editor -> New Query)
--
-- Features:
--   1. Safe pre-drop ONLY for legacy views/materialized views matching table names.
--   2. Exact 14 shared Bot+Website core tables with typed columns + `data jsonb`.
--   3. Dedicated Website tables (sessions, chats, channels, notifications, media, etc.).
--   4. Atomic PostgreSQL RPC `miyanji_adjust_wallet_atomic` enforcing unified accounting.
--   5. Strict RLS (`USING (false)`) on EVERY table for `anon` & `authenticated`.
-- ============================================================================

-- 0. Safely drop legacy views/materialized views with matching table names
do $$
declare
  tbl text;
  rk "char";
begin
  foreach tbl in array array[
    -- 14 Shared Core Tables
    'users',
    'otp_codes',
    'bot_login_tokens',
    'deals',
    'contract_signatures',
    'transactions',
    'wallet_requests',
    'pending_receipts',
    'disputes',
    'ambassadors',
    'commission_logs',
    'bot_settings',
    'security_audit_logs',
    'admin_logs',
    -- Website Extended Tables
    'user_sessions',
    'user_contacts',
    'contact_invites',
    'deal_drafts',
    'deal_reviews',
    'direct_chats',
    'direct_messages',
    'contract_messages',
    'chat_pins',
    'channels',
    'channel_posts',
    'channel_subscribers',
    'notifications',
    'notification_prefs',
    'push_subscriptions',
    'support_tickets',
    'payment_sessions',
    'media_assets',
    'media_chunks',
    'system_settings',
    'app_documents'
  ] loop
    select c.relkind into rk
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = tbl;

    if rk = 'v' then
      execute format('drop view if exists public.%I cascade', tbl);
    elsif rk = 'm' then
      execute format('drop materialized view if exists public.%I cascade', tbl);
    end if;
  end loop;
end $$;

-- Helper trigger function for automatic updated_at maintenance
create or replace function public.mianji_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- PART A: EXACT 14 SHARED TABLES (WEBSITE + TELEGRAM BOT)
-- ============================================================================

-- 1. users
create table if not exists public.users (
  id text primary key,
  telegram_id text unique,
  chat_id bigint,
  phone_number text,
  phone_core_digits text,
  full_name text not null default 'کاربر میانجی',
  username text,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin', 'owner')),
  kyc_status text not null default 'pending' check (kyc_status in ('pending', 'verified', 'rejected', 'needs_correction')),
  kyc_level text not null default 'basic',
  is_verified boolean not null default false,
  national_id text,
  sheba text,
  sheba_owner_name text,
  sheba_verified boolean not null default false,
  sheba_locked_to_national_id boolean not null default false,
  wallet_balance bigint not null default 0 check (wallet_balance >= 0),
  escrow_locked_balance bigint not null default 0 check (escrow_locked_balance >= 0 and escrow_locked_balance <= wallet_balance),
  saved_cards jsonb not null default '[]'::jsonb,
  has_financial_pin boolean not null default false,
  financial_pin_hash text,
  pin_failed_attempts integer not null default 0 check (pin_failed_attempts >= 0),
  pin_locked_until timestamptz,
  security_score integer not null default 0,
  referral_code text,
  invited_by text,
  is_blocked boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users add column if not exists telegram_id text;
alter table public.users add column if not exists chat_id bigint;
alter table public.users add column if not exists phone_number text;
alter table public.users add column if not exists phone_core_digits text;
alter table public.users add column if not exists full_name text not null default 'کاربر میانجی';
alter table public.users add column if not exists username text;
alter table public.users add column if not exists avatar_url text;
alter table public.users add column if not exists role text not null default 'user';
alter table public.users add column if not exists kyc_status text not null default 'pending';
alter table public.users add column if not exists kyc_level text not null default 'basic';
alter table public.users add column if not exists is_verified boolean not null default false;
alter table public.users add column if not exists national_id text;
alter table public.users add column if not exists sheba text;
alter table public.users add column if not exists sheba_owner_name text;
alter table public.users add column if not exists sheba_verified boolean not null default false;
alter table public.users add column if not exists sheba_locked_to_national_id boolean not null default false;
alter table public.users add column if not exists wallet_balance bigint not null default 0;
alter table public.users add column if not exists escrow_locked_balance bigint not null default 0;
alter table public.users add column if not exists saved_cards jsonb not null default '[]'::jsonb;
alter table public.users add column if not exists has_financial_pin boolean not null default false;
alter table public.users add column if not exists financial_pin_hash text;
alter table public.users add column if not exists pin_failed_attempts integer not null default 0;
alter table public.users add column if not exists pin_locked_until timestamptz;
alter table public.users add column if not exists security_score integer not null default 0;
alter table public.users add column if not exists referral_code text;
alter table public.users add column if not exists invited_by text;
alter table public.users add column if not exists is_blocked boolean not null default false;
alter table public.users add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.users add column if not exists created_at timestamptz not null default now();
alter table public.users add column if not exists updated_at timestamptz not null default now();

-- Backfill phone_core_digits & ensure kyc/balance constraints tolerate upgrades safely
update public.users
set phone_core_digits = right(regexp_replace(coalesce(phone_number, ''), '\D', '', 'g'), 10)
where phone_core_digits is null and phone_number is not null and length(regexp_replace(phone_number, '\D', '', 'g')) >= 10;

update public.users
set escrow_locked_balance = least(greatest(0, coalesce(escrow_locked_balance, 0)), greatest(0, coalesce(wallet_balance, 0))),
    wallet_balance = greatest(0, coalesce(wallet_balance, 0))
where escrow_locked_balance < 0 or wallet_balance < 0 or escrow_locked_balance > wallet_balance;

do $$
begin
  alter table public.users drop constraint if exists users_kyc_status_check;
  alter table public.users add constraint users_kyc_status_check
    check (kyc_status in ('pending', 'verified', 'rejected', 'needs_correction'));
  alter table public.users drop constraint if exists users_escrow_locked_balance_check;
  alter table public.users add constraint users_escrow_locked_balance_check
    check (escrow_locked_balance >= 0 and escrow_locked_balance <= wallet_balance);
exception when others then
  null;
end $$;

create index if not exists idx_users_telegram_id on public.users (telegram_id);
create index if not exists idx_users_phone_number on public.users (phone_number);
create index if not exists idx_users_phone_core_digits on public.users (phone_core_digits);
create index if not exists idx_users_national_id on public.users (national_id);
create index if not exists idx_users_referral_code on public.users (referral_code);

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
before update on public.users
for each row execute function public.mianji_set_updated_at();

-- 2. otp_codes
create table if not exists public.otp_codes (
  id text primary key,
  phone text,
  code text,
  code_hash text,
  expires bigint not null default 0,
  attempts integer not null default 0 check (attempts >= 0),
  purpose text not null default 'login',
  telegram_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.otp_codes add column if not exists phone text;
alter table public.otp_codes add column if not exists code text;
alter table public.otp_codes add column if not exists code_hash text;
alter table public.otp_codes add column if not exists expires bigint not null default 0;
alter table public.otp_codes add column if not exists attempts integer not null default 0;
alter table public.otp_codes add column if not exists purpose text not null default 'login';
alter table public.otp_codes add column if not exists telegram_id text;
alter table public.otp_codes add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.otp_codes add column if not exists created_at timestamptz not null default now();
alter table public.otp_codes add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_otp_codes_phone on public.otp_codes (phone);
create index if not exists idx_otp_codes_expires on public.otp_codes (expires);

drop trigger if exists trg_otp_codes_updated_at on public.otp_codes;
create trigger trg_otp_codes_updated_at
before update on public.otp_codes
for each row execute function public.mianji_set_updated_at();

-- 3. bot_login_tokens
create table if not exists public.bot_login_tokens (
  id text primary key,
  token text unique not null,
  telegram_id text,
  phone_number text,
  full_name text,
  username text,
  expires_at bigint,
  used boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bot_login_tokens add column if not exists token text;
alter table public.bot_login_tokens add column if not exists telegram_id text;
alter table public.bot_login_tokens add column if not exists phone_number text;
alter table public.bot_login_tokens add column if not exists full_name text;
alter table public.bot_login_tokens add column if not exists username text;
alter table public.bot_login_tokens add column if not exists expires_at bigint;
alter table public.bot_login_tokens add column if not exists used boolean not null default false;
alter table public.bot_login_tokens add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.bot_login_tokens add column if not exists created_at timestamptz not null default now();
alter table public.bot_login_tokens add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_bot_login_tokens_token on public.bot_login_tokens (token);
create index if not exists idx_bot_login_tokens_tg on public.bot_login_tokens (telegram_id);

drop trigger if exists trg_bot_login_tokens_updated_at on public.bot_login_tokens;
create trigger trg_bot_login_tokens_updated_at
before update on public.bot_login_tokens
for each row execute function public.mianji_set_updated_at();

-- 4. deals
create table if not exists public.deals (
  id text primary key,
  contract_id text unique not null,
  invite_token text,
  title text not null default 'قرارداد میانجی',
  category text,
  description text,
  status text not null default 'draft',
  escrow_deposit_status text not null default 'unpaid' check (escrow_deposit_status in ('unpaid', 'paid_locked', 'released', 'refunded')),
  commission_payer text not null default 'freelancer' check (commission_payer in ('freelancer', 'employer', 'shared', 'split_50_50')),
  creator_id text,
  creator_role text,
  buyer_id text,
  seller_id text,
  amount bigint not null default 0 check (amount >= 0),
  locked_amount bigint not null default 0 check (locked_amount >= 0),
  held_extra_amount bigint not null default 0,
  deadline integer,
  staged_payment boolean not null default false,
  milestones jsonb not null default '[]'::jsonb,
  buyer_signed_at timestamptz,
  seller_signed_at timestamptz,
  paid_at timestamptz,
  delivery_deadline timestamptz,
  completed_at timestamptz,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.deals add column if not exists contract_id text;
alter table public.deals add column if not exists invite_token text;
alter table public.deals add column if not exists title text not null default 'قرارداد میانجی';
alter table public.deals add column if not exists category text;
alter table public.deals add column if not exists description text;
alter table public.deals add column if not exists status text not null default 'draft';
alter table public.deals add column if not exists escrow_deposit_status text not null default 'unpaid';
alter table public.deals add column if not exists commission_payer text not null default 'freelancer';
alter table public.deals add column if not exists creator_id text;
alter table public.deals add column if not exists creator_role text;
alter table public.deals add column if not exists buyer_id text;
alter table public.deals add column if not exists seller_id text;
alter table public.deals add column if not exists amount bigint not null default 0;
alter table public.deals add column if not exists locked_amount bigint not null default 0;
alter table public.deals add column if not exists held_extra_amount bigint not null default 0;
alter table public.deals add column if not exists deadline integer;
alter table public.deals add column if not exists staged_payment boolean not null default false;
alter table public.deals add column if not exists milestones jsonb not null default '[]'::jsonb;
alter table public.deals add column if not exists buyer_signed_at timestamptz;
alter table public.deals add column if not exists seller_signed_at timestamptz;
alter table public.deals add column if not exists paid_at timestamptz;
alter table public.deals add column if not exists delivery_deadline timestamptz;
alter table public.deals add column if not exists completed_at timestamptz;
alter table public.deals add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.deals add column if not exists created_at timestamptz not null default now();
alter table public.deals add column if not exists updated_at timestamptz not null default now();

update public.deals set contract_id = id::text where contract_id is null;

create index if not exists idx_deals_contract_id on public.deals (contract_id);
create index if not exists idx_deals_buyer_id on public.deals (buyer_id);
create index if not exists idx_deals_seller_id on public.deals (seller_id);
create index if not exists idx_deals_creator_id on public.deals (creator_id);
create index if not exists idx_deals_status on public.deals (status);

drop trigger if exists trg_deals_updated_at on public.deals;
create trigger trg_deals_updated_at
before update on public.deals
for each row execute function public.mianji_set_updated_at();

-- 5. contract_signatures
create table if not exists public.contract_signatures (
  id text primary key,
  contract_id text not null,
  user_id text not null,
  telegram_id text,
  telegram_username text,
  full_name text,
  national_id text,
  phone_number text,
  role text,
  signed_at timestamptz not null default now(),
  otp_verified boolean not null default false,
  client_ip text,
  verification_method text,
  signature_hash text,
  status text not null default 'signed',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_contract_signatures_contract on public.contract_signatures (contract_id);
create index if not exists idx_contract_signatures_user on public.contract_signatures (user_id);

drop trigger if exists trg_contract_signatures_updated_at on public.contract_signatures;
create trigger trg_contract_signatures_updated_at
before update on public.contract_signatures
for each row execute function public.mianji_set_updated_at();

-- 6. transactions
create table if not exists public.transactions (
  id text primary key,
  user_id text not null,
  type text not null,
  amount bigint not null,
  title text,
  description text,
  status text not null default 'completed',
  ref_id text,
  contract_id text,
  sheba text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transactions add column if not exists title text;
alter table public.transactions add column if not exists ref_id text;
alter table public.transactions add column if not exists sheba text;
alter table public.transactions add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.transactions add column if not exists created_at timestamptz not null default now();
alter table public.transactions add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_transactions_user_id on public.transactions (user_id, created_at desc);
create index if not exists idx_transactions_contract_id on public.transactions (contract_id);
create index if not exists idx_transactions_type on public.transactions (type);

drop trigger if exists trg_transactions_updated_at on public.transactions;
create trigger trg_transactions_updated_at
before update on public.transactions
for each row execute function public.mianji_set_updated_at();

-- 7. wallet_requests
create table if not exists public.wallet_requests (
  id text primary key,
  user_id text not null,
  type text not null default 'withdraw' check (type in ('deposit', 'withdraw')),
  amount bigint not null check (amount >= 0),
  sheba text,
  holder_name text,
  source text not null default 'web',
  status text not null default 'pending' check (status in ('pending', 'paid', 'approved', 'rejected', 'cancelled')),
  ref_code text,
  suspicious_flag boolean not null default false,
  admin_id text,
  document_note text,
  documents jsonb not null default '[]'::jsonb,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.wallet_requests add column if not exists sheba text;
alter table public.wallet_requests add column if not exists holder_name text;
alter table public.wallet_requests add column if not exists source text not null default 'web';
alter table public.wallet_requests add column if not exists ref_code text;
alter table public.wallet_requests add column if not exists suspicious_flag boolean not null default false;
alter table public.wallet_requests add column if not exists admin_id text;
alter table public.wallet_requests add column if not exists document_note text;
alter table public.wallet_requests add column if not exists documents jsonb not null default '[]'::jsonb;
alter table public.wallet_requests add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.wallet_requests add column if not exists created_at timestamptz not null default now();
alter table public.wallet_requests add column if not exists updated_at timestamptz not null default now();

do $$
begin
  alter table public.wallet_requests drop constraint if exists wallet_requests_status_check;
  alter table public.wallet_requests add constraint wallet_requests_status_check
    check (status in ('pending', 'paid', 'approved', 'rejected', 'cancelled'));
  alter table public.wallet_requests drop constraint if exists wallet_requests_amount_check;
  alter table public.wallet_requests add constraint wallet_requests_amount_check check (amount >= 0);
exception when others then
  null;
end $$;

create index if not exists idx_wallet_requests_user_status on public.wallet_requests (user_id, status);
create index if not exists idx_wallet_requests_created_at on public.wallet_requests (created_at desc);

drop trigger if exists trg_wallet_requests_updated_at on public.wallet_requests;
create trigger trg_wallet_requests_updated_at
before update on public.wallet_requests
for each row execute function public.mianji_set_updated_at();

-- 8. pending_receipts
create table if not exists public.pending_receipts (
  id text primary key,
  type text not null check (type in ('wallet', 'contract', 'milestone', 'extra_edit')),
  related_id text not null,
  user_id text not null,
  file_id text,
  amount bigint not null default 0 check (amount >= 0),
  description text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pending_receipts_related on public.pending_receipts (related_id);
create index if not exists idx_pending_receipts_user on public.pending_receipts (user_id, status);

drop trigger if exists trg_pending_receipts_updated_at on public.pending_receipts;
create trigger trg_pending_receipts_updated_at
before update on public.pending_receipts
for each row execute function public.mianji_set_updated_at();

-- 9. disputes
create table if not exists public.disputes (
  id text primary key,
  contract_id text not null,
  contract_title text,
  claimant_id text,
  claimant_name text,
  reason text,
  description text,
  evidence_files jsonb not null default '[]'::jsonb,
  status text not null default 'under_review' check (status in ('under_review', 'resolved')),
  messages jsonb not null default '[]'::jsonb,
  ruling jsonb,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_disputes_contract_id on public.disputes (contract_id);
create index if not exists idx_disputes_status on public.disputes (status);

drop trigger if exists trg_disputes_updated_at on public.disputes;
create trigger trg_disputes_updated_at
before update on public.disputes
for each row execute function public.mianji_set_updated_at();

-- 10. ambassadors
create table if not exists public.ambassadors (
  id text primary key,
  telegram_id text unique,
  tier_level text not null default 'bronze',
  commission_rate numeric(6,4) not null default 0.10,
  total_referrals integer not null default 0,
  monthly_deals integer not null default 0,
  withdrawable_balance bigint not null default 0 check (withdrawable_balance >= 0),
  total_earnings bigint not null default 0 check (total_earnings >= 0),
  is_active boolean not null default true,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ambassadors_telegram_id on public.ambassadors (telegram_id);

drop trigger if exists trg_ambassadors_updated_at on public.ambassadors;
create trigger trg_ambassadors_updated_at
before update on public.ambassadors
for each row execute function public.mianji_set_updated_at();

-- 11. commission_logs
create table if not exists public.commission_logs (
  id text primary key,
  ambassador_id text not null,
  contract_id text not null,
  deal_amount bigint not null default 0,
  commission_amount bigint not null default 0,
  share_amount bigint not null default 0,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_commission_logs_ambassador on public.commission_logs (ambassador_id, created_at desc);
create index if not exists idx_commission_logs_contract on public.commission_logs (contract_id);

drop trigger if exists trg_commission_logs_updated_at on public.commission_logs;
create trigger trg_commission_logs_updated_at
before update on public.commission_logs
for each row execute function public.mianji_set_updated_at();

-- 12. bot_settings (NEVER store private secret keys here)
create table if not exists public.bot_settings (
  id text primary key,
  key text unique not null,
  value text,
  updated_by text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bot_settings_key on public.bot_settings (key);

drop trigger if exists trg_bot_settings_updated_at on public.bot_settings;
create trigger trg_bot_settings_updated_at
before update on public.bot_settings
for each row execute function public.mianji_set_updated_at();

-- 13. security_audit_logs
create table if not exists public.security_audit_logs (
  id text primary key,
  user_id text,
  phone_number text,
  event text not null,
  category text not null default 'auth',
  status text not null default 'info',
  details text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_security_audit_logs_user on public.security_audit_logs (user_id, created_at desc);
create index if not exists idx_security_audit_logs_category on public.security_audit_logs (category, created_at desc);

drop trigger if exists trg_security_audit_logs_updated_at on public.security_audit_logs;
create trigger trg_security_audit_logs_updated_at
before update on public.security_audit_logs
for each row execute function public.mianji_set_updated_at();

-- 14. admin_logs
create table if not exists public.admin_logs (
  id text primary key,
  admin_id text not null,
  action text not null,
  detail text,
  target_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_admin_logs_admin on public.admin_logs (admin_id, created_at desc);
create index if not exists idx_admin_logs_created on public.admin_logs (created_at desc);

drop trigger if exists trg_admin_logs_updated_at on public.admin_logs;
create trigger trg_admin_logs_updated_at
before update on public.admin_logs
for each row execute function public.mianji_set_updated_at();

-- ============================================================================
-- PART B: DEDICATED WEBSITE TABLES (CHATS, CHANNELS, NOTIFICATIONS, MEDIA, ETC.)
-- ============================================================================

-- 15. user_sessions
create table if not exists public.user_sessions (
  id text primary key,
  user_id text not null,
  device_label text,
  platform text,
  ip_masked text,
  issued_at bigint,
  last_seen_at bigint,
  revoked_at bigint,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_user_sessions_user on public.user_sessions (user_id);

drop trigger if exists trg_user_sessions_updated_at on public.user_sessions;
create trigger trg_user_sessions_updated_at
before update on public.user_sessions
for each row execute function public.mianji_set_updated_at();

-- 16. user_contacts
create table if not exists public.user_contacts (
  id text primary key,
  owner_id text not null,
  contact_user_id text,
  name text,
  phone_number text,
  phone_core_digits text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_user_contacts_owner on public.user_contacts (owner_id);

drop trigger if exists trg_user_contacts_updated_at on public.user_contacts;
create trigger trg_user_contacts_updated_at
before update on public.user_contacts
for each row execute function public.mianji_set_updated_at();

-- 17. contact_invites
create table if not exists public.contact_invites (
  id text primary key,
  inviter_id text not null,
  phone_number text,
  phone_core_digits text,
  status text not null default 'sent',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_contact_invites_inviter on public.contact_invites (inviter_id);

drop trigger if exists trg_contact_invites_updated_at on public.contact_invites;
create trigger trg_contact_invites_updated_at
before update on public.contact_invites
for each row execute function public.mianji_set_updated_at();

-- 18. deal_drafts
create table if not exists public.deal_drafts (
  id text primary key,
  owner_id text not null,
  title text,
  role text,
  step integer not null default 1,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_deal_drafts_owner on public.deal_drafts (owner_id);

drop trigger if exists trg_deal_drafts_updated_at on public.deal_drafts;
create trigger trg_deal_drafts_updated_at
before update on public.deal_drafts
for each row execute function public.mianji_set_updated_at();

-- 19. deal_reviews
create table if not exists public.deal_reviews (
  id text primary key,
  contract_id text not null,
  reviewer_id text not null,
  target_user_id text not null,
  rating integer not null check (rating >= 1 and rating <= 5),
  comment text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_deal_reviews_contract on public.deal_reviews (contract_id);
create index if not exists idx_deal_reviews_target on public.deal_reviews (target_user_id);

drop trigger if exists trg_deal_reviews_updated_at on public.deal_reviews;
create trigger trg_deal_reviews_updated_at
before update on public.deal_reviews
for each row execute function public.mianji_set_updated_at();

-- 20. direct_chats
create table if not exists public.direct_chats (
  id text primary key,
  participants jsonb not null default '[]'::jsonb,
  is_support boolean not null default false,
  last_msg text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_direct_chats_support on public.direct_chats (is_support);

drop trigger if exists trg_direct_chats_updated_at on public.direct_chats;
create trigger trg_direct_chats_updated_at
before update on public.direct_chats
for each row execute function public.mianji_set_updated_at();

-- 21. direct_messages
create table if not exists public.direct_messages (
  id text primary key,
  chat_id text not null,
  sender_id text not null,
  message_text text,
  message_type text not null default 'text',
  attachment_url text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_direct_messages_chat on public.direct_messages (chat_id, created_at desc);

drop trigger if exists trg_direct_messages_updated_at on public.direct_messages;
create trigger trg_direct_messages_updated_at
before update on public.direct_messages
for each row execute function public.mianji_set_updated_at();

-- 22. contract_messages
create table if not exists public.contract_messages (
  id text primary key,
  contract_id text not null,
  sender_id text not null,
  message_text text,
  message_type text not null default 'text',
  attachment_url text,
  is_system boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_contract_messages_contract on public.contract_messages (contract_id, created_at desc);

drop trigger if exists trg_contract_messages_updated_at on public.contract_messages;
create trigger trg_contract_messages_updated_at
before update on public.contract_messages
for each row execute function public.mianji_set_updated_at();

-- 23. chat_pins
create table if not exists public.chat_pins (
  id text primary key,
  scope text not null,
  chat_id text not null,
  message_id text,
  pinned_by text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_chat_pins_chat on public.chat_pins (scope, chat_id);

drop trigger if exists trg_chat_pins_updated_at on public.chat_pins;
create trigger trg_chat_pins_updated_at
before update on public.chat_pins
for each row execute function public.mianji_set_updated_at();

-- 24. channels
create table if not exists public.channels (
  id text primary key,
  slug text,
  title text not null,
  owner_id text,
  is_public boolean not null default true,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_channels_slug on public.channels (slug);

drop trigger if exists trg_channels_updated_at on public.channels;
create trigger trg_channels_updated_at
before update on public.channels
for each row execute function public.mianji_set_updated_at();

-- 25. channel_posts
create table if not exists public.channel_posts (
  id text primary key,
  channel_id text not null,
  author_id text,
  title text,
  body text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_channel_posts_channel on public.channel_posts (channel_id, created_at desc);

drop trigger if exists trg_channel_posts_updated_at on public.channel_posts;
create trigger trg_channel_posts_updated_at
before update on public.channel_posts
for each row execute function public.mianji_set_updated_at();

-- 26. channel_subscribers
create table if not exists public.channel_subscribers (
  id text primary key,
  channel_id text not null,
  user_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_channel_subscribers_channel on public.channel_subscribers (channel_id);
create index if not exists idx_channel_subscribers_user on public.channel_subscribers (user_id);

drop trigger if exists trg_channel_subscribers_updated_at on public.channel_subscribers;
create trigger trg_channel_subscribers_updated_at
before update on public.channel_subscribers
for each row execute function public.mianji_set_updated_at();

-- 27. notifications
create table if not exists public.notifications (
  id text primary key,
  user_id text not null,
  kind text not null default 'system',
  title text,
  body text,
  is_read boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on public.notifications (user_id, created_at desc);

drop trigger if exists trg_notifications_updated_at on public.notifications;
create trigger trg_notifications_updated_at
before update on public.notifications
for each row execute function public.mianji_set_updated_at();

-- 28. notification_prefs
create table if not exists public.notification_prefs (
  id text primary key,
  user_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_notification_prefs_user on public.notification_prefs (user_id);

drop trigger if exists trg_notification_prefs_updated_at on public.notification_prefs;
create trigger trg_notification_prefs_updated_at
before update on public.notification_prefs
for each row execute function public.mianji_set_updated_at();

-- 29. push_subscriptions
create table if not exists public.push_subscriptions (
  id text primary key,
  user_id text not null,
  endpoint text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_push_subscriptions_user on public.push_subscriptions (user_id);

drop trigger if exists trg_push_subscriptions_updated_at on public.push_subscriptions;
create trigger trg_push_subscriptions_updated_at
before update on public.push_subscriptions
for each row execute function public.mianji_set_updated_at();

-- 30. support_tickets
create table if not exists public.support_tickets (
  id text primary key,
  user_id text not null,
  subject text,
  message text,
  status text not null default 'pending',
  reply text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_support_tickets_user on public.support_tickets (user_id, created_at desc);

drop trigger if exists trg_support_tickets_updated_at on public.support_tickets;
create trigger trg_support_tickets_updated_at
before update on public.support_tickets
for each row execute function public.mianji_set_updated_at();

-- 31. payment_sessions
create table if not exists public.payment_sessions (
  id text primary key,
  user_id text not null,
  provider text not null,
  amount bigint not null check (amount >= 0),
  status text not null default 'pending',
  ref_id text,
  track_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_payment_sessions_user on public.payment_sessions (user_id, created_at desc);

drop trigger if exists trg_payment_sessions_updated_at on public.payment_sessions;
create trigger trg_payment_sessions_updated_at
before update on public.payment_sessions
for each row execute function public.mianji_set_updated_at();

-- 32. media_assets
create table if not exists public.media_assets (
  id text primary key,
  owner_id text,
  mime_type text,
  size_bytes bigint not null default 0,
  chunk_count integer not null default 0,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_media_assets_updated_at on public.media_assets;
create trigger trg_media_assets_updated_at
before update on public.media_assets
for each row execute function public.mianji_set_updated_at();

-- 33. media_chunks
create table if not exists public.media_chunks (
  id text primary key,
  media_id text not null,
  chunk_index integer not null default 0,
  content text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_media_chunks_media on public.media_chunks (media_id, chunk_index);

drop trigger if exists trg_media_chunks_updated_at on public.media_chunks;
create trigger trg_media_chunks_updated_at
before update on public.media_chunks
for each row execute function public.mianji_set_updated_at();

-- 34. system_settings
create table if not exists public.system_settings (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_system_settings_updated_at on public.system_settings;
create trigger trg_system_settings_updated_at
before update on public.system_settings
for each row execute function public.mianji_set_updated_at();

-- 35. app_documents (Generic subcollection fallback)
create table if not exists public.app_documents (
  collection_path text not null,
  doc_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection_path, doc_id)
);
create index if not exists idx_app_documents_collection on public.app_documents (collection_path);
create index if not exists idx_app_documents_data_gin on public.app_documents using gin (data);

drop trigger if exists trg_app_documents_updated_at on public.app_documents;
create trigger trg_app_documents_updated_at
before update on public.app_documents
for each row execute function public.mianji_set_updated_at();

-- ============================================================================
-- PART C: ATOMIC WALLET & ESCROW ACCOUNTING RPC + UNIFIED VIEW
-- ============================================================================

create or replace function public.miyanji_adjust_wallet_atomic(
  p_user_id text,
  p_wallet_delta bigint default 0,
  p_locked_delta bigint default 0,
  p_require_free_check boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet bigint;
  v_locked bigint;
  v_free bigint;
  v_next_wallet bigint;
  v_next_locked bigint;
begin
  select coalesce(wallet_balance, 0), coalesce(escrow_locked_balance, 0)
  into v_wallet, v_locked
  from public.users
  where id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'USER_NOT_FOUND');
  end if;

  v_free := greatest(0::bigint, v_wallet - v_locked);

  if p_require_free_check and p_locked_delta > 0 and p_wallet_delta = 0 then
    if v_free < p_locked_delta then
      return jsonb_build_object(
        'ok', false,
        'error', 'INSUFFICIENT_FREE_BALANCE',
        'wallet_balance', v_wallet,
        'escrow_locked_balance', v_locked,
        'free_balance', v_free
      );
    end if;
  end if;

  v_next_wallet := v_wallet + coalesce(p_wallet_delta, 0);
  v_next_locked := v_locked + coalesce(p_locked_delta, 0);

  if v_next_wallet < 0 then
    return jsonb_build_object('ok', false, 'error', 'NEGATIVE_WALLET_BALANCE');
  end if;

  if v_next_locked < 0 then
    v_next_locked := 0;
  end if;

  if v_next_locked > v_next_wallet then
    return jsonb_build_object('ok', false, 'error', 'LOCKED_EXCEEDS_WALLET');
  end if;

  update public.users
  set wallet_balance = v_next_wallet,
      escrow_locked_balance = v_next_locked,
      data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
        'wallet_balance', v_next_wallet,
        'escrow_locked_balance', v_next_locked,
        'updated_at', now()
      ),
      updated_at = now()
  where id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'wallet_balance', v_next_wallet,
    'escrow_locked_balance', v_next_locked,
    'free_balance', greatest(0::bigint, v_next_wallet - v_next_locked)
  );
end;
$$;

revoke all on function public.miyanji_adjust_wallet_atomic(text, bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.miyanji_adjust_wallet_atomic(text, bigint, bigint, boolean) to service_role;

-- Unified Wallet Summary View
create or replace view public.user_wallet_summary
with (security_invoker = true) as
select
  u.id::text as id,
  u.telegram_id::text as telegram_id,
  u.phone_number,
  u.phone_core_digits,
  u.full_name,
  u.wallet_balance::bigint as wallet_balance,
  u.escrow_locked_balance::bigint as escrow_locked_balance,
  greatest(0::bigint, u.wallet_balance::bigint - u.escrow_locked_balance::bigint) as free_balance,
  coalesce(pw.pending_withdraw_total, 0)::bigint as pending_withdraw_total,
  greatest(
    0::bigint,
    u.wallet_balance::bigint - u.escrow_locked_balance::bigint - coalesce(pw.pending_withdraw_total, 0)::bigint
  ) as available_balance
from public.users u
left join (
  select
    user_id::text as user_id,
    sum(amount)::bigint as pending_withdraw_total
  from public.wallet_requests
  where type = 'withdraw' and status = 'pending'
  group by user_id::text
) pw on pw.user_id = u.id::text;

-- ============================================================================
-- PART D: STRICT ROW LEVEL SECURITY (RLS) ON ALL TABLES
-- Zero access for `anon` & `authenticated` (`USING (false)` + revoked grants).
-- Only trusted backend server & Telegram Bot using SUPABASE_SERVICE_ROLE_KEY may access.
-- ============================================================================
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'users',
    'otp_codes',
    'bot_login_tokens',
    'deals',
    'contract_signatures',
    'transactions',
    'wallet_requests',
    'pending_receipts',
    'disputes',
    'ambassadors',
    'commission_logs',
    'bot_settings',
    'security_audit_logs',
    'admin_logs',
    'user_sessions',
    'user_contacts',
    'contact_invites',
    'deal_drafts',
    'deal_reviews',
    'direct_chats',
    'direct_messages',
    'contract_messages',
    'chat_pins',
    'channels',
    'channel_posts',
    'channel_subscribers',
    'notifications',
    'notification_prefs',
    'push_subscriptions',
    'support_tickets',
    'payment_sessions',
    'media_assets',
    'media_chunks',
    'system_settings',
    'app_documents'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on public.%I from anon, authenticated', tbl);
    execute format('drop policy if exists %I on public.%I', 'deny_all_' || tbl, tbl);
    execute format(
      'create policy %I on public.%I as restrictive for all to anon, authenticated using (false) with check (false)',
      'deny_all_' || tbl,
      tbl
    );
  end loop;
end $$;
