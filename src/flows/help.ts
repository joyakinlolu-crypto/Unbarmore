import { alertAdmin } from '../lib/alerts.js';
import { env } from '../config/env.js';
import { db, type Actor } from '../db/supabase.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { HELP_TOPICS, PERSON_ID, matchHelpTopic, topicById } from '../lib/help.js';

/** Remember what people get stuck on. Never blocks or fails a reply (the table needs migration 016). */
async function logHelp(businessId: string, topic: string, escalated: boolean): Promise<void> {
  try { await db.from('help_events').insert({ business_id: businessId, topic, escalated }); } catch { /* not set up yet */ }
}

/** HELP: pick your problem from a list. */
export function helpPicker(phone: string): Reply {
  return reply(phone)
    .text('🆘 *What do you need help with?*', 'Pick one and I will show you what to do. Or send *HELP* and then tell me what went wrong, like _HELP my video did not come_.')
    .listMenu('Choose a problem', [
      ...HELP_TOPICS.map((t) => ({ id: `HELP:${t.id}`, title: t.title, description: t.description })).slice(0, 9),
      { id: `HELP:${PERSON_ID}`, title: 'Talk to a person', description: 'Something else, or it is still not working' },
    ]);
}

/** The fix for one topic, with a way to say "that worked" or "get me a person". */
export async function helpTopicReply(actor: Actor, id: string): Promise<Reply> {
  if (id === PERSON_ID) return helpPerson(actor, '');
  const t = topicById(id);
  if (!t) return helpPicker(actor.phone);
  void logHelp(actor.business.id, t.id, false);
  return reply(actor.phone).text(...t.steps)
    .button('HELP:ok', '✅ That fixed it').button(`HELP:${PERSON_ID}`, '🧑 Talk to a person').button('HELP:more', '📋 Other problems');
}

/** "HELP my video did not come": answer from the matching topic, or pass it to a person when nothing fits. */
export async function helpFromText(actor: Actor, text: string): Promise<Reply> {
  if (!text) return helpPicker(actor.phone);
  const t = matchHelpTopic(text);
  return t ? helpTopicReply(actor, t.id) : helpPerson(actor, text);
}

/** Tell the admin who is stuck, and what they said. One alert per shop per hour so a stuck owner cannot flood you. */
export async function helpPerson(actor: Actor, text: string): Promise<Reply> {
  const b = actor.business;
  void logHelp(b.id, text ? 'free_text' : PERSON_ID, true);
  void alertAdmin('system', `HELP REQUEST from ${b.name} (${b.owner_phone})${text ? `: "${text.slice(0, 200)}"` : ''}`,
    `Plan ${b.subscription_tier}. Reply to them on WhatsApp.`, { key: `help:${b.id}`, cooldownS: 3600 });
  return reply(actor.phone).text(
    '🧑 *I have told the team.*',
    text ? 'We have your message. Add anything that helps by sending *HELP* and then what went wrong, with a screenshot if you can.' : 'Please send *HELP* and then what went wrong, like _HELP my video did not come_. A screenshot helps a lot.',
    env.SUPPORT_WHATSAPP_URL ? `Or chat with us directly: ${env.SUPPORT_WHATSAPP_URL}` : '',
  );
}

/** Admin scorecard line: what people got stuck on in the last 7 days. null when nothing logged. */
export async function helpSummaryLine(): Promise<string | null> {
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data } = await db.from('help_events').select('topic, escalated').gte('created_at', since).limit(5000);
    const rows = (data ?? []) as { topic: string; escalated: boolean }[];
    if (!rows.length) return null;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.topic, (counts.get(r.topic) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(' · ');
    return `🆘 Help asked (7 days): ${rows.length} · wanted a person ${rows.filter((r) => r.escalated).length} · most: ${top}`;
  } catch { return null; }
}
