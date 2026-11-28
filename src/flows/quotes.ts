import { PLANS } from '../config/plans.js';
import { env } from '../config/env.js';
import { consumeQuota, createPendingBatch, db, signedUrl, uploadFile, upsertCustomer, type Actor, type TxnDraft } from '../db/supabase.js';
import { businessContact } from '../lib/contact.js';
import { displayPhone } from '../lib/phone.js';
import { normalisePhone } from '../lib/waLink.js';
import { buildPlan, cleanDetail, dateLabel, daysLeft, DEFAULT_VALID_DAYS, expiryPhrase, extendedUntil, lineTotal, nextDueAfterPaid, planLine, quoteLabel, quoteSummaryLines, quoteTotal, validUntil, type PlanInstalment, type PlanRequest, type QuoteLine } from '../lib/quote.js';
import { ngn, watDateKey } from '../lib/money.js';
import { quotePdf } from '../services/pdfGenerator.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { loadLogo } from './branding.js';
import { confirmAndRespond, quotaReply } from './ledger.js';
import { parseBankDetails } from './payouts.js';

/** What the brain hands us when the owner asks for an invoice (a quote / proforma). */
export interface QuoteRequest {
  customer_name?: string;
  customer_phone?: string;
  payment_plan?: PlanRequest;
  lines: { item_name: string; item_detail?: string; quantity: number; unit_price_ngn: number }[];
  valid_days?: number;
  delivery_fee_ngn?: number;
  note?: string;
}

interface QuoteRow {
  id: string; business_id: string; quote_no: number; customer_name: string | null; lines: QuoteLine[];
  delivery_fee_ngn: number; total_ngn: number; valid_until: string | null; note: string | null;
  status: 'open' | 'paid' | 'cancelled'; paid_method: string | null;
  created_at?: string; customer_phone?: string | null; payment_plan?: PlanInstalment[] | null;
}
const NOT_READY = 'Invoices need a quick update on my side. Please try again in a little while.';
const MAX_LINES = 15;

const toRow = (r: Record<string, unknown>): QuoteRow => ({
  ...(r as unknown as QuoteRow), customer_phone: (r.customer_phone as string | null) ?? null, payment_plan: Array.isArray(r.payment_plan) ? (r.payment_plan as PlanInstalment[]) : null, delivery_fee_ngn: Number(r.delivery_fee_ngn), total_ngn: Number(r.total_ngn), quote_no: Number(r.quote_no),
  lines: (r.lines as QuoteLine[]).map((l) => ({ item: l.item, qty: Number(l.qty), unit: Number(l.unit), ...(l.detail ? { detail: l.detail } : {}) })),
});

async function findQuote(businessId: string, ref: { no?: number; id?: string }): Promise<QuoteRow | null> {
  let q = db.from('quotes').select('*').eq('business_id', businessId);
  q = ref.id ? q.eq('id', ref.id) : q.eq('quote_no', ref.no!);
  const { data } = await q.maybeSingle();
  return data ? toRow(data as Record<string, unknown>) : null;
}

/** Builds the PDF, stores it, and returns the signed link. Used on create and on extend (a new date = a new PDF, same number). */
async function pdfFor(actor: Actor, q: QuoteRow): Promise<{ url: string; filename: string }> {
  const plan = PLANS[actor.business.subscription_tier];
  const lines = q.lines.map((l) => ({ item: l.item, detail: l.detail ?? null, qty: l.qty, unit: l.unit, amount: lineTotal(l) }));
  const pdf = await quotePdf({
    businessName: actor.business.name, rcNumber: actor.business.rc_number, logo: await loadLogo(actor.business),
    quoteLabel: quoteLabel(q.quote_no), dateWat: dateLabel(watDateKey()), customerName: q.customer_name, customerPhone: displayPhone(q.customer_phone), businessContact: businessContact(actor.business),
    planLines: (q.payment_plan ?? []).map((p) => planLine(p, issuedOn(q))), lines,
    deliveryFee: q.delivery_fee_ngn, total: q.total_ngn,
    validUntilLabel: q.valid_until ? dateLabel(q.valid_until) : null, payDetails: actor.business.pay_details ?? null, note: q.note,
    promo: plan.watermark === 'none' ? null : { botNumber: env.WHATSAPP_DISPLAY_NUMBER, referralCode: actor.business.referral_code, businessName: actor.business.name },
  });
  const path = await uploadFile('pdf-receipts', `${actor.business.id}/quotes/${quoteLabel(q.quote_no)}.pdf`, pdf, 'application/pdf');
  return { url: await signedUrl('pdf-receipts', path), filename: `Invoice-${quoteLabel(q.quote_no)}.pdf` };
}

