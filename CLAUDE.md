# CLAUDE.md — UNBARMORE (unbarmore.com) MASTER ENGINEERING SPECIFICATION

## 1. PROJECT IDENTITY & PRODUCT MISSION
You are building the production backend for **Unbarmore** (`unbarmore.com`), an all-in-one **WhatsApp AI Sales, Video & Profit Co-Pilot ("Attract, Close & Count")** built specifically for Nigerian small and medium businesses.
- **Zero App Friction:** Users operate 100% inside WhatsApp via the official **Meta WhatsApp Cloud API**.
- **Domain Compliance Rule:** Unbarmore is a **vertical business utility assistant** (sales video generation, objection handling, bookkeeping, receipt generation, and profit diagnostics). Strictly decline off-topic general-purpose chatbot queries (essays, politics, trivia) to comply with Meta's 2026 WhatsApp Business Solution Policy.

---

## 2. TECH STACK & GOOGLE/GEMINI AI CONSOLIDATION
- **Runtime & Framework:** Node.js (v20+), TypeScript (strict mode), Fastify, BullMQ + Redis (for debouncing, video workers, and scheduled jobs).
- **Database & Storage:** Supabase (PostgreSQL using `supabase/migrations/001_init_schema.sql` + Storage buckets: `raw-images`, `cleaned-images`, `videos`, `pdf-receipts`).
- **Unified AI Stack (Google Gemini API via `@google/genai`):**
  - **Multimodal Router, Voice Transcriber, Bank Alert OCR & Copywriter:** `gemini-2.5-flash` (configured via `process.env.GEMINI_TEXT_MODEL`, defaulting to `gemini-2.5-flash` with `gemini-3.5-flash-lite` fallback). Handles raw WhatsApp `.ogg` voice notes (English, Nigerian Pidgin, Yoruba, Hausa, Igbo), bank transfer screenshots, supplier receipts, and text in a single API call using strict Structured Outputs (`responseSchema`).
  - **Product Photo Studio Enhancement:** `gemini-2.5-flash-image` (configured via `process.env.GEMINI_IMAGE_MODEL`). Cleans messy phone backgrounds and places products onto clean studio scenes (`clean_minimalist`, `luxury_boutique`, `outdoor_lifestyle`) while preserving product geometry, patterns, and labels.
  - **Nigerian Voiceover TTS:** Google Cloud Text-to-Speech (`en-NG` / Chirp 3 HD voices) or Azure Neural TTS (`en-NG-AbeoNeural` / `en-NG-EzinneNeural`).
- **Media & Document Rendering (Zero-License CPU Stack):**
  - **Video Assembly:** Plain `fluent-ffmpeg` (NO Remotion/Chromium). Renders 1080x1920 vertical MP4s (`< 3.5MB` target for Nigerian mobile data efficiency, H.264, AAC) with Ken Burns zoom-pan, bold burned-in captions, Naira price badge, background Afrobeats instrumental ducking, voiceover, and conditional end-frame watermark.
  - **PDF Receipts & Weekly Statements:** `pdfkit` or `puppeteer` generating branded A5/A4 PDF receipts (`PAID` stamp, RC number, itemized breakdown) and weekly financial reports.
- **Billing:** Paystack Subscriptions + Single-Charge API (`x-paystack-signature` HMAC SHA-512 verification).

---

## 3. SUBSCRIPTION FUNNEL, USAGE CAPS & PAYSTACK PLANS

### A. 2-Stage Free Funnel + Paid Tiers
1. **`trial` (Days 1–7 — Automatic on Signup):**
   - Caps: `2` videos (watermarked), `20` transactions (voice/text/SMS), `10` OCR alert/receipt scans, unlimited PDF receipts, `1` Sunday CEO Report.
2. **`free_limited` (Day 8+ Automatic Downgrade — Never Hard-Lock):**
   - Triggered automatically by hourly cron when `trial_ends_at < NOW()` and user has not paid.
   - Monthly Caps: `1` watermarked video/mo, `20` text/SMS logs/mo (**no voice notes or OCR image scans**), `3` PDF receipts/mo, and **0 paid outbound Sunday templates** (only teaser inside 24-hr window).
3. **`starter_5k` (₦5,000/month OR ₦50,000/year — 2 Months Free):**
   - Monthly Caps: `15` HD videos/mo (choice of 3 studio themes, subtle watermark), `250` voice/text/SMS logs/mo, `150` OCR scans/mo, unlimited PDF receipts, daily 9 PM check-in, Real-Time Inflation Shield, and full Sunday CEO Report with 1-tap action buttons.
