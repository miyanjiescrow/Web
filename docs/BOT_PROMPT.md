# 🤖 راهنمای هماهنگ‌سازی کامل ربات تلگرام میانجی با دیتابیس Supabase و سرور وب‌سایت

این سند مرجع کامل ۱۴ جدول مشترک در **Supabase PostgreSQL**، فرمول واحد حسابداری کیف پول/اسکرو، تابع اتمیک `miyanji_adjust_wallet_atomic` و اندپوینت‌های هماهنگ‌سازی ربات است.

---

## ۱. اتصال امن و ممنوعیت افشای کلیدها
- در سرور وب‌سایت و سرور ربات، دسترسی به Supabase **فقط از سمت سرور** با `@supabase/supabase-js` و متغیرهای محیطی `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` انجام می‌شود.
- هرگز `SUPABASE_SERVICE_ROLE_KEY` یا `BOT_SYNC_SECRET` را در فرانت‌اند (`VITE_*` / `NEXT_PUBLIC_*`) یا جدول `bot_settings` ذخیره نکنید.
- روی تمام جداول Supabase، سیاست RLS سخت‌گیرانه (`USING (false)`) برای نقش‌های `anon` و `authenticated` فعال است تا دسترسی مستقیم کلاینت مسدود بماند.

---

## ۲. ۱۴ جدول مشترک اصلی در Supabase PostgreSQL
هر جدول علاوه بر ستون‌های اصلی، دارای ستون `data jsonb` است که هم‌زمان با ستون‌های اصلی به‌روزرسانی می‌شود:

1. `public.users` (`id`, `telegram_id`, `chat_id`, `phone_number`, `phone_core_digits`, `full_name`, `username`, `role`, `kyc_status`, `kyc_level`, `is_verified`, `national_id`, `sheba`, `sheba_owner_name`, `sheba_verified`, `sheba_locked_to_national_id`, `wallet_balance`, `escrow_locked_balance`, `saved_cards`, `has_financial_pin`, `financial_pin_hash`, `pin_failed_attempts`, `pin_locked_until`, `security_score`, `referral_code`, `invited_by`, `is_blocked`, `data`, `created_at`, `updated_at`)
2. `public.otp_codes` (`id` = ۱۰ رقم آخر موبایل، `phone`, `code`, `code_hash`, `expires`, `attempts`, `purpose`, `telegram_id`, `data`)
3. `public.bot_login_tokens` (`id` = `token`, `token`, `telegram_id`, `phone_number`, `full_name`, `username`, `expires_at`, `used`, `created_at`)
4. `public.deals` (`id` = `contract_id`, `contract_id`, `invite_token`, `title`, `category`, `description`, `status`, `escrow_deposit_status`, `commission_payer`, `creator_id`, `creator_role`, `buyer_id`, `seller_id`, `amount`, `locked_amount`, `held_extra_amount`, `deadline`, `staged_payment`, `milestones`, `buyer_signed_at`, `seller_signed_at`, `paid_at`, `delivery_deadline`, `completed_at`, `data`)
5. `public.contract_signatures` (`id`, `contract_id`, `user_id`, `telegram_id`, `telegram_username`, `full_name`, `national_id`, `phone_number`, `role`, `signed_at`, `otp_verified`, `client_ip`, `verification_method`, `signature_hash`, `status`, `data`)
6. `public.transactions` (`id`, `user_id`, `type`, `amount`, `title`, `description`, `status`, `ref_id`, `contract_id`, `sheba`, `data`, `created_at`, `updated_at`)
7. `public.wallet_requests` (`id`, `user_id`, `type`, `amount`, `sheba`, `holder_name`, `source`, `status`, `suspicious_flag`, `admin_id`, `document_note`, `documents`, `data`)
8. `public.pending_receipts` (`id`, `type`, `related_id`, `user_id`, `file_id`, `amount`, `description`, `status`, `data`)
9. `public.disputes` (`id`, `contract_id`, `contract_title`, `claimant_id`, `claimant_name`, `reason`, `description`, `evidence_files`, `status`, `messages`, `ruling`, `data`)
10. `public.ambassadors` (`id`, `telegram_id`, `tier_level`, `commission_rate`, `total_referrals`, `monthly_deals`, `withdrawable_balance`, `total_earnings`, `is_active`, `data`)
11. `public.commission_logs` (`id`, `ambassador_id`, `contract_id`, `deal_amount`, `commission_amount`, `share_amount`, `data`, `created_at`)
12. `public.bot_settings` (`id`, `key`, `value`, `updated_by`, `data`, `updated_at`)
13. `public.security_audit_logs` (`id`, `user_id`, `phone_number`, `event`, `category`, `status`, `details`, `data`, `created_at`)
14. `public.admin_logs` (`id`, `admin_id`, `action`, `detail`, `target_id`, `data`, `created_at`)

