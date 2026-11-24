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

## What the bot understands (and the audit that proves it)
- **Intents**: log sale/expense/restock/debt payment · **record debts that already existed** (a typed or spoken list of names and amounts, confirmed before saving, with Undo) · **opening stock and price/cost changes** (same Confirm/Undo, never counted as a sale or purchase) · save a customer's phone · questions about their numbers (profit, who owes, one customer's debt, best customers, stock) · chase debtors · undo/correct the last entry · business advice · sales replies · videos.
- **Honest "not yet"**: money *you* owe suppliers, cash/bank balance, personal spending, invoices and broadcasts get a plain "I haven't recorded this" and a pointer, never a false "noted". The AI is forbidden from claiming any action in free text; only the system acts.
- **Sale vs old-debt payment** is decided with the list of who currently owes (given to the AI), so "collected 12k from Chika for the gele" is a sale and "Femi don pay 14k" clears Femi's debt.
- Run `npx tsx scripts/live-router-audit.mts` before every release: 51 realistic messages in English, Pidgin, Yoruba, Hausa and Igbo (uses the real Gemini API).

## Receipts, client list, onboarding and charts
- **Receipts**: the first receipt asks once for a logo (send a photo, or "use my name": a monogram + the business name is drawn). `LOGO` changes it, `LOGO REMOVE` drops it. Logo is on receipts and weekly statements. **Several sales in one message are never assumed to be one customer**: it asks "same customer?" and, if not, lets the owner pick which sale the receipt is for. Long business names shrink to fit.
- **Client list**: `MY CLIENTS` (spend, last purchase, what they owe, 📞 if a number is saved), "add my customers: Femi 0803…, Kalu 0805…" (preview → Confirm → Undo), `WIN BACK` (ready-to-send messages for customers quiet for 30+ days, tap-to-send links), `THANK` (best customers). The owner sends the messages from their own WhatsApp: no template cost, no spam risk. Same lists in the web Ledger → Customers tab.
- **Onboarding**: 3-step welcome, `START` = "how it works" + a live checklist (first entry · who owes you · receipt · evening alert · video) detected from real activity; the web dashboard shows the same card for the first 30 days, and the 9 PM check-in nudges new accounts with the next step.
- **Charts** (web → Charts tab): sales & profit trend, vs previous period, best days, best sellers, best customers, how you get paid, where money goes, debt age, stock health. Each has a plain-language takeaway and an "Ask your advisor" link that pre-fills the question.
- Speech: if every speech model is busy, the voice retries (3 rounds) before the video falls back to music-only.

## True profit (migration `005_true_profit.sql`)
- **profit = sales − cost of the goods sold − running costs.** Stock *bought* is shown separately (it is on the shelf, not a cost). Before this, "profit" was sales − (expenses + stock bought): selling old stock looked like 100% profit and buying stock looked like a loss.
- Every sale remembers the item's cost price at the moment of sale (`transactions.unit_cost_ngn`, frozen: later cost changes never rewrite old sales). Old sales are back-filled with the current cost.
- Items with no cost price: the owner is asked once ("What does Lace cost you? Say _lace costs me 15k_"), profit is shown as **"up to ₦X"** and the screen says how much of the sales have no cost price. `START` has a "tell me what your items cost" step.
- Until migration 005 is run, every screen, message and PDF says **"Cash left"** (sales − expenses − stock bought), never "profit". Code reads the new columns only if they exist.
- SQL test: `psql -v ON_ERROR_STOP=1 -f supabase/tests/005_profit_test.sql` on a scratch database with 001–005 (sales 210k − goods 150k − rent 10k = 50k with 150k stock bought kept out; unknown costs flagged; cost frozen at sale; undo; no public access).
- New expense categories: Bank/POS charges, Repairs, Taxes/Levies.

## 7 AM "who to follow up" + 9 PM notes
- **7 AM (Lagos)**: yesterday's result, then who to follow up TODAY: debts overdue / due today / due soon (using the due dates owners give), the oldest undated debt, a customer who has gone quiet, an item nearly out; ONE "start with…" action; buttons *Chase debts / Win back / Log a sale*. Works for shops and service businesses (nothing assumes stock). **9 PM**: how the day went + what is due tomorrow.
- **Free by design**: sent only to owners who messaged in the last 23 hours (inside WhatsApp's free window). Every button tap counts as a message from the owner, which keeps the window open for the next note. Owners outside the window get the free app notification instead; we never send a paid template unprompted.
- **Control**: `REMINDERS OFF` / `STOP` pauses both notes (remembered in `outbound_log`, kind `reminders_off`), `REMINDERS ON` resumes. The welcome message tells new owners the schedule and how to pause.
- Test against the real database with a pretend WhatsApp: `set -a; . ./.env; set +a; npx tsx scripts/live-morning.mts`.

## Getting owners into the app (WhatsApp + app together)
- Morning notes on **Tue/Fri** and evening notes on **Wed/Sat** invite owners to the app until they have it (accounts under 45 days old only): first *"Also in your app: charts, who owes you, your profit. Tap Open my app"* (a **📲 Open my app** button sends a fresh one-tap login link), then, once they've opened it, *"Add to Home Screen and turn on my evening alert"*. Detected from real activity: a redeemed login link = opened; a push subscription = installed with alerts. Nothing is sent to someone who already has alerts on.