4. **`growth_15k` (₦15,000/month OR ₦150,000/year — Multi-Staff Tier):**
   - Monthly Caps: `50` HD videos/mo (**no watermark**), unlimited transactions, `500` OCR scans/mo, up to `10` authorized staff WhatsApp numbers (every staff sale sends a silent audit alert to `owner_phone`), Daily EOD owner audit, and Live Google Sheets Sync.

### B. Referral System (v2: pay the referrer cash, by plan)
- Every new business receives a unique `referral_code` (`UNBAR-XXXX`) at onboarding. The new owner is asked "Who told you about Unbarmore?" and may answer with the referrer's **business name**, phone number or code; a name is matched and confirmed before `referred_by_business_id` is set.
- **Trigger on First Paid Conversion (`charge.success` webhook):** when a referred business makes its first paid subscription (`>= ₦5,000`) and `referral_reward_paid == FALSE`, credit **only the referrer's** `referral_wallet_ngn`: **₦1,000 for Starter, ₦3,000 for Growth** (`REFERRAL.REWARD_BY_TIER`). The new subscriber gets no wallet credit. Log one `referrer_bonus` row in `referral_ledger`, set `referral_reward_paid = TRUE`.
- Wallet is **cash by default**: bank payout once `referral_wallet_ngn >= ₦1,000`. The owner may opt in (`USE CREDIT`) to apply it to their own renewal instead.

---

## 4. CRITICAL WHATSAPP ARCHITECTURE RULES (OCTOBER 2026 COMPLIANCE & COST CONTROL)

1. **Single-Reply Message Bundling (Mandatory Cost Control):**
   - Because Meta charges per service reply beyond the first 1,000 monthly conversations in Nigeria, **NEVER send multiple sequential messages for a single user action**.
   - Example: When a user logs a sale or confirms a receipt, combine the confirmation text, updated daily profit total, AND the attached PDF receipt into **ONE single WhatsApp API response**.
2. **4-Second Redis Image Debounce Buffer:**
   - When a vendor selects 3–5 product photos in WhatsApp and hits send, Meta fires separate webhooks milliseconds apart.
   - Push incoming product image media IDs into a Redis list `img_buffer:{phone_number}` with a **4-second sliding TTL/delayed BullMQ job**. Process the batch once after 4 seconds so the bot sends **one single reply** asking for Product Name, Price (`₦`), and Delivery info.
3. **Human-in-the-Loop Confirmation on All Ledger Entries:**
   - Never commit a voice note or SMS financial log silently. Reply with the parsed 1-line summary and interactive buttons: `[✅ Confirm]` and `[✏️ Edit]`, plus support replying `UNDO` within 5 minutes to mark `status = 'undone'`.
4. **24-Hour Free Window Gate on Scheduled Messages:**
   - **9:00 PM WAT Daily Cash-in-Hand Reality Check:** Query `whatsapp_sessions WHERE last_inbound_at > NOW() - INTERVAL '23 hours'`. **ONLY** send the 9 PM check-in to users inside the free 24-hour service window (`$0.00` Meta cost). Skip users outside the window.
   - **Sunday 6:00 PM WAT Weekend CEO Report:** Send as an approved Meta Utility Template (`unbarmore_weekly_ceo_report`) **only** to active `trial` (first Sunday), `starter_5k`, and `growth_15k` accounts. Never send paid outbound templates to expired or `free_limited` accounts.

---

## 5. CORE WORKFLOWS & ENDPOINTS TO BUILD

1. **`POST /webhooks/whatsapp` & `GET /webhooks/whatsapp`:**
   - Verify Meta `X-Hub-Signature-256`. Respond `200 OK` within 200ms and enqueue into BullMQ `inbound-messages`.
   - Update `whatsapp_sessions.last_inbound_at = NOW()`.
   - Route new users through a **2-step zero-friction onboarding** (Step 1: Business Name; Step 2: Optional Referral Code or `[Skip]`)—never ask them to upload a product catalog upfront. Products auto-create lazily in `products` whenever they log a sale, restock, or create a video.
2. **`POST /webhooks/paystack`:**
   - Verify `x-paystack-signature`. Idempotently record in `billing_events`.
   - Upgrade `businesses.subscription_tier`, extend `subscription_expires_at` (`+30 days` or `+365 days`), reset monthly counters, and trigger the `₦1,000` referral credit if applicable.
