# Implementation Plan - Mianji (میانجی) Escrow Platform

Mianji is a high-fidelity, professional escrow and financial intermediation platform designed for secure transactions. It features a mobile-first Web App (optimized for Telegram Web App) and an integrated Telegram Bot, all powered by Firebase and a Node.js backend.

> [!IMPORTANT]
> Since the Cloud SQL setup was ineligible for this project, we have pivoted to **Firebase (Firestore & Auth)** as the primary persistence layer. This ensures real-time updates for chats and transaction states.

## User Review & Critical Decisions

- **Confirmed: Authentication Flow**: Custom Phone OTP + National ID (Code Meli) verification.
- **Confirmed: Language**: Persian (Farsi) only with Right-to-Left (RTL) design.
- **Confirmed: Verification**: Mock logic for National ID verification during development.
- **Decision: Bot Integration**: We will implement the Telegram Bot using **Node.js (Telegraf)** integrated directly into the Express backend.
    - *Why*: This allows the bot and web app to share the same Firebase database instance, security logic, and real-time listeners without needing a separate external API for a Python bot.

## 1. Overview & Core Concept
- **What It Does**: Mianji acts as a trusted middleman for buyers and sellers. It holds funds/commitments in "Escrow," provides a secure chat for parties, and offers a "Dispute Room" with professional arbitration.
- **Target Audience**: Individual freelancers, online buyers/sellers, and peer-to-peer service providers in the Persian-speaking market.
- **Key Value**: Security, legal-grade signing evidence (National ID/IP/OTP), and professional dispute resolution.

## 2. User Experience & Visual Design
- **Visual Identity**:
    - *Aesthetic*: Professional, trustworthy, and "Royal Finance" style.
    - *Color Palette*: Primary **Royal Blue (#2563EB)**, Background **Light Gray (#F8FAFC)**, Accents in Deep Slate.
    - *Typography*: Characterful Persian typeface (e.g., Vazirmatn or IRANSans) with tabular numerals for financial data.
- **Key User Flows**:
    1. **Onboarding**: User joins via Telegram Bot -> Launches Web App -> OTP Login -> National ID Verification.
    2. **Escrow Lifecycle**: Create Escrow -> Invite Party -> Sign Agreement (OTP/National ID) -> Active Chat -> Mark as Done/Request Dispute.
    3. **Dispute Room**: Buyer/Seller submit evidence -> Admin/Mediator joins the room -> Final Ruling.

## 3. Technical Architecture & Data Strategy

```unicode
┌──────────────────────────────────────────────────────────┐
│                  Mianji Ecosystem (RTL)                  │
└────────────────────────────┬─────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │      Express Backend        │
              │  (Vite Proxy + API + Bot)   │
              └──────────────┬──────────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
┌──────▼──────┐       ┌──────▼──────┐       ┌──────▼──────┐
│  Telegram   │       │  Firebase   │       │  React Web  │
│  Bot (TG)   │       │ Auth/Store  │       │     App     │
└─────────────┘       └─────────────┘       └─────────────┘
```

### Data Model (Firestore Collections)
- `users`: `{ uid, phone, nationalId, trustScore, profileStatus, telegramId }`
- `escrows`: `{ title, amount, terms, deadline, buyerId, sellerId, status, createdAt }`
- `signatures`: `{ escrowId, userId, nationalId, name, otpVerified, ip, timestamp }`
- `messages`: `{ escrowId, senderId, text, type, timestamp }` (Sub-collection of escrows)
- `disputes`: `{ escrowId, status, evidence: [], mediatorId, finalVerdict }`

## 4. Implementation Steps

### Phase 1: Infrastructure & Security
- [ ] Initialize Firebase via `show_aistudio_ui`.
- [ ] Configure `firebase-blueprint.json` and generate `firestore.rules` with strict ABAC.
- [ ] Setup Express server with `vite.middlewares` and Telegram Bot webhook.

### Phase 2: Core Backend Logic
- [ ] Build Admin Panel for managing disputes and users.
- [ ] Implement OTP Mock endpoint (generating 6-digit codes for any valid phone).
- [ ] Create Escrow Management API (CRUD with status transitions).
- [ ] Build Telegram Bot handlers (Invite link generation, Status notifications).

### Phase 3: Frontend Development (RTL)
- [ ] Implement RTL layout with Tailwind (`dir="rtl"`).
- [ ] Build Auth screens (Phone Entry -> OTP -> Verification).
- [ ] Create Dashboard & Escrow Detail views (Chat interface, Signature forms).
- [ ] Build Admin Dashboard (Dispute management, User trust score control).
- [ ] Implement "Dispute Room" UI with evidence upload.

### Phase 4: Integration & Testing
- [ ] Connect Web App to Telegram (TWA integration).
- [ ] End-to-end flow testing (Creation to Completion).
