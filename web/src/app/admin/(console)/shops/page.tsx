import Link from 'next/link';
import { loadShops } from '@/lib/adminData';
import { STATUS_ICON, STATUS_LABEL, type ShopStatus } from '@/lib/adminMetrics';
import { ngn } from '@/lib/format';

export const metadata = { title: 'Shops' };
const TIER: Record<string, string> = { trial: 'Trial', free_limited: 'Free', starter_5k: 'Starter', growth_15k: 'Growth' };
const ago = (iso: string | null) => { if (!iso) return 'never'; const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000); return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`; };

export default async function Shops({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? '').toLowerCase().replace(/[^\p{L}\p{N} .'@+-]/gu, '').trim().slice(0, 40);
  const status = (['habit', 'trying', 'stalled', 'never_started', 'new'] as ShopStatus[]).find((s) => s === sp.status) ?? null;
  const all = await loadShops();
  const shops = all.filter((s) => (!status || s.status === status) && (!q || s.name.toLowerCase().includes(q) || s.phone.includes(q.replace(/\D/g, '') || '\u0000')));
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="Search by shop name or phone" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />
        <select name="status" defaultValue={status ?? ''} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
          <option value="">All</option>{(Object.keys(STATUS_LABEL) as ShopStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <button className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Filter</button>
      </form>
      <p className="text-sm text-slate-500">{shops.length} of {all.length} shops</p>
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-400"><tr><th className="p-3">Shop</th><th className="p-3">Status</th><th className="p-3">Plan</th><th className="p-3 text-right">Active days</th><th className="p-3 text-right">Sales 30d</th><th className="p-3 text-right">Owed</th><th className="p-3">Last seen</th></tr></thead>
          <tbody>
            {shops.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-3"><Link href={`/admin/shops/${s.id}`} className="font-semibold text-royal hover:underline">{s.name}</Link><div className="text-xs text-slate-400">{s.phone}</div></td>
                <td className="p-3 whitespace-nowrap">{STATUS_ICON[s.status]} {STATUS_LABEL[s.status]}</td>
                <td className="p-3">{TIER[s.tier] ?? s.tier}</td>
                <td className="p-3 text-right">{s.activeDays7}/7</td>
                <td className="p-3 text-right">{ngn(s.revenue30)}</td>
                <td className="p-3 text-right">{s.owed ? ngn(s.owed) : '—'}</td>
                <td className="p-3 whitespace-nowrap text-slate-500">{ago(s.lastSeen)}</td>
              </tr>
            ))}
            {!shops.length && <tr><td colSpan={7} className="p-6 text-center text-slate-400">No shops match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
