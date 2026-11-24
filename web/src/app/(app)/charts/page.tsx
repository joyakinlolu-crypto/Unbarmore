import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Columns, Compare, HBars, Stack, TrendLine } from '@/components/charts';
import {
  agingInsight, compareInsight, customerInsight, debtAging, expenseBreakdown, expenseInsight, paymentInsight, paymentMix, productInsight, stockHealth,
  topCustomers, topProducts, totals, trend, trendInsight, weekdayInsight, weekdays, type DebtorRow, type ProductRow, type Tx,
} from '@/lib/analytics';
import { requireSession } from '@/lib/auth';
import { ngn, watDayStart } from '@/lib/format';
import { db } from '@/lib/supabase';

export const metadata = { title: 'Charts' };
export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;
const DAY = 86_400_000;

export default async function Charts({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { business: b } = await requireSession();
  const wanted = String((await searchParams).range);
  const range = RANGES.find((r) => String(r) === wanted) ?? 30;
  const from = new Date(watDayStart(new Date()).getTime() - (range - 1) * DAY);
  const prevFrom = new Date(from.getTime() - range * DAY);
  const to = new Date(Date.now() + DAY);

  const txQuery = (cols: string) => db.from('transactions').select(cols)
    .eq('business_id', b.id).eq('status', 'confirmed').gte('transaction_date', prevFrom.toISOString()).lt('transaction_date', to.toISOString())
    .order('transaction_date', { ascending: false }).limit(5000);
  const COLS = 'tx_type, category, description, quantity, total_amount_ngn, amount_paid_ngn, payment_method, transaction_date, customers(name), products(name)';
  let [txRes, debtRes, prodRes] = await Promise.all([
    txQuery(`${COLS}, unit_cost_ngn`),
    db.from('customers').select('name, outstanding_debt_ngn, debt_since').eq('business_id', b.id).gt('outstanding_debt_ngn', 0).limit(2000),
    db.from('products').select('name, stock_qty, cost_price_ngn, last_sold_at').eq('business_id', b.id).limit(1000),
  ]);
  // Database not upgraded yet (no cost column): show the charts anyway; every sale then counts as "cost price unknown".
  if (txRes.error) txRes = await txQuery(COLS);
  const all = (txRes.data ?? []) as unknown as Tx[];
  const cur = all.filter((t) => new Date(t.transaction_date) >= from);
  const prev = all.filter((t) => new Date(t.transaction_date) < from);
  const t = totals(cur), tp = totals(prev);
  const points = trend(cur, from, range);
  const days = weekdays(cur), prods = topProducts(cur), custs = topCustomers(cur), pay = paymentMix(cur), exp = expenseBreakdown(cur);
  const aging = debtAging((debtRes.data ?? []) as unknown as DebtorRow[]);
  const stock = stockHealth((prodRes.data ?? []) as unknown as ProductRow[]);

  const ask = (q: string) => `/advisor?q=${encodeURIComponent(q)}`;
  const Card = ({ title, insight, ask: q, children }: { title: string; insight: string; ask: string; children: React.ReactNode }) => (
    <section className="rounded-3xl border border-slate-100 p-4 shadow-sm">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-0.5 mb-3 text-sm text-slate-500">{insight}</p>
      {children}
      <Link href={ask(q)} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-royal"><Sparkles size={14} /> Ask your advisor what to do about this</Link>
    </section>
  );

  return (
    <main className="space-y-4 p-3">
      <div className="flex rounded-full bg-mist p-0.5 text-sm font-medium" role="tablist" aria-label="Period">
        {RANGES.map((r) => <Link key={r} href={`/charts?range=${r}`} className={`flex-1 rounded-full py-2 text-center ${r === range ? 'bg-white shadow-sm' : 'text-slate-500'}`}>{r} days</Link>)}
      </div>
      <p className="text-center text-xs text-slate-400">Every chart is built from what you told me on WhatsApp. Nothing to type here.</p>

      <Card title="Sales and profit" insight={trendInsight(t, points, range <= 31)} ask={`Look at my last ${range} days of sales and profit. What is working and what should I change?`}><TrendLine points={points} /></Card>
      <Card title="This period vs the one before" insight={compareInsight(t, tp)} ask="Why did my sales or profit change compared with the period before? What should I do next?">
        <Compare rows={[{ label: 'Sales', cur: t.revenue, prev: tp.revenue }, { label: 'Costs (goods sold + running)', cur: t.spend, prev: tp.spend }, { label: t.unpriced > 0 ? 'Profit (up to)' : 'Profit', cur: t.profit, prev: tp.profit }]} />
      </Card>
      <Card title="Your best days" insight={weekdayInsight(days)} ask="Which days are my slowest, and what promo should I run to fill them?"><Columns rows={days} label="Sales by day of the week" /></Card>
      <Card title="Best sellers" insight={productInsight(prods, t.revenue)} ask="Which of my products should I push harder and which should I stop stocking?"><HBars rows={prods} label="Top products by sales" /></Card>
      <Card title="Best customers" insight={customerInsight(custs, t.revenue)} ask="How do I get my best customers to buy more and bring their friends?"><HBars rows={custs} color="#16A34A" label="Top customers by spend" /></Card>
      <Card title="How you get paid" insight={paymentInsight(pay)} ask="How can I reduce credit sales and get paid faster?"><Stack slices={pay} label="Share of money received by payment method" /></Card>
      <Card title="Where your money goes (cash out)" insight={expenseInsight(exp)} ask="Where am I overspending, and where can I cut costs without hurting sales?"><HBars rows={exp} color="#E11D48" label="Spending by category" /></Card>
      <Card title="Who owes you, and for how long" insight={agingInsight(aging)} ask="Write me a plan to collect the money customers owe me, starting with the oldest."><HBars rows={aging} color="#F59E0B" label="Money owed by age" /></Card>

      <section className="rounded-3xl border border-slate-100 p-4 shadow-sm">
        <h2 className="font-semibold">Stock health</h2>
        <p className="mt-0.5 mb-3 text-sm text-slate-500">{stock.out.length + stock.low.length + stock.deadCount === 0 ? 'Nothing is running out and nothing is stuck.' : `${stock.deadCount > 0 ? `${ngn(stock.deadValue)} of stock has not sold in 21+ days. ` : ''}${stock.out.length + stock.low.length > 0 ? 'Some items need restocking.' : ''}`}</p>
        <ul className="space-y-1 text-sm">
          {stock.out.slice(0, 5).map((p) => <li key={p}>🔴 {p}: <b>out of stock</b></li>)}
          {stock.low.slice(0, 5).map((p) => <li key={p}>🟠 {p}</li>)}
          {stock.deadCount > 0 && <li>🧊 {stock.deadCount} item{stock.deadCount > 1 ? 's' : ''} not selling · {ngn(stock.deadValue)} tied up</li>}
        </ul>
        <Link href={ask('Which of my stock should I restock and which should I clear with a promo?')} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-royal"><Sparkles size={14} /> Ask your advisor what to do about this</Link>
      </section>
    </main>
  );
}
