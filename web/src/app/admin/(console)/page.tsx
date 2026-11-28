import Link from 'next/link';
import { loadOverview } from '@/lib/adminData';
import { STATUS_ICON, STATUS_LABEL, type ShopStatus } from '@/lib/adminMetrics';
import { ngn } from '@/lib/format';

export const metadata = { title: 'Overview' };

const Card = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="rounded-2xl bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-2xl font-bold">{value}</p>{sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}</div>
);
const days = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

function List({ title, empty, items }: { title: string; empty: string; items: { id: string; name: string; note: string }[] }) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{title}</h3>
      {items.length === 0 ? <p className="mt-2 text-sm text-slate-400">{empty}</p> : (
        <ul className="mt-2 divide-y divide-slate-100 text-sm">{items.map((s) => <li key={s.id} className="flex justify-between gap-3 py-2"><Link href={`/admin/shops/${s.id}`} className="font-medium text-royal hover:underline">{s.name}</Link><span className="text-right text-slate-500">{s.note}</span></li>)}</ul>
      )}
    </section>
  );
}

export default async function Overview() {
  const o = await loadOverview();
  const judged = o.shops.length - o.statusCounts.new;
  const habitPct = judged ? Math.round((o.statusCounts.habit / judged) * 100) : 0;
  const a = o.attention;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="Shops" value={String(o.shops.length)} sub={`+${o.signups7} this week · +${o.signups30} this month`} />
        <Card label="Active this week" value={`${o.active7}`} sub={`${habitPct}% are a daily habit`} />
        <Card label="Paying" value={String(o.paying)} sub={`MRR ${ngn(o.mrr)}`} />
        <Card label="Sales recorded (30 days)" value={ngn(o.sales30)} sub={`Still owed to shops: ${ngn(o.owed)}`} />
        <Card label="AI cost" value={ngn(o.aiCost7)} sub={`last 7 days · ${ngn(o.aiCost30)} in 30 days`} />
        <Card label="Failed videos (7 days)" value={String(o.failedVideos7)} />
        <Card label="Payouts waiting" value={String(o.payoutsPending.n)} sub={ngn(o.payoutsPending.ngn)} />
        <Card label="Referral wallets owed" value={ngn(o.walletsOwed)} />
      </div>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="font-semibold">Are owners coming back? <span className="text-sm font-normal text-slate-400">(🟢 = active on 4+ of the last 7 days)</span></h3>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {(['habit', 'trying', 'stalled', 'never_started', 'new'] as ShopStatus[]).map((s) => <span key={s} className="rounded-full bg-slate-100 px-3 py-1">{STATUS_ICON[s]} {STATUS_LABEL[s]}: <b>{o.statusCounts[s]}</b></span>)}
        </div>
        <p className="mt-2 text-xs text-slate-500">By plan: {Object.entries(o.byTier).map(([t, n]) => `${t.replace('_5k', '').replace('_15k', '')} ${n}`).join(' · ') || 'none yet'}</p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <List title="💰 Trials ending in 3 days" empty="None. Nobody's trial is about to end." items={a.trialsEnding.map((s) => ({ id: s.id, name: s.name, note: `${days(s.trialEndsAt)}d left · ${s.activeDays7} active days` }))} />
        <List title="⏳ Paid plans ending in 3 days" empty="None." items={a.paidExpiring.map((s) => ({ id: s.id, name: s.name, note: `${days(s.expiresAt)}d left` }))} />
        <List title="🔴 Signed up, never recorded anything" empty="Everyone has started." items={a.neverStarted.map((s) => ({ id: s.id, name: s.name, note: `${s.ageDays}d old` }))} />
        <List title="🟠 Used it, then went quiet" empty="Nobody has gone quiet." items={a.wentQuiet.map((s) => ({ id: s.id, name: s.name, note: 'nothing in 7 days' }))} />
      </div>
    </div>
  );
}
