import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadShopDetail } from '@/lib/adminData';
import { STATUS_ICON, STATUS_LABEL } from '@/lib/adminMetrics';
import { ngn, waLink, waNumber, watDate } from '@/lib/format';
import { profitLabel, profitPhrase, type ProfitView } from '@/lib/profit';
import { viewAsShop } from '../../actions';
import ShopActions from './ShopActions';

export const metadata = { title: 'Shop' };
const TIER: Record<string, string> = { trial: 'Free trial', free_limited: 'Free plan', starter_5k: 'Starter', growth_15k: 'Growth' };
const ICON: Record<string, string> = { sale: '💰', expense: '💸', restock: '📦', debt_repayment: '🤝' };
const GAP_STYLE = { warn: 'border-amber-200 bg-amber-50 text-amber-900', info: 'border-slate-200 bg-slate-50 text-slate-700', chance: 'border-emerald-200 bg-emerald-50 text-emerald-900' } as const;
const GAP_ICON = { warn: '⚠️', info: 'ℹ️', chance: '💡' } as const;

function Money({ title, v, cashIn }: { title: string; v: ProfitView; cashIn?: number }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-slate-400">{title}</p>
      <p className="mt-1 text-2xl font-bold">{profitPhrase(v)}</p><p className="text-xs text-slate-500">{profitLabel(v)}{v.marginPct !== null ? ` · ${v.marginPct}% margin` : ''}</p>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-slate-500">Money in (sales)</dt><dd>{ngn(v.revenue)}</dd></div>
        {cashIn !== undefined && <div className="flex justify-between"><dt className="text-slate-500">Cash actually received</dt><dd>{ngn(cashIn)}</dd></div>}
        <div className="flex justify-between"><dt className="text-slate-500">Cost of goods sold</dt><dd>{ngn(v.cogs)}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Running costs</dt><dd>{ngn(v.running)}</dd></div>
        <div className="flex justify-between"><dt className="text-slate-500">Stock bought</dt><dd>{ngn(v.stockBought)}</dd></div>
      </dl>
    </div>
  );
}

