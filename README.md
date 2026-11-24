# Unbarmore Copilot

WhatsApp AI Sales, Video & Profit Co-Pilot for Nigerian SMEs. Spec: `CLAUDE.md`.

## Run
```bash
cp .env.example .env        # fill in
# apply supabase/migrations/001_init_schema.sql in the Supabase SQL editor
npm run dev
```
`PROCESS_ROLE=all|api|workers|cron` splits the process. Run **one** `cron`, one+ `api`, and N `workers`
(video rendering is CPU-bound; ~10s CPU per video on 4 vCPU).

## Before you can go live (things only you can do)
1. **Meta**: verified business, WhatsApp number, webhook → `POST {PUBLIC_BASE_URL}/webhooks/whatsapp`, subscribe to `messages`.
2. **Meta template** `unbarmore_weekly_ceo_report` (category *Utility*) with exactly **one** button:
   **URL** "Open Full Dashboard" → `https://app.unbarmore.com/auth/verify?token={{1}}` (index 0; dynamic suffix, the backend sends the one-time token).
   **No quick-reply buttons** (mixing them with a URL button is the WhatsApp Desktop problem). Body has exactly 5 variables
   (business name, revenue, net profit, owed, expense alert); end the static body text with *"Reply CHASE, PROMO or STATEMENT any time."*
   — those three actions are plain text commands, and users who are inside the 24h window still get them as tap-buttons.
   Until approved, Sunday sends to users outside 24h fail (in-window users are unaffected).
3. **Paystack**: create 4 plans (₦5k/₦50k, ₦15k/₦150k), put codes in `.env`, webhook → `/webhooks/paystack`.
4. **Music**: drop licensed Afrobeats instrumentals in `assets/bgm/` (none bundled — licensing). Videos render voice-only without them.
5. **Google TTS** credentials (`GOOGLE_APPLICATION_CREDENTIALS`) or switch `TTS_PROVIDER=azure`.
6. **Sheets (Growth)**: service-account JSON (base64) → owners share their sheet with its email.

## Tested here
Schema + RPCs on Postgres 16 (confirm/undo, quota, referral idempotency, downgrade) · FFmpeg render (1080×1920, ~1.6MB) ·
4s sliding image debounce on real Redis · webhook signature/200-fast · PDF output · `npm test`.
## Not tested here (needs your keys)
Live Gemini/TTS output quality, Meta delivery & template approval, Paystack live charges, Supabase Storage.

---

## Web companion — `web/` (app.unbarmore.com)

Next.js 16 PWA: WhatsApp magic-link login, live dashboard, unlimited AI advisor, ledger + PDFs, settings.
```bash
# 1. apply supabase/migrations/002_web_magic_links.sql
cd web && cp .env.example .env.local   # fill in
npm run dev                            # production build: npm run build && npm start  (uses --webpack for Serwist)
```
Deploy anywhere that runs Node (Vercel works; `assets/fonts` ships via `outputFileTracingIncludes`).
Set the **same** `SUPABASE_*` as the backend, a fresh `JWT_SECRET`, and `APP_URL` / `WEB_APP_URL` (backend) to the public origin.

**How login works:** user texts `DASHBOARD` (or the Sunday report carries a link) → backend stores `SHA-256(token)`,
sends `…/auth/verify?token=…` → GET shows a "Open my dashboard" button (so WhatsApp link-preview bots can't burn the
single-use token) → POST redeems it atomically and sets a 30-day httpOnly cookie. Owner-only; staff never see the dashboard.

