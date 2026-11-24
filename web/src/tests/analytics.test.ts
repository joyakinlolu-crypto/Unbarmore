import { describe, expect, it } from 'vitest';
import {
  agingInsight, compareInsight, debtAging, expenseBreakdown, paymentInsight, paymentMix, stockHealth, topCustomers, topProducts, totals, trend, trendInsight, watDay, weekdayInsight, weekdays, type Tx,
} from '@/lib/analytics';

const DAY = 86_400_000;
// 2026-11-23 is a Monday (Lagos). Noon WAT = 11:00 UTC.
const at = (day: string) => `${day}T11:00:00Z`;
let id = 0;
const tx = (o: Partial<Tx> & { day: string }): Tx => ({
  tx_type: 'sale', category: null, description: '1 × Lace', total_amount_ngn: 10000, amount_paid_ngn: 10000, payment_method: 'cash', transaction_date: at(o.day), customers: null, products: { name: 'Lace' }, ...o,
}) as Tx;

const rows: Tx[] = [
  tx({ day: '2026-11-23', quantity: 2, unit_cost_ngn: 15000, total_amount_ngn: 50000, amount_paid_ngn: 30000, payment_method: 'transfer', customers: { name: 'Mama Tunde' } }),   // Mon, 20k on credit, cost 30k
  tx({ day: '2026-11-23', quantity: 1, unit_cost_ngn: 12000, total_amount_ngn: 20000, amount_paid_ngn: 20000, products: { name: 'Gele' }, customers: { name: 'Bisi' } }),       // cost 12k
  tx({ day: '2026-11-28', quantity: 5, unit_cost_ngn: 8000, total_amount_ngn: 100000, amount_paid_ngn: 100000, payment_method: 'pos', customers: { name: 'Mama Tunde' } }),      // Sat, cost 40k
  tx({ day: '2026-11-24', tx_type: 'expense', category: 'Fuel/Diesel', total_amount_ngn: 15000, amount_paid_ngn: 15000, products: null }),
  tx({ day: '2026-11-24', tx_type: 'restock', total_amount_ngn: 40000, amount_paid_ngn: 40000, products: { name: 'Lace' } }),
  tx({ day: '2026-11-25', tx_type: 'debt_repayment', total_amount_ngn: 12000, amount_paid_ngn: 12000, payment_method: 'cash', products: null, customers: { name: 'Femi' } }),
];

