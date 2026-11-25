/**
 * FULL AUTOMATIC conversation test. No phone, no Meta dashboard, no tunnel needed.
 *
 *   set -a; . ./.env; set +a; NODE_USE_ENV_PROXY=1 npx tsx scripts/live-whatsapp-flow.mts
 *
 * What is REAL: the bot (webhook → BullMQ/Redis → workers), Supabase, Gemini (router, scripts, OCR-free), the video renderer, PDFs, Storage.
 * What is PRETEND: Meta itself. A tiny local server plays Meta's Graph API, so we can capture every reply the bot would send
 * (text, buttons, PDF, video) and check it. Webhooks are signed with the real app secret, exactly like Meta signs them.
 */
import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';
import { GoogleGenAI } from '@google/genai';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k} (run: set -a; . ./.env; set +a)`); return v; };
const SB = need('SUPABASE_URL'), SBKEY = need('SUPABASE_SERVICE_ROLE_KEY'), SECRET = need('WHATSAPP_APP_SECRET'), VERIFY = need('WHATSAPP_VERIFY_TOKEN');
const PHONE_ID = need('WHATSAPP_PHONE_NUMBER_ID'), GKEY = need('GEMINI_API_KEY');
const FAKE_PORT = 4010, BOT_PORT = 3050, PH = '2349000000401', PH2 = '2349000000402', BOT = `http://127.0.0.1:${BOT_PORT}`;

