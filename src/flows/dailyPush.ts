import { debtors, ledgerSummary, type Business } from '../db/supabase.js';
import { ngn } from '../lib/money.js';
import type { PushPayload } from '../services/push.js';
import { daysSince, periodRange } from './insights.js';

/**
 * The evening notification. It always says something worth opening the app for, and it is the only message
 * that can reach an owner who has stopped chatting (no WhatsApp 24h window, no template cost).
 */
export async function buildDailyPush(biz: Business): Promise<PushPayload> {
  const { from, to } = periodRange('today');
  const [s, owing] = await Promise.all([ledgerSummary(biz.id, from, to), debtors(biz.id, 3)]);
  const owed = owing.reduce((a, d) => a + d.outstanding_debt_ngn, 0);
  const top = owing[0];
  const base = { url: '/dashboard', tag: 'daily' };

  if (s.tx_count > 0) {
    const bits = [`Sales ${ngn(s.revenue_ngn)}`, `Spent ${ngn(s.expenses_ngn + s.restock_ngn)}`, `Profit ${ngn(s.net_profit_ngn)}`];
    if (s.debt_collected_ngn > 0) bits.unshift(`🎉 ${ngn(s.debt_collected_ngn)} collected`);
    if (owed > 0) bits.push(`${ngn(owed)} still owed to you`);
    return { ...base, title: `${biz.name}: today in numbers`, body: bits.join(' · ') };
  }
  if (top) {
    return { ...base, title: `${ngn(owed)} is still owed to you`, body: `${top.name} owes ${ngn(top.outstanding_debt_ngn)} (${daysSince(top.debt_since)} days). Tap to chase.` };
  }
  return { ...base, title: 'Sold anything today?', body: 'Send a quick voice note on WhatsApp. It takes 5 seconds.' };
}