const shortMoney = (n: number) => (n >= 1000 && n % 1000 === 0 ? `${n / 1000}k` : String(n));

/** The day the invoice was issued (Lagos date): instalments marked "on issue" are due this day. */
const issuedOn = (q: QuoteRow) => watDateKey(q.created_at ? new Date(q.created_at) : new Date());

function quoteMessage(actor: Actor, q: QuoteRow, doc: { url: string; filename: string }, intro?: string): Reply {
  const canExtend = PLANS[actor.business.subscription_tier].quoteExpiry;
  const r = reply(actor.phone).document(doc.url, doc.filename).text(
    intro,
    ...quoteSummaryLines(q.quote_no, q.customer_name, q.lines, q.delivery_fee_ngn, q.total_ngn),
    q.customer_phone ? `📞 ${displayPhone(q.customer_phone)}` : '',
    q.payment_plan?.length ? '*Payment plan*' : '',
    ...(q.payment_plan ?? []).map((p) => `   ${planLine(p, issuedOn(q))}`),
    q.valid_until ? `⏳ Valid until *${dateLabel(q.valid_until)}*` : '',
    '',
    'Forward the PDF to your customer. When they pay, tap *Mark paid* and I record the sale.',
    q.payment_plan?.length ? `Part-payment? Say _${quoteLabel(q.quote_no)} PAID ${shortMoney(q.payment_plan[0]!.amount)}_ and I record it and track what they still owe.` : '',
    actor.business.pay_details ? '' : 'Tip: add your bank details so customers can pay straight from the invoice: _MY ACCOUNT GTBank 0123456789 Ada Fabrics_',
    !canExtend ? '_Starter adds a validity period and expiry reminders._' : '',
  );
  r.button(`QPAID:${q.id}`, '✅ Mark paid');
  if (canExtend) r.button(`QEXT:${q.id}`, `⏳ Extend ${DEFAULT_VALID_DAYS} days`);
  r.button(`QCAN:${q.id}`, '✖ Cancel invoice');
  return r;
}

