# 🤖 دستورالعمل هماهنگ‌سازی ربات تلگرام با فایربیس میانجی (Firebase Sync Patch)

این پرامپت را به عنوان پیام یا پچ به هوش مصنوعی در پروژه ربات تلگرام خود در **AI Studio** بدهید تا کدهای ربات را از سوپابیس به **Firebase Firestore** مهاجرت دهد و با سایت میانجی کاملاً هماهنگ شود:

---

## 📝 متن پرامپت برای پروژه ربات تلگرام:

```text
پروژه سایت میانجی اکنون به دیتابیس امن Firebase Firestore متصل شده است. لطفاً کدهای این ربات تلگرام را به‌روزرسانی کن تا مستقیماً به همان دیتابیس فایربیس متصل شود و تمام اطلاعات کاربران و تراکنش‌ها هماهنگ باشند.

### ۱. تنظیمات اتصال به فایربیس (Firebase Config):
از کتابخانه `firebase-admin` (در پایتون `firebase-admin` یا در نودجی‌اس) یا وب اس‌دی‌کی استفاده کن:
- Project ID: mianji-3639d
- Firestore Database ID: ai-studio-web-c8e655a8-004c-4987-89aa-e319ee39ab73
- API Key: AIzaSyDPLvDhCVsyBgteXD8mZLzYoNnA9nIA5RQ

همچنین آدرس وب‌اپ سایت (Web App URL):
WEBAPP_URL: https://ais-pre-vx4jx5tkaqeelhynnssugo-581273460261.europe-west2.run.app

### ۲. ساختار کالکشن کاربران (کالکشن users):
وقتی کاربر ربات را استارت می‌کند و دکمه اشتراک‌گذاری شماره همراه (Contact) را ارسال می‌کند:
یک سند در کالکشن `users` با کلید آیدی تلگرام کاربر (Doc ID = str(telegram_id)) ایجاد یا به‌روزرسانی کن با فیلدهای زیر:
{
  "id": str(user.id),
  "phone_number": clean_phone, // شماره با فرمت استاندارد 09...
  "full_name": user.full_name or "کاربر میانجی",
  "kyc_status": "pending",
  "wallet_balance": 0,
  "escrow_locked_balance": 0,
  "updatedAt": firestore.SERVER_TIMESTAMP
}

### ۳. هماهنگ‌سازی همزمان با وب‌سرور (Web Server Sync API):
برای اطمینان ۱۰۰٪ از ثبت فوری شماره در کش و سرور سایت میانجی، پس از دریافت شماره تلفن، علاوه بر فایربیس یک درخواست POST به آدرس زیر هم ارسال کن:
POST https://ais-dev-vx4jx5tkaqeelhynnssugo-581273460261.europe-west2.run.app/api/bot/register-user
Headers: {"Content-Type": "application/json"}
Body: {
  "telegramId": str(user.id),
  "phone": clean_phone,
  "fullName": user.full_name
}

### ۴. دکمه ورود به پنل وب (Mini App Button):
پس از ثبت شماره، یک پیام خوش‌آمدگویی همراه با دکمه شیشه‌ای (Inline Button) قرار بده:
دکمه: «ورود به پنل میانجی 🌐» با قابلیت WebApp که آدرس WEBAPP_URL را باز می‌کند.

### ۵. ارسال کد تایید ورود (OTP Service):
اگر کاربر در ربات درخواست کد ورود کرد یا پیامی برای دریافت کد ورود فرستاد، یا از طرف سرور وب کدی برای آیدی تلگرام او ارسال شد، کد را با فرمت زیبا و امن در چت تلگرام به کاربر نمایش بده.

لطفاً این تغییرات را به صورت کامل اعمال کن تا سوپابیس حذف شده و همه‌چیز بر بستر امن فایربیس و وب‌سرور میانجی کار کند.
```
