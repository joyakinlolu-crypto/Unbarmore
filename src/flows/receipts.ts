import { env } from '../config/env.js';
import { PLANS } from '../config/plans.js';
import { consumeQuota, db, getBatchRows, setReceiptUrl, signedUrl, uploadFile, type Actor } from '../db/supabase.js';
import { ngn, ngnShort } from '../lib/money.js';
import { receiptPdf } from '../services/pdfGenerator.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { loadLogo, logoPrompt } from './branding.js';
import { quotaReply } from './ledger.js';

export interface ReceiptLine { description: string; quantity: number; unitPrice: number | null; amount: number }

/** The text that travels with the PDF when the owner forwards it — readable even if the customer never opens the file. */
export function receiptCaption(o: { businessName: string; receiptNumber: string; customer: string | null; lines: ReceiptLine[]; amountPaid: number; method: string; remaining: number; date: string }): string {
  return [
    `🧾 *Receipt #${o.receiptNumber}*`,
    `*${o.businessName}*`,
    `Customer: ${o.customer ?? 'Walk-in customer'}`,
    ...o.lines.map((l) => `• ${l.description} — ${ngn(l.amount)}`),
    `Paid: ${ngn(o.amountPaid)}${o.method ? ` (${o.method})` : ''}`,
    o.remaining > 0 ? `*Balance remaining: ${ngn(o.remaining)}*` : '*Balance remaining: ₦0 — fully paid ✅*',
    `Date: ${o.date}`,
    'Thank you for your patronage 🙏',
  ].join('\n');
}

