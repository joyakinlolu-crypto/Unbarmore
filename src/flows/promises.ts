import { db, type Actor } from '../db/supabase.js';
import { ngn } from '../lib/money.js';
import { promiseLabel } from '../lib/debtReminders.js';
import { reply, type Reply } from '../services/whatsapp.js';

const likeSafe = (s: string) => s.replace(/[%_\\,()]/g, ' ').trim();

/**
 * "Femi will pay Friday": save the promised day on the customer's debt. The 7 AM note already surfaces debts due today,
 * so on Friday morning the owner is reminded to chase. Returns null when no customer who owes money matches the name,
 * so ordinary sentences ("the gele guy pays tomorrow") fall through to the normal router instead of being swallowed.
 */
export async function recordPromise(actor: Actor, nameRaw: string, dateYmd: string): Promise<Reply | null> {
  const name = likeSafe(nameRaw);
  if (name.length < 2) return null;
  const { data } = await db.from('customers').select('id, name, outstanding_debt_ngn')
    .eq('business_id', actor.business.id).gt('outstanding_debt_ngn', 0).ilike('name', `%${name}%`).limit(5);
  const rows = (data ?? []) as { id: string; name: string; outstanding_debt_ngn: number }[];
  if (!rows.length) return null;
  const exact = rows.filter((r) => r.name.toLowerCase() === name.toLowerCase());
  const pick = exact.length === 1 ? exact[0]! : rows.length === 1 ? rows[0]! : null;
  if (!pick) return reply(actor.phone).text(`Which one? ${rows.map((r) => `*${r.name}*`).join(', ')}. Say it again with the full name, like _${rows[0]!.name} will pay Friday_.`);
  await db.from('customers').update({ debt_due_date: dateYmd }).eq('id', pick.id).eq('business_id', actor.business.id);
  return reply(actor.phone).text(
    `✅ Noted: *${pick.name}* (${ngn(Number(pick.outstanding_debt_ngn))}) pays on *${promiseLabel(dateYmd)}*.`,
    `I'll remind you that morning at 7 AM so you can follow up.`,
  );
}
