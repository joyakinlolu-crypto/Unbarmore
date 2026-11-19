import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { db, isInServiceWindow, touchInbound } from './db/supabase.js';
import { inboundQueue } from './lib/queues.js';
import { extractMessages, verifyMetaSignature, reply, type WaWebhookBody } from './services/whatsapp.js';
import { handlePaystackEvent, verifyPaystackSignature } from './services/paystack.js';
import { ngn } from './lib/money.js';
import { startMessageWorkers } from './workers/messageWorker.js';
import { startVideoWorker } from './workers/videoWorker.js';
import { registerSchedules, startCronWorker } from './jobs/cronJobs.js';

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

app.get('/healthz', async () => ({ ok: true }));

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
        jobId: `wa:${msg.id}`, // BullMQ-level dedupe of Meta retries
        // Images may land out of order by ms; everything else is serialised per user in the worker.
      });
    }
  } catch (err) {
    req.log.error({ err }, 'webhook enqueue failed');
  }
});

// ═════════════════════════ PAYSTACK ═════════════════════════

app.post('/webhooks/paystack', async (req, res) => {
  if (!verifyPaystackSignature(rawOf(req), req.headers['x-paystack-signature'] as string | undefined)) return res.code(401).send('bad signature');
  try {
    const outcome = await handlePaystackEvent(req.body as Parameters<typeof handlePaystackEvent>[0]);
    res.code(200).send('ok');
    if (!outcome) return;

    const { business: b, tier, interval, referrerId, referralCredited } = outcome;
    const label = tier === 'growth_15k' ? 'Growth' : 'Starter';
    // Payer just interacted (they were on the checkout link) — but the window may be stale; failure is non-fatal.
    await reply(b.owner_phone).text(
      `🎉 *Payment received — you're on ${label}${interval === 'annual' ? ' (yearly)' : ''}!*`,
      tier === 'growth_15k' ? '50 videos · unlimited records · 10 staff numbers · Google Sheets sync' : '15 videos · 250 records · 150 alert checks · voice notes · Sunday CEO report',
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
    // 5xx → Paystack retries; our billing_events idempotency makes replays safe.
    return res.code(500).send('error');
  }
});

// ═════════════════════════ BOOT ═════════════════════════

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
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
