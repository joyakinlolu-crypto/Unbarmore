import { ledgerSummary, type Business } from '../db/supabase.js';
import { ngn } from '../lib/money.js';

export interface MoneyBack { debtCollected: number; protectedMargin: number; total: number }

/**
 * "Money Unbarmore got back for you": every naira of customer debt collected since day one,
 * plus margin protected by the Inflation Shield. This is the number that proves the app pays for itself.
 */
export async function moneyBack(b: Business): Promise<MoneyBack> {
  const s = await ledgerSummary(b.id, new Date('2000-01-01T00:00:00Z'), new Date(Date.now() + 86_400_000));
  const protectedMargin = Number(b.total_value_recovered_ngn);
  return { debtCollected: s.debt_collected_ngn, protectedMargin, total: s.debt_collected_ngn + protectedMargin };
}

/** One readable line, or null when there is nothing to brag about yet. */
export function moneyBackLine(m: MoneyBack): string | null {
  if (m.total <= 0) return null;
  const parts = [m.debtCollected > 0 ? `${ngn(m.debtCollected)} collected from customers` : '', m.protectedMargin > 0 ? `${ngn(m.protectedMargin)} margin protected` : ''].filter(Boolean);
  return `💰 *Money Unbarmore got back for you: ${ngn(m.total)}* (${parts.join(' + ')})`;
}
