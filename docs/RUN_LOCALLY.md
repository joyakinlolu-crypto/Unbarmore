# Run the WhatsApp bot on your computer (about 30 minutes)

You will: install 3 tools → fill one settings file → start the bot → open a tunnel → tell Meta the tunnel address → chat with the bot.

## 1. Install the tools (once)
| Tool | Why | Get it |
|---|---|---|
| **Node.js 20+** (LTS) | runs the bot | nodejs.org → LTS installer. Check: `node -v` |
| **Redis** | the bot's message queue | Mac: `brew install redis && brew services start redis` · Windows: install **Docker Desktop**, then `docker run -d -p 6379:6379 redis` · Linux: `sudo apt install redis-server` |
| **ngrok** | gives your computer a public address Meta can call | ngrok.com → sign up (free) → download → run the `ngrok config add-authtoken …` line they show you |
| ffmpeg *(only for video later)* | builds videos | skip for now |

No Redis on Windows and don't want Docker? Make a free database at upstash.com and use its `rediss://…` address as `REDIS_URL` below.

## 2. Unzip and install
```bash
cd unbarmore-copilot
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

## 3. Fill in `.env`
Open `.env` in any text editor and set these (keep the rest):
```
SUPABASE_URL=https://vtncsceauayvgbcqejpx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your sb_secret_… key>
WHATSAPP_ACCESS_TOKEN=<your NEW Meta token — see "Token" below>
WHATSAPP_PHONE_NUMBER_ID=1488405097688477
WHATSAPP_DISPLAY_NUMBER=15551658238
WHATSAPP_APP_SECRET=<your Meta app secret>
WHATSAPP_VERIFY_TOKEN=unbarmore_verify_2026_x9k2
GEMINI_API_KEY=<your Gemini key>
GEMINI_TEXT_MODEL=gemini-3.1-flash-lite
GEMINI_TEXT_FALLBACK_MODEL=gemini-3.5-flash-lite
REDIS_URL=redis://localhost:6379
PAYSTACK_SECRET_KEY=placeholder
PAYSTACK_PLAN_STARTER_MONTHLY=placeholder
PAYSTACK_PLAN_STARTER_ANNUAL=placeholder
PAYSTACK_PLAN_GROWTH_MONTHLY=placeholder
PAYSTACK_PLAN_GROWTH_ANNUAL=placeholder
```
**Token:** Meta's test tokens die after ~24h. Best: Business Settings → Users → System users → add one (Admin) → *Add assets* → your WhatsApp account (Full control) → *Generate token* with `whatsapp_business_messaging` + `whatsapp_business_management`. That one doesn't expire.

## 4. Start the bot
```bash
npm run dev
```
You should see the server listening on port 3000 and no red errors. Quick check in a browser: http://localhost:3000/healthz shows `{"ok":true}`.
(Error `ECONNREFUSED 6379` = Redis isn't running. A message about an invalid environment names the missing setting.)

## 5. Open the tunnel (second terminal window)
```bash
ngrok http 3000
```
Copy the `https://….ngrok-free.app` address it prints. Leave this window open.
Check: open `https://<that address>/healthz` in a browser — you should see `{"ok":true}`.

## 6. Tell Meta
developers.facebook.com → **My Apps → Unbarmore → WhatsApp → Configuration**
1. **Webhook → Edit**
   - Callback URL: `https://<your ngrok address>/webhooks/whatsapp`
   - Verify token: `unbarmore_verify_2026_x9k2`
   - Click **Verify and save** → it must succeed (if not: tunnel closed, bot not running, or token typo).
2. **Webhook fields → Manage →** switch **messages** to *Subscribed*.

## 7. Chat with it (from the phone that is on the test number's allowed list)
Open a chat with **+1 555-165-8238** and send, one at a time:
| You send | Expected |
|---|---|
| `Hi` | Welcome message asking for your business name |
| `Ada Fabrics` | "set up… trial started", a **Skip** button for referral |
| tap **Skip** | "You're in" tips |
| `sold 2 lace 50k, paid 30k transfer, balance 20k Mama Tunde` | Summary + **✅ Confirm / ✏️ Edit** buttons |
| tap **✅ Confirm** | ONE message: saved + today's profit + PDF receipt |
| `who dey owe me` | Mama Tunde ₦20,000 |
| `UNDO` (within 5 min) | entry reversed |
| a voice note: "I sold three ankara for forty five thousand cash" | transcribed + Confirm buttons |
| `PLANS` | plans menu |

## If something goes wrong
- **Verify fails** → open `https://<ngrok>/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=unbarmore_verify_2026_x9k2&hub.challenge=hi` in a browser; it should show `hi`. If not, the bot or tunnel is down.
- **Bot silent** → look at the `npm run dev` window for errors. Meta not even calling you? Re-check the **messages** subscription.
- **Replies fail with error 131005** → token problem (see Token). **131047** → you haven't messaged the number in the last 24h; send "Hi" again.
- **Slow/odd answers** → Gemini sometimes returns 503 "high demand"; wait a few seconds and resend.
- Paste any red error text to Claude and it can fix it.