export async function createQuote(actor: Actor, req: QuoteRequest): Promise<Reply> {
  const lines: QuoteLine[] = req.lines.filter((l) => l.item_name?.trim() && l.quantity > 0 && l.unit_price_ngn >= 0).slice(0, MAX_LINES)
    .map((l) => ({ item: l.item_name.trim().slice(0, 60), qty: l.quantity, unit: Math.round(l.unit_price_ngn), ...(cleanDetail(l.item_detail) ? { detail: cleanDetail(l.item_detail) } : {}) }));
  if (!lines.length) return reply(actor.phone).text('I need the items and prices for an invoice, like: _invoice for Mama Tunde: 2 lace 50k each and 1 gele 5k, valid 3 days_');
  const delivery = Math.max(0, Math.round(req.delivery_fee_ngn ?? 0));
  const total = quoteTotal(lines, delivery);
  if (!(total > 0)) return reply(actor.phone).text('That invoice adds up to ₦0. Please give me the prices, like: _2 lace 50k each_');
  if (!(await consumeQuota(actor.business, 'pdf_receipts_used_this_month'))) return quotaReply(actor, 'pdf_receipts_used_this_month');

  const planCaps = PLANS[actor.business.subscription_tier];
  const today = watDateKey();
  const until = planCaps.quoteExpiry ? validUntil(today, req.valid_days ?? DEFAULT_VALID_DAYS) : null;
  const customer = req.customer_name?.trim().slice(0, 60) || null;

  // The customer's number: what the owner said, else what we already hold for that customer.
  let phone = normalisePhone(req.customer_phone ?? '');
  if (!phone && customer) {
    const known = await db.from('customers').select('phone_number').eq('business_id', actor.business.id).eq('name_key', customer.toLowerCase().replace(/\s+/g, ' ')).maybeSingle();
    phone = normalisePhone(String(known.data?.phone_number ?? ''));
  }
  const paymentPlan = buildPlan(total, req.payment_plan, today);

  let row: QuoteRow | null = null;
  for (let attempt = 0; attempt < 3 && !row; attempt++) {
    const last = await db.from('quotes').select('quote_no').eq('business_id', actor.business.id).order('quote_no', { ascending: false }).limit(1).maybeSingle();
    if (last.error) return reply(actor.phone).text(NOT_READY);
    const no = Number(last.data?.quote_no ?? 0) + 1;
    const base = { business_id: actor.business.id, quote_no: no, customer_name: customer, lines, delivery_fee_ngn: delivery, total_ngn: total, valid_until: until, note: req.note?.trim().slice(0, 160) || null };
    let ins = await db.from('quotes').insert({ ...base, customer_phone: phone, payment_plan: paymentPlan }).select('*').single();
    // Migration 013 not run yet: save the invoice without the new columns rather than failing. This invoice still shows the phone and plan.
    if (ins.error && (ins.error.code === '42703' || ins.error.code === 'PGRST204' || /column/i.test(ins.error.message))) ins = await db.from('quotes').insert(base).select('*').single();
    if (!ins.error) row = { ...toRow(ins.data as Record<string, unknown>), customer_phone: phone, payment_plan: paymentPlan };
    else if (ins.error.code !== '23505') return reply(actor.phone).text(NOT_READY);   // 23505 = two invoices at once took the same number: try the next one
  }
  if (!row) return reply(actor.phone).text(NOT_READY);

  // Remember the customer's number, so reminders and later invoices open their chat. Never blocks the invoice.
  if (customer && phone) {
    try { const id = await upsertCustomer(actor.business.id, customer); await db.from('customers').update({ phone_number: phone }).eq('id', id).is('phone_number', null); } catch { /* optional */ }
  }
  const skipped = req.payment_plan?.instalments?.length && !paymentPlan ? 'I could not make sense of the payment plan, so this invoice has none. Tell me again, like: _half now, half in 2 weeks_.' : '';
  const msg = quoteMessage(actor, row, await pdfFor(actor, row));
  return skipped ? msg.text('', skipped) : msg;
}

export async function quotesListReply(actor: Actor): Promise<Reply> {
  const { data, error } = await db.from('quotes').select('*').eq('business_id', actor.business.id).eq('status', 'open').order('quote_no', { ascending: false }).limit(10);
  if (error) return reply(actor.phone).text(NOT_READY);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(toRow);
  if (!rows.length) return reply(actor.phone).text('You have no open invoices. Make one: _invoice for Mama Tunde: 2 lace 50k each and 1 gele 5k_');
  const today = watDateKey();
  const open = rows.reduce((a, q) => a + q.total_ngn, 0);
  return reply(actor.phone).text(
    `📄 *Open invoices: ${ngn(open)} waiting for customers to pay*`,
    ...rows.map((q) => `• *${quoteLabel(q.quote_no)}* ${q.customer_name ?? 'No name'} · ${ngn(q.total_ngn)} · ${expiryPhrase(daysLeft(q.valid_until, today))}`),
    '',
    'When one is paid: _INV-014 PAID_ · More time: _INV-014 EXTEND 3_ · Drop it: _INV-014 CANCEL_',
  );
}

const missing = (no: number) => reply('').text(`I can't find invoice ${quoteLabel(no)}. Say *INVOICES* to see your open ones.`);

