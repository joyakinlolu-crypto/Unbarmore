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
2. **Meta template** `unbarmore_weekly_ceo_report` (category *Utility*), 5 body variables
   (business name, revenue, net profit, owed, expense alert) + 3 quick-reply buttons whose payloads are
   `BTN_CHASE_DEBT`, `BTN_DEADSTOCK_PROMO`, `BTN_EXPORT_PDF`. Until approved, Sunday sends to users outside 24h fail (in-window users are unaffected).
3. **Paystack**: create 4 plans (₦5k/₦50k, ₦15k/₦150k), put codes in `.env`, webhook → `/webhooks/paystack`.
4. **Music**: drop licensed Afrobeats instrumentals in `assets/bgm/` (none bundled — licensing). Videos render voice-only without them.
5. **Google TTS** credentials (`GOOGLE_APPLICATION_CREDENTIALS`) or switch `TTS_PROVIDER=azure`.
6. **Sheets (Growth)**: service-account JSON (base64) → owners share their sheet with its email.

## Tested here
Schema + RPCs on Postgres 16 (confirm/undo, quota, referral idempotency, downgrade) · FFmpeg render (1080×1920, ~1.6MB) ·
4s sliding image debounce on real Redis · webhook signature/200-fast · PDF output · `npm test`.
## Not tested here (needs your keys)
Live Gemini/TTS output quality, Meta delivery & template approval, Paystack live charges, Supabase Storage.
