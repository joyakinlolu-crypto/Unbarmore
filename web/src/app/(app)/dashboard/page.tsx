import Link from 'next/link';
import Chart, { type Point } from '@/components/Chart';
import PushPrompt from '@/components/PushPrompt';
import { requireSession } from '@/lib/auth';
import { ngn, waLink, watDate, watDayStart, watMonthStart } from '@/lib/format';
import { db } from '@/lib/supabase';
import { botNumber } from '@/lib/whatsapp';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { business: b } = await requireSession();
  const weekly = (await searchParams).range === '12w';
  const now = new Date();
  const to = new Date(now.getTime() + 86_400_000).toISOString();
  const monthFrom = watMonthStart(now).toISOString();
  const seriesFrom = new Date(now.getTime() - (weekly ? 84 : 30) * 86_400_000).toISOString();

  const [sum, cats, series, debt, today, allTime] = await Promise.all([
    db.rpc('ledger_summary', { p_business_id: b.id, p_from: monthFrom, p_to: to }),
    db.rpc('expenses_by_category', { p_business_id: b.id, p_from: monthFrom, p_to: to }),
    db.rpc('ledger_series', { p_business_id: b.id, p_from: seriesFrom, p_to: to, p_bucket: weekly ? 'week' : 'day' }),
    db.from('customers').select('name, outstanding_debt_ngn').eq('business_id', b.id).gt('outstanding_debt_ngn', 0).order('outstanding_debt_ngn', { ascending: false }).limit(2000),
    db.rpc('ledger_summary', { p_business_id: b.id, p_from: watDayStart(now).toISOString(), p_to: to }),
    db.rpc('ledger_summary', { p_business_id: b.id, p_from: '2000-01-01T00:00:00Z', p_to: to }),
  ]);
  const s = ((sum.data as Record<string, string>[] | null)?.[0]) ?? {};
  const revenue = Number(s.revenue_ngn ?? 0);
  const spend = Number(s.expenses_ngn ?? 0) + Number(s.restock_ngn ?? 0);
  const net = Number(s.net_profit_ngn ?? 0);
  const margin = revenue > 0 ? Math.round((net / revenue) * 100) : 0;
  const owed = (debt.data ?? []).reduce((a, d) => a + Number(d.outstanding_debt_ngn), 0);
  const t = ((today.data as Record<string, string>[] | null)?.[0]) ?? {};
  const todayIn = Number(t.cash_in_ngn ?? 0);
  const todaySpent = Number(t.expenses_ngn ?? 0) + Number(t.restock_ngn ?? 0);
  const todayNet = Number(t.net_profit_ngn ?? 0);
  const todayCount = Number(t.tx_count ?? 0);
  const collectedEver = Number(((allTime.data as Record<string, string>[] | null)?.[0] ?? {}).debt_collected_ngn ?? 0);
  const protectedMargin = Number(b.total_value_recovered_ngn);
  const recovered = collectedEver + protectedMargin; // money Unbarmore got back: debts collected + margin protected
  const topDebtors = ((debt.data ?? []) as { name: string; outstanding_debt_ngn: string }[]).slice(0, 3);
  const bot = botNumber();
  const catRows = ((cats.data ?? []) as { category: string; amount_ngn: string }[]).slice(0, 5);
  const catMax = Math.max(1, ...catRows.map((c) => Number(c.amount_ngn)));
  const points: Point[] = ((series.data ?? []) as { bucket: string; revenue_ngn: string; spend_ngn: string }[]).map((r) => ({
    label: new Date(r.bucket + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    revenue: Number(r.revenue_ngn), spend: Number(r.spend_ngn),
  }));

  return (
    <main className="space-y-4 p-3">
      <section className="rounded-3xl bg-gradient-to-br from-royal to-accent p-5 text-white">
        <p className="text-sm text-blue-100">Money Unbarmore got back for you</p>
        {recovered > 0
          ? <>
              <p className="mt-1 text-4xl font-extrabold tracking-tight">{ngn(recovered)}</p>
              <p className="mt-1 text-xs text-blue-100">{[collectedEver > 0 ? `${ngn(collectedEver)} collected from customers` : '', protectedMargin > 0 ? `${ngn(protectedMargin)} margin protected` : ''].filter(Boolean).join(' + ')}</p>
            </>
          : <p className="mt-2 text-base font-medium leading-snug">Chase your first debt and every naira you get back shows up here.</p>}
      </section>

      <PushPrompt />

      <section className="rounded-3xl border border-slate-100 p-4 shadow-sm" aria-label="Today">
        <h2 className="mb-3 font-semibold">Today</h2>
        {todayCount > 0 ? (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div><p className="text-xs text-slate-500">Money in</p><p className="font-bold text-profit">{ngn(todayIn)}</p></div>
            <div><p className="text-xs text-slate-500">Spent</p><p className="font-bold text-alert">{ngn(todaySpent)}</p></div>
            <div><p className="text-xs text-slate-500">Profit</p><p className={`font-bold ${todayNet >= 0 ? 'text-profit' : 'text-alert'}`}>{ngn(todayNet)}</p></div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Nothing logged yet today. Sold something? A quick voice note is enough.</p>
        )}
        {topDebtors.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="mb-1.5 text-xs font-medium text-slate-500">Still owing you</p>
            <ul className="space-y-1 text-sm">
              {topDebtors.map((d) => <li key={d.name} className="flex justify-between"><span>{d.name}</span><b>{ngn(Number(d.outstanding_debt_ngn))}</b></li>)}
            </ul>
            <a href={waLink(bot, 'WHO DEY OWE ME')} className="mt-3 flex items-center justify-center rounded-xl bg-royal py-2.5 text-sm font-semibold text-white">Chase them on WhatsApp</a>
          </div>
        )}
        <a href={waLink(bot, 'Hi')} className="mt-3 flex items-center justify-center rounded-xl bg-mist py-2.5 text-sm font-semibold text-royal">Log a sale on WhatsApp</a>
      </section>

      <section className="grid grid-cols-2 gap-3" aria-label="This month">
        <Kpi label="Sales this month" value={ngn(revenue)} />
        <Kpi label="Expenses + stock" value={ngn(spend)} tone="alert" />
        <Kpi label="Net profit" value={ngn(net)} sub={revenue > 0 ? `${margin}% margin` : undefined} tone={net >= 0 ? 'profit' : 'alert'} />
        <Kpi label="Customers owe you" value={ngn(owed)} sub={owed > 0 ? `${debt.data?.length} customer${debt.data?.length === 1 ? '' : 's'}` : 'All paid 🎉'} href="/ledger?tab=debtors" />
      </section>

      <section className="rounded-3xl border border-slate-100 p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Sales vs spending</h2>
          <div className="flex rounded-full bg-mist p-0.5 text-xs font-medium">
            <Link href="/dashboard" className={`rounded-full px-3 py-1 ${!weekly ? 'bg-white shadow-sm' : 'text-slate-500'}`}>30 days</Link>
            <Link href="/dashboard?range=12w" className={`rounded-full px-3 py-1 ${weekly ? 'bg-white shadow-sm' : 'text-slate-500'}`}>12 weeks</Link>
          </div>
        </div>
        <Chart data={points} />
      </section>

      {catRows.length > 0 && (
        <section className="rounded-3xl border border-slate-100 p-4 shadow-sm">
          <h2 className="mb-3 font-semibold">Where your expenses go</h2>
          <ul className="space-y-2.5">
            {catRows.map((c) => (
              <li key={c.category}>
                <div className="flex justify-between text-sm"><span>{c.category}</span><b>{ngn(Number(c.amount_ngn))}</b></div>
                <div className="mt-1 h-2 rounded-full bg-mist"><div className="h-2 rounded-full bg-alert" style={{ width: `${Math.max(4, (Number(c.amount_ngn) / catMax) * 100)}%` }} /></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {revenue === 0 && spend === 0 && (
        <p className="rounded-2xl bg-mist p-4 text-center text-sm text-slate-500">Nothing logged this month yet. Send a voice note on WhatsApp — e.g. “sold 2 lace 50k cash”.</p>
      )}
      <p className="text-center text-xs text-slate-400">Month to date · updated {watDate(now.toISOString())}</p>
    </main>
  );
}

function Kpi({ label, value, sub, tone, href }: { label: string; value: string; sub?: string; tone?: 'profit' | 'alert'; href?: string }) {
  const body = (
    <div className="h-full rounded-2xl border border-slate-100 p-4 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone === 'profit' ? 'text-profit' : tone === 'alert' ? 'text-alert' : 'text-ink'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
