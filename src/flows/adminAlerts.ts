import { alertAdmin, recentAlerts, takeMissedAlerts } from '../lib/alerts.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { addVideoCredits, db, isInServiceWindow } from '../db/supabase.js';
import { ngn } from '../lib/money.js';
import { scorecardReply } from './scorecard.js';
import { signedUrl, uploadFile } from '../db/supabase.js';
import { synthesizeVoiceover } from '../services/ttsService.js';

const wat = (t: number) => new Date(t + 3600_000).toISOString().slice(5, 16).replace('T', ' ');

/** Admin-only: ALERTS (what went wrong recently + anything missed) and TEST ALERT (proves alerts reach this phone). */
export async function adminAlertCommand(phone: string, text: string): Promise<Reply | null> {
  const t = text.trim();
  if (/^test alert$/i.test(t)) {
    const res = await alertAdmin('test', 'Test alert: if you can read this, failure alerts reach you', '', { key: String(Date.now()), cooldownS: 1 });
    return reply(phone).text(res === 'sent' ? '🧪 Test alert sent: you should see it as its own message just above this one.' : `🧪 Test alert result: ${res}.`);
  }
  // GRANT VIDEOS 08012345678 3: add video credits after a bank transfer (until card payments are live)
  const grant = t.match(/^grant videos?\s+(\+?\d[\d\s]{8,14}\d)\s+(\d{1,3})$/i);
  if (grant) {
    const digits = grant[1]!.replace(/\D/g, '');
    const phoneKey = digits.startsWith('234') ? digits : digits.startsWith('0') ? `234${digits.slice(1)}` : `234${digits}`;
    const { data: biz } = await db.from('businesses').select('id, name').eq('owner_phone', phoneKey).maybeSingle();
    if (!biz) return reply(phone).text(`No shop found for ${grant[1]}. Check the number (the owner's WhatsApp number).`);
    try {
      const qty = Number(grant[2]);
      const balance = await addVideoCredits(biz.id as string, qty);
      if (await isInServiceWindow(phoneKey)) await reply(phoneKey).text(`🎉 ${qty} video credit${qty > 1 ? 's' : ''} added! You now have *${balance}*. Send 2–3 product photos with the name and price to make one.`).send().catch(() => undefined);
      return reply(phone).text(`✅ Added ${qty} video credit${qty > 1 ? 's' : ''} to *${biz.name}*. Balance: ${balance}.`);
    } catch (e) {
      return reply(phone).text(`Could not add credits: ${String((e as Error)?.message ?? e).slice(0, 120)} (has migration 008 been run?)`);
    }
  }
  const tv = t.match(/^test voice(?:\s+(yoruba|pidgin|english))?$/i);
  if (tv) return testVoiceReply(phone, (tv[1] ?? 'english').toLowerCase());
  const sc = t.match(/^(?:score ?card|pilot)(?:\s+(\d{1,2}))?$/i);
  if (sc) return scorecardReply(phone, sc[1] ? Number(sc[1]) : 7);
  if (/^costs?$/i.test(t)) return costsReply(phone);
  if (/^alerts?$/i.test(t)) {
    const list = await recentAlerts(10);
    if (!list.length) return reply(phone).text('✅ No alerts in the last 7 days.');
    return reply(phone).text('*Recent alerts* (newest first)', '', ...list.map((a) => `${wat(a.t)} WAT  ${a.text}`));
  }
  return null;
}

/** Alerts that could not be delivered while the 24h window was closed: handed over the moment the admin messages the bot. */
export async function missedAlertsReply(phone: string): Promise<Reply | null> {
  const missed = await takeMissedAlerts();
  if (!missed.length) return null;
  return reply(phone).text(`📥 *${missed.length} alert${missed.length > 1 ? 's' : ''} while your WhatsApp window was closed*`, '', ...missed.map((m) => m.replace(/^🚨 \*Unbarmore alert\* /, '')));
}

/** Owner/staff asked to delete their data (NDPA right + Meta requirement). Acknowledge now; the platform owner is alerted to fulfil it within 30 days. */
export async function deleteDataRequest(phone: string, who: { business: string; role: string }): Promise<Reply> {
  void alertAdmin('system', `DATA DELETION REQUEST from ${who.business} (…${phone.slice(-4)}, ${who.role})`, 'Fulfil within 30 days: delete the business and its files, then confirm to them on WhatsApp. Keep payment records the law requires.', { key: phone, cooldownS: 86400 });
  return reply(phone).text(
    '🗑️ *Delete my data: request received.*',
    'We will delete your account, records, customers, photos and videos within 30 days and confirm here. Records the law requires us to keep (like payment records) are kept for the legal period.',
    '',
    'Changed your mind? Just keep using Unbarmore and tell us to cancel the request. To only stop messages, send *STOP*.',
  );
}

