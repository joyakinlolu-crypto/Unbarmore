import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth';
import { watMonthEnd, watMonthStart } from '@/lib/format';
import { monthlyStatementPdf } from '@/lib/statementPdf';
import { db } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const bid = session.business_id;

  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(req.nextUrl.searchParams.get('month') ?? '');
  const from = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, 1) - 3600_000) : watMonthStart();
  const to = watMonthEnd(from);
  const label = new Date(from.getTime() + 3600_000).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const args = { p_business_id: bid, p_from: from.toISOString(), p_to: to.toISOString() };
  const [sum, cats, top, debt] = await Promise.all([
    db.rpc('ledger_summary', args), db.rpc('expenses_by_category', args), db.rpc('top_products', { ...args, p_limit: 8 }),
    db.from('customers').select('name, outstanding_debt_ngn').eq('business_id', bid).gt('outstanding_debt_ngn', 0).order('outstanding_debt_ngn', { ascending: false }).limit(15),
  ]);
  const s = ((sum.data as Record<string, string>[] | null)?.[0]) ?? {};
  const n = (k: string) => Number(s[k] ?? 0);

  const pdf = await monthlyStatementPdf({
    businessName: session.business.name, rcNumber: session.business.rc_number, monthLabel: label,
    revenue: n('revenue_ngn'), expenses: n('expenses_ngn'), restock: n('restock_ngn'), netProfit: n('net_profit_ngn'),
    cashIn: n('cash_in_ngn'), debtCollected: n('debt_collected_ngn'),
    categories: ((cats.data ?? []) as { category: string; amount_ngn: string }[]).map((c) => ({ category: c.category, amount: Number(c.amount_ngn) })),
    topProducts: ((top.data ?? []) as { name: string; qty: string; revenue_ngn: string }[]).map((p) => ({ name: p.name, qty: Number(p.qty), revenue: Number(p.revenue_ngn) })),
    debtors: (debt.data ?? []).map((d) => ({ name: String(d.name), amount: Number(d.outstanding_debt_ngn) })),
  });
  const file = `Statement-${label.replace(' ', '-')}.pdf`;
  return new NextResponse(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'private, no-store' } });
}
