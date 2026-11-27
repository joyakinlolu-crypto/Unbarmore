import { db } from '../db/supabase.js';
import { daysLeft, quoteLabel } from '../lib/quote.js';
import { watDateKey } from '../lib/money.js';

/** Open quotes that expire tomorrow/today or expired yesterday: for the 7 AM note. Only plans with a validity window have any. */
export interface QuoteDue { label: string; customer: string | null; total: number; left: number }
export async function quotesDue(businessId: string, today = watDateKey()): Promise<QuoteDue[]> {
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const { data } = await db.from('quotes').select('quote_no, customer_name, total_ngn, valid_until').eq('business_id', businessId).eq('status', 'open')
    .gte('valid_until', day(-1)).lte('valid_until', day(1)).order('valid_until', { ascending: true }).limit(5);
  return ((data ?? []) as { quote_no: number; customer_name: string | null; total_ngn: string; valid_until: string }[])
    .map((r) => ({ label: quoteLabel(Number(r.quote_no)), customer: r.customer_name, total: Number(r.total_ngn), left: daysLeft(r.valid_until, today) ?? 0 }));
}

