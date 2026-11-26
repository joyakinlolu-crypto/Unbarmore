import { alertAdmin, recentAlerts, takeMissedAlerts } from '../lib/alerts.js';
import { reply, type Reply } from '../services/whatsapp.js';

const wat = (t: number) => new Date(t + 3600_000).toISOString().slice(5, 16).replace('T', ' ');

/** Admin-only: ALERTS (what went wrong recently + anything missed) and TEST ALERT (proves alerts reach this phone). */
export async function adminAlertCommand(phone: string, text: string): Promise<Reply | null> {
  const t = text.trim();
  if (/^test alert$/i.test(t)) {
    const res = await alertAdmin('test', 'Test alert: if you can read this, failure alerts reach you', '', { key: String(Date.now()), cooldownS: 1 });
    return reply(phone).text(res === 'sent' ? '🧪 Test alert sent: you should see it as its own message just above this one.' : `🧪 Test alert result: ${res}.`);
  }
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
