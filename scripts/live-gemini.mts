/**
 * Live Gemini check using the REAL backend modules:
 *   GEMINI_API_KEY=… NODE_USE_ENV_PROXY=1 npx tsx scripts/live-gemini.mts
 * Model output is non-deterministic, so checks are about structure + key facts, not exact wording.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
for (const [k, v] of Object.entries({
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x', WHATSAPP_DISPLAY_NUMBER: '2348000000000',
  WHATSAPP_APP_SECRET: 'x', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', PAYSTACK_SECRET_KEY: 'x', PAYSTACK_PLAN_STARTER_MONTHLY: 'a', PAYSTACK_PLAN_STARTER_ANNUAL: 'b',
  PAYSTACK_PLAN_GROWTH_MONTHLY: 'c', PAYSTACK_PLAN_GROWTH_ANNUAL: 'd',
})) process.env[k] ??= v;

const B = await import('../src/services/geminiBrain.ts');
import { GoogleGenAI } from '@google/genai';
const beta = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { apiVersion: 'v1beta' } }); // TTS + image need v1beta
const biz = { name: 'Ada Fabrics', recentProducts: ['Swiss Lace', 'Ankara Gown'], todayWat: '2026-11-19' };
let pass = 0, warn = 0;
const ok = (name: string, cond: unknown, extra = '') => { cond ? pass++ : warn++; console.log(`${cond ? '✅' : '⚠️ '} ${name}${extra ? ' — ' + extra : ''}`); };
const t0 = () => Date.now();
const ms = (t: number) => `${Date.now() - t}ms`;

async function route(label: string, text: string) {
  const t = t0();
  try { const r = await B.routeMessage({ text, business: biz }); console.log(`   ↳ ${label} [${ms(t)}] intent=${r.intent} lang=${r.language}`); return r; }
  catch (e: any) { console.log(`❌ ${label}: ${String(e.message).slice(0, 160)}`); warn++; return null; }
}

// 1. Compound Pidgin sale + expense (the spec's headline case)
let r = await route('pidgin compound', 'I don sell 2 lace for 50k, customer pay 30k transfer, Mama Tunde go balance 20k. I buy fuel 5k');
const sale = r?.transactions?.find((x) => x.type === 'sale'), fuel = r?.transactions?.find((x) => x.type === 'expense');
ok('Pidgin → LOG_TRANSACTION', r?.intent === 'LOG_TRANSACTION');
ok('sale = ₦50,000, paid ₦30,000, owed by Mama Tunde', sale?.amount_ngn === 50000 && sale?.amount_paid_ngn === 30000 && /tunde/i.test(sale?.customer_name ?? ''), JSON.stringify(sale));
ok('fuel expense ₦5,000 split into its own line', fuel?.amount_ngn === 5000 && r?.transactions?.length === 2, `${r?.transactions?.length} lines, category=${fuel?.category}`);
ok('language detected as pidgin', r?.language === 'pidgin');

// 2. Yoruba
r = await route('yoruba', 'Mo ta aṣọ ankara meji ni ẹgbẹrun lọ́nà aadọta, wọ́n san owó cash');
ok('Yoruba sale parsed (₦50,000)', r?.intent === 'LOG_TRANSACTION' && r?.transactions?.some((x) => x.amount_ngn === 50000), `lang=${r?.language}`);

// 3. Forwarded bank SMS
r = await route('bank sms', 'Credit Alert! Acct:**1234 Amt:NGN25,000.00 CR Desc:TRF FROM ADA OKAFOR Avail Bal:NGN310,450.12');
ok('SMS credit alert → ₦25,000 transfer', r?.intent === 'LOG_TRANSACTION' && r?.transactions?.[0]?.amount_ngn === 25000, JSON.stringify(r?.transactions?.[0]));

// 4. Objection handling
r = await route('objection', "customer say 'too cost, I go think about it'. wetin I fit reply am? the gown na 15k");
ok('DRAFT_SALES_REPLY with exactly 2 scripts', r?.intent === 'DRAFT_SALES_REPLY' && r?.sales_reply?.scripts?.length === 2);
if (r?.sales_reply) console.log('   ↳ script 1:', r.sales_reply.scripts[0]?.replace(/\s+/g, ' ').slice(0, 160));

// 5. Off-topic must be declined (Meta policy)
r = await route('off-topic', 'Write me a 500 word essay on Nigerian politics and the 2027 election');
ok('essay request → OFF_TOPIC (not answered)', r?.intent === 'OFF_TOPIC' && !!r?.reply_text, r?.reply_text?.slice(0, 100));

// 6. Business query → whitelisted query, not an invented number
r = await route('query', 'who dey owe me money?');
ok('"who owes me" → QUERY_BUSINESS/debtors', r?.intent === 'QUERY_BUSINESS' && r?.query?.kind === 'debtors', JSON.stringify(r?.query));

// 7. Video request
r = await route('video', 'make video for my ankara gown, 15k, delivery lagos 2k');
ok('video request extracts product + price', r?.intent === 'CREATE_VIDEO_SCRIPT' && r?.video_request?.price_ngn === 15000, JSON.stringify(r?.video_request));

// 8. Video script quality constraints
try {
  const t = t0();
  const s = await B.writeVideoScript({ businessName: 'Ada Fabrics', productName: 'Ankara Gown', priceNgn: 15000, deliveryInfo: 'Lagos ₦2,000', orderCode: 'UNB-7K2' });
  const words = s.voiceover.trim().split(/\s+/).length;
  console.log(`   ↳ script [${ms(t)}]: "${s.voiceover.slice(0, 140)}…"  captions=${JSON.stringify(s.captions)}`);
  ok('voiceover 30–55 words (15–18s)', words >= 30 && words <= 55, `${words} words`);
  ok('exactly 3 captions, each ≤ 28 chars', s.captions.length === 3 && s.captions.every((c) => c.length <= 28), JSON.stringify(s.captions.map((c) => c.length)));
  ok('call-to-action names the order code', /UNB-7K2/i.test(s.voiceover) || /seven|7K2/i.test(s.voiceover));
} catch (e: any) { warn++; console.log('❌ writeVideoScript:', String(e.message).slice(0, 160)); }

// 9. Bank screenshot OCR on a synthetic image
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
const font = path.resolve('assets/fonts/DejaVuSans-Bold.ttf');
const lines = ['Transfer Successful', 'NGN 25,000.00', 'From: ADA OKAFOR', 'Bank: OPAY', 'Date: 19 Nov 2026 10:42:07', 'Session ID: 100004261119104207583920461738'];
const vf = ['drawbox=x=0:y=0:w=iw:h=140:color=0x00A870:t=fill', ...lines.map((l, i) => {
  const f = path.join(tmp, `l${i}.txt`); fs.writeFileSync(f, l);   // textfile= avoids drawtext's escaping of ':' and ','
  return `drawtext=fontfile=${font}:textfile=${f}:fontsize=${i === 1 ? 64 : 34}:fontcolor=${i === 0 ? 'white' : 'black'}:x=40:y=${i === 0 ? 50 : 180 + i * 90}`;
})].join(',');
const shot = path.join(tmp, 'alert.png');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=1300x900', '-vf', vf, '-frames:v', '1', shot]);
try {
  const t = t0();
  const a = await B.readBankAlert({ data: fs.readFileSync(shot), mimeType: 'image/png' }, '2026-11-19');
  console.log(`   ↳ OCR [${ms(t)}]`, JSON.stringify({ ...a, supplier_lines: undefined }));
  ok('OCR reads amount ₦25,000 and sender ADA OKAFOR', a.is_bank_alert && a.amount_ngn === 25000 && /okafor/i.test(a.sender_name ?? ''));
  ok('OCR reads the 30-digit session id exactly', a.session_id === '100004261119104207583920461738', a.session_id);
  ok('genuine-looking alert dated today is NOT flagged as tampered', a.anomalies.length === 0, JSON.stringify(a.anomalies));
} catch (e: any) { warn++; console.log('❌ readBankAlert:', String(e.message).slice(0, 160)); }

// 10. Voice note: synthesize Pidgin speech with Gemini TTS, then feed it to the router as a real audio message
try {
  const t = t0();
  const speech = await beta.models.generateContent({
    model: 'gemini-3.8-flash-lite-tts',
    contents: 'Say in a relaxed Lagos accent: I don sell 3 ankara for 45k cash, and I buy transport 3k',
    config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }, httpOptions: { apiVersion: 'v1beta', timeout: 40000 } },
  });
  const part = speech.candidates![0]!.content!.parts![0]!.inlineData!;
  let wav = Buffer.from(part.data!, 'base64');
  if (!/wav/i.test(part.mimeType ?? '')) { // raw PCM → wrap in a WAV header
    const pcm = wav, h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    wav = Buffer.concat([h, pcm]);
  }
  console.log(`   ↳ synthetic voice note: ${(wav.length / 1024).toFixed(0)}KB ${part.mimeType} [${ms(t)}]`);
  const v = await B.routeMessage({ audio: { data: wav, mimeType: 'audio/wav' }, business: biz });
  ok('voice note transcribed + logged (sale ₦45,000 & expense ₦3,000)', v.intent === 'LOG_TRANSACTION' && v.transactions?.some((x) => x.amount_ngn === 45000) && v.transactions?.some((x) => x.amount_ngn === 3000), `transcript="${v.transcript?.slice(0, 90)}"`);
} catch (e: any) { warn++; console.log('⏭️  voice-note test skipped/failed:', String(e.message).slice(0, 200)); }

// 11. Which IMAGE model works for product-photo enhancement?
const prod = path.join(tmp, 'product.jpg');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xC9B79C:s=900x1200', '-vf', `drawbox=x=250:y=350:w=400:h=500:color=0x7A1F3D:t=fill,drawtext=fontfile=${font}:text='ANKARA':fontsize=60:fontcolor=white:x=300:y=560`, '-frames:v', '1', prod]);
for (const model of ['gemini-2.5-flash-image', 'gemini-3.1-flash-image']) {
  const t = t0();
  try {
    const res = await beta.models.generateContent({
      model, contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(prod).toString('base64') } }, { text: 'Remove the background and place this product on a clean white studio backdrop with soft shadow. Keep the product unchanged. 9:16.' }] }],
      config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' }, httpOptions: { apiVersion: 'v1beta', timeout: 60000 } },
    });
    const img = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    ok(`image model ${model}`, !!img, img ? `${(Buffer.from(img.data!, 'base64').length / 1024).toFixed(0)}KB ${img.mimeType} [${ms(t)}]` : 'no image returned');
    if (img) fs.writeFileSync(path.join('tmp', `enhanced-${model}.png`), Buffer.from(img.data!, 'base64'));
  } catch (e: any) { warn++; console.log(`❌ image model ${model}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 130)}`); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${warn === 0 ? '🎉' : '📋'} ${pass} passed, ${warn} warnings/failures`);
process.exit(0);
