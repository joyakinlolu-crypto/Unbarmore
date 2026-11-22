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