*(علاوه بر این، جداول اختصاصی وب‌سایت از جمله `user_sessions`, `user_contacts`, `contact_invites`, `deal_drafts`, `deal_reviews`, `direct_chats`, `direct_messages`, `contract_messages`, `chat_pins`, `channels`, `channel_posts`, `channel_subscribers`, `notifications`, `notification_prefs`, `push_subscriptions`, `support_tickets`, `payment_sessions`, `media_assets`, `media_chunks`, `system_settings` و `app_documents` نیز در `supabase/schema.sql` تعریف شده‌اند.)*

---

## ۳. فرمول واحد و اتمیک حسابداری کیف پول و اسکرو
- `wallet_balance` = موجودی **کل** کاربر (آزاد + بلوکه‌شده).
- `escrow_locked_balance` = موجودی **قفل‌شده در معاملات فعال** (`0 <= escrow_locked_balance <= wallet_balance`).
- **موجودی آزاد:** `free_balance = Math.max(0, wallet_balance - escrow_locked_balance)`
- **قفل وجه از کیف پول:** فقط `escrow_locked_balance += lockAmount` (`wallet_balance` ثابت می‌ماند و قبل از آن `free_balance >= lockAmount` بررسی می‌شود).
- **تایید فیش کارت‌به‌کارت قرارداد:** هم `wallet_balance += paidAmount` و هم `escrow_locked_balance += paidAmount`.
- **لغو قرارداد یا رأی به نفع کارفرما:** فقط `escrow_locked_balance -= lockedAmount` (هرگز دوباره به `wallet_balance` اضافه نمی‌شود).
- **تایید تحویل یا رأی به نفع مجری:** از کارفرما هم `escrow_locked_balance -= lockedAmount` و هم `wallet_balance -= lockedAmount` کم می‌شود و به `wallet_balance` مجری خالص پس از کسر کارمزد اضافه می‌گردد.
- **برداشت وجه:** فقط تا سقف `free_balance` مجاز است و از `wallet_balance` کسر می‌شود.
- تابع PostgreSQL `public.miyanji_adjust_wallet_atomic(p_user_id, p_wallet_delta, p_locked_delta, p_require_free_check)` تمام این تغییرات را با قفل ردیف (`FOR UPDATE`) و به‌روزرسانی هم‌زمان ستون‌ها و `data jsonb` اجرا می‌کند.

---

## ۴. اندپوینت‌های هماهنگ با ربات (هدر `x-bot-secret: BOT_SYNC_SECRET`)
- `POST /api/bot/register-user` با `{ telegramId, phone, fullName, username }` (جستجو با `telegram_id` یا ۱۰ رقم انتهایی `phone_core_digits` بدون صفر کردن موجودی).
- `GET /api/bot/user-balance?telegramId=...` یا `?phone=...`
- `POST /api/tgcloud/sync` با اکشن‌های:
  `upsert_user`, `upsert_deal`, `upsert_tx`, `upsert_withdrawal`, `upsert_dispute`, `upsert_signature`, `upsert_pending_receipt`, `upsert_ambassador`, `create_commission_log`, `create_admin_log`, `upsert_setting`, `pull_user`, `pull_deal`, `pull_all`.
- `POST /api/auth/send-otp` و `POST /api/auth/verify-otp`
- `POST /api/auth/telegram` (پشتیبانی یکجا از توکن یک‌بارمصرف `token`/`tg_login` و `initData` مینی‌اپ).
