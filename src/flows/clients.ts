import { db, type Actor } from '../db/supabase.js';
import { ngn } from '../lib/money.js';
import { writeCustomerMessages } from '../services/geminiBrain.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { daysSince } from './insights.js';
import { waLink } from '../lib/waLink.js';

/** A customer as the owner sees them: what they've spent, when they last bought, what they owe. */
export interface ClientStat { id: string; name: string; phone: string | null; spent: number; owes: number; lastBuy: string | null; createdAt: string }

export const LAPSED_AFTER_DAYS = 30;

export async function clientStats(businessId: string): Promise<ClientStat[]> {
  const [{ data: cs }, { data: tx }] = await Promise.all([
    db.from('customers').select('id, name, phone_number, total_spent_ngn, outstanding_debt_ngn, created_at').eq('business_id', businessId).limit(2000),
    db.from('transactions').select('customer_id, transaction_date').eq('business_id', businessId).eq('tx_type', 'sale').eq('status', 'confirmed')
      .not('customer_id', 'is', null).order('transaction_date', { ascending: false }).limit(5000),
  ]);
  const last = new Map<string, string>();
  for (const t of tx ?? []) if (!last.has(t.customer_id as string)) last.set(t.customer_id as string, t.transaction_date as string);
  return (cs ?? []).map((c) => ({
    id: c.id as string, name: c.name as string, phone: (c.phone_number as string | null) ?? null, spent: Number(c.total_spent_ngn), owes: Number(c.outstanding_debt_ngn),
    lastBuy: last.get(c.id as string) ?? null, createdAt: c.created_at as string,
  }));
}

/** Customers who bought before but not in the last `days` days, biggest spenders first. */
export function lapsed(stats: ClientStat[], days = LAPSED_AFTER_DAYS): ClientStat[] {
  return stats.filter((c) => c.lastBuy && daysSince(c.lastBuy) >= days).sort((a, b) => b.spent - a.spent);
}

const ago = (iso: string | null) => { if (!iso) return 'no purchase yet'; const d = daysSince(iso); return d < 1 ? 'bought today' : d === 1 ? 'bought yesterday' : `last bought ${d} days ago`; };

export function myClientsText(stats: ClientStat[]): string {
  if (!stats.length) return 'You have no customers on your list yet. Name the buyer when you log a sale ("sold 2 lace 50k to Mama Tunde"), or send me a list: _add my customers: Femi 08031234567, Kalu 08051234567_';
  const top = [...stats].sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name)).slice(0, 15);
  const gone = lapsed(stats).length;
  return [
    `*Your customers — ${stats.length} on your list*`,
    ...top.map((c, i) => `${i + 1}. ${c.name} — ${ngn(c.spent)} spent · ${ago(c.lastBuy)}${c.owes > 0 ? ` · owes ${ngn(c.owes)}` : ''}${c.phone ? ' 📞' : ''}`),
    stats.length > top.length ? `…and ${stats.length - top.length} more in your dashboard.` : '',
    '',
    gone > 0 ? `👋 ${gone} ${gone === 1 ? 'customer hasn\'t' : 'customers haven\'t'} bought in ${LAPSED_AFTER_DAYS}+ days. Say *WIN BACK* for ready-to-send messages.` : '',
    '📞 = I have their number, so messages open straight to their chat.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

export function lapsedText(stats: ClientStat[]): string {
  const list = lapsed(stats);
  if (!list.length) return `🎉 Nobody has gone quiet. Every customer on your list has bought within ${LAPSED_AFTER_DAYS} days.`;
  return [
    `*Customers who stopped buying (${LAPSED_AFTER_DAYS}+ days)*`,
    ...list.slice(0, 15).map((c, i) => `${i + 1}. ${c.name} — ${ago(c.lastBuy)} · spent ${ngn(c.spent)}`),
    '',
    'A past customer is the cheapest sale you can make. Say *WIN BACK* and I\'ll write the messages.',
  ].join('\n');
}

const firstName = (n: string) => n.trim().split(/\s+/)[0]!;

/**
 * Ready-to-send messages for customers who went quiet ('winback') or best customers ('thank_top'). The owner sends them
 * (free, from their own WhatsApp): we never message customers ourselves, so there is no template cost and no spam risk.
 */
export async function customerMessagesReply(actor: Actor, kind: 'winback' | 'thank_top'): Promise<Reply> {
  const stats = await clientStats(actor.business.id);
  const pool = kind === 'winback' ? lapsed(stats) : [...stats].filter((c) => c.spent > 0).sort((a, b) => b.spent - a.spent);
  const pick = pool.slice(0, 5);
  if (!pick.length) {
    return reply(actor.phone).text(kind === 'winback'
      ? '🎉 Nobody has gone quiet, so there is nobody to win back right now.'
      : 'I need a few sales with customer names first. Name the buyer when you log a sale, like "sold 2 lace 50k to Mama Tunde".');
  }
  const msgs = await writeCustomerMessages(actor.business.name, kind, pick.map((c) => ({ name: firstName(c.name), daysSinceLastBuy: c.lastBuy ? daysSince(c.lastBuy) : null, totalSpent: ngn(c.spent) })));
  const byName = new Map(msgs.map((m) => [m.customer.toLowerCase(), m.message]));
  const lines: string[] = [kind === 'winback' ? '💌 *Win-back messages. Tap the link to send, or copy:*' : '🙏 *Thank-you messages for your best customers:*'];
  for (const c of pick) {
    const message = byName.get(firstName(c.name).toLowerCase()) ?? msgs[pick.indexOf(c)]?.message;
    if (!message) continue;
    const link = waLink(c.phone, message);
    lines.push('', `*${c.name}*${kind === 'winback' ? ` (${ago(c.lastBuy)})` : ` (${ngn(c.spent)} spent)`}`, message, link ? `👉 ${link}` : '_(no number saved: copy and send)_');
  }
  lines.push('', 'Tip: save their numbers (_Femi\'s number is 0803…_) so these open straight to their chat.');
  return reply(actor.phone).text(...lines);
}
