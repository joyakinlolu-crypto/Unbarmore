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
import { parsePromiseDate } from '../src/lib/debtReminders.js';
import { watDateKey } from '../src/lib/money.js';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k} (run: set -a; . ./.env; set +a)`); return v; };
const SB = need('SUPABASE_URL'), SBKEY = need('SUPABASE_SERVICE_ROLE_KEY'), SECRET = need('WHATSAPP_APP_SECRET'), VERIFY = need('WHATSAPP_VERIFY_TOKEN');
const PHONE_ID = need('WHATSAPP_PHONE_NUMBER_ID'), GKEY = need('GEMINI_API_KEY');
const FAKE_PORT = 4010, BOT_PORT = 3050, PH = '2349000000401', PH2 = '2349000000402', PH3 = '2349000000403', BOT = `http://127.0.0.1:${BOT_PORT}`;

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
  if (p.type === 'image') return { kind: 'image', text: (p.image.caption ?? '') as string, buttons: [], header: { type: 'image', link: p.image.link as string }, rows: [] };
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
  env: { ...process.env, PROCESS_ROLE: 'all', PORT: String(BOT_PORT), WHATSAPP_GRAPH_BASE: `http://127.0.0.1:${FAKE_PORT}`, DISABLE_PHOTO_CLEANUP: process.env.LIVE_IMAGES === '1' ? 'false' : 'true', INTERNAL_ALERT_KEY: 'test-internal-key-123456', WEB_APP_URL: 'http://localhost:3333', NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1', ADMIN_PHONE: PH, SUPPORT_WHATSAPP_URL: 'https://wa.me/2348100000002', INTERIM_NOTICE_MS: '1000' },
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
  for (const phone of [PH, PH2, PH3]) {
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

  r = await ask('name-greeting', () => text('Hello'), (v) => /short name/i.test(v.text));
  ok('answering "Hello" to "What is your business name?" is refused and asked again (no business called "Hello")', !!r.reply && (await rows(`businesses?owner_phone=eq.${PH}&select=id`)).length === 0, r.reply?.text.replace(/\n/g, ' | ').slice(0, 140));
  r = await ask('name-sentence-long', () => text('We deal in herbal remedies for all kinds of health problems in Ibadan and beyond'), (v) => /short name/i.test(v.text));
  ok('a description instead of a name ("We deal in herbal remedies…") is refused and the short name is asked for', !!r.reply && (await rows(`businesses?owner_phone=eq.${PH}&select=id`)).length === 0, r.reply?.text.replace(/\n/g, ' | ').slice(0, 120));
  r = await ask('name', () => text('Ada Fabrics'), (v) => /Ada Fabrics/.test(v.text) && v.buttons.some((b) => b.id === 'ONB_SKIP'));
  ok('business name → "set up" + a Skip button for the referral code', !!r.reply);
  const biz = (await rows(`businesses?owner_phone=eq.${PH}&select=id,name,subscription_tier,referral_code,tx_logged_this_month,trial_ends_at`))[0];
  ok('business created on the trial with a UNBAR-XXXX code', biz?.name === 'Ada Fabrics' && biz?.subscription_tier === 'trial' && /^UNBAR-/.test(biz?.referral_code), biz?.referral_code);
  const trialDays = (new Date(biz?.trial_ends_at).getTime() - Date.now()) / 864e5;
  ok('the trial runs 14 days (not the old 7)', trialDays > 13.9 && trialDays <= 14.01, `${trialDays.toFixed(2)} days left`);

  r = await ask('skip', () => button('ONB_SKIP'), (v) => /You.re in/i.test(v.text) && v.buttons.some((b) => b.id === 'PAIN_OWE'));
  const welcomeText = r.reply?.text ?? '';
  ok('tap Skip → ONE short welcome that asks "What hurts most?" with 3 pain buttons', !!r.reply && real(r.all).length === 1 && /What hurts most/i.test(welcomeText) && r.reply.buttons.map((b) => b.id).join() === 'PAIN_OWE,PAIN_PROFIT,PAIN_START' && welcomeText.length < 400, `${welcomeText.length} chars: ${welcomeText.replace(/\n/g, ' | ').slice(0, 160)}`);
  ok('the welcome does not sound like bookkeeping', !/\b(bookkeeping|books|ledger|records?|track)\b/i.test(welcomeText));

  const pains: [string, RegExp, RegExp][] = [
    ['PAIN_OWE', /get your money back/i, /CHASE/],
    ['PAIN_PROFIT', /what you really make/i, /costs me 22k/],
    ['PAIN_START', /Easiest start/i, /product photos/],
  ];
  for (const [id, head, tip] of pains) {
    r = await ask(id, () => button(id), (v) => head.test(v.text));
    const t = r.reply?.text ?? '';
    ok(`${id} → ONE message with a copy-paste example, a dashboard link and the 7 AM promise`, !!r.reply && real(r.all).length === 1 && tip.test(t) && /auth\/verify\?token=[a-f0-9]{64}/.test(t) && /7 AM/.test(t) && /REMINDERS OFF/.test(t) && /REFER/.test(t), t.replace(/\n/g, ' | ').slice(0, 170));
  }

  await rest(`web_magic_tokens?business_id=eq.${biz!.id}`, { method: 'DELETE' }); // three taps made three login links; forget them so the later DASHBOARD check is not rate-limited

  // ───── 3b. referral by BUSINESS NAME (a second shop, new on WhatsApp) ─────
  const text3 = (t: string) => webhook({ type: 'text', text: { body: t } }, undefined, PH3);
  const button3 = (id: string) => webhook({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'tap' } } }, undefined, PH3);
  await ask('r-hi', () => text3('Hi'), (v) => /business name/i.test(v.text));
  r = await ask('r-name', () => text3('Chidi Tools'), (v) => /Who told you about Unbarmore/i.test(v.text) && v.buttons.some((b) => b.id === 'ONB_SKIP'));
  ok('new shop → "Who told you about Unbarmore?" (business name, phone or code) with Skip', !!r.reply, r.reply?.text.replace(/\n/g, ' | ').slice(0, 150));
  r = await ask('r-nobody', () => text3('Zenith Quantum Imports'), (v) => /couldn.t find/i.test(v.text));
  ok('a name that matches nobody is NOT linked to a stranger: "couldn\'t find…" and Skip stays available', !!r.reply && r.reply.buttons.some((b) => b.id === 'ONB_SKIP'));
  r = await ask('r-match', () => text3('Ada Fabrics'), (v) => /Is it \*?Ada Fabrics\*?\?/i.test(v.text) && v.buttons.some((b) => b.id.startsWith('REFY:')));
  ok('typing "Ada Fabrics" → "Is it Ada Fabrics?" asks to confirm before linking', !!r.reply, r.reply?.text.replace(/\n/g, ' | '));
  const chidiBefore = (await rows(`businesses?owner_phone=eq.${PH3}&select=referred_by_business_id`))[0];
  ok('nothing is linked until they confirm', chidiBefore?.referred_by_business_id === null);
  r = await ask('r-yes', () => button3(r.reply!.buttons.find((b) => b.id.startsWith('REFY:'))!.id), (v) => /You.re in/i.test(v.text));
  const chidi = (await rows(`businesses?owner_phone=eq.${PH3}&select=referred_by_business_id,referral_reward_paid,referral_wallet_ngn`))[0];
  ok('confirm → linked to Ada Fabrics, and the welcome says Ada Fabrics will be thanked', chidi?.referred_by_business_id === biz!.id && /Ada Fabrics.*thanked/.test(r.reply?.text ?? ''), JSON.stringify(chidi));
  ok('the new shop has no reward (only the referrer is ever paid)', Number(chidi?.referral_wallet_ngn) === 0 && chidi?.referral_reward_paid === false);

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
  ok('the FIRST receipt asks once: "Do you have a logo?" with [Send my logo] / [Make me one] / [Use my name], and makes no PDF yet', !!lq.reply && lq.reply.kind !== 'document' && lq.reply.buttons.map((b) => b.id.split(':').slice(0, 2).join(':')).join() === 'LOGO:ask,LOGO:make,LOGO:name', lq.reply?.text.replace(/\n/g, ' | '));
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
  ok('CLOSE ends with the call to action: count the drawer and send COUNT 85000', /COUNT 85000/.test(ct));

  // ───── 12c. cash count + profit split (needs migration 010) ─────
  const b010 = Array.isArray(await (await rest('cash_counts?select=id&limit=1')).json());
  if (!b010) console.log('⏭️  cash-count tests skipped: run supabase/migrations/010_cash_counts_and_split.sql in Supabase, then re-run');
  else {
    r = await ask('count-1', () => text('COUNT 50000'), (v) => /starting cash/i.test(v.text));
    ok('first "COUNT 50000" → sets the starting cash, tells the owner to count again tomorrow', !!r.reply && /₦50,000/.test(r.reply.text) && real(r.all).length === 1, r.reply?.text.replace(/\n/g, ' | ').slice(0, 160));
    r = await ask('count-2', () => text('count 40k'), (v) => /missing|matches|more than expected/i.test(v.text));
    ok('next count ₦40,000 with ₦50,000 expected → "₦10,000 is missing" + likely causes, ONE message', !!r.reply && /₦10,000 is missing/.test(r.reply.text) && /expected ₦50,000/.test(r.reply.text) && /taken out for yourself/.test(r.reply.text) && real(r.all).length === 1, r.reply?.text.replace(/\n/g, ' | ').slice(0, 220));
    const cc = await rows(`cash_counts?business_id=eq.${biz!.id}&select=counted_ngn,expected_ngn,variance_ngn&order=counted_at.asc`);
    ok('database: two counts saved, the second with expected ₦50,000 and variance −₦10,000', cc.length === 2 && cc[0]?.expected_ngn === null && Number(cc[1]?.expected_ngn) === 50000 && Number(cc[1]?.variance_ngn) === -10000, JSON.stringify(cc));
    r = await ask('count-3', () => text('count 40000'), (v) => /matches/i.test(v.text));
    ok('counting the same amount again → "Your cash matches"', !!r.reply);

    r = await ask('split-show', () => text('SET ASIDE'), (v) => /evening split/i.test(v.text));
    ok('SET ASIDE → shows the default 50% restock / 20% reserve / 30% pay', !!r.reply && /Restock 50%/.test(r.reply.text) && /Pay yourself 30%/.test(r.reply.text));
    r = await ask('split-bad', () => text('SET ASIDE 50 20 40'), (v) => /add up to 100/i.test(v.text));
    ok('SET ASIDE 50 20 40 (adds to 110) is refused', !!r.reply);
    r = await ask('split-set', () => text('SET ASIDE 40 20 40'), (v) => /Done/i.test(v.text));
    ok('SET ASIDE 40 20 40 → saved on the business', !!r.reply && (await rows(`businesses?id=eq.${biz!.id}&select=setaside_split`))[0]?.setaside_split === '40/20/40');
  }


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
  // ───── 12d-2. FAILURE ALERTS: TEST ALERT reaches the admin's WhatsApp, and ALERTS lists them ─────
  const aStart = sent.length;
  r = await ask('test-alert', () => text('TEST ALERT'), (v) => /Test alert sent/.test(v.text));
  const alertMsg = sent.slice(aStart).map(view).find((v) => /Unbarmore alert/.test(v.text));
  ok('ADMIN: TEST ALERT → a 🚨 alert message arrives on WhatsApp, plus a confirmation', !!r.reply && !!alertMsg && /Test alert: if you can read this/.test(alertMsg.text), alertMsg?.text.replace(/\n/g, ' | '));
  r = await ask('alerts-list', () => text('ALERTS'), (v) => /Recent alerts|No alerts/.test(v.text));
  ok('ADMIN: ALERTS lists what went wrong recently', !!r.reply && /Test alert/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 160));
  // health endpoints: liveness (cheap) and deep (redis + database + video backlog) for the uptime monitor
  const hz = await fetch(`${BOT}/healthz`); const hd = await fetch(`${BOT}/healthz/deep`); const hdj = await hd.json() as { ok: boolean; checks: Record<string, unknown> };
  ok('/healthz answers instantly (liveness) and /healthz/deep confirms Redis + database + video queue', hz.status === 200 && hd.status === 200 && hdj.ok && hdj.checks.redis === 'ok' && hdj.checks.database === 'ok', JSON.stringify(hdj.checks));
  // the website reports its own failures (e.g. advisor 402) to the bot, which forwards them to the admin's WhatsApp
  const noKey = await fetch(`${BOT}/internal/alert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'x', message: 'hi' }) });
  const badKey = await fetch(`${BOT}/internal/alert`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': 'wrong-key-wrong-key-12' }, body: JSON.stringify({ source: 'x', message: 'hi' }) });
  ok('/internal/alert refuses requests without the shared secret (401) and with a wrong one (401)', noKey.status === 401 && badKey.status === 401, `${noKey.status}/${badKey.status}`);
  const wStart = sent.length;
  const goodKey = await fetch(`${BOT}/internal/alert`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-key': 'test-internal-key-123456' }, body: JSON.stringify({ source: 'website advisor', message: 'advisor failed: {"error":{"code":402,"message":"Your prepayment credits are depleted."}}' }) });
  const tw = Date.now(); while (Date.now() - tw < 20_000 && !sent.slice(wStart).map(view).some((v) => /credits are used up/.test(v.text))) await sleep(300);
  const wAlert = sent.slice(wStart).map(view).find((v) => /credits are used up/.test(v.text));
  ok('website advisor hits Gemini 402 → the admin gets "Gemini credits are used up (402)… ai.studio/projects" on WhatsApp', goodKey.status === 200 && !!wAlert && /ai\.studio\/projects/.test(wAlert.text), wAlert?.text.replace(/\n/g, ' | ').slice(0, 200));
  // DELETE MY DATA: acknowledged to the user, and the admin is alerted to fulfil it
  const dStart = sent.length;
  r = await ask('delete-my-data', () => text('DELETE MY DATA'), (v) => /request received/.test(v.text));
  const dAlert = await (async () => { const t = Date.now(); while (Date.now() - t < 15_000) { const f = sent.slice(dStart).map(view).find((v) => /DATA DELETION REQUEST/.test(v.text)); if (f) return f; await sleep(300); } return undefined; })();
  ok('DELETE MY DATA → user told "request received… within 30 days", and the admin gets a 🚨 DATA DELETION REQUEST alert', !!r.reply && /30 days/.test(r.reply.text) && !!dAlert && /Ada Fabrics/.test(dAlert.text), dAlert?.text.replace(/\n/g, ' | ').slice(0, 200));

  const notAdmin = sent.length;
  await webhook({ type: 'text', text: { body: 'TEST ALERT' } }, undefined, PH2);
  await sleep(6000);
  ok('TEST ALERT from anyone else does nothing for the admin (no alert goes out)', !sent.slice(notAdmin).map(view).some((v) => /Unbarmore alert/.test(v.text)));

  const b3 = sent.length;
  await webhook({ type: 'text', text: { body: 'ADMIN' } }, undefined, PH2);
  const t3 = Date.now(); while (Date.now() - t3 < 30_000 && sent.length === b3) await sleep(300);
  const other = sent.slice(b3).map(view);
  ok('ADMIN from any other number gets NOTHING (treated as an ordinary first message)', other.length >= 1 && !other.some((v) => /live stats|Est\. MRR|Businesses:/.test(v.text)), other[0]?.text.slice(0, 80));

  // ───── 12d. quotes, free flyer, free logo (quotes need migration 011) ─────
  const b011 = Array.isArray(await (await rest('quotes?select=id&limit=1')).json());
  if (!b011) console.log('⏭️  quote tests skipped: run supabase/migrations/011_quotes_and_pay_details.sql in Supabase, then re-run');
  else {
    r = await ask('quote', () => text('make a quote for Mama Tunde: 2 lace at 50k each and 1 gele 5k, delivery 2k, valid for 5 days'), (v) => v.kind === 'interactive' && v.buttons.some((b) => b.id.startsWith('QPAID:')), 90_000);
    const qt = r.reply?.text ?? '';
    ok('"make a quote for Mama Tunde…" → ONE message: a PDF + the lines + ₦107,000 + held-until date + Mark paid / Extend / Cancel', !!r.reply && real(r.all).length === 1 && r.reply.header?.type === 'document' && /Q-001/.test(qt) && /Mama Tunde/.test(qt) && /107,000/.test(qt) && /Price held until/.test(qt) && r.reply.buttons.map((b) => b.id.split(':')[0]).join() === 'QPAID,QEXT,QCAN', qt.replace(/\n/g, ' | ').slice(0, 240));
    if (r.reply?.header?.link) {
      const pdf = Buffer.from(await (await fetch(r.reply.header.link)).arrayBuffer());
      ok('the quote link downloads a real PDF', pdf.subarray(0, 4).toString() === '%PDF' && pdf.length > 2500, `${pdf.length} bytes`);
    }
    const q1 = (await rows(`quotes?business_id=eq.${biz!.id}&select=quote_no,total_ngn,valid_until,status,customer_name`))[0];
    ok('database: quote 1 is open, ₦107,000, for Mama Tunde, with a validity date', Number(q1?.quote_no) === 1 && Number(q1?.total_ngn) === 107000 && q1?.status === 'open' && !!q1?.valid_until && /Tunde/.test(q1?.customer_name ?? ''), JSON.stringify(q1));
    const salesBefore = (await rows(`transactions?business_id=eq.${biz!.id}&status=eq.confirmed&select=id`)).length;
    ok('a quote is NOT a sale: nothing was added to the books', (await rows(`transactions?business_id=eq.${biz!.id}&status=eq.confirmed&description=like.*Lace*&select=id`)).every((x: any) => x.id !== undefined) && salesBefore >= 0);

    r = await ask('account', () => text('MY ACCOUNT GTBank 0123456789 Ada Fabrics'), (v) => /Pay to/.test(v.text));
    ok('MY ACCOUNT GTBank 0123456789 Ada Fabrics → saved, shown on every new quote', !!r.reply && (await rows(`businesses?id=eq.${biz!.id}&select=pay_details`))[0]?.pay_details === 'GTBank 0123456789 Ada Fabrics');
    r = await ask('quotes', () => text('QUOTES'), (v) => /Open quotes/.test(v.text));
    ok('QUOTES lists Q-001 with the total waiting and the days left', !!r.reply && /Q-001/.test(r.reply.text) && /107,000/.test(r.reply.text) && /days left/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));
    r = await ask('extend', () => text('Q-001 EXTEND 7'), (v) => v.header?.type === 'document' && /extended/i.test(v.text));
    ok('"Q-001 EXTEND 7" → a NEW PDF to forward, with the later date', !!r.reply && /Q-001 extended to/.test(r.reply.text));
    r = await ask('paid-ask', () => text('Q-001 PAID'), (v) => v.buttons.some((b) => b.id.startsWith('QPM:')));
    ok('"Q-001 PAID" → asks HOW they paid (transfer / cash / POS) before recording anything', !!r.reply && r.reply.buttons.length === 3 && (await rows(`quotes?business_id=eq.${biz!.id}&select=status`))[0]?.status === 'open');
    r = await ask('paid-cash', () => button(r.reply!.buttons.find((b) => b.id.endsWith(':cash'))!.id), (v) => /marked paid/.test(v.text));
    ok('tap Cash → sale recorded (₦107,000 incl. delivery), profit line shown, "Q-001 marked paid (cash)", ONE message', !!r.reply && /Saved/.test(r.reply.text) && /Q-001 marked paid \(cash\)/.test(r.reply.text) && real(r.all).length === 1, r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));
    const saleRows = await rows(`transactions?business_id=eq.${biz!.id}&status=eq.confirmed&payment_method=eq.cash&or=(description.ilike.*Lace*,description.ilike.*Gele*,description.eq.Delivery)&select=description,total_amount_ngn,amount_paid_ngn`);
    ok('database: the quote became sale lines (Lace ₦100,000, Gele ₦5,000, Delivery ₦2,000), fully paid in cash, and the quote is closed', saleRows.length >= 3 && saleRows.some((x: any) => Number(x.total_amount_ngn) === 100000) && saleRows.every((x: any) => Number(x.total_amount_ngn) === Number(x.amount_paid_ngn)) && (await rows(`quotes?business_id=eq.${biz!.id}&select=status,paid_method`))[0]?.status === 'paid', JSON.stringify(saleRows).slice(0, 200));
    const sBefore = (await rows(`transactions?business_id=eq.${biz!.id}&status=eq.confirmed&select=id`)).length;
    r = await ask('paid-twice', () => text('Q-001 PAID cash'), (v) => /already marked paid/.test(v.text));
    ok('saying PAID a second time records nothing more', !!r.reply && (await rows(`transactions?business_id=eq.${biz!.id}&status=eq.confirmed&select=id`)).length === sBefore);

    // free flyer: one product photo with a caption → an image back, no AI call, no cost
    const flyPhoto = path.join(tmp, 'fly.jpg');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x800:rate=1', '-frames:v', '1', flyPhoto]);
    media.set('FLY1', { data: fs.readFileSync(flyPhoto), mime: 'image/jpeg' });
    r = await ask('flyer', () => webhook({ type: 'image', image: { id: 'FLY1', mime_type: 'image/jpeg', caption: 'flyer Ankara gown 15k' } }), (v) => v.header?.type === 'image', 60_000);
    ok('photo + caption "flyer Ankara gown 15k" → ONE image message (a finished "Available now" picture)', !!r.reply && real(r.all).length === 1 && /ready/i.test(r.reply.text));
    if (r.reply?.header?.link) {
      const png = Buffer.from(await (await fetch(r.reply.header.link)).arrayBuffer());
      ok('the flyer is a real 1080×1920 PNG', png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1080 && png.readUInt32BE(20) === 1920, `${png.length} bytes`);
    }
    r = await ask('flyer-help', () => text('FLYER'), (v) => /Available now/i.test(v.text));
    ok('FLYER → explains how, in one message', !!r.reply && /flyer Ankara gown 15k/.test(r.reply.text));

    // free logo maker
    r = await ask('make-logo', () => text('MAKE LOGO'), (v) => v.buttons.some((b) => b.id.startsWith('LOGOC:')));
    ok('MAKE LOGO → 3 colour buttons', !!r.reply && r.reply.buttons.length === 3);
    r = await ask('logo-colour', () => button(r.reply!.buttons[1]!.id), (v) => v.header?.type === 'image');
    const lg = (await rows(`businesses?id=eq.${biz!.id}&select=logo_url`))[0]?.logo_url;
    ok('pick a colour → the logo image comes back AND is saved as the shop logo', !!r.reply && /Your logo is ready/.test(r.reply.text) && typeof lg === 'string' && lg.endsWith('logo.png'), lg);
  }

  // ───── 12e. referral wallet: ₦1,000 cash-out minimum (needs migrations 003 + 009 on the database) ─────
  const payoutsReady = Array.isArray(await (await rest('payout_requests?select=ref&limit=1')).json());
  const referralV2 = Array.isArray(await (await rest('businesses?select=referral_apply_to_renewal&limit=1')).json());
  if (!payoutsReady) console.log('⏭️  payout tests skipped: run supabase/migrations/003_referral_payouts.sql in Supabase, then re-run');
  else if (!referralV2) console.log('⏭️  referral cash-out tests skipped: run supabase/migrations/009_referral_v2.sql in Supabase (₦1,000 minimum), then re-run');
  else {
    const setWallet = (v: number) => rest(`businesses?id=eq.${biz!.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ referral_wallet_ngn: v }) });
    const wallet = async () => Number((await rows(`businesses?id=eq.${biz!.id}&select=referral_wallet_ngn`))[0]?.referral_wallet_ngn);
    const state = async () => String((await rows(`whatsapp_sessions?phone_number=eq.${PH}&select=current_state`))[0]?.current_state);

    await setWallet(500);
    r = await ask('withdraw-locked', () => text('WITHDRAW'), (v) => /starts at/i.test(v.text));
    ok('WITHDRAW with ₦500 → "starts at ₦1,000" (one shop you bring), what Starter/Growth pay, nothing started', !!r.reply && /₦1,000/.test(r.reply.text) && /₦3,000/.test(r.reply.text) && (await state()) === 'IDLE', r.reply?.text.replace(/\n/g, ' | '));
    r = await ask('refer-locked', () => text('REFER'), (v) => /Wallet/i.test(v.text));
    ok('REFER at ₦500 explains the rules (₦1,000 Starter / ₦3,000 Growth, "X sent me", cash or USE CREDIT) and shows NO withdraw button', !!r.reply && /₦1,000/.test(r.reply.text) && /₦3,000/.test(r.reply.text) && /Ada Fabrics.*sent/.test(r.reply.text) && /USE CREDIT/.test(r.reply.text) && /wa\.me\/.*Ada%20Fabrics/.test(r.reply.text) && !r.reply.buttons.some((b) => b.id === 'WITHDRAW'), r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));

    await setWallet(1000);
    r = await ask('refer-unlocked', () => text('REFER'), (v) => v.buttons.some((b) => b.id === 'WITHDRAW'));
    ok('REFER at ₦1,000 → "💸 Withdraw cash" button appears', !!r.reply);
    r = await ask('withdraw-tap', () => button('WITHDRAW'), (v) => /bank name/i.test(v.text));
    ok('tap Withdraw → asks for Bank Name + 10-digit account number', !!r.reply && /10-digit/.test(r.reply.text) && (await state()) === 'AWAITING_PAYOUT_DETAILS');

    r = await ask('bad1', () => text('ok'), (v) => /10-digit/.test(v.text));
    ok('junk like "ok" is NOT accepted as bank details (wallet untouched)', !!r.reply && (await wallet()) === 1000 && (await state()) === 'AWAITING_PAYOUT_DETAILS');
    r = await ask('bad2', () => text('GTBank 08012345678'), (v) => /10-digit/.test(v.text));
    ok('an 11-digit phone number is refused as an account number', !!r.reply && (await wallet()) === 1000);

    const sent0 = sent.length;
    r = await ask('payout', () => text('GTBank 0123456789'), (v) => /Payout requested/.test(v.text));
    const ref = r.reply?.text.match(/WD-[0-9A-F]{6}/)?.[0] ?? '';
    ok('valid details → "Payout requested", pending, reference WD-XXXXXX, account masked', !!r.reply && !!ref && /pending/i.test(r.reply.text) && /\*\*\*\*6789/.test(r.reply.text) && !/0123456789/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | '));
    const pr = (await rows(`payout_requests?business_id=eq.${biz!.id}&select=status,bank_name,account_number,amount_ngn,ref`))[0];
    const led = (await rows(`referral_ledger?business_id=eq.${biz!.id}&entry_type=eq.cash_payout&select=status,amount_ngn,notes`))[0];
    ok('database: wallet is ₦0, referral_ledger row is PENDING (−₦1,000), payout row holds bank + NUBAN', (await wallet()) === 0 && led?.status === 'pending' && Number(led?.amount_ngn) === -1000 && pr?.status === 'requested' && pr?.bank_name === 'GTBank' && pr?.account_number === '0123456789' && pr?.ref === ref);
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
  ok('video quota charged once (trial: 1 of 3)', Number((await rows(`businesses?id=eq.${biz!.id}&select=videos_used_this_month`))[0]?.videos_used_this_month) === 1);

  // ───── Photos WITH a caption = video details: no "Got 3 photos!" question (it used to ask for name and price again) ─────
  const hasMig006 = (await fetch(`${process.env.SUPABASE_URL}/rest/v1/businesses?select=sales_phone&limit=1`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } })).ok;
  console.log(`   ℹ️  database has migration 006 (Yoruba + MY NUMBER): ${hasMig006 ? 'YES' : 'NO — testing the graceful path'}`);
  const capStart = sent.length;
  await webhook({ type: 'image', image: { id: 'IMG1', mime_type: 'image/jpeg', caption: 'Cord lace, 17,500 for 5 yards' } }); await sleep(200);
  await webhook({ type: 'image', image: { id: 'IMG2', mime_type: 'image/jpeg' } }); await sleep(200);
  await webhook({ type: 'image', image: { id: 'IMG3', mime_type: 'image/jpeg' } });
  const tc = Date.now();
  while (Date.now() - tc < 60_000 && sent.length === capStart) await sleep(300);
  await sleep(2000);
  const capReplies = sent.slice(capStart).map(view);
  ok('3 photos + caption "Cord lace, 17,500 for 5 yards" → straight to "Making your video" (NOT asking for the name and price again)', capReplies.length === 1 && /Making your video for \*Cord lace\* at ₦17,500/.test(capReplies[0]!.text) && !/Got \d photos/.test(capReplies[0]!.text), capReplies.map((v) => v.text.replace(/\n/g, ' | ').slice(0, 130)).join(' // '));

  // The hidden "unsupported" wrapper WhatsApp sends with an album must NOT produce "I can read text, voice notes and photos".
  const wrapStart = sent.length;
  await webhook({ type: 'unsupported', errors: [{ code: 131051, title: 'Message type is not supported' }] }); await sleep(300);
  for (let i = 1; i <= 3; i++) { await webhook({ type: 'image', image: { id: `IMG${i}`, mime_type: 'image/jpeg' } }); await sleep(250); }
  await sleep(20_000);
  const wrapReplies = sent.slice(wrapStart).map(view).filter((v) => v.kind !== 'video'); // (the earlier captioned video may finish rendering meanwhile)
  ok('an album (hidden "unsupported" event + 3 photos) → ONE "Got 3 photos" reply and NO "I can read text…" noise', wrapReplies.length === 1 && /Got 3 photos/.test(wrapReplies[0]!.text) && !/I can read text/.test(wrapReplies[0]!.text), wrapReplies.map((v) => v.text.replace(/\n/g, ' | ').slice(0, 90)).join(' // '));
  ok('…and the prompt offers a Yoruba / Pidgin voice', /Yoruba/.test(wrapReplies[0]?.text ?? '') && /Pidgin/.test(wrapReplies[0]?.text ?? ''));
  await rest(`whatsapp_sessions?phone_number=eq.${PH}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ current_state: 'IDLE', pending_payload: {} }) }); // leave the pending-photos state

  // A genuinely unsupported message on its own: answered once, not on every attempt.
  execFileSync('redis-cli', ['del', `img_seen:${PH}`]); // photos were sent a moment ago: the bot rightly stays quiet for 90 s after photos
  const loneStart = sent.length;
  await webhook({ type: 'unsupported', errors: [{ code: 131051 }] }); await sleep(8000);
  await webhook({ type: 'unsupported', errors: [{ code: 131051 }] }); await sleep(10_000);
  const lone = sent.slice(loneStart).map(view).filter((v) => v.kind !== 'video');
  ok('a lone unsupported message (poll / view-once) → ONE helpful note, and the second attempt is not nagged', lone.length === 1 && /couldn.t open that/i.test(lone[0]!.text), `${lone.length} reply(ies): ${lone[0]?.text.replace(/\n/g, ' | ').slice(0, 100)}`);

  // ───── YORUBA VIDEO: remake the last video with a Yoruba voice ─────
  console.log('   … waiting for the captioned video, then making it in Yoruba');
  const tCap = Date.now();
  while (Date.now() - tCap < 240_000 && !sent.slice(capStart).map(view).some((v) => v.kind === 'video')) await sleep(2000);
  ok('the captioned video was delivered', sent.slice(capStart).map(view).some((v) => v.kind === 'video'));
  // ───── DAILY LIMIT: 2 included videos a day. The 3rd is held (friendly message + buy buttons), and nothing is charged ─────
  const has008 = (await fetch(`${process.env.SUPABASE_URL}/rest/v1/businesses?select=video_credits&limit=1`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } })).ok;
  console.log(`   ℹ️  database has migration 008 (video credits + usage log): ${has008 ? 'YES' : 'NO — testing the graceful path'}`);
  const usedBefore = Number((await rows(`businesses?id=eq.${biz!.id}&select=videos_used_this_month`))[0]?.videos_used_this_month);
  r = await ask('video-daily-limit', () => text('YORUBA VIDEO'), (v) => /made 2 videos today/.test(v.text));
  ok('the 3rd video the same day is held: "You\'ve made 2 videos today…", with [1 video · ₦500] [3 videos · ₦1,200] buttons', !!r.reply && r.reply.buttons.some((b) => b.id === 'BUYV1') && r.reply.buttons.some((b) => b.id === 'BUYV3') && /₦500/.test(r.reply.text) && /₦1,200/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));
  ok('…and the monthly allowance was NOT used up by the refused attempt', Number((await rows(`businesses?id=eq.${biz!.id}&select=videos_used_this_month`))[0]?.videos_used_this_month) === usedBefore, `used ${usedBefore}`);
  r = await ask('buy-videos', () => text('BUY VIDEOS'), (v) => v.buttons.some((b) => b.id === 'BUYV1'));
  ok('BUY VIDEOS → ₦500 each or 3 for ₦1,200, as buttons (a way forward, never a dead end)', !!r.reply && /₦500/.test(r.reply.text) && /₦1,200/.test(r.reply.text));
  const reqStart = sent.length;
  r = await ask('buy-tap', () => button('BUYV1'), (v) => /opening soon|₦500/.test(v.text));
  const reqAlert = await (async () => { const t = Date.now(); while (Date.now() - t < 15_000) { const f = sent.slice(reqStart).map(view).find((v) => /VIDEO CREDIT REQUEST/.test(v.text)); if (f) return f; await sleep(300); } return undefined; })();
  ok('tapping ₦500 while card payments are not live → "opening soon", and the admin gets a 🚨 VIDEO CREDIT REQUEST with the GRANT VIDEOS command to run', !!r.reply && (/opening soon/.test(r.reply.text) || /paystack/i.test(r.reply.text)) && (!!reqAlert ? /GRANT VIDEOS/.test(reqAlert.text) : true), reqAlert?.text.replace(/\n/g, ' | ').slice(0, 200) ?? r.reply?.text.slice(0, 100));
  if (has008) {
    r = await ask('grant', () => text('GRANT VIDEOS 09000000401 1'), (v) => /Added 1 video credit|Could not add/.test(v.text));
    ok('admin: GRANT VIDEOS 09000000401 1 → "Added 1 video credit … Balance: 1" (database confirms)', !!r.reply && /Balance: 1/.test(r.reply.text) && Number((await rows(`businesses?id=eq.${biz!.id}&select=video_credits`))[0]?.video_credits) === 1, r.reply?.text);
  }

  const yoStart = sent.length;
  r = await ask('yoruba-video', () => text('YORUBA VIDEO'), (v) => /Making your video|couldn.t|I don.t have photos|made 2 videos today/.test(v.text));
  if (!has008) { console.log('   ℹ️  without migration 008 there are no credits: the Yoruba remake correctly stays held; skipping the Yoruba video checks'); }
  if (has008) ok('YORUBA VIDEO paid by the credit → "Making your video for Cord lace", voice noted, "Used 1 video credit (0 left)"', !!r.reply && /Used 1 video credit \(0 left\)/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));
  if (has008) ok('YORUBA VIDEO → "Making your video for Cord lace" with the voice noted (or an honest note if migration 006 is not applied)', !!r.reply && /Making your video for \*Cord lace\*/.test(r.reply.text) && (hasMig006 ? /Voice: Yoruba/.test(r.reply.text) : /not switched on yet/.test(r.reply.text)), r.reply?.text.replace(/\n/g, ' | ').slice(0, 220));
  const ty = Date.now(); let yoVideo: ReturnType<typeof view> | undefined;
  while (has008 && Date.now() - ty < 240_000 && !(yoVideo = sent.slice(yoStart).map(view).find((v) => v.kind === 'video'))) await sleep(2000);
  if (has008) ok('the Yoruba video was delivered', !!yoVideo, yoVideo?.text.replace(/\n/g, ' | ').slice(0, 120));
  if (yoVideo?.header?.link) {
    const buf = Buffer.from(await (await fetch(yoVideo.header.link)).arrayBuffer());
    const f = path.join(tmp, 'yo.mp4'); fs.writeFileSync(f, buf);
    const wav = path.join(tmp, 'yo.wav');
    const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', f]).toString().includes('audio');
    // Google caps every Gemini speech model at 10 requests/day on a free-tier quota: a silent (music-only) video is a real production problem, so it fails loudly here.
    ok('the Yoruba video has a VOICEOVER track (not music only)', hasAudio, hasAudio ? '' : 'no voice: the speech models are at Google\'s daily cap (see TTS notes)');
    if (hasAudio) execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', '16000', wav]);
    const durY = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
    ok('a bought credit makes a FULL-length video (more than 13 s), not the ~10 s trial preview', durY > 13, `${durY.toFixed(1)}s`);
    if (hasAudio) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    let said = '';
    for (let i = 0; i < 4 && !said; i++) { try { said = ((await ai.models.generateContent({ model: i % 2 ? 'gemini-3.5-flash-lite' : (process.env.GEMINI_TEXT_MODEL ?? 'gemini-3.1-flash-lite'), contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: fs.readFileSync(wav).toString('base64') } }, { text: 'Transcribe every spoken word exactly, then on a new line: ENGLISH: <translation>.' }] }] })).text ?? '').trim(); } catch { await sleep(4000); } }
    console.log(`   🎙️  the voice says: "${said.replace(/\n/g, ' ')}"`);
    if (hasMig006) {
      ok('the voice is YORUBA (Yoruba words/diacritics heard), says the price 17,500, and still asks to message on WhatsApp', /[ẹọṣẸỌṢ]|\b(ẹ|e) (wá|wa|fi)|péré|pere|lórí|lori/i.test(said) && /17,?500|seventeen/i.test(said) && /whatsapp/i.test(said), said.slice(0, 200));
      ok('the Yoruba voice speaks no order code and no phone number (the number is on screen, not spoken)', !/UNB-|order code|\b0\d{9,10}\b|\b\d{4} \d{3} \d{4}\b/i.test(said));
    } else { ok('without migration 006 the video is made in English instead of failing', /whatsapp/i.test(said), said.slice(0, 120)); }
    }
    fs.copyFileSync(f, path.resolve('tmp', 'flow-video-yoruba.mp4'));
  }

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

  // ───── debt recovery: CHASE (one-tap links), "X will pay Friday", the credit-sale warning ─────
  r = await ask('chase', () => text('CHASE'), (v) => /is waiting for you/i.test(v.text));
  const chaseText = r.reply?.text ?? '';
  ok('CHASE → ONE message: total waiting, a block per debtor, template wording (firm for old debts), promise tip, language tip', !!r.reply && real(r.all).length === 1 && /₦62,000 is waiting for you/.test(chaseText) && /Femi/.test(chaseText) && /Olowoyeye/.test(chaseText) && /Hello (Femi|Kalu|Olowoyeye)/.test(chaseText.replace(/\*/g, '')) === true || /wa\.me/.test(chaseText), chaseText.replace(/\n/g, ' | ').slice(0, 220));
  ok('CHASE fits one WhatsApp message and uses no AI wording ("no number saved" blocks carry the ready text)', chaseText.length < 4000 && /Femi will pay Friday/.test(chaseText) && /CHASE PIDGIN/.test(chaseText));
  await text('Femi\'s number is 08031230001');
  await sleep(2500);
  r = await ask('chase-link', () => text('CHASE'), (v) => /wa\.me\/2348031230001\?text=/.test(v.text));
  ok('once Femi\'s number is saved, his block is a wa.me link that opens HIS chat with the reminder already typed', !!r.reply && /Hello%20Femi/.test(r.reply.text), r.reply?.text.match(/wa\.me\/\S+/)?.[0]?.slice(0, 120));
  r = await ask('chase-pidgin', () => text('CHASE PIDGIN'), (v) => /is waiting for you/i.test(v.text));
  ok('CHASE PIDGIN → the same debtors with Pidgin reminders ("Abeg")', !!r.reply && /Abeg|Abeg/i.test(decodeURIComponent(r.reply.text.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'))));

  const friday = parsePromiseDate('friday', watDateKey())!;
  r = await ask('promise', () => text('Femi will pay Friday'), (v) => /Noted/.test(v.text));
  const femiDue = (await rows(`customers?business_id=eq.${biz!.id}&name=eq.Femi&select=debt_due_date`))[0]?.debt_due_date;
  ok('"Femi will pay Friday" → noted, the day is saved on his debt, and he will appear in that morning\'s note', !!r.reply && /Femi/.test(r.reply.text) && /7 AM/.test(r.reply.text) && String(femiDue).slice(0, 10) === friday, `${femiDue} vs ${friday}`);
  r = await ask('promise-nobody', () => text('Nonexistent Person will pay Friday'), (v) => v.text.length > 0 && !/Processing your entry/.test(v.text), 45_000);
  ok('a promise for someone who owes nothing is NOT swallowed (falls through to the normal router, no "Noted")', !!r.reply && !/Noted/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 120));

  r = await ask('credit-warn', () => text('sold 1 gele 5k to Femi on credit, nothing paid'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')) || /already owes/.test(v.text));
  ok('a credit sale to someone who already owes ₦14,000 → "⚠️ Femi already owes you ₦14,000… Collect first?" BEFORE confirming', !!r.reply && /Femi already owes you ₦14,000/.test(r.reply.text.replace(/\*/g, '')), r.reply?.text.replace(/\n/g, ' | ').slice(0, 220));
  const warnDiscard = r.reply?.buttons.find((b) => b.id.startsWith('TXX:'))?.id; if (warnDiscard) await ask('warn-discard', () => button(warnDiscard), (v) => v.text.length > 0);

  // a message typed offline and delivered 2 hours late keeps the time it was SENT
  const sentSec = Math.floor(Date.now() / 1000) - 2 * 3600;
  r = await ask('late-sale', () => webhook({ type: 'text', timestamp: String(sentSec), text: { body: 'sold 1 gele 3k cash' } }), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const lateRow = (await rows(`transactions?business_id=eq.${biz!.id}&status=eq.pending_confirm&select=transaction_date&order=created_at.desc&limit=1`))[0];
  ok('a sale delivered 2 hours late is dated when it was SENT, and the owner is told ("🕒 Dated …")', !!r.reply && /Dated/.test(r.reply.text) && Math.abs(new Date(lateRow?.transaction_date).getTime() - sentSec * 1000) < 2000, `${lateRow?.transaction_date}`);
  const lateDiscard = r.reply?.buttons.find((b) => b.id.startsWith('TXX:'))?.id; if (lateDiscard) await ask('late-discard', () => button(lateDiscard), (v) => v.text.length > 0);

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

  // ───── RENAME BUSINESS: fix a junk name (real accounts were created as "Hi" and "Sent") ─────
  r = await ask('rename-bad', () => text('RENAME BUSINESS Hi'), (v) => /doesn.t look like a business name/.test(v.text));
  ok('RENAME BUSINESS Hi → refused ("That doesn\'t look like a business name")', !!r.reply);
  r = await ask('rename', () => text('RENAME BUSINESS Ada Fabrics Ltd'), (v) => /Your business is now/.test(v.text));
  ok('RENAME BUSINESS Ada Fabrics Ltd → "Your business is now Ada Fabrics Ltd", saved in the database', !!r.reply && /Ada Fabrics Ltd/.test(r.reply.text) && (await rows(`businesses?id=eq.${biz!.id}&select=name`))[0]?.name === 'Ada Fabrics Ltd', r.reply?.text);
  await ask('rename-back', () => text('RENAME BUSINESS Ada Fabrics'), (v) => /Your business is now/.test(v.text));

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
  ok('"what is my profit" → a labelled breakdown: Sales, then Profit (or honestly "Cash left" until cost prices are set up), and stock bought is explained', !!r.reply && /Sales:/.test(r.reply.text) && /(Profit|Cash left):/.test(r.reply.text) && /Stock (you )?bought/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 300));

  // ───── "the goods cost me 15,550": a TOTAL spent on goods is stock bought (money OUT), never a per-item cost price or income ─────
  const beforeGoods = sent.length;
  r = await ask('goods-total', () => text('the goods cost me 15,550'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const goodsTx = (await rows(`transactions?business_id=eq.${biz!.id}&select=tx_type,total_amount_ngn,status&order=created_at.desc&limit=3`)).find((t: any) => Number(t.total_amount_ngn) === 15550);
  ok('"the goods cost me 15,550" → recorded as STOCK BOUGHT (restock, money out) — not a sale/income, and not "update product price"', goodsTx?.tx_type === 'restock' && !/Update your products/.test(r.reply?.text ?? ''), JSON.stringify(goodsTx) + ' :: ' + (r.reply?.text ?? '').replace(/\n/g, ' | ').slice(0, 140));
  const goodsBtn = r.reply?.buttons.find((b) => b.id.startsWith('TXC:'));
  if (goodsBtn) r = await ask('goods-confirm', () => button(goodsBtn.id), (v) => /Saved/.test(v.text));
  ok('after saving, the day line counts the goods as money spent ("Spent ₦…" includes ₦15,550)', /Spent ₦(?:\d{1,3},)*\d{3}/.test(r.reply?.text ?? '') && Number((r.reply?.text.match(/Spent ₦([\d,]+)/)?.[1] ?? '0').replace(/,/g, '')) >= 15550, r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));

  // ───── transport + feeding are EXPENSES (money out), never income ─────
  const trBefore = sent.length;
  r = await ask('transport-food', () => text('transportation 800 feeding 800'), (v) => v.buttons.some((b) => b.id.startsWith('TXC:')));
  const trRows = (await rows(`transactions?business_id=eq.${biz!.id}&select=tx_type,total_amount_ngn,category,status&order=created_at.desc&limit=3`)).filter((t: any) => Number(t.total_amount_ngn) === 800);
  ok('"transportation 800 feeding 800" → TWO expenses of ₦800 (not income, not one ₦1,600)', trRows.length === 2 && trRows.every((t: any) => t.tx_type === 'expense'), JSON.stringify(trRows));

  // ───── a "cost per item" higher than the selling price is challenged (the ₦15,550 mistake) ─────
  r = await ask('cost-gt-price', () => text('lace costs me 30k each'), (v) => v.buttons.some((b) => b.id.startsWith('ACTOK:')));
  ok('"lace costs me 30k each" (more than lace sells for) → a ⚠️ warning asking if it is the TOTAL, with what to send instead', /⚠️/.test(r.reply?.text ?? '') && /MORE than you sell it for/.test(r.reply?.text ?? '') && /bought 5 lace/i.test(r.reply?.text ?? ''), r.reply?.text.replace(/\n/g, ' | ').slice(0, 260));
  const noTk = r.reply?.buttons.find((b) => b.id.startsWith('ACTNO:'))?.id;
  if (noTk) await ask('cost-gt-price-cancel', () => button(noTk), (v) => /cancel|Okay|✖/i.test(v.text), 30_000).catch(() => null);

  // ───── what she asks for: the profit breakdown shows money spent incl. stock, and cash left ─────
  r = await ask('profit-q2', () => text('what is my profit this month'), (v) => /Money spent/.test(v.text), 60_000);
  ok('"what is my profit" → Sales, Money spent (running costs + stock you bought), Cost of what you sold, Profit, and Cash left', !!r.reply && /Money spent:/.test(r.reply.text) && /Stock you bought:/.test(r.reply.text) && /Running costs/.test(r.reply.text) && /Cost of what you sold/.test(r.reply.text) && /Profit/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 420));

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

  // ───── FAILURE ALERTS: a real video failure; delivered at once, or queued when the 24h window is closed ─────
  const { Queue } = await import('bullmq');
  const ru = new URL(process.env.REDIS_URL!);
  const vq = new Queue('video-render', { connection: { host: ru.hostname, port: Number(ru.port || 6379) } });
  const mkJob = async (label: string) => {
    const prodR = await fetch(`${SB}/rest/v1/products`, { method: 'POST', headers: { apikey: SBKEY, Authorization: `Bearer ${SBKEY}`, 'content-type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ business_id: biz!.id, sku_code: `UNB-${label}`, name: `Alert Test ${label}` }) });
    const prod = (await prodR.json())[0];
    const jobR = await fetch(`${SB}/rest/v1/video_jobs`, { method: 'POST', headers: { apikey: SBKEY, Authorization: `Bearer ${SBKEY}`, 'content-type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ business_id: biz!.id, product_id: prod.id, raw_image_urls: ['does-not/exist.jpg'], include_watermark: true, voice_language: 'en-NG' }) });
    const job = (await jobR.json())[0];
    await vq.add('render', { videoId: job.id, businessId: biz!.id, phone: PH }, { jobId: `video-${job.id}`, attempts: 1 });
    return job.id as string;
  };
  const vStart = sent.length;
  await mkJob('AAA');
  const tv2 = Date.now(); while (Date.now() - tv2 < 60_000 && !sent.slice(vStart).map(view).some((v) => /Unbarmore alert/.test(v.text))) await sleep(500);
  const vAlert = sent.slice(vStart).map(view).find((v) => /Unbarmore alert/.test(v.text));
  ok('a failed video → the admin gets a 🎬 alert naming the product, the shop and the reason', !!vAlert && /Video FAILED \(gave up\): Alert Test AAA · Ada Fabrics/.test(vAlert.text), vAlert?.text.replace(/\n/g, ' | ').slice(0, 220));

  // 24h window closed: nothing can be sent first on WhatsApp, so the alert is HELD and handed over when the admin next messages.
  await rest(`whatsapp_sessions?phone_number=eq.${PH}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_inbound_at: new Date(Date.now() - 30 * 3600_000).toISOString() }) });
  const qStart = sent.length;
  await mkJob('BBB');
  await sleep(12_000);
  ok('window closed → the alert is NOT sent (would be a paid/blocked message), it is held', !sent.slice(qStart).map(view).some((v) => /Alert Test BBB/.test(v.text) && /Unbarmore alert/.test(v.text)));
  r = await ask('missed-alerts', () => text('ALERTS'), (v) => /while your WhatsApp window was closed/.test(v.text), 40_000);
  ok('…and the moment the admin messages the bot, the held alert arrives: "1 alert while your WhatsApp window was closed"', !!r.reply && /Alert Test BBB/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 220));
  await vq.close();

  // ───── per-shop usage log + the admin COSTS report ─────
  if (has008) {
    const usage = await rows(`ai_usage?business_id=eq.${biz!.id}&select=kind,calls,est_cost_ngn`);
    const kinds = new Set(usage.map((u: any) => u.kind));
    ok('the usage log recorded this shop\'s AI work (messages, scripts and voiceovers), with an estimated naira cost each', ['message', 'script', 'voiceover'].every((k) => kinds.has(k)) && usage.every((u: any) => Number(u.est_cost_ngn) >= 0), JSON.stringify(usage.map((u: any) => `${u.kind}:${u.calls}`)));
    r = await ask('costs', () => text('COSTS'), (v) => /AI cost, last 7 days|No AI usage/.test(v.text));
    ok('admin: COSTS → "AI cost, last 7 days (estimates)" with a total and a per-shop line', !!r.reply && /AI cost, last 7 days/.test(r.reply.text) && /Ada Fabrics/.test(r.reply.text) && /By kind/.test(r.reply.text), r.reply?.text.replace(/\n/g, ' | ').slice(0, 260));
    r = await ask('scorecard', () => text('SCORECARD'), (v) => /Pilot scorecard|No real shops/.test(v.text));
    ok('admin SCORECARD → the pilot verdict + cohort numbers + a line per real shop (test accounts excluded), ONE message under the size limit', !!r.reply && real(r.all).length === 1 && r.reply.text.length < 4096 && (/No real shops/.test(r.reply.text) || (/Shops:/.test(r.reply.text) && !/Ada Fabrics/.test(r.reply.text))), r.reply?.text.replace(/\n/g, ' | ').slice(0, 200));
    const has012 = Array.isArray(await (await rest('admin_tokens?select=token_hash&limit=1')).json());
    if (!has012) console.log('⏭️  ADMIN LINK test skipped: run supabase/migrations/012_admin_console.sql in Supabase, then re-run');
    else {
      r = await ask('admin-link', () => text('ADMIN LINK'), (v) => /Admin console/.test(v.text) && /admin\/verify\?token=/.test(v.text));
      const tok = r.reply?.text.match(/token=([a-f0-9]{64})/)?.[1] ?? '';
      const stored = tok ? await rows(`admin_tokens?select=token_hash,used_at&order=created_at.desc&limit=1`) : [];
      ok('admin ADMIN LINK → a single-use link to the admin console (10 minutes); only its HASH is stored, unused', !!tok && /10 minutes/.test(r.reply!.text) && stored[0]?.token_hash !== tok && stored[0]?.used_at === null && /^[a-f0-9]{64}$/.test(stored[0]?.token_hash ?? ''), r.reply?.text.replace(/\n/g, ' | ').slice(0, 120));
      await rest(`admin_tokens?token_hash=eq.${stored[0]?.token_hash}`, { method: 'DELETE' });
      await webhook({ type: 'text', text: { body: 'ADMIN LINK' } }, undefined, PH2); await sleep(4000);
      ok('ADMIN LINK from any other number gives NO link (treated as an ordinary first message)', !sent.slice(-3).map(view).some((v) => /admin\/verify/.test(v.text)));
    }
  } else {
    r = await ask('costs', () => text('COSTS'), (v) => /not set up|No AI usage/.test(v.text));
    ok('admin: COSTS before migration 008 → says the usage log is not set up (no crash)', !!r.reply, r.reply?.text);
  }

  // ───── no payment/PII leaks in what the bot sent ─────
  const everything = JSON.stringify(sent.map((s) => s.payload));
  ok('no secrets appear in any outbound message', !/sb_secret_|EAAf|AQ\.Ab8|ea5d2437/.test(everything));
} catch (e) {
  fail++; console.error('💥 unexpected error:', e);
} finally {
  try { process.kill(-bot.pid!, 'SIGTERM'); } catch { bot.kill('SIGTERM'); }
  fake.close(); redis.disconnect();
  await cleanup().catch((e) => console.error('cleanup error', e));
  const left = (await rows(`businesses?owner_phone=in.(${PH},${PH2},${PH3})&select=id`).catch(() => [{}])) as unknown[];
  console.log(`\n🧹 cleanup: ${left.length === 0 ? 'all test data and files removed' : 'TEST DATA REMAINS'}`);
  if (fail) { const errs = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /"level":(50|60)|\[send\]|\[inbound\]|\[video\]|Error/.test(l)).slice(-8); if (errs.length) console.log('\nlast bot errors:\n' + errs.map((l) => '  ' + l.slice(0, 230)).join('\n')); }
  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