describe('analytics', () => {
  it('TRUE profit = sales − cost of goods sold − running costs; stock bought is NOT a cost; old-debt payments are not sales', () => {
    expect(totals(rows)).toEqual({ revenue: 170000, cogs: 82000, running: 15000, stockBought: 40000, spend: 97000, profit: 73000, unpriced: 0 });
  });
  it('selling stock bought earlier is not 100% profit, and buying stock is not a loss', () => {
    const sale = tx({ day: '2026-11-23', quantity: 10, unit_cost_ngn: 15000, total_amount_ngn: 200000, amount_paid_ngn: 200000 });
    const buy = tx({ day: '2026-11-24', tx_type: 'restock', total_amount_ngn: 700000, amount_paid_ngn: 700000, products: null });
    expect(totals([sale]).profit).toBe(50000);            // was 200000 before the fix
    expect(totals([sale, buy]).profit).toBe(50000);       // was −500000 before the fix
  });
  it('sales with no cost price are flagged: profit is "at most" and the gap is reported', () => {
    const t = totals([tx({ day: '2026-11-23', total_amount_ngn: 30000, amount_paid_ngn: 30000 }), tx({ day: '2026-11-23', quantity: 1, unit_cost_ngn: 10000, total_amount_ngn: 20000, amount_paid_ngn: 20000 })]);
    expect(t).toMatchObject({ revenue: 50000, cogs: 10000, unpriced: 30000, profit: 40000 });
    expect(trendInsight(t, trend([], new Date('2026-11-22T23:00:00Z'), 1), true)).toContain('Up to');
  });
  it('trend: one point per Lagos day, empty days kept, profit per day', () => {
    const pts = trend(rows, new Date('2026-11-22T23:00:00Z'), 7); // starts Mon 23 Nov WAT
    expect(pts).toHaveLength(7);
    expect(pts.map((p) => p.revenue)).toEqual([70000, 0, 0, 0, 0, 100000, 0]);
    expect(pts[0]).toMatchObject({ spend: 42000, profit: 28000 });    // Monday: goods sold cost 30k + 12k
    expect(pts[1]).toMatchObject({ spend: 15000, profit: -15000 });   // Tuesday: only the fuel; the 40k stock purchase is not a cost
  });
  it('trend: long ranges are grouped weekly', () => {
    expect(trend(rows, new Date('2026-09-01T00:00:00Z'), 90)).toHaveLength(13);
  });
  it('a late-evening sale counts on the Lagos day, not the UTC day', () => {
    expect(watDay('2026-11-23T23:30:00Z')).toBe('2026-11-24');
  });
  it('top products and customers rank by money, not count', () => {
    expect(topProducts(rows)).toEqual([{ label: 'Lace', value: 150000, sub: '2 sales' }, { label: 'Gele', value: 20000, sub: '1 sale' }]);
    expect(topCustomers(rows).map((b) => [b.label, b.value])).toEqual([['Mama Tunde', 150000], ['Bisi', 20000]]);
  });
  it('weekdays: Monday-first, and the insight names the best and slowest day', () => {
    const w = weekdays(rows);
    expect(w.map((b) => b.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(w[0]!.value).toBe(70000); expect(w[5]!.value).toBe(100000);
    expect(weekdayInsight(w)).toContain('Saturday is your strongest day (₦100,000, 59% of sales)');
  });
  it('payment mix: money received by method, plus new sales still on credit', () => {
    const mix = Object.fromEntries(paymentMix(rows).map((s) => [s.label, s.value]));
    expect(mix).toEqual({ Cash: 32000 + 0, Transfer: 30000, POS: 100000, 'Still on credit': 20000 });
    expect(paymentInsight(paymentMix(rows))).toContain('₦20,000 of new sales went out on credit');
  });
  it('expense breakdown separates stock bought from running costs', () => {
    expect(expenseBreakdown(rows).map((b) => [b.label, b.value])).toEqual([['Stock bought (not a cost)', 40000], ['Fuel/Diesel', 15000]]);
  });
  it('debt aging buckets by days owed and flags the old money', () => {
    const now = new Date('2026-11-24T12:00:00Z').getTime();
    const b = debtAging([
      { name: 'A', outstanding_debt_ngn: 5000, debt_since: new Date(now - 3 * DAY).toISOString() },
      { name: 'B', outstanding_debt_ngn: 7000, debt_since: new Date(now - 20 * DAY).toISOString() },
      { name: 'C', outstanding_debt_ngn: 9000, debt_since: new Date(now - 45 * DAY).toISOString() },
      { name: 'D', outstanding_debt_ngn: 1000, debt_since: new Date(now - 90 * DAY).toISOString() },
      { name: 'E', outstanding_debt_ngn: 500, debt_since: null },
    ], now);
    expect(b.map((x) => x.value)).toEqual([5500, 7000, 9000, 1000]);
    expect(agingInsight(b)).toContain('₦10,000 has been owed for over 30 days');
  });
  it('compare insight: up/down against the period before, and no history yet', () => {
    const T = (revenue: number) => ({ revenue, cogs: 0, running: 0, stockBought: 0, spend: 0, profit: 0, unpriced: 0 });
    expect(compareInsight(T(150), T(100))).toContain('up 50%');
    expect(compareInsight(T(50), T(100))).toContain('down 50%');
    expect(compareInsight(T(50), T(0))).toContain('Not enough history');
  });
  it('stock health: out, nearly out, and cash tied up in stock that has not sold in 3 weeks', () => {
    const now = Date.now();
    const h = stockHealth([
      { name: 'Gele', stock_qty: 0, cost_price_ngn: 3000, last_sold_at: new Date(now - DAY).toISOString() },
      { name: 'Ankara', stock_qty: 2, cost_price_ngn: 4000, last_sold_at: new Date(now - DAY).toISOString() },
      { name: 'Old lace', stock_qty: 10, cost_price_ngn: 5000, last_sold_at: new Date(now - 40 * DAY).toISOString() },
    ], now);
    expect(h).toEqual({ out: ['Gele'], low: ['Ankara (2 left)'], deadCount: 1, deadValue: 50000 });
  });
  it('empty data never throws', () => {
    expect(totals([])).toEqual({ revenue: 0, cogs: 0, running: 0, stockBought: 0, spend: 0, profit: 0, unpriced: 0 });
    expect(weekdayInsight(weekdays([]))).toContain('No sales');
    expect(paymentMix([])).toEqual([]);
  });
});
