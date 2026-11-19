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
2. **Meta template** `unbarmore_weekly_ceo_report` (category *Utility*), buttons in THIS order (indices matter):
   0. **URL** button "Open dashboard" → `https://app.unbarmore.com/auth/verify?token={{1}}` (dynamic suffix; the backend sends the one-time token),
   1–3. **Quick replies** with payloads `BTN_CHASE_DEBT`, `BTN_DEADSTOCK_PROMO`, `BTN_EXPORT_PDF`.
   Body has exactly 5 variables (business name, revenue, net profit, owed, expense alert). Until approved, Sunday sends to users outside 24h fail (in-window users are unaffected).
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
