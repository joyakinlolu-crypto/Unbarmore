import { loadAudit } from '@/lib/adminData';

export const metadata = { title: 'Activity log' };

export default async function AuditPage() {
  const rows = await loadAudit(150);
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Every admin login, every time a shop was opened in "view as owner", and every change made here. Shown newest first.</p>
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[560px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-400"><tr><th className="p-3">When (Lagos)</th><th className="p-3">Action</th><th className="p-3">Shop</th><th className="p-3">Detail</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100"><td className="p-3 whitespace-nowrap text-slate-500">{new Date(r.at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' })}</td><td className="p-3 font-medium">{r.action.replace(/_/g, ' ')}</td><td className="p-3">{r.business_name ?? '—'}</td><td className="p-3 text-xs text-slate-500">{Object.keys(r.detail).length ? JSON.stringify(r.detail).slice(0, 140) : ''}</td></tr>)}
            {!rows.length && <tr><td colSpan={4} className="p-6 text-center text-slate-400">Nothing yet.</td></tr>}</tbody></table>
      </div>
    </div>
  );
}
