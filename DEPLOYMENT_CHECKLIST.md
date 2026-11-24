# Deployment checklist (no laptop needed)

Two deployments from this one GitHub repo:
**Railway** = the WhatsApp bot (root `Dockerfile` + `railway.json`) · **Vercel** = the web app (`web/`, with `web/vercel.json`).

Done once, before deploying: all FOUR SQL files in `supabase/migrations/` have been run in Supabase, in order: `001`, `002`, `003` (referral cash payouts), then `004` (app alerts). Without `003` everything else works, but WITHDRAW says "payouts are being switched on". Without `004` everything else works, but "Turn on my evening alert" says alerts are being set up.

App alerts also need a VAPID key pair: `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` on the bot (Railway) and the same public key as `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on the web app (Vercel). Without them alerts are simply off.

---

## A. Vercel — the web app (do this first, it gives you a URL)
1. Vercel → **Add New → Project** → import this GitHub repo.
2. **Root Directory: `web`** (important). Framework is detected as Next.js; `vercel.json` sets the build command.
3. Paste these **Environment Variables** (names only — use the same values you already have):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `JWT_SECRET`  *(any long random text, 32+ characters)*
   - `GEMINI_API_KEY`
   - `GEMINI_TEXT_MODEL`
   - `GEMINI_TEXT_FALLBACK_MODEL`
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_GRAPH_VERSION`
   - `WHATSAPP_DISPLAY_NUMBER`
   - `APP_URL`  *(optional — only if you use your own domain; otherwise Vercel's address is used automatically)*
4. **Deploy.** Copy the address Vercel gives you (e.g. `https://xxx.vercel.app`).

## B. Railway — the WhatsApp bot
1. Railway → **New Project → Deploy from GitHub repo** → this repo (root folder; it finds the `Dockerfile`).
2. **Add a Redis service** to the same project (+ New → Database → Redis).
3. In the bot service → **Variables**, paste these names:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `WHATSAPP_ACCESS_TOKEN`   *(use a permanent System-User token, not the 24-hour one)*
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_DISPLAY_NUMBER`
   - `WHATSAPP_APP_SECRET`
   - `WHATSAPP_VERIFY_TOKEN`
   - `GEMINI_API_KEY`
   - `GEMINI_TEXT_MODEL`
   - `GEMINI_TEXT_FALLBACK_MODEL`
   - `REDIS_URL`   *(click "Add Reference" → the Redis service's `REDIS_URL`)*
   - `WEB_APP_URL`   *(the Vercel address from step A.4)*
   - `ADMIN_PHONE`   *(your own number, digits only — enables ADMIN, and gets the WhatsApp alert for each cash-payout request. WhatsApp only lets the bot message you if you messaged it in the last 24 hours, so send it `ADMIN` or `PAYOUTS` once a day; requests are never lost — `PAYOUTS` lists every pending one)*
   - `SUPPORT_WHATSAPP_URL`   *(e.g. `https://wa.me/234…` — shown by SUPPORT and when payments aren't live)*
4. **Settings → Networking → Generate Domain.** Railway checks `/healthz`; the bot is up when it turns green.

## C. Tell Meta (one time)
In **developers.facebook.com → your app → WhatsApp → Configuration → Webhook**:
- Callback URL: `https://<your-railway-domain>/webhooks/whatsapp`
- Verify token: the same value as `WHATSAPP_VERIFY_TOKEN`
- Subscribe the **messages** field.

## D. Later, when you are ready to take payments (the bot works without these)
Until these are set, plans say "payment opens very soon" and nothing breaks:
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_PLAN_STARTER_MONTHLY`
- `PAYSTACK_PLAN_STARTER_ANNUAL`
- `PAYSTACK_PLAN_GROWTH_MONTHLY`
- `PAYSTACK_PLAN_GROWTH_ANNUAL`

Then in Paystack set the webhook to `https://<your-railway-domain>/webhooks/paystack`.

## Optional extras
- `WHATSAPP_CEO_TEMPLATE`, `WHATSAPP_TEMPLATE_LANG` — the Sunday report template (must be approved by Meta first)
- `GOOGLE_SHEETS_SA_JSON_B64` — Growth-plan Google Sheets sync
- `TTS_PROVIDER` (default `gemini`, no extra account needed), `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE`
- `INTERIM_NOTICE_MS` — seconds-in-ms before the "Processing your entry..." note (default 12000)
- `OPS_ALERT_PHONE` — only a fallback for `ADMIN_PHONE` (the payout alerts go to `ADMIN_PHONE`)

## Smoke test after deploying (2 minutes, from your phone)
1. Message the WhatsApp number: `Hi` → it asks for a business name.
2. Finish onboarding, send `sold 2 lace 50k cash`, tap **Confirm**, tap **🧾 Customer Receipt**.
3. Send `CLOSE`, `SUPPORT`, and (from `ADMIN_PHONE`) `ADMIN`.
4. Send `LOGIN` → open the link → your dashboard on the Vercel address.

## Auto-deploys
Vercel (web/) and Railway (bot) redeploy automatically on every push to `main`.