const fmtDate = (iso: string) => new Date(new Date(iso).getTime() + 3600_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Most recent confirmed sale / debt payment (optionally for one customer). */
export async function latestReceiptBatch(actor: Actor, customerName?: string): Promise<string | null> {
  let q = db.from('transactions').select('batch_id').eq('business_id', actor.business.id).eq('status', 'confirmed')
    .in('tx_type', ['sale', 'debt_repayment']).order('confirmed_at', { ascending: false, nullsFirst: false }).limit(1);
  const name = (customerName ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim();
  if (name) {
    const { data: cs } = await db.from('customers').select('id').eq('business_id', actor.business.id).ilike('name', `%${name}%`).limit(20);
    const ids = (cs ?? []).map((c) => c.id as string);
    if (!ids.length) return null;
    q = q.in('customer_id', ids);
  }
  const { data } = await q.maybeSingle();
  return (data?.batch_id as string | undefined) ?? null;
}

type ReceiptRow = Awaited<ReturnType<typeof getBatchRows>>[number];
const short = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const lineTitle = (t: ReceiptRow) => `${t.tx_type === 'debt_repayment' ? 'Payment' : t.description} ${ngnShort(Number(t.tx_type === 'debt_repayment' ? t.amount_paid_ngn : t.total_amount_ngn))}`;

/**
 * One document message: the customer receipt PDF + a forward-ready caption.
 * Regenerated each time (so the remaining balance is current), but only the FIRST generation counts toward the PDF quota.
 *
 * `mode`: undefined = decide; 'one' = all lines on one receipt; 'pick' = let the owner choose a sale; 'L<n>' = just sale number n.
 * Several sales in one message with no single named customer are never assumed to belong to one person: we ask.
 */
export async function customerReceiptReply(actor: Actor, batchId: string | null, forName?: string, mode?: string): Promise<Reply> {
  if (!batchId) {
    return reply(actor.phone).text(forName ? `I can't find a recent sale or payment for "${forName}".` : 'No receipt yet — log a sale first (e.g. "sold 2 lace 50k cash"), then tap 🧾 Customer Receipt.');
  }
  const all = await getBatchRows(batchId);
  if (!all.length || all[0]!.business_id !== actor.business.id) return reply(actor.phone).text('I can\'t find that entry any more.');
  let rows = all.filter((t) => t.status === 'confirmed' && (t.tx_type === 'sale' || t.tx_type === 'debt_repayment'));
  if (!rows.length) return reply(actor.phone).text('That entry isn\'t confirmed yet — tap ✅ Confirm first.');

  // "RECEIPT Mama" on a batch with several people: only her lines.
  if (forName) {
    const mine = rows.filter((t) => t.customers?.name && t.customers.name.toLowerCase().includes(forName.toLowerCase()));
    if (mine.length) rows = mine;
  }

  // One-time question: a logo (or "use my name"). Staff can't change branding, so they skip it.
  if (!actor.isStaff && actor.business.logo_url == null) return logoPrompt(actor.phone, batchId);

  const sales = rows.filter((t) => t.tx_type === 'sale');
  const sameCustomer = rows.every((t) => t.customer_id && t.customer_id === rows[0]!.customer_id);
  if (!mode && sales.length >= 2 && !sameCustomer) {
    return reply(actor.phone)
      .text(`You logged *${sales.length} sales* in that message.`, 'Are they all for the *same customer*?')
      .button(`RCPT:${batchId}:one`, '✅ Same customer')
      .button(`RCPT:${batchId}:pick`, '👥 Different customers');
  }
  if (mode === 'pick') {
    const r = reply(actor.phone).text('Which sale is this receipt for?');
    if (rows.length <= 3) rows.forEach((t, i) => r.button(`RCPT:${batchId}:L${i}`, `🧾 ${short(lineTitle(t), 17)}`));
    else r.listMenu('Choose a sale', rows.slice(0, 10).map((t, i) => ({ id: `RCPT:${batchId}:L${i}`, title: short(lineTitle(t), 24), description: t.customers?.name ?? 'No customer name' })));
    return r;
  }
  const line = /^L(\d+)$/.exec(mode ?? '');
  if (line) {
    const one = rows[Number(line[1])];
    if (!one) return reply(actor.phone).text('I can\'t find that sale. Say RECEIPT to try again.');
    rows = [one];
  }

  const firstTime = !rows.some((t) => t.receipt_pdf_url);
  if (firstTime && !(await consumeQuota(actor.business, 'pdf_receipts_used_this_month'))) return quotaReply(actor, 'pdf_receipts_used_this_month');

  const customerId = rows.find((t) => t.customer_id)?.customer_id ?? null;
  const customer = rows.find((t) => t.customers?.name)?.customers?.name ?? null;
  let remaining = rows.reduce((a, t) => a + Math.max(0, Number(t.total_amount_ngn) - Number(t.amount_paid_ngn)), 0); // unnamed customer: this sale's unpaid part
  if (customerId) {
    const { data } = await db.from('customers').select('outstanding_debt_ngn').eq('id', customerId).maybeSingle();
    if (data) remaining = Number(data.outstanding_debt_ngn);
  }
  const lines: ReceiptLine[] = rows.map((t) => t.tx_type === 'debt_repayment'
    ? { description: 'Payment towards your balance', quantity: 1, unitPrice: null, amount: Number(t.amount_paid_ngn) }
    : { description: t.description, quantity: Number(t.quantity), unitPrice: t.unit_price_ngn ? Number(t.unit_price_ngn) : null, amount: Number(t.total_amount_ngn) });
  const amountPaid = rows.reduce((a, t) => a + Number(t.amount_paid_ngn), 0);
  const method = rows.find((t) => t.payment_method)?.payment_method ?? '';
  const saleDate = rows[0]!.transaction_date;
  const receiptNumber = `${new Date(new Date(saleDate).getTime() + 3600_000).toISOString().slice(2, 10).replace(/-/g, '')}-${batchId.slice(0, 4).toUpperCase()}${line ? `-${Number(line[1]) + 1}` : ''}`;
  const date = fmtDate(saleDate);

  const pdf = await receiptPdf({
    businessName: actor.business.name, rcNumber: actor.business.rc_number, receiptNumber, dateWat: date, customerName: customer,
    lines, amountPaid, paymentMethod: method || '—', remainingBalance: remaining, balanceAsAt: fmtDate(new Date().toISOString()),
    logo: await loadLogo(actor.business),
    promo: PLANS[actor.business.subscription_tier].watermark === 'none' ? null : { botNumber: env.WHATSAPP_DISPLAY_NUMBER, referralCode: actor.business.referral_code },
  });
  const path = await uploadFile('pdf-receipts', `${actor.business.id}/${receiptNumber}.pdf`, pdf, 'application/pdf');
  await setReceiptUrl(batchId, path);
  return reply(actor.phone)
    .document(await signedUrl('pdf-receipts', path), `Receipt-${receiptNumber}.pdf`)
    .text(receiptCaption({ businessName: actor.business.name, receiptNumber, customer, lines, amountPaid, method, remaining, date }));
}
