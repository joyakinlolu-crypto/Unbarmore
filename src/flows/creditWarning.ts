import { db, type TxnDraft } from '../db/supabase.js';
import { ngn } from '../lib/money.js';
import { daysSince } from './insights.js';

/** Warn only when a customer already owes this much OR has owed for this long: a ₦500 balance doesn't deserve a lecture. */
export const WARN_DEBT_NGN = 10_000;
export const WARN_DEBT_DAYS = 14;

/** Pure: "Ada already owes ₦45,000 (21 days)". null = no warning. */
export function creditWarningText(name: string, owes: number, days: number): string | null {
  if (!(owes >= WARN_DEBT_NGN || (owes > 0 && days >= WARN_DEBT_DAYS))) return null;
  return `⚠️ *${name}* already owes you ${ngn(owes)}${days >= 1 ? ` (${days} days)` : ''}, and this sale adds more on credit. Collect first? Say *CHASE* for the reminder.`;
}

/**
 * Before the owner confirms a credit sale, say so if that customer is already a slow payer. Stops the leak at the door,
 * which is cheaper than chasing later. Pure arithmetic on records we already hold: no AI call, no cost.
 */
export async function creditWarning(businessId: string, drafts: TxnDraft[]): Promise<string | null> {
  const credit = drafts.find((d) => d.tx_type === 'sale' && d.customer_name && d.total_amount_ngn - d.amount_paid_ngn > 0);
  if (!credit?.customer_name) return null;
  const { data } = await db.from('customers').select('name, outstanding_debt_ngn, debt_since')
    .eq('business_id', businessId).ilike('name', credit.customer_name.replace(/[%_\\,()]/g, ' ').trim()).maybeSingle();
  if (!data) return null;
  return creditWarningText(data.name as string, Number(data.outstanding_debt_ngn), daysSince(data.debt_since as string | null));
}
