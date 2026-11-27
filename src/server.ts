import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { db, isInServiceWindow, touchInbound } from './db/supabase.js';
import { inboundQueue } from './lib/queues.js';
import { extractMessages, verifyMetaSignature, reply, type WaWebhookBody } from './services/whatsapp.js';
import { handlePaystackEvent, paymentsLive, verifyPaystackSignature, type CreditOutcome, type PaymentOutcome } from './services/paystack.js';
import { ngn } from './lib/money.js';
import { PLANS } from './config/plans.js';
import { startMessageWorkers } from './workers/messageWorker.js';
import { startVideoWorker } from './workers/videoWorker.js';
import { registerSchedules, startCronWorker } from './jobs/cronJobs.js';
import { alertAdmin, noteGeminiError } from './lib/alerts.js';
import { timingSafeEqual } from 'node:crypto';
import { videoQueue } from './lib/queues.js';

const app = Fastify({
  logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug', redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]'] },
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: true,
});

// Signature checks need the EXACT bytes Meta/Paystack signed → keep the raw buffer, parse JSON ourselves.
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
  try {
    const raw = body as Buffer;
    (_req as unknown as { rawBody: Buffer }).rawBody = raw;
    done(null, raw.length ? JSON.parse(raw.toString('utf8')) : {});
  } catch (e) {
    done(e as Error, undefined);
  }
});
const rawOf = (req: unknown) => (req as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);

await app.register(rateLimit, { global: false });

// Liveness only (Railway restarts the container if this stops answering). Deliberately does NOT touch the database:
// a database outage can't be fixed by restarting the bot, and restart loops would only make it worse.
app.get('/healthz', async () => ({ ok: true }));

const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Deep check for the uptime monitor: can we reach Redis and the database, and are videos piling up or failing?
app.get('/healthz/deep', async (_req, res) => {
  const checks: Record<string, string | number> = {};
  let ok = true;
  try { await within(videoQueue.getJobCounts('waiting'), 3000); checks.redis = 'ok'; } catch (e) { ok = false; checks.redis = `FAIL ${String((e as Error).message).slice(0, 60)}`; }
  try { const { error } = await within(Promise.resolve(db.from('businesses').select('id', { head: true, count: 'exact' }).limit(1)), 3000); if (error) throw new Error(error.message); checks.database = 'ok'; } catch (e) { ok = false; checks.database = `FAIL ${String((e as Error).message).slice(0, 60)}`; }
  try { const c = await within(videoQueue.getJobCounts('waiting', 'active', 'failed'), 3000); checks.videosWaiting = c.waiting ?? 0; checks.videosFailed7d = c.failed ?? 0; if ((c.waiting ?? 0) > 20) { ok = false; checks.videoQueue = 'BACKLOG'; } } catch { /* redis check already reports it */ }
  return res.code(ok ? 200 : 503).send({ ok, uptimeS: Math.round(process.uptime()), checks });
});

// The website reports its own failures here (e.g. the advisor could not reach Gemini) so they reach the owner's WhatsApp too.
app.post('/internal/alert', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, res) => {
  const key = String(req.headers['x-internal-key'] ?? '');
  const want = env.INTERNAL_ALERT_KEY ?? '';
  if (!want || key.length !== want.length || !timingSafeEqual(Buffer.from(key), Buffer.from(want))) return res.code(401).send('no');
  const { source = 'website', message = '' } = (req.body ?? {}) as { source?: string; message?: string };
  const m = String(message).slice(0, 400);
  if (/gemini|generativelanguage|prepayment|RESOURCE_EXHAUSTED|UNAVAILABLE|\b(401|402|403|429|500|503)\b/i.test(m)) await noteGeminiError(String(source).slice(0, 30), new Error(m));
  else await alertAdmin('system', `Website problem (${String(source).slice(0, 30)})`, m, { key: m.slice(0, 50), cooldownS: 900 });
  return res.code(200).send('ok');
});

// Any unexpected server error (not the client's fault) reaches the owner.
app.setErrorHandler((error, req, res) => {
  const err = error as Error & { statusCode?: number };
  const status = err.statusCode ?? 500;
  if (status >= 500) {
    req.log.error({ err }, 'unhandled request error');
    void alertAdmin('webhook', `Server error on ${req.method} ${(req.routeOptions?.url ?? req.url).split('?')[0]}`, err.message, { key: `${req.method}${req.routeOptions?.url}${err.message.slice(0, 40)}`, cooldownS: 600 });
  }
  return res.code(status).send({ error: status >= 500 ? 'internal' : err.message });
});

// ═════════════════════════ META WHATSAPP ═════════════════════════

app.get('/webhooks/whatsapp', async (req, res) => {
  const q = req.query as Record<string, string>;
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) return res.type('text/plain').send(q['hub.challenge'] ?? '');
  return res.code(403).send('forbidden');
});

