import Link from 'next/link';
import { Download, FileText, MessageCircle, Search } from 'lucide-react';
import { requireSession } from '@/lib/auth';
import { ngn, waLink, waNumber, watDate } from '@/lib/format';
import { db } from '@/lib/supabase';
import { botNumber } from '@/lib/whatsapp';

export const metadata = { title: 'Money' };
export const dynamic = 'force-dynamic';

const PAGE = 25;
const TYPES = { sale: 'Sales', expense: 'Expenses', restock: 'Restock', debt_repayment: 'Repayments' } as const;
const ICON = { sale: '💰', expense: '💸', restock: '📦', debt_repayment: '🤝' } as const;

interface Row {
  id: string; tx_type: keyof typeof TYPES; description: string; category: string; total_amount_ngn: string; amount_paid_ngn: string;
  balance_due_ngn: string; payment_method: string | null; transaction_date: string; receipt_pdf_url: string | null; customers: { name: string } | null;
}

export default async function Ledger({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; type?: string; page?: string }> }) {
  const { business: b } = await requireSession();
  const sp = await searchParams;
  const debtorsTab = sp.tab === 'debtors';
  const customersTab = sp.tab === 'customers';
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const type = sp.type && sp.type in TYPES ? sp.type : null;
  // Allow-list: this string is interpolated into a PostgREST filter, so only letters/digits/space/.'- survive.
  const q = (sp.q ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
  const month = new Date(Date.now() + 3600_000).toISOString().slice(0, 7);
  const qs = (o: Record<string, string | null>) => {
    const p = new URLSearchParams(); for (const [k, v] of Object.entries({ tab: sp.tab ?? null, q: q || null, type, ...o })) if (v) p.set(k, v);
    return `/ledger?${p}`;
  };

  return (
    <main className="space-y-3 p-3">
      <div className="flex rounded-full bg-mist p-0.5 text-sm font-medium">
        <Link href="/ledger" className={`flex-1 rounded-full py-2 text-center ${!debtorsTab && !customersTab ? 'bg-white shadow-sm' : 'text-slate-500'}`}>Transactions</Link>
        <Link href="/ledger?tab=debtors" className={`flex-1 rounded-full py-2 text-center ${debtorsTab ? 'bg-white shadow-sm' : 'text-slate-500'}`}>Who owes me</Link>
        <Link href="/ledger?tab=customers" className={`flex-1 rounded-full py-2 text-center ${customersTab ? 'bg-white shadow-sm' : 'text-slate-500'}`}>Customers</Link>
      </div>
      <a href={`/api/export?month=${month}`} className="flex items-center justify-center gap-2 rounded-xl bg-royal py-3 text-sm font-semibold text-white">
        <FileText size={16} /> Download this month’s statement (PDF)
      </a>
      {customersTab ? await Customers(b.id, b.name) : debtorsTab ? await Debtors(b.id, b.name) : await Transactions(b.id, { q, type, page, qs })}
    </main>
  );
}

async function Transactions(bid: string, o: { q: string; type: string | null; page: number; qs: (x: Record<string, string | null>) => string }) {
  let query = db.from('transactions')
    .select('id, tx_type, description, category, total_amount_ngn, amount_paid_ngn, balance_due_ngn, payment_method, transaction_date, receipt_pdf_url, customers(name)', { count: 'exact' })
    .eq('business_id', bid).eq('status', 'confirmed').order('transaction_date', { ascending: false }).range((o.page - 1) * PAGE, o.page * PAGE - 1);
  if (o.type) query = query.eq('tx_type', o.type);
  if (o.q) {
    const { data: cs } = await db.from('customers').select('id').eq('business_id', bid).ilike('name', `%${o.q}%`).limit(20);
    const ids = (cs ?? []).map((c) => c.id as string);
    query = query.or([`description.ilike.%${o.q}%`, `category.ilike.%${o.q}%`, ids.length ? `customer_id.in.(${ids.join(',')})` : null].filter(Boolean).join(','));
  }
  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Row[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));

  return (
    <>
      <form action="/ledger" className="relative">
        <Search size={16} className="absolute left-3.5 top-3.5 text-slate-400" />
        <input name="q" defaultValue={o.q} placeholder="Search item, category or customer" className="w-full rounded-xl border border-slate-200 py-3 pl-10 pr-3 text-base outline-none focus:border-accent" />
        {o.type && <input type="hidden" name="type" value={o.type} />}
      </form>
      <div className="no-scrollbar flex gap-2 overflow-x-auto text-sm">
        {([['All', null], ...Object.entries(TYPES)] as [string, string | null][]).map(([label, t]) => (
          <Link key={label} href={o.qs({ type: t, page: null })} className={`shrink-0 rounded-full border px-3.5 py-1.5 ${o.type === t ? 'border-royal bg-royal text-white' : 'border-slate-200 text-slate-600'}`}>{label}</Link>
        ))}
      </div>

      {rows.length === 0 ? <p className="py-10 text-center text-sm text-slate-400">No confirmed records{o.q || o.type ? ' match your filter' : ' yet'}.</p> : (
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-100">
          {rows.map((r) => {
            const out = r.tx_type === 'expense' || r.tx_type === 'restock';
            const due = Number(r.balance_due_ngn);
            return (
              <li key={r.id} className="flex items-center gap-3 p-3">
                <span className="text-xl" aria-hidden>{ICON[r.tx_type]}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{r.description}</p>
                  <p className="truncate text-xs text-slate-500">{watDate(r.transaction_date)}{r.customers?.name ? ` · ${r.customers.name}` : ''}{r.payment_method ? ` · ${r.payment_method}` : ''}</p>
                  {r.tx_type === 'sale' && due > 0 && <p className="text-xs font-medium text-alert">Owes {ngn(due)}</p>}
                </div>
                <div className="text-right">
                  <p className={`font-semibold ${out ? 'text-alert' : 'text-profit'}`}>{out ? '−' : '+'}{ngn(Number(r.total_amount_ngn))}</p>
                  {r.receipt_pdf_url && <a href={`/api/receipt/${r.id}`} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-accent"><Download size={12} />Receipt</a>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between pt-1 text-sm">
          {o.page > 1 ? <Link href={o.qs({ page: String(o.page - 1) })} className="rounded-lg border border-slate-200 px-4 py-2">← Newer</Link> : <span />}
          <span className="text-slate-400">Page {o.page} of {pages}</span>
          {o.page < pages ? <Link href={o.qs({ page: String(o.page + 1) })} className="rounded-lg border border-slate-200 px-4 py-2">Older →</Link> : <span />}
        </div>
      )}
    </>
  );
}

async function Debtors(bid: string, bizName: string) {
  const { data } = await db.from('customers').select('id, name, phone_number, outstanding_debt_ngn, debt_since')
    .eq('business_id', bid).gt('outstanding_debt_ngn', 0).order('outstanding_debt_ngn', { ascending: false }).limit(100);
  const list = data ?? [];
  const total = list.reduce((a, d) => a + Number(d.outstanding_debt_ngn), 0);
  if (!list.length) return <p className="py-10 text-center text-slate-500">🎉 Nobody owes you money.</p>;

  return (
    <>
      <p className="text-sm text-slate-500">{list.length} customer{list.length > 1 ? 's' : ''} owe you <b className="text-alert">{ngn(total)}</b></p>
      <ul className="space-y-2">
        {list.map((d) => {
          const days = d.debt_since ? Math.floor((Date.now() - new Date(d.debt_since as string).getTime()) / 86_400_000) : null;
          const first = String(d.name).split(' ')[0];
          const msg = `Hello ${first}, hope you're doing well 🙏. A gentle reminder of your outstanding balance of ${ngn(Number(d.outstanding_debt_ngn))} with ${bizName}. Kindly send it whenever you can and share the confirmation here. Thank you!`;
          return (
            <li key={d.id as string} className="flex items-center gap-3 rounded-2xl border border-slate-100 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{d.name as string}</p>
                <p className="text-xs text-slate-500">{days !== null ? `owing ${days} day${days === 1 ? '' : 's'}` : 'balance'}</p>
              </div>
              <p className="font-bold text-alert">{ngn(Number(d.outstanding_debt_ngn))}</p>
              <a href={waLink(waNumber(d.phone_number as string | null), msg)} target="_blank" rel="noopener" aria-label={`Send WhatsApp reminder to ${d.name}`}
                className="grid h-10 w-10 place-items-center rounded-full bg-[#25D366] text-white"><MessageCircle size={18} /></a>
            </li>
          );
        })}
      </ul>
      <p className="text-center text-xs text-slate-400">Customer with no saved number? WhatsApp lets you pick the contact.</p>
    </>
  );
}

async function Customers(bid: string, bizName: string) {
  const [cs, tx] = await Promise.all([
    db.from('customers').select('id, name, phone_number, total_spent_ngn, outstanding_debt_ngn').eq('business_id', bid).order('total_spent_ngn', { ascending: false }).limit(300),
    db.from('transactions').select('customer_id, transaction_date').eq('business_id', bid).eq('tx_type', 'sale').eq('status', 'confirmed').not('customer_id', 'is', null).order('transaction_date', { ascending: false }).limit(5000),
  ]);
  const last = new Map<string, string>();
  for (const t of tx.data ?? []) if (!last.has(t.customer_id as string)) last.set(t.customer_id as string, t.transaction_date as string);
  const list = cs.data ?? [];
  const bot = botNumber();
  const daysAgo = (iso?: string) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);
  const quiet = list.filter((c) => { const d = daysAgo(last.get(c.id as string)); return d !== null && d >= 30; }).length;

  if (!list.length) {
    return (
      <div className="space-y-3 py-8 text-center">
        <p className="text-slate-500">No customers on your list yet. Name the buyer when you log a sale, or send me a list on WhatsApp.</p>
        <a href={waLink(bot, 'add my customers: Femi 08031234567, Kalu 08051234567')} target="_blank" rel="noopener" className="inline-block rounded-xl bg-royal px-4 py-2.5 text-sm font-semibold text-white">Add customers on WhatsApp</a>
      </div>
    );
  }
  return (
    <>
      <p className="text-sm text-slate-500">{list.length} customer{list.length > 1 ? 's' : ''}{quiet > 0 && <> · <b className="text-alert">{quiet} gone quiet (30+ days)</b></>}</p>
      {quiet > 0 && <a href={waLink(bot, 'WIN BACK')} target="_blank" rel="noopener" className="flex items-center justify-center rounded-xl bg-[#25D366] py-2.5 text-sm font-semibold text-white">Get win-back messages on WhatsApp</a>}
      <ul className="space-y-2">
        {list.map((c) => {
          const d = daysAgo(last.get(c.id as string));
          const gone = d !== null && d >= 30;
          const first = String(c.name).split(' ')[0];
          const msg = gone ? `Hello ${first}, it's been a while! 🙏 We miss you at ${bizName}. Come see what's new, or just reply to this message.` : `Hello ${first}, thank you for shopping with ${bizName}! 🙏 We really appreciate you.`;
          return (
            <li key={c.id as string} className="flex items-center gap-3 rounded-2xl border border-slate-100 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.name as string}{gone && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">QUIET {d}d</span>}</p>
                <p className="text-xs text-slate-500">{ngn(Number(c.total_spent_ngn))} spent · {d === null ? 'no purchase yet' : d < 1 ? 'bought today' : `last bought ${d} day${d === 1 ? '' : 's'} ago`}{Number(c.outstanding_debt_ngn) > 0 && <> · <span className="text-alert">owes {ngn(Number(c.outstanding_debt_ngn))}</span></>}</p>
              </div>
              <a href={waLink(waNumber(c.phone_number as string | null), msg)} target="_blank" rel="noopener" aria-label={`Message ${c.name} on WhatsApp`} className="grid h-10 w-10 place-items-center rounded-full bg-[#25D366] text-white"><MessageCircle size={18} /></a>
            </li>
          );
        })}
      </ul>
      <p className="text-center text-xs text-slate-400">The green button opens WhatsApp with a message ready. No number saved? WhatsApp lets you pick the contact.</p>
    </>
  );
}
