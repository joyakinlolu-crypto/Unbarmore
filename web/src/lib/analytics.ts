/**
 * Everything the Charts page shows, computed from the owner's own confirmed transactions.
 * Plain functions with no I/O so they can be tested; the page only fetches rows and calls these.
 */
const WAT = 3600_000;
const DAY = 86_400_000;

export interface Tx {
  tx_type: 'sale' | 'expense' | 'restock' | 'debt_repayment';
  category: string | null; description: string; total_amount_ngn: number | string; amount_paid_ngn: number | string;
  payment_method: string | null; transaction_date: string;
  customers: { name: string } | null; products: { name: string } | null;
}
export interface DebtorRow { name: string; outstanding_debt_ngn: number | string; debt_since: string | null }
export interface ProductRow { name: string; stock_qty: number | string; cost_price_ngn: number | string; last_sold_at: string | null }

const n = (v: number | string | null | undefined) => Number(v ?? 0);
/** YYYY-MM-DD of the Lagos calendar day */
export const watDay = (iso: string | Date) => new Date((typeof iso === 'string' ? new Date(iso) : iso).getTime() + WAT).toISOString().slice(0, 10);
const label = (day: string) => new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export interface Totals { revenue: number; spend: number; profit: number }
export function totals(rows: Tx[]): Totals {
  let revenue = 0, spend = 0;
  for (const t of rows) {
    if (t.tx_type === 'sale') revenue += n(t.total_amount_ngn);
    else if (t.tx_type === 'expense' || t.tx_type === 'restock') spend += n(t.total_amount_ngn);
  }
  return { revenue, spend, profit: revenue - spend };
}

export interface TrendPoint { label: string; revenue: number; spend: number; profit: number }
/** One point per day (≤ 31 days) or per week (longer). Empty days are kept so gaps are visible. */
export function trend(rows: Tx[], from: Date, days: number): TrendPoint[] {
  const per = new Map<string, { revenue: number; spend: number }>();
  for (const t of rows) {
    const k = watDay(t.transaction_date); const e = per.get(k) ?? { revenue: 0, spend: 0 };
    if (t.tx_type === 'sale') e.revenue += n(t.total_amount_ngn);
    else if (t.tx_type === 'expense' || t.tx_type === 'restock') e.spend += n(t.total_amount_ngn);
    per.set(k, e);
  }
  const keys = Array.from({ length: days }, (_, i) => watDay(new Date(from.getTime() + i * DAY)));
  const size = days <= 31 ? 1 : 7;
  const out: TrendPoint[] = [];
  for (let i = 0; i < keys.length; i += size) {
    const slice = keys.slice(i, i + size);
    const revenue = slice.reduce((a, k) => a + (per.get(k)?.revenue ?? 0), 0);
    const spend = slice.reduce((a, k) => a + (per.get(k)?.spend ?? 0), 0);
    out.push({ label: label(slice[0]!), revenue, spend, profit: revenue - spend });
  }
  return out;
}

export interface Bar { label: string; value: number; sub?: string }
const topN = (m: Map<string, { v: number; c: number }>, k: number): Bar[] =>
  [...m].sort((a, b) => b[1].v - a[1].v).slice(0, k).map(([label, e]) => ({ label, value: e.v, sub: e.c > 1 ? `${e.c} sales` : '1 sale' }));