/** ADMIN: what the AI really cost over the last 7 days, per shop and per kind of work. ESTIMATES (see src/lib/aiCost.ts): compare with Google AI Studio's Spend page. */
async function costsReply(phone: string): Promise<Reply> {
  const since = new Date(Date.now() + 3600_000 - 6 * 86400_000).toISOString().slice(0, 10);
  const { data, error } = await db.from('ai_usage').select('business_id, kind, calls, images, est_cost_ngn').gte('day', since);
  if (error) return reply(phone).text('The usage log is not set up yet. Run migration 008 in Supabase first.');
  if (!data?.length) return reply(phone).text('📊 No AI usage logged yet. It fills as shops use the bot.');
  const byShop = new Map<string, { cost: number; photos: number; calls: number }>();
  const byKind = new Map<string, number>();
  let total = 0, photos = 0;
  for (const r of data) {
    const c = Number(r.est_cost_ngn), k = String(r.kind);
    total += c; photos += Number(r.images);
    byKind.set(k, (byKind.get(k) ?? 0) + c);
    const s = byShop.get(r.business_id as string) ?? { cost: 0, photos: 0, calls: 0 };
    s.cost += c; s.photos += Number(r.images); s.calls += Number(r.calls);
    byShop.set(r.business_id as string, s);
  }
  const ids = [...byShop.keys()];
  const { data: names } = await db.from('businesses').select('id, name').in('id', ids);
  const nameOf = new Map((names ?? []).map((n) => [n.id as string, n.name as string]));
  const top = [...byShop.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
  return reply(phone).text(
    '📊 *AI cost, last 7 days* (estimates)',
    `Total: *${ngn(Math.round(total))}* · ${photos} photos cleaned · ${byShop.size} shop${byShop.size > 1 ? 's' : ''} · average ${ngn(Math.round(total / byShop.size))} per shop`,
    '',
    ...top.map(([id, s], i) => `${i + 1}. ${nameOf.get(id) ?? 'Shop'}: ${ngn(Math.round(s.cost))} (${s.photos} photos, ${s.calls} AI calls)`),
    '',
    `By kind: ${[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k.replace('_', ' ')} ${ngn(Math.round(c))}`).join(' · ')}`,
    '_Estimates from token counts; check Google AI Studio → Spend for the real number._',
  );
}

const VOICE_LINES: Record<string, string> = {
  english: 'Fresh Ankara gown, fifteen thousand naira. Message us on WhatsApp to order today.',
  pidgin: 'Oga, this Ankara gown sweet die! Na fifteen thousand naira only. Message us on WhatsApp make you order today.',
  yoruba: 'Aṣọ Ankara tuntun wà. Ẹ kọ̀wé sí wa lórí WhatsApp láti paṣẹ lónìí.',
};

/** Admin: TEST VOICE [yoruba|pidgin]. Makes a short voiceover through the real pipeline, says which service answered, and sends it so you can listen. */
export async function testVoiceReply(phone: string, lang: string): Promise<Reply> {
  const t0 = Date.now();
  try {
    const v = await synthesizeVoiceover(VOICE_LINES[lang] ?? VOICE_LINES.english!, { pidgin: lang === 'pidgin', yoruba: lang === 'yoruba' });
    const path = await uploadFile('videos', `admin-tests/voice-${Date.now()}.${v.ext}`, v.data, v.mime);
    const who = { cloud: 'Google Cloud Text-to-Speech', gemini: 'Gemini API speech (the capped one)', azure: 'Azure', google: 'Google TTS' }[v.provider ?? 'gemini'];
    return reply(phone).document(await signedUrl('videos', path), `voice-test-${lang}.${v.ext}`)
      .text(`🔊 *Voice test (${lang}) worked* via *${who}* in ${((Date.now() - t0) / 1000).toFixed(1)}s.`, 'Open the file and listen: does it sound right?');
  } catch (e) {
    return reply(phone).text(`🔇 *Voice test (${lang}) FAILED* after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 300), '', 'Videos made now will have music only. Check GOOGLE_TTS_CREDENTIALS_JSON / AZURE_SPEECH_KEY.');
  }
}