/** "INV-014 PAID": ask HOW they paid (cash and transfers are counted differently in the drawer), unless the owner already said. */
export async function quotePaid(actor: Actor, ref: { no?: number; id?: string }, method: 'cash' | 'transfer' | 'pos' | null, amount: number | null = null): Promise<Reply> {
  const q = await findQuote(actor.business.id, ref);
  if (!q) return reply(actor.phone).text(`I can't find that invoice. Say *INVOICES* to see your open ones.`);
  if (q.status === 'paid') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} was already marked paid ✅`);
  if (q.status === 'cancelled') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} was cancelled. Make a new invoice if they still want it.`);

  // Full payment by default; a smaller amount is a part-payment (deposit / first instalment).
  const paidNow = amount ?? q.total_ngn;
  if (paidNow > q.total_ngn) return reply(actor.phone).text(`That is more than the invoice: ${quoteLabel(q.quote_no)} is ${ngn(q.total_ngn)}. Say _${quoteLabel(q.quote_no)} PAID ${shortMoney(q.total_ngn)}_ or just _${quoteLabel(q.quote_no)} PAID_.`);
  const partial = paidNow < q.total_ngn;
  if (partial && !q.customer_name) return reply(actor.phone).text('To record a part-payment I need the customer\'s name, so I can track what they still owe. Make the invoice again with their name, or say the full payment.');
  if (!method) {
    return reply(actor.phone).text(`How did ${q.customer_name ?? 'the customer'} pay *${ngn(paidNow)}* of *${quoteLabel(q.quote_no)}*${partial ? ` (${ngn(q.total_ngn)})` : ''}?`)
      .button(`QPM:${q.id}:transfer:${paidNow}`, '🏦 Transfer').button(`QPM:${q.id}:cash:${paidNow}`, '💵 Cash').button(`QPM:${q.id}:pos:${paidNow}`, '💳 POS');
  }
  const cap = PLANS[actor.business.subscription_tier].tx_logged_this_month;
  if (cap >= 0 && actor.business.tx_logged_this_month >= cap) return quotaReply(actor, 'tx_logged_this_month');

  // Claim it first: two taps (or two phones) can never record the same sale twice.
  const claim = await db.from('quotes').update({ status: 'paid', paid_at: new Date().toISOString(), paid_method: method })
    .eq('id', q.id).eq('business_id', actor.business.id).eq('status', 'open').select('id').maybeSingle();
  if (claim.error) return reply(actor.phone).text(NOT_READY);
  if (!claim.data) return reply(actor.phone).text(`${quoteLabel(q.quote_no)} was already handled ✅`);

  try {
    // The whole invoice becomes a sale. The money received is spread over the lines in order; what is left unpaid becomes the customer's debt.
    let left = paidNow;
    const take = (lineTotalNgn: number) => { const t = Math.min(lineTotalNgn, left); left -= t; return t; };
    const drafts: TxnDraft[] = q.lines.map((l) => ({
      tx_type: 'sale', description: `${l.qty} × ${l.item}${l.detail ? ` (${l.detail})` : ''}`, category: 'Sales', quantity: l.qty, unit_price_ngn: l.unit, total_amount_ngn: lineTotal(l),
      amount_paid_ngn: take(lineTotal(l)), payment_method: method, item_name: l.item, customer_name: q.customer_name,
    }));
    if (q.delivery_fee_ngn > 0) drafts.push({
      tx_type: 'sale', description: 'Delivery', category: 'Sales', quantity: 1, unit_price_ngn: q.delivery_fee_ngn, total_amount_ngn: q.delivery_fee_ngn,
      amount_paid_ngn: take(q.delivery_fee_ngn), payment_method: method, item_name: null, customer_name: q.customer_name,
    });
    const { batchId } = await createPendingBatch(actor, 'whatsapp_text', drafts);
    // confirmAndRespond is what confirms the batch (and replies with the profit line, stock warnings, Undo and receipt buttons).
    const r = await confirmAndRespond(actor, batchId);
    if (!partial) return r.text('', `🧾 ${quoteLabel(q.quote_no)} marked paid (${method}).`);

    // Part-payment: the balance is now a debt. Give it the next instalment's due date, so the 7 AM note reminds them on the day.
    const owed = q.total_ngn - paidNow;
    const due = q.payment_plan?.length ? nextDueAfterPaid(q.payment_plan, paidNow) : null;
    if (due && q.customer_name) {
      await db.from('customers').update({ debt_due_date: due }).eq('business_id', actor.business.id).eq('name_key', q.customer_name.toLowerCase().replace(/\s+/g, ' ').trim());
    }
    return r.text('', `🧾 ${quoteLabel(q.quote_no)}: ${ngn(paidNow)} received (${method}). *${q.customer_name} still owes ${ngn(owed)}*${due ? `, due ${dateLabel(due)}. I'll remind you that morning` : ''}. Say *CHASE* any time for a reminder to send.`);
  } catch (err) {
    await db.from('quotes').update({ status: 'open', paid_at: null, paid_method: null }).eq('id', q.id).eq('business_id', actor.business.id);
    throw err;
  }
}