app.post('/webhooks/whatsapp', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, res) => {
  if (!verifyMetaSignature(rawOf(req), req.headers['x-hub-signature-256'] as string | undefined)) return res.code(401).send('bad signature');

  // Respond 200 first — Meta retries (and eventually disables) slow webhooks. All work happens after this line.
  res.code(200).send('ok');

  const body = req.body as WaWebhookBody;
  try {
    for (const { msg, profileName } of extractMessages(body)) {
      await touchInbound(msg.from); // last_inbound_at = NOW() → free 24h window
      await inboundQueue.add('msg', { msg, profileName }, {
        jobId: `wa-${msg.id}`, // BullMQ-level dedupe of Meta retries (BullMQ forbids ":" in custom job ids)
        // Images may land out of order by ms; everything else is serialised per user in the worker.
      });
    }
  } catch (err) {
    req.log.error({ err }, 'webhook enqueue failed');
    void alertAdmin('webhook', 'WhatsApp webhook could not queue an incoming message (it may be LOST)', String((err as Error)?.message ?? err), { key: 'enqueue', cooldownS: 300 });
  }
});

// ═════════════════════════ PAYSTACK ═════════════════════════

app.post('/webhooks/paystack', async (req, res) => {
  if (!paymentsLive()) return res.code(503).send('payments not configured'); // Paystack will simply retry once the key is set
  if (!verifyPaystackSignature(rawOf(req), req.headers['x-paystack-signature'] as string | undefined)) return res.code(401).send('bad signature');
  try {
    const outcome = await handlePaystackEvent(req.body as Parameters<typeof handlePaystackEvent>[0]);
    res.code(200).send('ok');
    if (!outcome) return;

    const credit = outcome as CreditOutcome;
    if (credit.kind === 'video_credits') {
      await reply(credit.business.owner_phone).text(
        `🎉 *Payment received: ${credit.qty} video credit${credit.qty > 1 ? 's' : ''} added!*`,
        `You now have *${credit.balance}*. Send 2–3 product photos with the name and price and I'll make it.`,
      ).send().catch(() => undefined);
      return;
    }

    const { business: b, tier, interval, referrerId, referralCredited } = outcome as PaymentOutcome;
    const label = tier === 'growth_15k' ? 'Growth' : 'Starter';
    // Payer just interacted (they were on the checkout link) — but the window may be stale; failure is non-fatal.
    await reply(b.owner_phone).text(
      `🎉 *Payment received — you're on ${label}${interval === 'annual' ? ' (yearly)' : ''}!*`,
      tier === 'growth_15k' ? '50 videos · unlimited logging · 10 staff numbers · Google Sheets sync' : `${PLANS.starter_5k.videos_used_this_month} videos · 250 logged messages · 150 alert checks · voice notes · Sunday CEO report`,
      referralCredited ? `🎁 ₦1,000 referral reward added to your wallet (${ngn(b.referral_wallet_ngn)}).` : '',
      '', 'Send a voice note or photos to get going.',
    ).send().catch(() => undefined);

    if (referralCredited && referrerId) {
      const { data: ref } = await db.from('businesses').select('owner_phone, referral_wallet_ngn').eq('id', referrerId).single();
      // Free only inside their 24h window; otherwise they see the balance via REFER / next summary.
      if (ref && (await isInServiceWindow(ref.owner_phone as string))) {
        await reply(ref.owner_phone as string)
          .text(`🎁 *${b.name}* subscribed with your code — ₦1,000 added to your wallet! Balance: ${ngn(Number(ref.referral_wallet_ngn))}`)
          .send().catch(() => undefined);
      }
    }
  } catch (err) {
    req.log.error({ err }, 'paystack webhook failed');
    void alertAdmin('webhook', 'Paystack webhook failed (a payment may not have been applied)', String((err as Error)?.message ?? err), { key: 'paystack', cooldownS: 300 });
    // 5xx → Paystack retries; our billing_events idempotency makes replays safe.
    return res.code(500).send('error');
  }
});

// ═════════════════════════ BOOT ═════════════════════════

if (!paymentsLive()) app.log.warn('PAYSTACK_SECRET_KEY not set (or placeholder): the bot runs, but paid plans show "payments opening soon".');

const role = env.PROCESS_ROLE;
const closers: (() => Promise<unknown>)[] = [];

if (role === 'all' || role === 'workers') {
  for (const w of startMessageWorkers()) closers.push(() => w.close());
  const v = startVideoWorker();
  closers.push(() => v.close());
}
if (role === 'all' || role === 'cron') {
  await registerSchedules();
  const c = startCronWorker();
  closers.push(() => c.close());
}
if (role === 'all' || role === 'api') {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  closers.push(() => app.close());
}

const shutdown = async (sig: string) => {
  app.log.info(`${sig}: draining`);
  await Promise.allSettled(closers.map((c) => c()));
  process.exit(0);
};
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  void alertAdmin('system', 'Unhandled promise rejection', String((reason as Error)?.message ?? reason), { key: String((reason as Error)?.message ?? reason).slice(0, 60), cooldownS: 900 });
});
process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);
  await Promise.race([alertAdmin('system', 'The bot crashed (uncaught exception) and is restarting', err.message, { key: err.message.slice(0, 60), cooldownS: 300 }), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(1);
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