3. **`src/services/geminiBrain.ts`:**
   - Single multimodal entry point using `gemini-2.5-flash` with strict Zod validation for 5 intents:
     - `LOG_TRANSACTION` (splits multi-item voice/text like *"Sold 2 laces 50k, transfer 30k balance 20k, buy fuel 5k"* into atomic `transactions` + `customers` debt updates).
     - `VERIFY_BANK_ALERT` (Vision OCR on transfer screenshots/receipts: extracts `sender_name`, `bank_name`, `amount_ngn`, `session_id`, `timestamp`, and checks font/alignment anomalies for `ocr_fraud_flag`).
     - `DRAFT_SALES_REPLY` (generates 2 high-converting Nigerian WhatsApp closing scripts for customer price objections).
     - `CREATE_VIDEO_SCRIPT` (generates a punchy 15–18s Nigerian direct-response audio script + 3-line burned-in caption overlay + `UNB-XXX` Smart Order Code).
     - `QUERY_BUSINESS` (answers ad-hoc questions like *"Who owes me money?"* or *"What was my profit this week?"* strictly from PostgreSQL queries).
4. **`src/workers/videoWorker.ts`:**
   - Step 1: Enhance raw photos via `gemini-2.5-flash-image` using the business's selected `studio_theme`.
   - Step 2: Generate Nigerian English/Pidgin voiceover MP3 via TTS.
   - Step 3: Assemble 1080x1920 vertical MP4 (`< 3.5MB`) using `fluent-ffmpeg` with smooth zoom, bold captions, Naira price tag, background instrumental, and end-frame Unbarmore watermark (when `include_watermark == true`).
   - Step 4: Upload to Supabase Storage and deliver in **one single WhatsApp video message** with the Smart Order Code caption.
5. **`src/jobs/cronJobs.ts`:**
   - **Hourly:** Downgrade expired `trial` users to `free_limited`; reset monthly usage counters on the 1st of each month.
   - **Real-Time Hook (on `restock` confirmation):** Compare new unit cost against `products.cost_price_ngn`. If higher, send **Inflation & Margin Shield Alert** with `[Update Selling Price]` button and increment `total_value_recovered_ngn` when accepted.
   - **Daily 9:00 PM WAT:** Send Cash-in-Hand Reality Check (strictly inside 24-hr free window).
   - **Sunday 6:00 PM WAT:** Compute weekly Revenue, Expenses, Net Profit, >20% expense anomalies, Overdue Debtors, Dead Stock (`>21 days` unsold), and `total_value_recovered_ngn`. Send report with 3 interactive buttons:
     - `BTN_CHASE_DEBT`: Outputs ready-to-forward polite Nigerian payment reminder messages for each debtor.
     - `BTN_DEADSTOCK_PROMO`: Queues a 48-hour clearance flash-sale video for the oldest unsold item.
     - `BTN_EXPORT_PDF`: Generates and sends the weekly PDF Income & Expense Statement.

---

## 6. PROJECT STRUCTURE & BUILD ORDER
Scaffold the repository in this exact structure:
```text
unbarmore-copilot/
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── .env.example
├── supabase/
│   └── migrations/
│       └── 001_init_schema.sql
└── src/
    ├── server.ts                 # Fastify server + Meta & Paystack webhooks
    ├── config/
    │   └── env.ts                # Zod-validated environment variables
    ├── db/
    │   └── supabase.ts           # Typed Supabase client & atomic ledger helpers
    ├── services/
    │   ├── whatsapp.ts           # Meta Cloud API client (single-reply bundler & media download)
    │   ├── geminiBrain.ts        # Unified Gemini 2.5 Flash multimodal router & Zod schemas
    │   ├── imageStudio.ts        # Gemini Image product background enhancement
    │   ├── ttsService.ts         # Nigerian English/Pidgin voiceover generator
    │   ├── pdfGenerator.ts       # Branded PDF receipts & weekly statements
    │   ├── paystack.ts           # Subscription links, webhook verification & referral wallet
    │   └── googleSheets.ts       # Growth-tier live ledger sync
    ├── workers/
    │   ├── messageWorker.ts      # BullMQ processor + 4-second Redis image debounce
    │   └── videoWorker.ts        # Plain FFmpeg (<3.5MB) vertical video renderer
    └── jobs/
        └── cronJobs.ts           # Trial-to-Free downgrade, 9 PM check-in & Sunday CEO Report
```
