import { loadPayouts } from '@/lib/adminData';
import { ngn, watDate } from '@/lib/format';

export const metadata = { title: 'Payouts' };

export default async function Payouts() {
  const rows = await loadPayouts();
  return (
    <div className="space-y-3">
      <p className="rounded-xl bg-slate-100 p-3 text-sm text-slate-600">To pay or reject a request, send <b>PAID WD-XXXXXX</b> or <b>REJECT WD-XXXXXX</b> to the bot from the admin phone. That also tells the shop on WhatsApp. This page shows the list and the bank details.</p>
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[640px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-400"><tr><th className="p-3">Ref</th><th className="p-3">Shop</th><th className="p-3 text-right">Amount</th><th className="p-3">Bank</th><th className="p-3">Asked</th><th className="p-3">Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.ref} className="border-t border-slate-100"><td className="p-3 font-mono">{r.ref}</td><td className="p-3">{r.businesses?.name ?? '—'}</td><td className="p-3 text-right">{ngn(Number(r.amount_ngn))}</td><td className="p-3">{r.bank_name} {r.account_number}</td><td className="p-3 text-slate-500">{watDate(r.created_at)}</td><td className="p-3"><span className={`rounded px-1.5 py-0.5 text-xs ${r.status === 'requested' ? 'bg-amber-100 text-amber-800' : r.status === 'paid' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{r.status}</span></td></tr>)}
            {!rows.length && <tr><td colSpan={6} className="p-6 text-center text-slate-400">No payout requests yet.</td></tr>}</tbody></table>
      </div>
    </div>
  );
}