export default async function ShopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const d = await loadShopDetail(id);
  if (!d) notFound();
  const s = d.shop;
  const wa = waNumber(s.phone);
  return (
    <div className="space-y-5">
      <Link href="/admin/shops" className="text-sm text-slate-500 hover:underline">← All shops</Link>
      <section className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm">
        <div>
          <h1 className="text-xl font-bold">{s.name}</h1>
          <p className="text-sm text-slate-500">{s.phone} · {TIER[s.tier] ?? s.tier} · joined {watDate(s.createdAt)} ({s.ageDays}d) · {STATUS_ICON[s.status]} {STATUS_LABEL[s.status]}</p>
          <p className="mt-1 text-xs text-slate-400">
            {s.tier === 'trial' && `Trial ends ${watDate(s.trialEndsAt)} · `}{(s.tier === 'starter_5k' || s.tier === 'growth_15k') && `Plan runs to ${watDate(s.expiresAt)} · `}
            Video credits {s.videoCredits} · {s.activeDays7}/7 active days · {s.entries7} entries this week{d.referredBy ? ` · referred by ${d.referredBy}` : ''}{d.referralsMade ? ` · has referred ${d.referralsMade}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={viewAsShop.bind(null, id)}><button className="rounded-xl bg-royal px-4 py-2 text-sm font-semibold text-white">👁 View as owner</button></form>
          {wa && <a href={waLink(wa, `Hi ${s.name}, it's Unbarmore. `)} target="_blank" rel="noopener" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold">💬 WhatsApp them</a>}
        </div>
      </section>

      {d.gaps.length > 0 && (
        <section><h2 className="mb-2 font-semibold">What this shop is missing</h2>
          <ul className="space-y-2">{d.gaps.map((g, i) => <li key={i} className={`rounded-xl border p-3 text-sm ${GAP_STYLE[g.level]}`}>{GAP_ICON[g.level]} {g.text}</li>)}</ul></section>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <Money title="Today" v={d.today} />
        <Money title="Last 30 days" v={d.month} cashIn={d.cashInMonth} />
        <Money title="Since day one" v={d.allTime} />
      </div>
      <p className="text-xs text-slate-400">These are the same numbers the owner sees. Debt collected in the last 30 days: {ngn(d.debtCollectedMonth)}. Open quotes: {d.quotesOpen}.</p>

      <section className="rounded-2xl bg-white p-4 shadow-sm"><h2 className="mb-3 font-semibold">Manage</h2><ShopActions id={id} tier={s.tier} /></section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-2xl bg-white p-4 shadow-sm"><h2 className="mb-2 font-semibold">Owed to this shop</h2>
          {d.debtors.length === 0 ? <p className="text-sm text-slate-400">Nobody owes them.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.debtors.map((x, i) => <li key={i} className="flex justify-between py-1.5"><span>{x.name}{!x.phone_number && <span className="ml-1 text-xs text-amber-600">no phone</span>}</span><span>{ngn(Number(x.outstanding_debt_ngn))}{x.debt_since ? <span className="ml-2 text-xs text-slate-400">{Math.floor((Date.now() - new Date(x.debt_since).getTime()) / 86_400_000)}d</span> : null}</span></li>)}</ul>)}
        </section>
        <section className="rounded-2xl bg-white p-4 shadow-sm"><h2 className="mb-2 font-semibold">Stock</h2>
          <p className="text-sm text-slate-500">{d.products.total} products.</p>
          {d.products.noCost.length > 0 && <p className="mt-2 text-sm"><b>No cost price:</b> {d.products.noCost.map((p) => p.name).join(', ')}</p>}
          {d.products.low.length > 0 && <p className="mt-2 text-sm"><b>Running low:</b> {d.products.low.map((p) => `${p.name} (${p.stock_qty})`).join(', ')}</p>}
          {!d.products.noCost.length && !d.products.low.length && <p className="mt-2 text-sm text-slate-400">Nothing to flag.</p>}
        </section>
        <section className="rounded-2xl bg-white p-4 shadow-sm"><h2 className="mb-2 font-semibold">AI cost (30 days)</h2>
          {d.aiByKind.length === 0 ? <p className="text-sm text-slate-400">No usage logged yet.</p> : <ul className="text-sm">{d.aiByKind.map((k) => <li key={k.kind} className="flex justify-between py-0.5"><span>{k.kind}</span><span>{ngn(k.cost)}</span></li>)}</ul>}
        </section>
        <section className="rounded-2xl bg-white p-4 shadow-sm"><h2 className="mb-2 font-semibold">Videos &amp; drawer counts</h2>
          <p className="text-sm">Last videos: {d.videos.length ? d.videos.map((v) => v.status).join(', ') : 'none'}</p>
          <p className="mt-1 text-sm">Drawer counts: {d.counts.length ? d.counts.map((c) => `${ngn(Number(c.counted_ngn))}${c.variance_ngn != null ? ` (${Number(c.variance_ngn) >= 0 ? '+' : ''}${ngn(Number(c.variance_ngn))})` : ''}`).join(' · ') : 'none'}</p>
        </section>
      </div>

      <section className="overflow-x-auto rounded-2xl bg-white shadow-sm"><h2 className="p-4 pb-2 font-semibold">Latest entries (what is coming in and going out)</h2>
        <table className="w-full min-w-[640px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-400"><tr><th className="p-3">When</th><th className="p-3">What</th><th className="p-3">Customer</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">Paid</th><th className="p-3">How</th><th className="p-3">Status</th></tr></thead>
          <tbody>{d.recent.map((r) => <tr key={r.id} className="border-t border-slate-100"><td className="p-3 whitespace-nowrap text-slate-500">{watDate(r.transaction_date)}</td><td className="p-3">{ICON[r.tx_type] ?? ''} {r.description}</td><td className="p-3">{r.customers?.name ?? '—'}</td><td className="p-3 text-right">{ngn(Number(r.total_amount_ngn))}</td><td className="p-3 text-right">{ngn(Number(r.amount_paid_ngn))}</td><td className="p-3">{r.payment_method ?? '—'}</td><td className="p-3 text-xs">{r.status === 'confirmed' ? '' : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">{r.status}</span>}</td></tr>)}
            {!d.recent.length && <tr><td colSpan={7} className="p-6 text-center text-slate-400">Nothing recorded yet.</td></tr>}</tbody></table>
      </section>

      {d.audit.length > 0 && <section className="rounded-2xl bg-white p-4 shadow-sm"><h2 className="mb-2 font-semibold">Admin activity on this shop</h2>
        <ul className="text-sm text-slate-600">{d.audit.map((a, i) => <li key={i} className="py-0.5">{new Date(a.at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}: {a.action.replace(/_/g, ' ')} {Object.keys(a.detail).length ? <span className="text-slate-400">{JSON.stringify(a.detail).slice(0, 120)}</span> : null}</li>)}</ul></section>}
    </div>
  );
}
