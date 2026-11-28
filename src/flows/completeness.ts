import { db } from '../db/supabase.js';
import { watDateKey } from '../lib/money.js';
import { completenessLine } from '../lib/completeness.js';

const DAY_MS = 86_400_000;

/** How many Lagos days in [from, to) have at least one confirmed record. Never throws: a missing line is better than a failed reply. */
export async function daysWithEntries(businessId: string, from: Date, to: Date): Promise<number> {
  try {
    const { data } = await db.from('transactions').select('transaction_date')
      .eq('business_id', businessId).eq('status', 'confirmed').gte('transaction_date', from.toISOString()).lt('transaction_date', to.toISOString()).limit(5000);
    return new Set((data ?? []).map((r) => watDateKey(new Date(r.transaction_date as string)))).size;
  } catch { return 0; }
}

/** The "how complete is this?" line for a summary over [from, to). */
export async function completenessFor(
  businessId: string, from: Date, to: Date, s: { tx_count: number; revenue_ngn: number; unpriced_revenue_ngn?: number },
): Promise<string | null> {
  const daysInPeriod = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const days = daysInPeriod > 1 ? await daysWithEntries(businessId, from, to) : 1;
  return completenessLine({ txCount: s.tx_count, revenue: s.revenue_ngn, unpriced: s.unpriced_revenue_ngn ?? 0, daysWithEntries: days, daysInPeriod });
}