let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + String(extra).replace(/\s+/g, ' ').slice(0, 170) : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rest = (p: string, init: RequestInit = {}) => fetch(`${SB}/rest/v1/${p}`, { ...init, headers: { apikey: SBKEY, Authorization: `Bearer ${SBKEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
const rows = async (p: string) => (await (await rest(p)).json()) as Record<string, any>[];

// ───────────────────────── pretend Meta ─────────────────────────
interface Sent { to: string; payload: any }
const sent: Sent[] = [];
const media = new Map<string, { data: Buffer; mime: string }>();
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString();
  const json = (o: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
    const p = JSON.parse(body);
    if (p.status === 'read') return json({ success: true });           // typing indicator, not a billable message
    sent.push({ to: p.to, payload: p });
    return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.FAKE${sent.length}` }] });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
    const m = media.get(url.pathname.split('/').pop()!);
    if (!m) return json({ error: 'nope' }, 404);
    res.writeHead(200, { 'content-type': m.mime }); return res.end(m.data);
  }
  if (req.method === 'GET') {
    const id = url.pathname.split('/').pop()!, m = media.get(id);
    return m ? json({ url: `http://127.0.0.1:${FAKE_PORT}/media/${id}`, mime_type: m.mime, file_size: m.data.length }) : json({ error: 'not found' }, 404);
  }
  json({ error: 'unhandled' }, 404);
});
await new Promise<void>((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

// what did the bot send? (flattened view of a WhatsApp payload)
const view = (s: Sent) => {
  const p = s.payload;
  if (p.type === 'text') return { kind: 'text', text: p.text.body as string, buttons: [] as { id: string; title: string }[], header: null as null | { type: string; link: string }, rows: [] as string[] };
  if (p.type === 'interactive') {
    const i = p.interactive;
    return {
      kind: 'interactive', text: (i.body?.text ?? '') as string,
      buttons: (i.action?.buttons ?? []).map((b: any) => b.reply) as { id: string; title: string }[],
      header: i.header ? { type: i.header.type as string, link: (i.header.document?.link ?? i.header[i.header.type]?.link) as string } : null,
      rows: (i.action?.sections ?? []).flatMap((x: any) => x.rows.map((r: any) => r.id)) as string[],
    };
  }
  if (p.type === 'video') return { kind: 'video', text: (p.video.caption ?? '') as string, buttons: [], header: { type: 'video', link: p.video.link as string }, rows: [] };
  if (p.type === 'document') return { kind: 'document', text: (p.document.caption ?? '') as string, buttons: [], header: { type: 'document', link: p.document.link as string }, rows: [] };
  return { kind: p.type as string, text: JSON.stringify(p), buttons: [], header: null, rows: [] };
};
/** the lone "⏳ Processing your entry..." note is not a reply; with INTERIM_NOTICE_MS=1000 in this test it can appear on any slow step */
const real = (vs: ReturnType<typeof view>[]) => vs.filter((v) => !/Processing your entry\.\.\./.test(v.text));
const APOLOGY = /couldn.t process that|couldn.t read those photos/i;

// ───────────────────────── the real bot ─────────────────────────
const logFile = path.join(os.tmpdir(), `bot-${Date.now()}.log`);
const bot: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true, // own process group, so the whole tree (npx → tsx → node) can be stopped; a stale bot on the test port serves old code
  env: { ...process.env, PROCESS_ROLE: 'all', PORT: String(BOT_PORT), WHATSAPP_GRAPH_BASE: `http://127.0.0.1:${FAKE_PORT}`, WEB_APP_URL: 'http://localhost:3333', NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1', ADMIN_PHONE: PH, SUPPORT_WHATSAPP_URL: 'https://wa.me/2348100000002', INTERIM_NOTICE_MS: '1000' },
  stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
});

let n = 0;
const sign = (body: string) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const envelope = (msg: Record<string, unknown>, from = PH) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, contacts: [{ profile: { name: 'Ada Tester' }, wa_id: from }], messages: [msg] } }] }],
});
async function webhook(msg: Record<string, unknown>, id?: string, from = PH) {
  const body = envelope({ from, id: id ?? `wamid.FLOW${Date.now()}${++n}`, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }, from);
  const r = await fetch(`${BOT}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
  return r.status;
}
const text = (t: string, id?: string) => webhook({ type: 'text', text: { body: t } }, id);
const button = (id: string) => webhook({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'tap' } } });

/** Send something, wait for the bot's reply (retrying once if Gemini was too busy and the bot apologised). */
async function ask(label: string, send: () => Promise<number>, until: (v: ReturnType<typeof view>) => boolean, timeoutMs = 90_000) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const from = sent.length;
    const status = await send();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const fresh = sent.slice(from).map(view);
      const hit = fresh.find(until);
      if (hit) return { reply: hit, all: fresh, status };
      if (fresh.some((v) => APOLOGY.test(v.text))) { console.log(`   ⚠️  ${label}: bot apologised (Gemini busy) — retrying`); break; }
      await sleep(400);
    }
  }
  return { reply: null, all: [] as ReturnType<typeof view>[], status: 0 };
}

// ───────────────────────── cleanup ─────────────────────────
async function cleanup() {
  for (const phone of [PH, PH2]) {
    const bs = await rows(`businesses?owner_phone=eq.${phone}&select=id`);
    for (const b of bs) for (const bucket of ['raw-images', 'cleaned-images', 'videos', 'pdf-receipts']) {
      const l = await fetch(`${SB}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { apikey: SBKEY, Authorization: `Bearer ${SBKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: b.id, limit: 100 }) });
      const files = (await l.json().catch(() => [])) as { name: string }[];
      if (Array.isArray(files) && files.length) await fetch(`${SB}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { apikey: SBKEY, Authorization: `Bearer ${SBKEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: files.map((f) => `${b.id}/${f.name}`) }) });
    }
    for (const b of bs) await rest(`payout_requests?business_id=eq.${b.id}`, { method: 'DELETE' });
    await rest(`businesses?owner_phone=eq.${phone}`, { method: 'DELETE' });
    await rest(`whatsapp_sessions?phone_number=eq.${phone}`, { method: 'DELETE' });
  }
  await rest(`processed_messages?wa_message_id=like.wamid.FLOW*`, { method: 'DELETE' });
}

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));

try {
  await cleanup();
  await redis.flushall();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BOT}/healthz`)).ok) break; } catch { /* booting */ } await sleep(1000); }
  ok('bot booted (webhook server + queues + workers + schedules)', (await fetch(`${BOT}/healthz`).then((r) => r.json()).catch(() => null))?.ok === true);

  // ───── 0. Meta's side of the handshake + webhook security ─────
  ok('Meta verification handshake returns the challenge', (await (await fetch(`${BOT}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=CHAL42`)).text()) === 'CHAL42');
  ok('wrong verify token is refused (403)', (await fetch(`${BOT}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`)).status === 403);
  ok('unsigned webhook is refused (401)', (await fetch(`${BOT}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: envelope({ from: PH, id: 'x', type: 'text', text: { body: 'hi' } }) })).status === 401);
  const tampered = envelope({ from: PH, id: 'y', type: 'text', text: { body: 'hi' } });
  ok('tampered webhook is refused (401)', (await fetch(`${BOT}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(tampered.replace('hi', 'HACKED')) }, body: tampered })).status === 401);

  // ───── 1–3. onboarding ─────
  let r = await ask('hi', () => text('Hi'), (v) => /business name/i.test(v.text));
  ok('"Hi" → welcome + asks for the business name', !!r.reply, r.reply?.text.split('\n').slice(0, 2).join(' | '));
  ok('webhook answered Meta instantly (200)', r.status === 200);
  ok('no business is created until a name is given', (await rows(`businesses?owner_phone=eq.${PH}&select=id`)).length === 0);

  r = await ask('name', () => text('Ada Fabrics'), (v) => /Ada Fabrics/.test(v.text) && v.buttons.some((b) => b.id === 'ONB_SKIP'));
  ok('business name → "set up" + a Skip button for the referral code', !!r.reply);
  const biz = (await rows(`businesses?owner_phone=eq.${PH}&select=id,name,subscription_tier,referral_code,tx_logged_this_month,trial_ends_at`))[0];
  ok('business created on the trial with a UNBAR-XXXX code', biz?.name === 'Ada Fabrics' && biz?.subscription_tier === 'trial' && /^UNBAR-/.test(biz?.referral_code), biz?.referral_code);
  const trialDays = (new Date(biz?.trial_ends_at).getTime() - Date.now()) / 864e5;
  ok('the trial runs 14 days (not the old 7)', trialDays > 13.9 && trialDays <= 14.01, `${trialDays.toFixed(2)} days left`);

  r = await ask('skip', () => button('ONB_SKIP'), (v) => /You.re in/i.test(v.text));
  ok('tap Skip → welcome with examples and the referral code', !!r.reply && /UNBAR-/.test(r.reply.text));
  const welcomeText = r.reply?.text ?? '';
  ok('welcome gives 3 clear first steps (tell me a sale · tell me who owes you · make a receipt), mentions photos/screenshots and "ask me anything", and says how to see progress (START)', /Start with these 3 steps/.test(welcomeText) && /Tell me a sale/.test(welcomeText) && /who owes you/i.test(welcomeText) && /receipt/i.test(welcomeText) && /photos/.test(welcomeText) && /screenshot/.test(welcomeText) && /ask me anything about your business/i.test(welcomeText) && /START/.test(welcomeText) && /7 AM/.test(welcomeText) && /9 PM/.test(welcomeText) && /REMINDERS OFF/.test(welcomeText), welcomeText.replace(/\n/g, ' | ').slice(0, 200));
  ok('welcome carries a one-tap dashboard link + the "evening alert" instruction', /auth\/verify\?token=[a-f0-9]{64}/.test(welcomeText) && /Turn on my evening alert/.test(welcomeText) && /Home Screen/.test(welcomeText));
  ok('that was ONE welcome message', real(r.all).length === 1, `${real(r.all).length} message(s)`);

  // ───── 4–7. ledger: propose → confirm → debts → undo ─────
  r = await ask('sale', () => text('sold 2 lace 50k, paid 30k transfer, balance 20k Mama Tunde. bought fuel 5k'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const confirmId = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id ?? '';
  ok('sale message → summary with ✅ Confirm / ✏️ Edit (nothing saved silently)', !!r.reply && r.reply.buttons.some((b) => b.id.startsWith('TXE:')), r.reply?.text.replace(/\n/g, ' | '));
  ok('summary shows the debt: Mama Tunde owes ₦20k, and the ₦5k fuel', /Mama Tunde/.test(r.reply?.text ?? '') && /20k|20,000/.test(r.reply?.text ?? '') && /5,000/.test(r.reply?.text ?? ''));
  ok('quota not charged at proposal time', Number((await rows(`businesses?id=eq.${biz!.id}&select=tx_logged_this_month`))[0]?.tx_logged_this_month) === 0);

  r = await ask('confirm', () => button(confirmId), (v) => /Saved/.test(v.text) && v.buttons.some((b) => b.id.startsWith('RCPT:')));
  ok('Confirm → ONE light message: saved + today\'s profit + [🧾 Customer Receipt] + Undo (no PDF forced on every sale)', !!r.reply && /Profit|Cash left/.test(r.reply.text) && r.reply.header === null && r.reply.buttons.some((b) => b.id.startsWith('TXU:')) && r.reply.buttons.some((b) => /Customer Receipt/.test(b.title)), r.reply?.text.replace(/\n/g, ' | '));
  ok('that was exactly one outbound message for the action', real(r.all).length === 1, `${real(r.all).length} message(s)`);
  ok('PDF quota untouched until a receipt is actually requested', Number((await rows(`businesses?id=eq.${biz!.id}&select=pdf_receipts_used_this_month`))[0]?.pdf_receipts_used_this_month) === 0);
  const rcptId = r.reply?.buttons.find((b) => b.id.startsWith('RCPT:'))?.id ?? '';
  ok('selling an item with no cost price → asks ONCE what it costs ("What does Lace cost you? Say lace costs me 15k…") so profit can be real', /What does \*?Lace\*? cost you\?/i.test(r.reply?.text ?? '') && /costs me 15k/.test(r.reply?.text ?? ''), (r.reply?.text ?? '').replace(/\n/g, ' | ').slice(-200));
  ok('first confirmed entry also cheers and points to the next step ("🎉 First entry saved! Next: tell me who owes you")', /First entry saved/.test(r.reply?.text ?? ''));
  const lq = await ask('receipt-logo-q', () => button(rcptId), (v) => /Do you have a logo/.test(v.text));
  ok('the FIRST receipt asks once: "Do you have a logo?" with [Send my logo] / [Use my name], and makes no PDF yet', !!lq.reply && lq.reply.kind !== 'document' && lq.reply.buttons.map((b) => b.id.split(':').slice(0, 2).join(':')).join() === 'LOGO:ask,LOGO:name', lq.reply?.text.replace(/\n/g, ' | '));
  const nameBtn = lq.reply?.buttons.find((b) => b.id.startsWith('LOGO:name:'))?.id ?? '';
  const rc = await ask('receipt-button', () => button(nameBtn), (v) => v.kind === 'document');
  const cap = rc.reply?.text ?? '';
  ok('tap 🧾 Customer Receipt → ONE document message with a forward-ready caption', !!rc.reply && real(rc.all).length === 1, cap.replace(/\n/g, ' | '));
  ok('receipt shows business, customer, item, paid ₦30,000, remaining debt ₦20,000 and a date', /Ada Fabrics/.test(cap) && /Mama Tunde/.test(cap) && /Lace/.test(cap) && /Paid: ₦30,000/.test(cap) && /Balance remaining: ₦20,000/.test(cap) && /20\d\d/.test(cap));
  if (rc.reply?.header?.link) {
    const pdf = Buffer.from(await (await fetch(rc.reply.header.link)).arrayBuffer());
    ok('the receipt link downloads a real PDF', pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 3000, `${pdf.length} bytes`);
  }
  const rc2 = await ask('RECEIPT', () => text('RECEIPT'), (v) => v.kind === 'document');
  ok('typing RECEIPT resends the last receipt', !!rc2.reply && /Balance remaining: ₦20,000/.test(rc2.reply.text));
  const rc3 = await ask('RECEIPT name', () => text('RECEIPT Mama'), (v) => v.kind === 'document');
  ok('RECEIPT Mama → receipt for that customer', !!rc3.reply && /Mama Tunde/.test(rc3.reply.text));
  const rc4 = await ask('RECEIPT nobody', () => text('RECEIPT Zzyzx'), (v) => /can.t find/i.test(v.text), 30_000);
  ok('RECEIPT for an unknown customer → polite "can\'t find"', !!rc4.reply);
  ok('receipt regenerated 3× but counted ONCE against the PDF quota', Number((await rows(`businesses?id=eq.${biz!.id}&select=pdf_receipts_used_this_month`))[0]?.pdf_receipts_used_this_month) === 1);
  ok('quota: 2 lines in 1 message = 1 unit', Number((await rows(`businesses?id=eq.${biz!.id}&select=tx_logged_this_month`))[0]?.tx_logged_this_month) === 1);
  const dbl = await ask('double-confirm', () => button(confirmId), (v) => /Already saved/.test(v.text), 40_000);
  ok('tapping Confirm twice does not duplicate or re-charge', !!dbl.reply && Number((await rows(`businesses?id=eq.${biz!.id}&select=tx_logged_this_month`))[0]?.tx_logged_this_month) === 1);

  r = await ask('debtors', () => text('who dey owe me'), (v) => /Mama Tunde/.test(v.text) && /20,000/.test(v.text));
  ok('"who dey owe me" (Pidgin) → Mama Tunde ₦20,000, figure from the database', !!r.reply, r.reply?.text.replace(/\n/g, ' | '));

  r = await ask('undo', () => text('UNDO'), (v) => /Reversed/.test(v.text));
  ok('UNDO within 5 min reverses it', !!r.reply);
  ok('…debt is back to ₦0 and the message unit is refunded', Number((await rows(`customers?business_id=eq.${biz!.id}&select=outstanding_debt_ngn`))[0]?.outstanding_debt_ngn) === 0 && Number((await rows(`businesses?id=eq.${biz!.id}&select=tx_logged_this_month`))[0]?.tx_logged_this_month) === 0);

  // ───── 8–11. menus, links, guardrails, sales help ─────
  r = await ask('plans', () => text('PLANS'), (v) => v.rows.length > 0);
  ok('PLANS → menu pitches "speak a full day\'s sales & expenses in one voice note"', !!r.reply && /one voice note/i.test(r.reply.text) && r.reply.rows.includes('PAY:starter_5k:monthly'));

  r = await ask('starter', () => text('STARTER'), (v) => /switched on|opens very soon/i.test(v.text));
  ok('payments not live (placeholder Paystack key) → friendly "opens soon" + support link, no crash', !!r.reply && /wa\.me\/2348100000002/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));

  r = await ask('support', () => text('SUPPORT'), (v) => /Quick help/i.test(v.text));
  ok('SUPPORT → the 5 core commands + the support link', !!r.reply && ['VOICE NOTE', 'WHO DEY OWE ME', 'CLOSE', 'RECEIPT', 'LOGIN'].every((c) => r.reply!.text.includes(c)) && /wa\.me\/2348100000002/.test(r.reply.text));

  r = await ask('who-dey-owe-me', () => text('WHO DEY OWE ME'), (v) => /Nobody owes|owing you/i.test(v.text), 30_000);
  ok('"WHO DEY OWE ME" works as an instant command (no AI needed)', !!r.reply, r.reply?.text.replace(/\n/g, ' | '));

  r = await ask('dashboard', () => text('DASHBOARD'), (v) => /auth\/verify\?token=/.test(v.text));
  ok('DASHBOARD → a one-time login link (64-hex token)', !!r.reply && /token=[a-f0-9]{64}/.test(r.reply.text));

  r = await ask('offtopic', () => text('Write me a 500 word essay on Nigerian politics'), (v) => /only help|can only|cannot assist|sales, video/i.test(v.text));
  ok('off-topic request is politely declined (Meta policy)', !!r.reply, r.reply?.text);

  // ───── beyond bookkeeping: a pocket business advisor ─────
  r = await ask('advice', () => text('how do i price my ankara gowns so i actually make profit and not just sell cheap?'), (v) => /\/advisor/.test(v.text) || v.text.length > 120, 60_000);
  const adv = r.reply?.text ?? '';
  ok('a real business question gets a practical answer (not the off-topic refusal) with a link to the full advisor', adv.length > 100 && !/only help with|I only/i.test(adv.split('\n')[0] ?? '') && /localhost:3333\/advisor/.test(adv), adv.replace(/\n/g, ' | ').slice(0, 260));
  ok('…and it records nothing in the books', Number((await rows(`transactions?business_id=eq.${biz!.id}&select=id&tx_type=eq.expense&description=ilike.*price*`)).length) === 0);

  r = await ask('objection', () => text("customer say 'too cost, I go think about it'. the gown na 15k, wetin I fit reply?"), (v) => /Option 1/i.test(v.text) && /Option 2/i.test(v.text));
  ok('customer objection → 2 ready-to-send closing replies', !!r.reply);

  // ───── 12. voice note (audio made by Gemini TTS, transcribed by the bot's Gemini router) ─────
  try {
    // The app's own voice function (tries the backup speech model when the main one is out of quota).
    const { synthesizeVoiceover } = await import('../src/services/ttsService.ts');
    let wav: Buffer | null = null;
    for (let i = 0; i < 6 && !wav; i++) { // Google's free speech tier is rate-limited; wait it out
      try { wav = (await synthesizeVoiceover('I don sell three ankara for forty five thousand naira cash, and I buy transport three thousand naira.')).data; } catch { await sleep(10_000); }
    }
    if (!wav) throw new Error('could not synthesise test audio');
    media.set('VOICE1', { data: wav, mime: 'audio/wav' });
    r = await ask('voice', () => webhook({ type: 'audio', audio: { id: 'VOICE1', mime_type: 'audio/wav', voice: true } }), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
    ok('voice note (Pidgin) → transcribed, split into sale ₦45,000 + transport ₦3,000, with Confirm', !!r.reply && /45,000/.test(r.reply.text) && /3,000/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
    const vid = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id;
    if (vid) { await ask('voice-confirm', () => button(vid), (v) => /Saved/.test(v.text)); }
    ok('confirmed voice message counts as 1 logged message', Number((await rows(`businesses?id=eq.${biz!.id}&select=tx_logged_this_month`))[0]?.tx_logged_this_month) === 1);
  } catch (e) { ok('voice-note test', false, String(e)); }

  // ───── 12b. CLOSE: end-of-day reconcile ─────
  r = await ask('close', () => text('close shop'), (v) => /Expected cash in drawer/.test(v.text));
  const ct = r.reply?.text ?? '';
  ok('"close shop" → expected cash, bank transfers, total expenses and new credit', !!r.reply && /Expected bank transfers/.test(ct) && /Total expenses: ₦3,000/.test(ct) && /New credit given today: ₦0/.test(ct), ct.replace(/\n/g, ' | ').slice(0, 220));
  ok('CLOSE counts only today\'s confirmed sale (₦45,000); the undone one is excluded', /Sales today ₦45,000/.test(ct));

  // ───── 12c. low-stock warning on a sale ─────
  r = await ask('restock', () => text('bought 6 gele at 4k each cash'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const rid = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id;
  if (rid) await ask('restock-confirm', () => button(rid), (v) => /Saved/.test(v.text));
  r = await ask('sale-gele', () => text('sold 5 gele for 50k cash'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const sid = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id;
  r = sid ? await ask('sale-gele-confirm', () => button(sid), (v) => /Saved/.test(v.text)) : r;
  ok('selling down to 1 left → the confirmation carries a concise low-stock warning', /gele/i.test(r.reply?.text ?? '') && /only 1 left/.test(r.reply?.text ?? '') && /restock/i.test(r.reply?.text ?? ''), r.reply?.text.replace(/\n/g, ' | '));

  // ───── 12d. ADMIN: only the admin number ─────
  r = await ask('admin', () => text('ADMIN'), (v) => /live stats/i.test(v.text));
  ok('ADMIN from ADMIN_PHONE → live platform stats from the database', !!r.reply && /Businesses/.test(r.reply.text) && /Est\. MRR/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));
  const b3 = sent.length;
  await webhook({ type: 'text', text: { body: 'ADMIN' } }, undefined, PH2);
  const t3 = Date.now(); while (Date.now() - t3 < 30_000 && sent.length === b3) await sleep(300);
  const other = sent.slice(b3).map(view);
  ok('ADMIN from any other number gets NOTHING (treated as an ordinary first message)', other.length >= 1 && !other.some((v) => /live stats|Est\. MRR|Businesses:/.test(v.text)), other[0]?.text.slice(0, 80));

  // ───── 12e. referral wallet: ₦1,000 renewal discount, ₦5,000 cash payout (needs migration 003 on the database) ─────
  const payoutsReady = Array.isArray(await (await rest('payout_requests?select=ref&limit=1')).json());
  if (!payoutsReady) console.log('⏭️  payout tests skipped: run supabase/migrations/003_referral_payouts.sql in Supabase, then re-run');
  else {
    const setWallet = (v: number) => rest(`businesses?id=eq.${biz!.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ referral_wallet_ngn: v }) });
    const wallet = async () => Number((await rows(`businesses?id=eq.${biz!.id}&select=referral_wallet_ngn`))[0]?.referral_wallet_ngn);
    const state = async () => String((await rows(`whatsapp_sessions?phone_number=eq.${PH}&select=current_state`))[0]?.current_state);

    await setWallet(3000);
    r = await ask('withdraw-locked', () => text('WITHDRAW'), (v) => /unlocks at/i.test(v.text));
    ok('WITHDRAW with ₦3,000 → "unlocks at ₦5,000 (5 referrals) — 2 more", renewal discount mentioned, nothing started', !!r.reply && /₦5,000/.test(r.reply.text) && /2 more referrals/.test(r.reply.text) && /renewal/.test(r.reply.text) && (await state()) === 'IDLE', r.reply?.text.replace(/\n/g, ' | '));
    r = await ask('refer-locked', () => text('REFER'), (v) => /Wallet/i.test(v.text));
    ok('REFER at ₦3,000 explains the rules and shows NO withdraw button', !!r.reply && /₦1,000/.test(r.reply.text) && /WITHDRAW/.test(r.reply.text) && !r.reply.buttons.some((b) => b.id === 'WITHDRAW'));

    await setWallet(5000);
    r = await ask('refer-unlocked', () => text('REFER'), (v) => v.buttons.some((b) => b.id === 'WITHDRAW'));
    ok('REFER at ₦5,000 → "💸 Withdraw cash" button appears', !!r.reply);
    r = await ask('withdraw-tap', () => button('WITHDRAW'), (v) => /bank name/i.test(v.text));
    ok('tap Withdraw → asks for Bank Name + 10-digit account number', !!r.reply && /10-digit/.test(r.reply.text) && (await state()) === 'AWAITING_PAYOUT_DETAILS');

    r = await ask('bad1', () => text('ok'), (v) => /10-digit/.test(v.text));
    ok('junk like "ok" is NOT accepted as bank details (wallet untouched)', !!r.reply && (await wallet()) === 5000 && (await state()) === 'AWAITING_PAYOUT_DETAILS');
    r = await ask('bad2', () => text('GTBank 08012345678'), (v) => /10-digit/.test(v.text));
    ok('an 11-digit phone number is refused as an account number', !!r.reply && (await wallet()) === 5000);

    const sent0 = sent.length;
    r = await ask('payout', () => text('GTBank 0123456789'), (v) => /Payout requested/.test(v.text));
    const ref = r.reply?.text.match(/WD-[0-9A-F]{6}/)?.[0] ?? '';
    ok('valid details → "Payout requested", pending, reference WD-XXXXXX, account masked', !!r.reply && !!ref && /pending/i.test(r.reply.text) && /\*\*\*\*6789/.test(r.reply.text) && !/0123456789/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
    const pr = (await rows(`payout_requests?business_id=eq.${biz!.id}&select=status,bank_name,account_number,amount_ngn,ref`))[0];
    const led = (await rows(`referral_ledger?business_id=eq.${biz!.id}&entry_type=eq.cash_payout&select=status,amount_ngn,notes`))[0];
    ok('database: wallet is ₦0, referral_ledger row is PENDING (−₦5,000), payout row holds bank + NUBAN', (await wallet()) === 0 && led?.status === 'pending' && Number(led?.amount_ngn) === -5000 && pr?.status === 'requested' && pr?.bank_name === 'GTBank' && pr?.account_number === '0123456789' && pr?.ref === ref);
    await sleep(2500);
    const adminMsg = sent.slice(sent0).map(view).find((v) => /Payout request WD-/.test(v.text));
    ok('ADMIN_PHONE is notified on WhatsApp with full bank details and the PAID / REJECT commands', !!adminMsg && /0123456789/.test(adminMsg.text) && new RegExp(`PAID ${ref}`).test(adminMsg.text) && new RegExp(`REJECT ${ref}`).test(adminMsg.text), adminMsg?.text.replace(/\n/g, ' | ').slice(0, 160));
    ok('conversation state is cleared after the request', (await state()) === 'IDLE');

    await setWallet(9000); // even if the wallet refills, a pending payout blocks another one
    r = await ask('double', () => text('WITHDRAW'), (v) => /already have a payout/i.test(v.text));
    ok('DOUBLE WITHDRAWAL blocked: wallet refilled to ₦9,000 but a payout is still pending → refused', !!r.reply && (await wallet()) === 9000 && (await rows(`payout_requests?business_id=eq.${biz!.id}&select=id`)).length === 1);

    r = await ask('payouts-list', () => text('PAYOUTS'), (v) => /pending/i.test(v.text) && v.text.includes(ref));
    ok('admin PAYOUTS lists the pending request', !!r.reply);
    const before = await rows(`payout_requests?ref=eq.${ref}&select=status`);
    const b4 = sent.length;
    await webhook({ type: 'text', text: { body: `PAID ${ref}` } }, undefined, PH2);
    await sleep(6000);
    ok('a NON-admin number cannot mark a payout paid', before[0]?.status === 'requested' && (await rows(`payout_requests?ref=eq.${ref}&select=status`))[0]?.status === 'requested' && !sent.slice(b4).map(view).some((v) => /marked \*paid\*/.test(v.text)));

    const bPaid = sent.length;
    r = await ask('paid', () => text(`PAID ${ref}`), (v) => /marked \*paid\*/.test(v.text));
    await sleep(2500);
    const notice = sent.slice(bPaid).map(view).find((v) => /payout has been sent/i.test(v.text));
    ok('admin "PAID WD-…" → recorded as paid, and the business is told (masked account)', !!r.reply && !!notice && /\*\*\*\*6789/.test(notice.text) && (await rows(`payout_requests?ref=eq.${ref}&select=status`))[0]?.status === 'paid' && (await rows(`referral_ledger?business_id=eq.${biz!.id}&entry_type=eq.cash_payout&select=status`))[0]?.status === 'completed');
    r = await ask('paid-again', () => text(`PAID ${ref}`), (v) => /already decided/i.test(v.text));
    ok('deciding the same payout twice is refused', !!r.reply);

    r = await ask('withdraw-again', () => text('WITHDRAW'), (v) => /bank name/i.test(v.text));
    ok('after PAID a new payout can be requested again', !!r.reply);
    r = await ask('payout2', () => text('Opay 8101234567'), (v) => /Payout requested/.test(v.text));
    const ref2 = r.reply?.text.match(/WD-[0-9A-F]{6}/)?.[0] ?? '';
    const bRej = sent.length;
    r = await ask('reject', () => text(`REJECT ${ref2}`), (v) => /rejected/i.test(v.text));
    await sleep(2500);
    ok('admin "REJECT WD-…" → ₦9,000 returns to the wallet and the business is told', !!r.reply && (await wallet()) === 9000 && sent.slice(bRej).map(view).some((v) => /back in your wallet/i.test(v.text)));

    r = await ask('withdraw-cancel', () => text('WITHDRAW'), (v) => /bank name/i.test(v.text));
    r = await ask('cancel', () => text('CANCEL'), (v) => /cancelled/i.test(v.text));
    ok('CANCEL stops it and leaves the wallet alone', !!r.reply && (await wallet()) === 9000 && (await state()) === 'IDLE');

    await ask('withdraw-stale', () => text('WITHDRAW'), (v) => /bank name/i.test(v.text));
    await rest(`whatsapp_sessions?phone_number=eq.${PH}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pending_payload: { at: Date.now() - 3600_000 } }) });
    r = await ask('stale', () => text('sold 2 lace 50k cash'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
    ok('a forgotten WITHDRAW (older than 10 min) does not swallow the next sale message', !!r.reply && (await wallet()) === 9000);
    const staleId = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id; if (staleId) await ask('stale-confirm', () => button(staleId), (v) => /Saved/.test(v.text));
  }

  // ───── 13. duplicate delivery from Meta (retries) must not double-reply ─────
  const dupId = `wamid.FLOWDUP${Date.now()}`;
  const before = sent.length;
  await text('MENU', dupId); await text('MENU', dupId);
  await sleep(6000);
  ok('Meta re-delivering the same message → only ONE reply', sent.length - before === 1, `${sent.length - before} reply(ies)`);

  // ───── 13b. two messages in the same instant must BOTH be answered (second waits its turn, is not dropped) ─────
  const b2 = sent.length;
  await Promise.all([text('PLANS'), text('REFER')]);
  const tb = Date.now();
  while (Date.now() - tb < 60_000 && sent.length - b2 < 2) await sleep(300);
  await sleep(2000);
  const both = sent.slice(b2).map(view);
  ok('two messages sent at the same instant → BOTH answered, none lost', both.length === 2 && both.some((v) => v.rows.length > 0) && both.some((v) => /Wallet/i.test(v.text)), `${both.length} replies`);

  // ───── 14. three photos at once → one reply (4-second debounce) → video ─────
  const colours = ['0x7A1F3D', '0x1F5C7A', '0x2E7A1F'];
  colours.forEach((c, i) => {
    const f = path.join(tmp, `p${i}.jpg`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0xC9B79C:s=900x1200`, '-vf', `drawbox=x=250:y=350:w=400:h=500:color=${c}:t=fill`, '-frames:v', '1', f]);
    media.set(`IMG${i + 1}`, { data: fs.readFileSync(f), mime: 'image/jpeg' });
  });
  const beforeImg = sent.length;
  for (let i = 1; i <= 3; i++) { await webhook({ type: 'image', image: { id: `IMG${i}`, mime_type: 'image/jpeg' } }); await sleep(250); }
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && sent.length === beforeImg) await sleep(300);
  await sleep(8000); // if a 2nd/3rd reply were coming, it would be here by now
  const imgReplies = sent.slice(beforeImg).map(view);
  ok('3 photos sent at once → exactly ONE reply (not three)', imgReplies.length === 1 && /3 photos/i.test(imgReplies[0]!.text) && /price/i.test(imgReplies[0]!.text), `${imgReplies.length} reply(ies): ${imgReplies[0]?.text.replace(/\n/g, ' | ').slice(0, 120)}`);

  // A slow album: two more photos arrive AFTER the first prompt. They must be ADDED (not replace the first 3) and answered once.
  media.set('IMG4', media.get('IMG1')!); media.set('IMG5', media.get('IMG2')!);
  const beforeLate = sent.length;
  for (let i = 4; i <= 5; i++) { await webhook({ type: 'image', image: { id: `IMG${i}`, mime_type: 'image/jpeg' } }); await sleep(250); }
  const tl = Date.now();
  while (Date.now() - tl < 60_000 && sent.length === beforeLate) await sleep(300);
  await sleep(9000);
  const lateReplies = sent.slice(beforeLate).map(view);
  ok('2 late photos (slow album) → ONE short "Added — you now have 5 photos" reply, first 3 photos kept', lateReplies.length === 1 && /Added/.test(lateReplies[0]!.text) && /5 photos/.test(lateReplies[0]!.text), `${lateReplies.length} reply(ies): ${lateReplies[0]?.text.replace(/\n/g, ' | ').slice(0, 140)}`);
  ok('…the pending video now holds all 5 photos in the database session', ((await rows(`whatsapp_sessions?phone_number=eq.${PH}&select=pending_payload`))[0]?.pending_payload?.image_paths ?? []).length === 5);

  const beforeVid = sent.length;
  r = await ask('video-details', () => text('Ankara gown, 15k, delivery Lagos 2k'), (v) => /Making your video/i.test(v.text));
  ok('product details → instant "making your video"; customers are told they will see the WhatsApp number, NOT a code', !!r.reply && /WhatsApp number/i.test(r.reply.text) && !/UNB-|order code/i.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 160));

  console.log('   … rendering the video (Gemini script → voiceover → FFmpeg → upload). This takes 1–3 minutes.');
  const tv = Date.now();
  let videoMsg: ReturnType<typeof view> | undefined;
  while (Date.now() - tv < 240_000 && !(videoMsg = sent.slice(beforeVid).map(view).find((v) => v.kind === 'video'))) await sleep(2000);
  ok(`video delivered as ONE video message — no technical code; says "sold 1 Ankara gown" for logging (${Math.round((Date.now() - tv) / 1000)}s)`, !!videoMsg && !/UNB-|order code/i.test(videoMsg.text) && /sold 1 Ankara gown/i.test(videoMsg.text) && /Your number \*0\d{3} \d{3} \d{4}\*/.test(videoMsg.text), videoMsg?.text.replace(/\n/g, ' | '));
  if (videoMsg?.header?.link) {
    const buf = Buffer.from(await (await fetch(videoMsg.header.link)).arrayBuffer());
    const f = path.join(tmp, 'out.mp4'); fs.writeFileSync(f, buf);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', f]).toString());
    const vs = probe.streams.find((s: any) => s.codec_type === 'video'), as = probe.streams.find((s: any) => s.codec_type === 'audio');
    ok('video file: 1080×1920 H.264, under 3.5MB', vs?.codec_name === 'h264' && vs.width === 1080 && vs.height === 1920 && buf.length < 3.5 * 1048576, `${vs?.width}×${vs?.height} ${vs?.codec_name} ${(buf.length / 1048576).toFixed(2)}MB`);
    ok('video has a Nigerian voiceover audio track (Gemini speech)', !!as, as ? `${as.codec_name}, ${Number(probe.format.duration).toFixed(1)}s` : 'NO AUDIO');
    ok('trial video is a short ~10-second preview (8–12 s), not the full 15–18 s ad', Number(probe.format.duration) >= 7.9 && Number(probe.format.duration) <= 12.1, `${Number(probe.format.duration).toFixed(1)}s, ${(buf.length / 1048576).toFixed(2)}MB`);
    ok('…and the caption tells them it is a preview (Starter = full HD)', /10-second preview/.test(videoMsg?.text ?? ''));
    // What does the voice actually SAY? (an earlier bug made it read the prompt instructions aloud before the ad)
    const wav = path.join(tmp, 'vo-check.wav');
    if (!as) { ok('(skipped: this video has no audio because Google speech is rate-limited right now; the check above already reported it)', true); } else {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    let said = '';
    for (let i = 0; i < 6 && !said; i++) { // Google's text models have brief overload spikes: alternate models and retry
      try {
        const tr = await ai.models.generateContent({ model: i % 2 === 0 ? (process.env.GEMINI_TEXT_MODEL ?? 'gemini-3.1-flash-lite') : 'gemini-3.5-flash-lite', contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: fs.readFileSync(wav).toString('base64') } }, { text: 'Transcribe every spoken word exactly. Output only the words.' }] }] });
        said = (tr.text ?? '').trim();
      } catch { await sleep(4000); }
    }
    console.log(`   🎙️  the voice says: "${said.replace(/\n/g, ' ')}"`);
    ok('the voice speaks ONLY the ad: no spoken instructions ("read this advert…", "accent", "do not add anything")', said.length > 10 && !/read this|do not add|accent|market seller|energetic/i.test(said), said.slice(0, 160));
    ok('…and the ad is not cut off: the call to action (WhatsApp / order) is still there', /whatsapp|order/i.test(said), said.slice(-80));
    }
    fs.copyFileSync(f, path.resolve('tmp', 'flow-video.mp4'));
  }
  const vj = (await rows(`video_jobs?business_id=eq.${biz!.id}&select=status,include_watermark,cleaned_image_urls,generated_script,error_message`))[0];
  ok('video job completed; trial video carries the watermark', vj?.status === 'completed' && vj?.include_watermark === true, JSON.stringify({ status: vj?.status, err: vj?.error_message }));
  console.log(`   ℹ️  photo clean-up by the image model: ${vj?.cleaned_image_urls?.length ? 'used' : 'skipped (image quota) — original photos were used, as designed'}`);
  ok('video quota charged once (trial: 1 of 5)', Number((await rows(`businesses?id=eq.${biz!.id}&select=videos_used_this_month`))[0]?.videos_used_this_month) === 1);

  // ───── the "Processing your entry..." note (INTERIM_NOTICE_MS=1000 in this test) ─────
  const notices = sent.map(view).filter((v) => /Processing your entry\.\.\./.test(v.text));
  ok('slow AI → "⏳ Processing your entry..." was sent (and only as a lone short note)', notices.length >= 1 && notices.every((v) => v.kind === 'text' && v.buttons.length === 0), `${notices.length} notice(s)`);

  // ───── money back: a customer pays what they owed → the moment that sells the app ─────
  r = await ask('credit-sale', () => text('sold 1 ankara 20k, balance 20k Mama Tunde'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const creditId = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id ?? '';
  await ask('credit-confirm', () => button(creditId), (v) => /Saved/.test(v.text));
  r = await ask('repay', () => text('Mama Tunde paid me 20k transfer'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const repayId = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id ?? '';
  r = await ask('repay-confirm', () => button(repayId), (v) => /Saved/.test(v.text));
  ok('debt payment confirm → "🎉 ₦20,000 collected from your customers" + "Money Unbarmore got back for you: ₦20,000"', !!r.reply && /🎉 ₦20,000 collected from your customers/.test(r.reply.text) && /Money Unbarmore got back for you: ₦20,000/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
  ok('…still ONE message, and the debt is back to ₦0', real(r.all).length === 1 && Number((await rows(`customers?business_id=eq.${biz!.id}&select=outstanding_debt_ngn`))[0]?.outstanding_debt_ngn) === 0);

  // ───── a shop owner's FIRST DAY: old debts, opening stock, phone numbers, honest "not yet" (the real-user bug) ─────
  const owed = async () => (await rows(`customers?business_id=eq.${biz!.id}&select=name,outstanding_debt_ngn,debt_due_date&outstanding_debt_ngn=gt.0&order=name`)) as { name: string; outstanding_debt_ngn: string; debt_due_date: string | null }[];
  const txCount = async () => (await rows(`transactions?business_id=eq.${biz!.id}&select=id&status=eq.confirmed`)).length;
  const quotaNow = async () => Number((await rows(`businesses?id=eq.${biz!.id}&select=tx_logged_this_month`))[0]?.tx_logged_this_month);
  const tx0 = await txCount(), q0 = await quotaNow();

  r = await ask('debts-vague', () => text('3 persons own me money before now'), (v) => /names and amounts/i.test(v.text));
  ok('"3 persons own me money before now" → asks for names and amounts (NOT "Nobody owes you money")', !!r.reply && !/Nobody owes/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));

  r = await ask('debts-list', () => text('3 people are owning me money.\n\n1. 20,000 Olowoyeye (to pay next week)\n2. 14,000 Femi (not yet mentioned date)\n3. 28,000 kalu (month end)'), (v) => v.buttons.some((b) => b.id.startsWith('ACTOK:')));
  const dtxt = r.reply?.text ?? '';
  ok('typed list → preview of all three with the total ₦62,000 and Confirm / Cancel', /Olowoyeye/.test(dtxt) && /Femi/.test(dtxt) && /[Kk]alu/.test(dtxt) && /₦62,000/.test(dtxt) && r.reply!.buttons.some((b) => b.id.startsWith('ACTNO:')), dtxt.replace(/\n/g, ' | ').slice(0, 260));
  ok('nothing is saved before Confirm', (await owed()).length === 0);
  const debtOk = r.reply?.buttons.find((b) => b.id.startsWith('ACTOK:'))?.id ?? '';

  r = await ask('debts-confirm', () => button(debtOk), (v) => /Added 3 debts/.test(v.text));
  ok('Confirm → "Added 3 debts: ₦62,000", ONE message, with an Undo button', !!r.reply && /₦62,000/.test(r.reply.text) && real(r.all).length === 1 && r.reply.buttons.some((b) => b.id.startsWith('ACTUNDO:')), r.reply?.text.replace(/\n/g, ' | '));
  const od = await owed();
  ok('the database now has Olowoyeye ₦20,000, Femi ₦14,000, Kalu ₦28,000, with the due dates she gave', od.length === 3 && Number(od.find((d) => d.name === 'Olowoyeye')?.outstanding_debt_ngn) === 20000 && Number(od.find((d) => d.name === 'Femi')?.outstanding_debt_ngn) === 14000 && /kalu/i.test(od.find((d) => /kalu/i.test(d.name))?.name ?? '') && !!od.find((d) => d.name === 'Olowoyeye')?.debt_due_date, JSON.stringify(od));
  ok('…and it is NOT counted as sales, income or a logged message (books and quota untouched)', (await txCount()) === tx0 && (await quotaNow()) === q0);

  r = await ask('debts-again', () => button(debtOk), (v) => /expired|already handled/i.test(v.text));
  ok('tapping Confirm a second time does NOT add the debts again', !!r.reply && (await owed()).reduce((a, d) => a + Number(d.outstanding_debt_ngn), 0) === 62000);

  r = await ask('who-owes-62', () => text('who dey owe me'), (v) => /Olowoyeye/.test(v.text));
  ok('"who dey owe me" now lists all three — the exact question that failed — with the ₦62,000 total', !!r.reply && /₦62,000/.test(r.reply.text) && /Femi/.test(r.reply.text) && /[Kk]alu/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));

  r = await ask('how-much-femi', () => text('how much does Femi owe me'), (v) => /Femi/.test(v.text));
  ok('"how much does Femi owe me" → ₦14,000', !!r.reply && /14,000/.test(r.reply.text), r.reply?.text);

  // a customer pays one of those debts: this is a repayment, and the 🎉 moment shows it
  r = await ask('femi-pays', () => text('Femi don pay 14k'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  ok('"Femi don pay 14k" → logged as a debt payment (not a sale)', !!r.reply && /[Dd]ebt/.test(r.reply.text) && !/Sale|Sold/.test(r.reply.text.split('\n')[0] ?? ''), r.reply?.text.replace(/\n/g, ' | '));
  const femiId = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id ?? '';
  r = await ask('femi-confirm', () => button(femiId), (v) => /Saved/.test(v.text));
  ok('confirmed: 🎉 ₦14,000 collected, and Femi is cleared (the other two still owe ₦48,000)', !!r.reply && /🎉 ₦14,000 collected/.test(r.reply.text) && (await owed()).reduce((a, d) => a + Number(d.outstanding_debt_ngn), 0) === 48000, r.reply?.text.replace(/\n/g, ' | ').slice(0, 220));

  // money received for GOODS is a sale, even when worded "collected from"
  r = await ask('collect-sale', () => text('collected 12k from Chika for the gele'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  ok('"collected 12k from Chika for the gele" → a SALE (not an old-debt payment that would vanish from sales)', !!r.reply && /Gele/i.test(r.reply.text) && !/[Dd]ebt repayment/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));
  const chikaTxc = r.reply?.buttons.find((b) => b.id.startsWith('TXX:'))?.id; if (chikaTxc) await ask('collect-discard', () => button(chikaTxc), (v) => v.text.length > 0);

  // opening stock + price change: not a purchase, not a sale
  const exp0 = (await rows(`transactions?business_id=eq.${biz!.id}&select=id&tx_type=eq.restock&status=eq.confirmed`)).length;
  r = await ask('opening-stock', () => text('I have 50 pieces of lace in stock, I bought them at 15k each, I sell 20k'), (v) => v.buttons.some((b) => b.id.startsWith('ACTOK:')));
  ok('"I have 50 lace…" → a stock preview (stock 50, cost ₦15,000, price ₦20,000), NOT a ₦750,000 purchase', !!r.reply && /50/.test(r.reply.text) && /15,000/.test(r.reply.text) && /20,000/.test(r.reply.text) && !/750,000/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
  const stockOk = r.reply?.buttons.find((b) => b.id.startsWith('ACTOK:'))?.id ?? '';
  r = await ask('opening-stock-ok', () => button(stockOk), (v) => /Updated 1 product/.test(v.text));
  const lace = (await rows(`products?business_id=eq.${biz!.id}&select=name,stock_qty,cost_price_ngn,selling_price_ngn&name_key=eq.lace`))[0];
  ok('database: Lace stock 50, cost ₦15,000, price ₦20,000 — and no restock/expense was created', Number(lace?.stock_qty) === 50 && Number(lace?.cost_price_ngn) === 15000 && Number(lace?.selling_price_ngn) === 20000 && (await rows(`transactions?business_id=eq.${biz!.id}&select=id&tx_type=eq.restock&status=eq.confirmed`)).length === exp0, JSON.stringify(lace));

  r = await ask('price-change', () => text('update price of lace to 22k'), (v) => v.buttons.some((b) => b.id.startsWith('ACTOK:')));
  ok('"update price of lace to 22k" → asks to confirm (old ₦20,000 → new ₦22,000) instead of falsely saying "noted"', !!r.reply && /20,000/.test(r.reply.text) && /22,000/.test(r.reply.text) && !/\bnoted\b/i.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
  const cancelId = r.reply?.buttons.find((b) => b.id.startsWith('ACTNO:'))?.id ?? '';
  await ask('price-cancel', () => button(cancelId), (v) => /Cancelled/.test(v.text));
  ok('Cancel leaves the price at ₦20,000', Number((await rows(`products?business_id=eq.${biz!.id}&select=selling_price_ngn&name_key=eq.lace`))[0]?.selling_price_ngn) === 20000);

  r = await ask('cust-phone', () => text("Olowoyeye's number is 08031234567"), (v) => /Saved/.test(v.text));
  ok('customer phone saved in international format', !!r.reply && /2348031234567/.test(r.reply.text) && (await rows(`customers?business_id=eq.${biz!.id}&select=phone_number&name=eq.Olowoyeye`))[0]?.phone_number === '2348031234567', r.reply?.text.replace(/\n/g, ' | '));

  r = await ask('owe-supplier', () => text('I owe Mama Ade 30k for fabric'), (v) => /don't track|can't do that/i.test(v.text), 40_000);
  ok('"I owe Mama Ade 30k" → honest "I don\'t track money you owe suppliers yet" (not silently logged as something else)', !!r.reply && /don't track money \*?you\*? owe|don't track money you owe/i.test(r.reply.text) && r.reply.buttons.length === 0, r.reply?.text.replace(/\n/g, ' | '));
  r = await ask('thanks', () => text('thank you'), (v) => /Anytime|welcome/i.test(v.text), 40_000);
  ok('"thank you" → a short friendly line (not "I only help with…")', !!r.reply && !/only help/i.test(r.reply.text) && r.reply.text.length < 120, r.reply?.text);

  // ───── receipts: several sales ≠ one person; logo upload ─────
  r = await ask('two-sales', () => text('sold 2 gele 20k cash, sold 1 ankara 15k cash'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const twoConfirm = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'))?.id ?? '';
  r = await ask('two-sales-confirm', () => button(twoConfirm), (v) => /Saved/.test(v.text) && v.buttons.some((b) => b.id.startsWith('RCPT:')));
  const twoRcpt = r.reply?.buttons.find((b) => b.id.startsWith('RCPT:'))?.id ?? '';
  r = await ask('two-sales-receipt', () => button(twoRcpt), (v) => /same customer/i.test(v.text) || v.kind === 'document');
  ok('two sales in one message → it ASKS "Are they all for the same customer?" (no single receipt assumed)', !!r.reply && r.reply.kind !== 'document' && /2 sales/.test(r.reply.text) && r.reply.buttons.length === 2, r.reply?.text.replace(/\n/g, ' | '));
  const diffBtn = r.reply?.buttons.find((b) => b.id.endsWith(':pick'))?.id ?? '';
  r = await ask('two-sales-pick', () => button(diffBtn), (v) => v.buttons.length >= 2);
  ok('"Different customers" → asks which sale (one button per sale)', !!r.reply && r.reply.buttons.length === 2 && r.reply.buttons.every((b) => /^RCPT:.*:L\d$/.test(b.id)), r.reply?.buttons.map((b) => b.title).join(' | '));
  const line1 = r.reply?.buttons[1]?.id ?? '';
  r = await ask('two-sales-line', () => button(line1), (v) => v.kind === 'document');
  ok('picking one sale → a receipt for ONLY that sale', !!r.reply && /Ankara/.test(r.reply.text) && !/Gele/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 160));

  const logoJpg = path.join(tmp, 'logo.jpg');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x7C3AED:s=300x300', '-frames:v', '1', logoJpg]);
  media.set('LOGO1', { data: fs.readFileSync(logoJpg), mime: 'image/jpeg' });
  r = await ask('logo-cmd', () => text('LOGO'), (v) => /Send your logo/.test(v.text));
  ok('"LOGO" → asks for the picture', !!r.reply);
  r = await ask('logo-photo', () => webhook({ type: 'image', image: { id: 'LOGO1', mime_type: 'image/jpeg' } }), (v) => /Logo saved/.test(v.text), 40_000);
  ok('sending the picture saves it as the logo (not treated as a product photo / video request)', !!r.reply && /Logo saved/.test(r.reply.text), r.reply?.text);

  // ───── MY NUMBER: the WhatsApp number printed on videos ─────
  const has006 = (await fetch(`${process.env.SUPABASE_URL}/rest/v1/businesses?select=sales_phone&limit=1`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } })).ok;
  console.log(`   ℹ️  database has migration 006 (sales_phone): ${has006 ? 'YES' : 'NO — testing the graceful path'}`);
  r = await ask('mynumber-show', () => text('MY NUMBER'), (v) => /Customers see/.test(v.text));
  ok('MY NUMBER shows the number customers see on videos (the owner\'s own by default) and how to change it', !!r.reply && /0900 000 0401/.test(r.reply.text) && /MY NUMBER 0803/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
  r = await ask('mynumber-bad', () => text('my number 12345'), (v) => /doesn.t look right/.test(v.text));
  ok('a bad number is refused with an example (nothing saved)', !!r.reply, r.reply?.text.replace(/\n/g, ' | '));
  r = await ask('mynumber-set', () => text('MY NUMBER 0803 123 4567'), (v) => /Your next videos|couldn.t save/.test(v.text));
  if (has006) {
    ok('MY NUMBER 0803… saves it: "next videos will show 0803 123 4567", old videos keep the old one', !!r.reply && /0803 123 4567/.test(r.reply.text) && /already made/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
    ok('…stored in international format in the database', (await rows(`businesses?id=eq.${biz!.id}&select=sales_phone`))[0]?.sales_phone === '2348031234567');
    r = await ask('mynumber-reset', () => text('MY NUMBER RESET'), (v) => /Your next videos/.test(v.text));
    ok('MY NUMBER RESET goes back to the number they chat from', !!r.reply && /0900 000 0401/.test(r.reply.text) && (await rows(`businesses?id=eq.${biz!.id}&select=sales_phone`))[0]?.sales_phone === null);
  } else {
    ok('without migration 006 the bot says it could not save (no crash, no false "saved")', !!r.reply && /couldn.t save/i.test(r.reply.text) && !/Your next videos/.test(r.reply.text), r.reply?.text);
  }
  const logoPath = String((await rows(`businesses?id=eq.${biz!.id}&select=logo_url`))[0]?.logo_url ?? '');
  ok('database: logo_url points at the stored logo', logoPath === `${biz!.id}/logo.png`, logoPath);
  r = await ask('receipt-with-logo', () => text('RECEIPT Mama'), (v) => v.kind === 'document');
  if (r.reply?.header?.link) {
    const pf = path.join(tmp, 'rc-logo.pdf'); fs.writeFileSync(pf, Buffer.from(await (await fetch(r.reply.header.link)).arrayBuffer()));
    const imgs = execFileSync('pdfimages', ['-list', pf]).toString().split('\n').filter((l) => /^\s*\d+\s/.test(l)).length;
    ok('the receipt PDF now contains the logo image at the top', imgs >= 1, `${imgs} image(s) in the PDF`);
  }

  // ───── client list, win-back, onboarding checklist ─────
  r = await ask('clients-add', () => text('add my customers: Femi 08031234567, Kalu 08051234567'), (v) => v.buttons.some((b) => b.id.startsWith('ACTOK:')));
  ok('a list of clients → preview with their numbers in international format + Confirm', !!r.reply && /Femi — 2348031234567/.test(r.reply.text) && /Kalu — 2348051234567/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
  const cok = r.reply?.buttons.find((b) => b.id.startsWith('ACTOK:'))?.id ?? '';
  await ask('clients-confirm', () => button(cok), (v) => /on your list/.test(v.text));
  const fem = (await rows(`customers?business_id=eq.${biz!.id}&select=name,phone_number&name=eq.Femi`))[0];
  ok('database: Femi saved with his number', fem?.phone_number === '2348031234567', JSON.stringify(fem));
  r = await ask('my-clients', () => text('MY CLIENTS'), (v) => /Your customers/.test(v.text));
  ok('MY CLIENTS → the list with spend, last purchase and 📞 where a number is saved', !!r.reply && /Mama Tunde/.test(r.reply.text) && /Femi/.test(r.reply.text) && /📞/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 260));
  r = await ask('who-stopped', () => text('which customers have stopped buying'), (v) => /gone quiet|Customers who stopped|Nobody has gone quiet/i.test(v.text), 40_000);
  ok('"which customers have stopped buying" → answered from real data (nobody is 30+ days quiet yet)', !!r.reply && /Nobody has gone quiet/.test(r.reply.text), r.reply?.text);
  r = await ask('winback', () => text('WIN BACK'), (v) => v.text.length > 10, 40_000);
  ok('WIN BACK with nobody quiet → says so honestly (no invented messages)', !!r.reply && /Nobody has gone quiet/.test(r.reply.text), r.reply?.text);
  r = await ask('start', () => text('START'), (v) => /Getting started/.test(v.text));
  ok('START → "How Unbarmore works" + a live checklist (✅ done / ⬜ to do) + the next step', !!r.reply && /How Unbarmore works/.test(r.reply.text) && /✅/.test(r.reply.text) && /⬜/.test(r.reply.text) && /Next:/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 300));

  // ───── cost price → real profit ─────
  r = await ask('cost-price', () => text('gele costs me 3k'), (v) => v.buttons.some((b) => b.id.startsWith('ACTOK:')));
  ok('"gele costs me 3k" → preview of the cost price (not a purchase, not a sale)', !!r.reply && /Gele/i.test(r.reply.text) && /3,000/.test(r.reply.text) && /not counted as a sale or a purchase/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
  const costOk = r.reply?.buttons.find((b) => b.id.startsWith('ACTOK:'))?.id ?? '';
  await ask('cost-confirm', () => button(costOk), (v) => /Updated 1 product/.test(v.text));
  const gele2 = (await rows(`products?business_id=eq.${biz!.id}&select=cost_price_ngn&name_key=eq.gele`))[0];
  ok('database: Gele now has cost price ₦3,000', Number(gele2?.cost_price_ngn) === 3000, JSON.stringify(gele2));
  r = await ask('profit-q', () => text('what is my profit this month'), (v) => /Profit|Cash left/.test(v.text), 40_000);
  ok('"what is my profit" → a labelled breakdown: Sales, then Profit (or honestly "Cash left" until cost prices are set up), and stock bought is explained as not a cost', !!r.reply && /Sales:/.test(r.reply.text) && /(Profit|Cash left):/.test(r.reply.text) && /Stock bought/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 300));

  // ───── morning/evening notes: pause, resume, and the buttons on them ─────
  r = await ask('reminders-off', () => text('REMINDERS OFF'), (v) => /stop the 7 AM and 9 PM/i.test(v.text));
  ok('REMINDERS OFF → confirmed, and remembered in the database', !!r.reply && (await rows(`outbound_log?business_id=eq.${biz!.id}&kind=eq.reminders_off&select=id`)).length === 1);
  r = await ask('reminders-on', () => text('REMINDERS ON'), (v) => /Back on/i.test(v.text));
  ok('REMINDERS ON → back, and the pause is removed', !!r.reply && (await rows(`outbound_log?business_id=eq.${biz!.id}&kind=eq.reminders_off&select=id`)).length === 0);
  r = await ask('stop', () => text('STOP'), (v) => /stop the 7 AM and 9 PM/i.test(v.text));
  ok('"STOP" is honoured the same way (WhatsApp policy)', !!r.reply);
  await ask('stop-undo', () => text('reminders on'), (v) => /Back on/i.test(v.text));
  r = await ask('loghow', () => button('LOGHOW'), (v) => /Send a voice note or type it/.test(v.text));
  ok('the morning note\'s [📝 Log a sale] button answers with how to log one', !!r.reply);
  r = await ask('dashlink', () => button('DASHLINK'), (v) => /auth\/verify\?token=[a-f0-9]{64}/.test(v.text));
  ok('the morning note\'s [📲 Open my app] button replies with a fresh one-tap login link', !!r.reply && /auth\/verify\?token=/.test(r.reply.text));
  r = await ask('winback-btn', () => button('WINBACK'), (v) => v.text.length > 10, 40_000);
  ok('the morning note\'s [👋 Win back] button works', !!r.reply && /Nobody has gone quiet|Win-back messages/.test(r.reply.text), r.reply?.text.slice(0, 80));

  // ───── no payment/PII leaks in what the bot sent ─────
  const everything = JSON.stringify(sent.map((s) => s.payload));
  ok('no secrets appear in any outbound message', !/sb_secret_|EAAf|AQ\.Ab8|ea5d2437/.test(everything));
} catch (e) {
  fail++; console.error('💥 unexpected error:', e);
} finally {
  try { process.kill(-bot.pid!, 'SIGTERM'); } catch { bot.kill('SIGTERM'); }
  fake.close(); redis.disconnect();
  await cleanup().catch((e) => console.error('cleanup error', e));
  const left = (await rows(`businesses?owner_phone=in.(${PH},${PH2})&select=id`).catch(() => [{}])) as unknown[];
  console.log(`\n🧹 cleanup: ${left.length === 0 ? 'all test data and files removed' : 'TEST DATA REMAINS'}`);
  if (fail) { const errs = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /"level":(50|60)|\[send\]|\[inbound\]|\[video\]|Error/.test(l)).slice(-8); if (errs.length) console.log('\nlast bot errors:\n' + errs.map((l) => '  ' + l.slice(0, 230)).join('\n')); }
  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
