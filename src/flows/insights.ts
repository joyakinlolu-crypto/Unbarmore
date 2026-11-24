/**
 * Every number a user sees is computed here from PostgreSQL. The LLM only chooses WHICH query.
 */
import {
  db, debtors, deadStock, expensesByCategory, ledgerSummary, lowStock, topProducts, type Business,
} from '../db/supabase.js';
import { ngn, watDayStart } from '../lib/money.js';

export type Period = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month';

export function periodRange(p: Period, now = new Date()): { from: Date; to: Date; label: string } {
  const day = watDayStart(now);
  const D = 86400_000;
  // WAT weekday (Mon=0)
  const watNow = new Date(now.getTime() + 3600_000);
  const dow = (watNow.getUTCDay() + 6) % 7;
  const weekStart = new Date(day.getTime() - dow * D);
  const monthStart = (() => {
    const m = new Date(Date.UTC(watNow.getUTCFullYear(), watNow.getUTCMonth(), 1));
    return new Date(m.getTime() - 3600_000);
  })();
  const prevMonthStart = (() => {
    const m = new Date(Date.UTC(watNow.getUTCFullYear(), watNow.getUTCMonth() - 1, 1));
    return new Date(m.getTime() - 3600_000);
  })();
  switch (p) {
    case 'today': return { from: day, to: new Date(day.getTime() + D), label: 'today' };
    case 'yesterday': return { from: new Date(day.getTime() - D), to: day, label: 'yesterday' };
    case 'this_week': return { from: weekStart, to: new Date(day.getTime() + D), label: 'this week' };
    case 'last_week': return { from: new Date(weekStart.getTime() - 7 * D), to: weekStart, label: 'last week' };
    case 'this_month': return { from: monthStart, to: new Date(day.getTime() + D), label: 'this month' };
    case 'last_month': return { from: prevMonthStart, to: monthStart, label: 'last month' };
  }
}

export const daysSince = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000)) : 0);

export async function todayLine(businessId: string): Promise<string> {
  const { from, to } = periodRange('today');
  const s = await ledgerSummary(businessId, from, to);
  return `📊 Today: Sales ${ngn(s.revenue_ngn)} · Spent ${ngn(s.expenses_ngn + s.restock_ngn)} · Profit *${ngn(s.net_profit_ngn)}*`;
}

export async function answerQuery(
  b: Business,
  q: { kind: string; period?: Period; product_name?: string; customer_name?: string },
): Promise<string> {
  const period = q.period ?? (q.kind === 'cash_today' ? 'today' : 'this_week');
  const { from, to, label } = periodRange(period);

  switch (q.kind) {
    case 'profit':
    case 'cash_today': {
      const s = await ledgerSummary(b.id, from, to);
      if (s.tx_count === 0) return `No confirmed records ${label} yet. Send a voice note like "sold 2 lace 50k" to start.`;
      return [
        `*${b.name} — ${label}*`,
        `Sales: ${ngn(s.revenue_ngn)}`,
        `Expenses: ${ngn(s.expenses_ngn)}`,
        `Stock bought: ${ngn(s.restock_ngn)}`,
        `*Net profit: ${ngn(s.net_profit_ngn)}*`,
        `Cash/transfer received: ${ngn(s.cash_in_ngn)}${s.debt_collected_ngn ? ` (incl. ${ngn(s.debt_collected_ngn)} old debts)` : ''}`,
      ].join('\n');
    }
    case 'debtors': {
      if (q.customer_name) {
        const { data } = await db.from('customers').select('name, outstanding_debt_ngn, debt_since').eq('business_id', b.id).ilike('name', `%${q.customer_name.trim().replace(/[%_]/g, '')}%`).limit(5);
        if (!data?.length) return `I have no customer called "${q.customer_name}" yet.`;
        return data.map((c) => Number(c.outstanding_debt_ngn) > 0
          ? `${c.name} owes you ${ngn(Number(c.outstanding_debt_ngn))}${c.debt_since && daysSince(c.debt_since as string) >= 1 ? ` (${daysSince(c.debt_since as string)} days)` : ''}.`
          : `${c.name} owes you nothing.`).join('\n');
      }
      const list = await debtors(b.id, 15);
      if (!list.length) return '🎉 Nobody owes you money right now.';
      const total = list.reduce((s, d) => s + d.outstanding_debt_ngn, 0);
      return [
        `*Customers owing you — ${ngn(total)} total*`,
        ...list.map((d, i) => `${i + 1}. ${d.name} — ${ngn(d.outstanding_debt_ngn)}${d.debt_since && daysSince(d.debt_since) >= 1 ? ` (${daysSince(d.debt_since)}d)` : ''}`),
        '',
        'Reply *CHASE* for ready-to-forward reminder messages.',
      ].join('\n');
    }
    case 'top_products': {
      const list = await topProducts(b.id, from, to, 5);
      if (!list.length) return `No sales recorded ${label}.`;
      return [`*Best sellers ${label}*`, ...list.map((p, i) => `${i + 1}. ${p.name} — ${p.qty} sold · ${ngn(p.revenue)}`)].join('\n');
    }
    case 'top_customers': {
      const { data } = await db.from('transactions').select('total_amount_ngn, customers(name)').eq('business_id', b.id).eq('tx_type', 'sale').eq('status', 'confirmed')
        .not('customer_id', 'is', null).gte('transaction_date', from.toISOString()).lt('transaction_date', to.toISOString()).limit(5000);
      const sums = new Map<string, number>();
      for (const r of (data ?? []) as unknown as { total_amount_ngn: string; customers: { name: string } | null }[]) {
        if (r.customers?.name) sums.set(r.customers.name, (sums.get(r.customers.name) ?? 0) + Number(r.total_amount_ngn));
      }
      const top = [...sums].sort((x, y) => y[1] - x[1]).slice(0, 5);
      if (!top.length) return `No sales with a customer name ${label} yet. Name the buyer when you log a sale, like "sold 2 lace 50k to Mama Tunde".`;
      return [`*Best customers ${label}*`, ...top.map(([n, v], i) => `${i + 1}. ${n} — ${ngn(v)}`)].join('\n');
    }
    case 'dead_stock': {
      const list = await deadStock(b.id);
      if (!list.length) return 'No dead stock — everything has sold in the last 21 days. 💪';
      return [
        '*Not moving (21+ days)*',
        ...list.map((p) => `• ${p.name} — ${p.stock_qty} left, ${daysSince(p.last_sold_at)}d since last sale`),
        '',
        'Reply *PROMO* and I\'ll make a 48-hour flash-sale video for the oldest one.',
      ].join('\n');
    }
    case 'expenses_by_category': {
      const list = await expensesByCategory(b.id, from, to);
      if (!list.length) return `No expenses recorded ${label}.`;
      return [`*Expenses ${label}*`, ...list.map((e) => `• ${e.category}: ${ngn(e.amount)}`)].join('\n');
    }
    case 'stock_level': {
      const list = await lowStock(b.id, q.product_name);
      if (!list.length) return q.product_name ? `I don't have "${q.product_name}" yet. Log a restock like "bought 10 ${q.product_name} 4k each".` : 'No products yet.';
      return ['*Stock left*', ...list.map((p) => `• ${p.name}: ${Math.max(0, Number(p.stock_qty))}`)].join('\n');
    }
    default:
      return 'I can tell you: profit, who owes you, best sellers, dead stock, expenses, stock left.';
  }
}
