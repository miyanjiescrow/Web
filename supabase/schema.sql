-- ============================================================================
-- Mianji (میانجی) — Secure PostgreSQL Schema for Supabase
-- Run this script once in your Supabase SQL Editor (Project -> SQL Editor -> New Query)
-- Both the Website Backend (server.ts) and the Telegram Bot share these exact tables.
-- ============================================================================

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

-- 1. Users (Accounts, Wallets, Escrow Locks, Bank Cards, KYC, Roles & Limits)
create table if not exists public.users (
  id text primary key,
  telegram_id text unique,
  phone_number text,
  full_name text not null default 'کاربر میانجی',
  username text,
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin', 'owner')),
  kyc_status text not null default 'pending' check (kyc_status in ('pending', 'verified', 'rejected')),
  wallet_balance bigint not null default 0 check (wallet_balance >= 0),
  escrow_locked_balance bigint not null default 0 check (escrow_locked_balance >= 0),
  saved_cards jsonb not null default '[]'::jsonb,
  is_blocked boolean not null default false,
  national_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_users_phone_number on public.users (phone_number);
create index if not exists idx_users_telegram_id on public.users (telegram_id);
create index if not exists idx_users_national_id on public.users (national_id);

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
before update on public.users
for each row execute function public.mianji_set_updated_at();

-- 2. Deals (Escrow Contracts, Milestones, Signatures, Timeline)
create table if not exists public.deals (
  id text primary key,
  contract_id text unique not null,
  title text not null,
  amount bigint not null default 0 check (amount >= 0),
  status text not null default 'draft',
  buyer_id text,
  seller_id text,
  creator_id text,
  escrow_deposit_status text not null default 'unpaid',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_deals_contract_id on public.deals (contract_id);
create index if not exists idx_deals_buyer_id on public.deals (buyer_id);
create index if not exists idx_deals_seller_id on public.deals (seller_id);
create index if not exists idx_deals_status on public.deals (status);

drop trigger if exists trg_deals_updated_at on public.deals;
create trigger trg_deals_updated_at
before update on public.deals
for each row execute function public.mianji_set_updated_at();

-- 3. Wallet Requests (Deposit Slips & Withdraw Requests)
create table if not exists public.wallet_requests (
  id text primary key,
  user_id text not null,
  type text not null check (type in ('deposit', 'withdraw')),
  amount bigint not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  ref_code text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wallet_requests_user_status on public.wallet_requests (user_id, status);
create index if not exists idx_wallet_requests_created_at on public.wallet_requests (created_at desc);

drop trigger if exists trg_wallet_requests_updated_at on public.wallet_requests;
create trigger trg_wallet_requests_updated_at
before update on public.wallet_requests
for each row execute function public.mianji_set_updated_at();

-- 4. Immutable Financial Ledger Transactions
create table if not exists public.transactions (
  id text primary key,
  user_id text not null,
  contract_id text,
  amount bigint not null,
  type text not null,
  status text not null,
  description text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_user_id on public.transactions (user_id, created_at desc);
create index if not exists idx_transactions_type on public.transactions (type);

drop trigger if exists trg_transactions_updated_at on public.transactions;
create trigger trg_transactions_updated_at
before update on public.transactions
for each row execute function public.mianji_set_updated_at();

-- 5. OTP Verification Codes (Shared between Web & Telegram Bot)
create table if not exists public.otp_codes (
  id text primary key,
  phone text,
  code text,
  code_hash text,
  expires bigint not null,
  attempts integer not null default 0,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_otp_codes_updated_at on public.otp_codes;
create trigger trg_otp_codes_updated_at
before update on public.otp_codes
for each row execute function public.mianji_set_updated_at();

-- 6. Single-use Telegram Magic Login Tokens
create table if not exists public.bot_login_tokens (
  id text primary key,
  token text unique not null,
  telegram_id text,
  phone_number text,
  full_name text,
  username text,
  expires_at bigint,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bot_login_tokens_token on public.bot_login_tokens (token);

drop trigger if exists trg_bot_login_tokens_updated_at on public.bot_login_tokens;
create trigger trg_bot_login_tokens_updated_at
before update on public.bot_login_tokens
for each row execute function public.mianji_set_updated_at();

-- 7. Supporting Collections & Subcollections Store
-- Stores: direct_chats, direct_messages, contract_messages, notifications,
--         notification_prefs, push_subscriptions, channels, channel_posts,
--         dispute_records, support_tickets, contacts, deal_reviews,
--         user_sessions, system_settings, audit_logs, chat_pins,
--         payment_sessions, media_assets, media_chunks, and subcollections
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
-- SECURITY HARDENING: Row Level Security (RLS)
-- Enable RLS on ALL tables with ZERO public/anon write or read policies.
-- Only the trusted Backend Server and Telegram Bot (using SUPABASE_SERVICE_ROLE_KEY)
-- can read or mutate sensitive financial tables, balances, cards, and contracts.
-- ============================================================================
alter table public.users enable row level security;
alter table public.deals enable row level security;
alter table public.wallet_requests enable row level security;
alter table public.transactions enable row level security;
alter table public.otp_codes enable row level security;
alter table public.bot_login_tokens enable row level security;
alter table public.app_documents enable row level security;