export async function quoteExtend(actor: Actor, ref: { no?: number; id?: string }, days: number): Promise<Reply> {
  if (!PLANS[actor.business.subscription_tier].quoteExpiry) {
    return reply(actor.phone).text('Free invoices have no expiry, so there is nothing to extend. Starter adds a validity period and expiry reminders.').button('PLANS', '⭐ See plans');
  }
  const q = await findQuote(actor.business.id, ref);
  if (!q) return reply(actor.phone).text(`I can't find that invoice. Say *INVOICES* to see your open ones.`);
  if (q.status !== 'open') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} is ${q.status}, so it can't be extended.`);
  const until = extendedUntil(q.valid_until, watDateKey(), days);
  const upd = await db.from('quotes').update({ valid_until: until }).eq('id', q.id).eq('business_id', actor.business.id).eq('status', 'open');
  if (upd.error) return reply(actor.phone).text(NOT_READY);
  const next = { ...q, valid_until: until };
  return quoteMessage(actor, next, await pdfFor(actor, next), `⏳ *${quoteLabel(q.quote_no)} extended to ${dateLabel(until)}.* Send this new PDF to your customer:`);
}

export async function quoteCancel(actor: Actor, ref: { no?: number; id?: string }): Promise<Reply> {
  const q = await findQuote(actor.business.id, ref);
  if (!q) return reply(actor.phone).text(`I can't find that invoice. Say *INVOICES* to see your open ones.`);
  if (q.status !== 'open') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} is already ${q.status}.`);
  await db.from('quotes').update({ status: 'cancelled' }).eq('id', q.id).eq('business_id', actor.business.id).eq('status', 'open');
  return reply(actor.phone).text(`✖ ${quoteLabel(q.quote_no)} cancelled. Nothing was recorded.`);
}

export const quoteNotFound = missing;

/** MY ACCOUNT GTBank 0123456789 Ada Fabrics: printed on every invoice. Strict: it must contain a real bank + 10-digit account number. */
export async function payDetailsReply(actor: Actor, cmd: { text: string } | 'show'): Promise<Reply> {
  const r = reply(actor.phone);
  if (actor.isStaff) return r.text('Only the shop owner can set the bank details that appear on invoices.');
  if (cmd === 'show') {
    return actor.business.pay_details
      ? r.text(`🏦 Your invoices show: *${actor.business.pay_details}*`, 'To change it: _MY ACCOUNT GTBank 0123456789 Ada Fabrics_')
      : r.text('Add the bank details customers should pay into. They print on every invoice:', '_MY ACCOUNT GTBank 0123456789 Ada Fabrics_');
  }
  const parsed = parseBankDetails(cmd.text);
  if (!parsed.ok) return r.text('I need the bank and the 10-digit account number, like: _MY ACCOUNT GTBank 0123456789 Ada Fabrics_');
  const { error } = await db.from('businesses').update({ pay_details: cmd.text }).eq('id', actor.business.id);
  if (error) return r.text('I could not save that yet. Please try again in a little while.');
  actor.business.pay_details = cmd.text;
  return r.text(`✅ Saved. Every new invoice now says *Pay to: ${cmd.text}*.`);
}

/** MY ADDRESS 12 Bode Street, Ibadan: printed under the business name on receipts and invoices. */
export async function addressReply(actor: Actor, cmd: { text: string } | 'show'): Promise<Reply> {
  const r = reply(actor.phone);
  if (actor.isStaff) return r.text('Only the shop owner can set the business address.');
  if (cmd === 'show') {
    return actor.business.address
      ? r.text(`📍 Your receipts and invoices show: *${actor.business.address}*`, 'To change it: _MY ADDRESS 12 Bode Street, Ibadan_')
      : r.text('Add your address so it prints under your business name on receipts and invoices:', '_MY ADDRESS 12 Bode Street, Ibadan_');
  }
  if (cmd.text.length < 5) return r.text('That is too short for an address. Try: _MY ADDRESS 12 Bode Street, Ibadan_');
  const { error } = await db.from('businesses').update({ address: cmd.text }).eq('id', actor.business.id);
  if (error) return r.text('I could not save the address yet. Please try again in a little while.');
  actor.business.address = cmd.text;
  return r.text(`✅ Saved. Your receipts and invoices now show *${cmd.text}* under your business name.`);
}