export function topProducts(rows: Tx[], k = 6): Bar[] {
  const m = new Map<string, { v: number; c: number }>();
  for (const t of rows) if (t.tx_type === 'sale') { const name = t.products?.name ?? t.description.replace(/^\d+(\.\d+)?\s*[×x]\s*/i, '') ?? 'Other'; const e = m.get(name) ?? { v: 0, c: 0 }; e.v += n(t.total_amount_ngn); e.c++; m.set(name, e); }
  return topN(m, k);
}
export function topCustomers(rows: Tx[], k = 6): Bar[] {
  const m = new Map<string, { v: number; c: number }>();
  for (const t of rows) if (t.tx_type === 'sale' && t.customers?.name) { const e = m.get(t.customers.name) ?? { v: 0, c: 0 }; e.v += n(t.total_amount_ngn); e.c++; m.set(t.customers.name, e); }
  return topN(m, k);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Sales by weekday, Monday first. */
export function weekdays(rows: Tx[]): Bar[] {
  const sums = new Array(7).fill(0) as number[];
  for (const t of rows) if (t.tx_type === 'sale') sums[new Date(new Date(t.transaction_date).getTime() + WAT).getUTCDay()]! += n(t.total_amount_ngn);
  return [1, 2, 3, 4, 5, 6, 0].map((d) => ({ label: DAYS[d]!.slice(0, 3), value: sums[d]!, sub: DAYS[d]! }));
}

export interface Slice { label: string; value: number; color: string }
const METHOD = { cash: ['Cash', '#16A34A'], transfer: ['Transfer', '#2563EB'], pos: ['POS', '#7C3AED'] } as const;
/** How money actually arrived (sales paid + old debts collected), plus new sales still on credit. */
export function paymentMix(rows: Tx[]): Slice[] {
  const got = { cash: 0, transfer: 0, pos: 0, other: 0 }; let credit = 0;
  for (const t of rows) {
    if (t.tx_type !== 'sale' && t.tx_type !== 'debt_repayment') continue;
    const paid = n(t.amount_paid_ngn); const m = (t.payment_method ?? '') as keyof typeof METHOD;
    if (m in METHOD) got[m] += paid; else got.other += paid;
    if (t.tx_type === 'sale') credit += Math.max(0, n(t.total_amount_ngn) - paid);
  }
  return [
    ...(Object.keys(METHOD) as (keyof typeof METHOD)[]).map((k) => ({ label: METHOD[k][0], value: got[k], color: METHOD[k][1] })),
    { label: 'Other / not stated', value: got.other, color: '#94A3B8' },
    { label: 'Still on credit', value: credit, color: '#E11D48' },
  ].filter((s) => s.value > 0);
}

export function expenseBreakdown(rows: Tx[], k = 7): Bar[] {
  const m = new Map<string, { v: number; c: number }>();
  for (const t of rows) {
    if (t.tx_type !== 'expense' && t.tx_type !== 'restock') continue;
    const name = t.tx_type === 'restock' ? 'Stock bought' : (t.category || 'Other'); const e = m.get(name) ?? { v: 0, c: 0 }; e.v += n(t.total_amount_ngn); e.c++; m.set(name, e);
  }
  return topN(m, k);
}

/** Who owes you, by how long: the old ones are the hardest to collect. */
export function debtAging(list: DebtorRow[], now = Date.now()): Bar[] {
  const b = [{ label: '0–7 days', value: 0 }, { label: '8–30 days', value: 0 }, { label: '31–60 days', value: 0 }, { label: '60+ days', value: 0 }];
  for (const d of list) {
    const age = d.debt_since ? Math.floor((now - new Date(d.debt_since).getTime()) / DAY) : 0;
    b[age <= 7 ? 0 : age <= 30 ? 1 : age <= 60 ? 2 : 3]!.value += n(d.outstanding_debt_ngn);
  }
  return b;
}

export function stockHealth(products: ProductRow[], now = Date.now()) {
  const out = products.filter((p) => n(p.stock_qty) <= 0).map((p) => p.name);
  const low = products.filter((p) => n(p.stock_qty) > 0 && n(p.stock_qty) <= 2).map((p) => `${p.name} (${n(p.stock_qty)} left)`);
  const dead = products.filter((p) => n(p.stock_qty) > 0 && p.last_sold_at && now - new Date(p.last_sold_at).getTime() > 21 * DAY);
  return { out, low, deadCount: dead.length, deadValue: dead.reduce((a, p) => a + n(p.stock_qty) * n(p.cost_price_ngn), 0) };
}

// ─────────── one plain-language takeaway per chart ───────────
const money = (v: number) => '₦' + Math.round(v).toLocaleString('en-NG');
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

export function trendInsight(t: Totals, pts: TrendPoint[], daily: boolean): string {
  if (t.revenue === 0 && t.spend === 0) return 'Nothing recorded in this period yet.';
  const best = [...pts].sort((a, b) => b.profit - a.profit)[0]!;
  return `${t.profit >= 0 ? 'You made' : 'You lost'} ${money(Math.abs(t.profit))} (${money(t.revenue)} in, ${money(t.spend)} out). Best ${daily ? 'day' : 'week'}: ${best.label} at ${money(best.profit)}.`;
}
export function weekdayInsight(bars: Bar[]): string {
  const total = bars.reduce((a, b) => a + b.value, 0); if (!total) return 'No sales in this period yet.';
  const best = [...bars].sort((a, b) => b.value - a.value)[0]!; const worst = [...bars].sort((a, b) => a.value - b.value)[0]!;
  return `${best.sub} is your strongest day (${money(best.value)}, ${pct(best.value, total)}% of sales). ${worst.sub} is your slowest. A promo on ${worst.sub} could fill the gap.`;
}
export function productInsight(bars: Bar[], revenue: number): string {
  if (!bars.length) return 'No sales in this period yet.';
  return `${bars[0]!.label} brings in ${pct(bars[0]!.value, revenue)}% of your sales. Keep it in stock and make a video for it.`;
}
export function customerInsight(bars: Bar[], revenue: number): string {
  if (!bars.length) return 'Name the buyer when you log a sale and your best customers show up here.';
  return `${bars[0]!.label} spent ${money(bars[0]!.value)}, ${pct(bars[0]!.value, revenue)}% of all sales. Thank them, and ask who they can bring.`;
}
export function paymentInsight(s: Slice[]): string {
  const total = s.reduce((a, x) => a + x.value, 0); if (!total) return 'No payments in this period yet.';
  const top = [...s].filter((x) => x.label !== 'Still on credit').sort((a, b) => b.value - a.value)[0];
  const credit = s.find((x) => x.label === 'Still on credit')?.value ?? 0;
  return `${top ? `${top.label} is ${pct(top.value, total)}% of the flow. ` : ''}${credit > 0 ? `${money(credit)} of new sales went out on credit: follow it up.` : 'Nothing new went out on credit.'}`;
}
export function expenseInsight(bars: Bar[]): string {
  const total = bars.reduce((a, b) => a + b.value, 0); if (!total) return 'No expenses in this period yet.';
  return `${bars[0]!.label} is your biggest cost: ${money(bars[0]!.value)} (${pct(bars[0]!.value, total)}% of spending).`;
}
export function agingInsight(bars: Bar[]): string {
  const total = bars.reduce((a, b) => a + b.value, 0); if (!total) return 'Nobody owes you money.';
  const old = bars[2]!.value + bars[3]!.value;
  return old > 0 ? `${money(old)} has been owed for over 30 days (${pct(old, total)}% of what you're owed). Chase these first.` : `All ${money(total)} owed to you is under 30 days old. Collect before it gets old.`;
}
export function compareInsight(cur: Totals, prev: Totals): string {
  if (!prev.revenue && !prev.spend) return 'Not enough history yet to compare.';
  if (!prev.revenue) return `Sales this period: ${money(cur.revenue)}. Last period had none.`;
  const ch = Math.round(((cur.revenue - prev.revenue) / prev.revenue) * 100);
  return `Sales are ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch)}% on the period before (${money(cur.revenue)} vs ${money(prev.revenue)}).`;
}
