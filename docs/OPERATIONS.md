# Operations: alerts, health, backups, legal

## Failure alerts (WhatsApp → ADMIN_PHONE)
- Sent for: any video failure, Gemini 402 (credits gone) / 401 / 403 / 500, Gemini 429 and 503 when they keep happening, unhandled server or webhook errors, a customer message that could not be processed, a Paystack webhook failure, bot crashes, website-advisor failures, and DELETE MY DATA requests.
- The same problem alerts once per 10 minutes (30 for credits/key problems). At most 30 alerts an hour.
- WhatsApp only lets us message you first inside 24 hours of your last message to the bot. Outside it, alerts are HELD and delivered when you next message the bot. Send any message (e.g. `ALERTS`) once a day. The proper fix is an approved Meta utility template (needs business verification).
- Commands (admin number only): `ALERTS` = last 10 alerts; `TEST ALERT` = proves delivery.
- Variables: `ADMIN_PHONE` (digits, e.g. 2348107136951). `INTERNAL_ALERT_KEY` (same value on Railway and Vercel) lets the website report advisor failures to the bot (`BOT_URL` on Vercel).

## Health and uptime
- `/healthz` = liveness only (Railway restarts the bot if it stops answering; it deliberately does not touch the database).
- `/healthz/deep` = Redis + database + video backlog; 503 if anything is wrong. Used by `.github/workflows/uptime.yml` (every 10 min, emails you on failure). You can also point UptimeRobot / Better Stack at it.

## Backups
- Supabase Free has NO backups. Supabase Pro ($25/month) includes daily backups (7-day retention). Turn on: Dashboard → Project → Database → Backups. Point-in-time recovery is a paid add-on.
- Also test a restore once; an untested backup is a hope, not a backup.

## Legal pages
- `/privacy` and `/terms` are public. Set in Vercel: `NEXT_PUBLIC_LEGAL_NAME`, `NEXT_PUBLIC_LEGAL_RC`, `NEXT_PUBLIC_LEGAL_ADDRESS`, `NEXT_PUBLIC_PRIVACY_EMAIL`, `NEXT_PUBLIC_WHATSAPP_DISPLAY`. Unset values are not shown.
- Written to the NDPA 2023 and Meta's requirements, but NOT lawyer-reviewed: have a Nigerian lawyer read both before Meta Business Verification. They promise deletion within 30 days: `DELETE MY DATA` alerts the admin, who fulfils it by hand today.
- Not yet built: automatic retention (deleting old photos/videos on a schedule). The policy therefore says files are kept while the account is active.

## Website advisor time limit
- One hard 25 s budget across three models (primary, fallback, `gemini-2.5-flash`); the browser also stops waiting after 32 s. Answers cut short say so.