**Tested:** migration 002 RPCs on Postgres 16 · production build · live auth behaviour (unauth redirects/401s, forged cookie,
GET-doesn't-consume) · JWT tamper/alg=none/expiry · Md renderer XSS · advisor snapshot logic (12 tests) · login page ≈173KB gz JS.
**Not tested here:** the authenticated pages against a live Supabase, real Gemini streaming, installing the PWA on a device.

## Live smoke test (real Supabase)
```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<secret> SUPABASE_ANON_KEY=<publishable> \
  npx tsx scripts/live-smoke.mts
```
Creates throw-away tenants (phones `2349000000xxx`), checks onboarding → pending/confirm/undo metering → receipt via Storage →
magic tokens → advisor limit → Paystack upgrade + ₦1,000 referral (idempotent) → RLS, then deletes what it created.

## Gemini notes (verified live)
- `gemini-2.5-flash` / `-flash-lite` return **404 for new API keys** ("no longer available to new users"). Default is now
  `gemini-3.1-flash-lite` (fallback `gemini-3.5-flash-lite`); both are env-configurable. Don't pass `thinkingConfig` — some models 400 on it.
- Newer flash models return **503 "high demand"** in spikes (free-tier especially). The router retries once per model, then falls back; BullMQ retries the job.
- **Image enhancement needs a billed key** (free keys get 429 on image models). On failure `imageStudio` falls back to the original photo, so videos still render.
- Image + TTS calls must use the `v1beta` API surface (the SDK default is `v1`).
- `npx tsx scripts/live-gemini.mts` (set `GEMINI_API_KEY`, `NODE_USE_ENV_PROXY=1` in the sandbox) exercises the router on Pidgin/Yoruba/SMS,
  objection handling, off-topic refusal, video script limits, bank-alert OCR and a synthetic voice note.

## Live web end-to-end (real Supabase + Gemini + browser)
```bash
cd web && NODE_ENV=production npx next build --webpack && NODE_USE_ENV_PROXY=1 npx next start -p 3333 &   # NODE_USE_ENV_PROXY only needed behind the sandbox proxy
set -a; . web/.env.local; set +a; NODE_USE_ENV_PROXY=1 npx tsx scripts/live-web-e2e.mts
```
Seeds a business (sales ₦200k, fuel ₦60k, rent ₦20k, a ₦95k debtor), mints a magic link with the backend's own function, then checks:
login (GET doesn't consume, POST redeems once, cookie flags, replay/forged rejected) → dashboard figures → ledger/debtors/settings/PDF →
3 advisor chats in a real browser (reply #3 opens with the exact ₦ fact, CTA + locked input, server 402 on #4, state survives reload). Cleans up after itself.

## Live WhatsApp outbound test
```bash
set -a; . ./.env; set +a; NODE_USE_ENV_PROXY=1 npx tsx scripts/live-whatsapp-send.mts <recipient digits>
```
Sends ONE interactive message (text + PDF receipt header + 2 buttons) through the app's own `Reply` builder. Verified delivered on a real phone.
Rules for Meta test numbers: the recipient must be on the allowed list, and free-form messages only work within 24h of the recipient messaging the number
(first contact must be the `hello_world` template). Error `131005` = the token has no WhatsApp account assigned (generate it from App → WhatsApp → API Setup,
or use a System User token with the WhatsApp account asset).

## One-command automatic tests (no phone, no Meta dashboard, no tunnel)
```bash
set -a; . ./.env; set +a; export NODE_USE_ENV_PROXY=1      # NODE_USE_ENV_PROXY only inside the Claude sandbox
npx tsx scripts/live-whatsapp-flow.mts   # bot: onboarding, ledger, undo, debts, plans, voice note, 3-photo debounce, video render
npx tsx scripts/live-smoke.mts           # database + billing + referral rules
npx tsx scripts/live-gemini.mts          # languages, scripts, OCR, voice
# web app (needs: cd web && env -u NODE_ENV npx next build --webpack && env -u NODE_ENV npx next start -p 3333)
set -a; . web/.env.local; set +a; npx tsx scripts/live-web-e2e.mts
```
`live-whatsapp-flow` runs a *pretend Meta* server (`WHATSAPP_GRAPH_BASE`, testing only), so every reply the bot would send is captured and checked.
Gotchas learned: don't export the bot's `NODE_ENV=development` into the web build (Next prerender crash); kill stale `next-server` processes (port 3333).
Voiceover now defaults to Gemini speech (`TTS_PROVIDER=gemini`) — no Google Cloud account needed.

## Referral wallet & cash payouts (migration `003_referral_payouts.sql`)
- Every paid referral credits **₦1,000 to both sides**. **Any balance from ₦1,000** automatically discounts the owner's own renewal.
- **Cash payout unlocks at ₦5,000** (5 referrals): `WITHDRAW` in WhatsApp, or **Request Cash Payout** in the web app's Settings. The whole wallet is paid out.
- The bot asks for **Bank Name + 10-digit NUBAN**, validates them strictly, marks the request **pending** in `referral_ledger`, zeroes the wallet and messages `ADMIN_PHONE`.
- Double withdrawal is blocked by the database (locked wallet row + a unique "one pending payout per business" index + a 10-digit CHECK).
- Admin (from `ADMIN_PHONE`): `PAYOUTS` lists pending · `PAID WD-XXXXXX` after paying · `REJECT WD-XXXXXX` returns the money to the wallet. The business is told either way.
- SQL tests: `psql -v ON_ERROR_STOP=1 -f supabase/tests/003_payouts_test.sql` on a scratch database with 001–003 applied (22 checks, incl. a two-sessions race).

## Retention: evening alerts, "money back", and the receipt invite (migration `004_push_subscriptions.sql`)
- **Evening alert (8 PM WAT)**: owners who tap *Turn on my evening alert* in the web app get one free push every evening ("today in numbers", or "₦X is still owed to you", or "Sold anything today?"), plus a ping when the Sunday report is ready. It works outside WhatsApp's 24h window and costs nothing. Needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (bot) and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (web).
- **Money Unbarmore got back for you**: all debt collected since day one + margin protected by the Inflation Shield. Shown as the dashboard headline, in the Sunday report, and as a 🎉 line the moment a debt payment is confirmed on WhatsApp.
- **Dashboard "Today" card**: money in / spent / profit, who still owes, and one-tap buttons to chase them or log a sale on WhatsApp.
- **Receipt invite**: customer receipts on trial / free / Starter carry "Try Unbarmore free" + the owner's referral code (Growth receipts stay clean).
- Service worker is now registered (it was built but never started before), so the offline page, fast reopen and alerts actually work.

## Trial & video cost controls
- **Trial = 14 days** (`TRIAL_DAYS` in `src/config/plans.ts`; set in code when a business is created, so no SQL change). Trial gets **5 short videos**.
- **Short "mini" videos** (`videoLength: 'mini'`) on the trial and free plans: ≤3 photos (fewer image-model calls, the biggest cost), a ~13-word script, ~9–11 s render, with a "Starter makes full HD ads" note. Paid plans keep the full 15–18 s ad. Tune in `PLANS` / `MINI_VIDEO`.
- **Voiceover fix**: the speech model now receives only the words to speak. Before, an instruction sentence was read aloud ahead of every ad (and long scripts were cut off at the end). If a voice ever overruns, it is sped up (max 1.25×) rather than clipped.
