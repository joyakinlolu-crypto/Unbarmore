import { PLANS } from '../config/plans.js';
import { env } from '../config/env.js';
import { confirmBatch, consumeQuota, createPendingBatch, db, signedUrl, uploadFile, type Actor, type TxnDraft } from '../db/supabase.js';
import { dateLabel, daysLeft, DEFAULT_VALID_DAYS, expiryPhrase, extendedUntil, lineTotal, quoteLabel, quoteSummaryLines, quoteTotal, validUntil, type QuoteLine } from '../lib/quote.js';
import { ngn, watDateKey } from '../lib/money.js';
import { quotePdf } from '../services/pdfGenerator.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { loadLogo } from './branding.js';
import { confirmAndRespond, quotaReply } from './ledger.js';
import { parseBankDetails } from './payouts.js';

/** What the brain hands us when the owner asks for a quote / invoice / proforma. */
export interface QuoteRequest {
  customer_name?: string;
  lines: { item_name: string; quantity: number; unit_price_ngn: number }[];
  valid_days?: number;
  delivery_fee_ngn?: number;
  note?: string;
}

interface QuoteRow {
  id: string; business_id: string; quote_no: number; customer_name: string | null; lines: QuoteLine[];
  delivery_fee_ngn: number; total_ngn: number; valid_until: string | null; note: string | null;
  status: 'open' | 'paid' | 'cancelled'; paid_method: string | null;
}
const NOT_READY = 'Quotes need a quick update on my side. Please try again in a little while.';
const MAX_LINES = 15;

const toRow = (r: Record<string, unknown>): QuoteRow => ({
  ...(r as unknown as QuoteRow), delivery_fee_ngn: Number(r.delivery_fee_ngn), total_ngn: Number(r.total_ngn), quote_no: Number(r.quote_no),
  lines: (r.lines as QuoteLine[]).map((l) => ({ item: l.item, qty: Number(l.qty), unit: Number(l.unit) })),
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
  const lines = q.lines.map((l) => ({ item: l.item, qty: l.qty, unit: l.unit, amount: lineTotal(l) }));
  const pdf = await quotePdf({
    businessName: actor.business.name, rcNumber: actor.business.rc_number, logo: await loadLogo(actor.business),
    quoteLabel: quoteLabel(q.quote_no), dateWat: dateLabel(watDateKey()), customerName: q.customer_name, lines,
    deliveryFee: q.delivery_fee_ngn, total: q.total_ngn,
    validUntilLabel: q.valid_until ? dateLabel(q.valid_until) : null, payDetails: actor.business.pay_details ?? null, note: q.note,
    promo: plan.watermark === 'none' ? null : { botNumber: env.WHATSAPP_DISPLAY_NUMBER, referralCode: actor.business.referral_code, businessName: actor.business.name },
  });
  const path = await uploadFile('pdf-receipts', `${actor.business.id}/quotes/${quoteLabel(q.quote_no)}.pdf`, pdf, 'application/pdf');
  return { url: await signedUrl('pdf-receipts', path), filename: `Quote-${quoteLabel(q.quote_no)}.pdf` };
}

function quoteMessage(actor: Actor, q: QuoteRow, doc: { url: string; filename: string }, intro?: string): Reply {
  const canExtend = PLANS[actor.business.subscription_tier].quoteExpiry;
  const r = reply(actor.phone).document(doc.url, doc.filename).text(
    intro,
    ...quoteSummaryLines(q.quote_no, q.customer_name, q.lines, q.delivery_fee_ngn, q.total_ngn),
    q.valid_until ? `⏳ Price held until *${dateLabel(q.valid_until)}*` : '',
    '',
    'Forward the PDF to your customer. When they pay, tap *Mark paid* and I record the sale.',
    actor.business.pay_details ? '' : 'Tip: add your bank details so customers can pay straight from the quote: _MY ACCOUNT GTBank 0123456789 Ada Fabrics_',
    !canExtend ? '_Starter adds a price-validity window and expiry reminders._' : '',
  );
  r.button(`QPAID:${q.id}`, '✅ Mark paid');
  if (canExtend) r.button(`QEXT:${q.id}`, `⏳ Extend ${DEFAULT_VALID_DAYS} days`);
  r.button(`QCAN:${q.id}`, '✖ Cancel quote');
  return r;
}

export async function createQuote(actor: Actor, req: QuoteRequest): Promise<Reply> {
  const lines: QuoteLine[] = req.lines.filter((l) => l.item_name?.trim() && l.quantity > 0 && l.unit_price_ngn >= 0).slice(0, MAX_LINES)
    .map((l) => ({ item: l.item_name.trim().slice(0, 60), qty: l.quantity, unit: Math.round(l.unit_price_ngn) }));
  if (!lines.length) return reply(actor.phone).text('I need the items and prices for a quote, like: _quote for Mama Tunde: 2 lace 50k each and 1 gele 5k, valid 3 days_');
  const delivery = Math.max(0, Math.round(req.delivery_fee_ngn ?? 0));
  const total = quoteTotal(lines, delivery);
  if (!(total > 0)) return reply(actor.phone).text('That quote adds up to ₦0. Please give me the prices, like: _2 lace 50k each_');
  if (!(await consumeQuota(actor.business, 'pdf_receipts_used_this_month'))) return quotaReply(actor, 'pdf_receipts_used_this_month');

  const plan = PLANS[actor.business.subscription_tier];
  const until = plan.quoteExpiry ? validUntil(watDateKey(), req.valid_days ?? DEFAULT_VALID_DAYS) : null;
  const customer = req.customer_name?.trim().slice(0, 60) || null;

  let row: QuoteRow | null = null;
  for (let attempt = 0; attempt < 3 && !row; attempt++) {
    const last = await db.from('quotes').select('quote_no').eq('business_id', actor.business.id).order('quote_no', { ascending: false }).limit(1).maybeSingle();
    if (last.error) return reply(actor.phone).text(NOT_READY);
    const no = Number(last.data?.quote_no ?? 0) + 1;
    const ins = await db.from('quotes').insert({
      business_id: actor.business.id, quote_no: no, customer_name: customer, lines, delivery_fee_ngn: delivery, total_ngn: total,
      valid_until: until, note: req.note?.trim().slice(0, 160) || null,
    }).select('*').single();
    if (!ins.error) row = toRow(ins.data as Record<string, unknown>);
    else if (ins.error.code !== '23505') return reply(actor.phone).text(NOT_READY);   // 23505 = two quotes at once took the same number: try the next one
  }
  if (!row) return reply(actor.phone).text(NOT_READY);
  return quoteMessage(actor, row, await pdfFor(actor, row));
}

export async function quotesListReply(actor: Actor): Promise<Reply> {
  const { data, error } = await db.from('quotes').select('*').eq('business_id', actor.business.id).eq('status', 'open').order('quote_no', { ascending: false }).limit(10);
  if (error) return reply(actor.phone).text(NOT_READY);
  const rows = ((data ?? []) as Record<string, unknown>[]).map(toRow);
  if (!rows.length) return reply(actor.phone).text('You have no open quotes. Make one: _quote for Mama Tunde: 2 lace 50k each and 1 gele 5k_');
  const today = watDateKey();
  const open = rows.reduce((a, q) => a + q.total_ngn, 0);
  return reply(actor.phone).text(
    `📄 *Open quotes: ${ngn(open)} waiting for customers to pay*`,
    ...rows.map((q) => `• *${quoteLabel(q.quote_no)}* ${q.customer_name ?? 'No name'} · ${ngn(q.total_ngn)} · ${expiryPhrase(daysLeft(q.valid_until, today))}`),
    '',
    'When one is paid: _Q-014 PAID_ · More time: _Q-014 EXTEND 3_ · Drop it: _Q-014 CANCEL_',
  );
}

const missing = (no: number) => reply('').text(`I can't find quote ${quoteLabel(no)}. Say *QUOTES* to see your open ones.`);

/** "Q-014 PAID": ask HOW they paid (cash and transfers are counted differently in the drawer), unless the owner already said. */
export async function quotePaid(actor: Actor, ref: { no?: number; id?: string }, method: 'cash' | 'transfer' | 'pos' | null): Promise<Reply> {
  const q = await findQuote(actor.business.id, ref);
  if (!q) return reply(actor.phone).text(`I can't find that quote. Say *QUOTES* to see your open ones.`);
  if (q.status === 'paid') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} was already marked paid ✅`);
  if (q.status === 'cancelled') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} was cancelled. Make a new quote if they still want it.`);
  if (!method) {
    return reply(actor.phone).text(`How did ${q.customer_name ?? 'the customer'} pay *${quoteLabel(q.quote_no)}* (${ngn(q.total_ngn)})?`)
      .button(`QPM:${q.id}:transfer`, '🏦 Transfer').button(`QPM:${q.id}:cash`, '💵 Cash').button(`QPM:${q.id}:pos`, '💳 POS');
  }
  const cap = PLANS[actor.business.subscription_tier].tx_logged_this_month;
  if (cap >= 0 && actor.business.tx_logged_this_month >= cap) return quotaReply(actor, 'tx_logged_this_month');

  // Claim it first: two taps (or two phones) can never record the same sale twice.
  const claim = await db.from('quotes').update({ status: 'paid', paid_at: new Date().toISOString(), paid_method: method })
    .eq('id', q.id).eq('business_id', actor.business.id).eq('status', 'open').select('id').maybeSingle();
  if (claim.error) return reply(actor.phone).text(NOT_READY);
  if (!claim.data) return reply(actor.phone).text(`${quoteLabel(q.quote_no)} was already handled ✅`);

  try {
    const drafts: TxnDraft[] = q.lines.map((l) => ({
      tx_type: 'sale', description: `${l.qty} × ${l.item}`, category: 'Sales', quantity: l.qty, unit_price_ngn: l.unit, total_amount_ngn: lineTotal(l),
      amount_paid_ngn: lineTotal(l), payment_method: method, item_name: l.item, customer_name: q.customer_name,
    }));
    if (q.delivery_fee_ngn > 0) drafts.push({
      tx_type: 'sale', description: 'Delivery', category: 'Sales', quantity: 1, unit_price_ngn: q.delivery_fee_ngn, total_amount_ngn: q.delivery_fee_ngn,
      amount_paid_ngn: q.delivery_fee_ngn, payment_method: method, item_name: null, customer_name: q.customer_name,
    });
    const { batchId } = await createPendingBatch(actor, 'whatsapp_text', drafts);
    await confirmBatch(batchId);
    const r = await confirmAndRespond(actor, batchId).catch(() => reply(actor.phone).text('✅ Saved'));
    return r.text('', `🧾 ${quoteLabel(q.quote_no)} marked paid (${method}).`);
  } catch (err) {
    await db.from('quotes').update({ status: 'open', paid_at: null, paid_method: null }).eq('id', q.id).eq('business_id', actor.business.id);
    throw err;
  }
}

export async function quoteExtend(actor: Actor, ref: { no?: number; id?: string }, days: number): Promise<Reply> {
  if (!PLANS[actor.business.subscription_tier].quoteExpiry) {
    return reply(actor.phone).text('Free quotes have no expiry, so there is nothing to extend. Starter adds a price-validity window and expiry reminders.').button('PLANS', '⭐ See plans');
  }
  const q = await findQuote(actor.business.id, ref);
  if (!q) return reply(actor.phone).text(`I can't find that quote. Say *QUOTES* to see your open ones.`);
  if (q.status !== 'open') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} is ${q.status}, so it can't be extended.`);
  const until = extendedUntil(q.valid_until, watDateKey(), days);
  const upd = await db.from('quotes').update({ valid_until: until }).eq('id', q.id).eq('business_id', actor.business.id).eq('status', 'open');
  if (upd.error) return reply(actor.phone).text(NOT_READY);
  const next = { ...q, valid_until: until };
  return quoteMessage(actor, next, await pdfFor(actor, next), `⏳ *${quoteLabel(q.quote_no)} extended to ${dateLabel(until)}.* Send this new PDF to your customer:`);
}

export async function quoteCancel(actor: Actor, ref: { no?: number; id?: string }): Promise<Reply> {
  const q = await findQuote(actor.business.id, ref);
  if (!q) return reply(actor.phone).text(`I can't find that quote. Say *QUOTES* to see your open ones.`);
  if (q.status !== 'open') return reply(actor.phone).text(`${quoteLabel(q.quote_no)} is already ${q.status}.`);
  await db.from('quotes').update({ status: 'cancelled' }).eq('id', q.id).eq('business_id', actor.business.id).eq('status', 'open');
  return reply(actor.phone).text(`✖ ${quoteLabel(q.quote_no)} cancelled. Nothing was recorded.`);
}

export const quoteNotFound = missing;

/** MY ACCOUNT GTBank 0123456789 Ada Fabrics: printed on every quote. Strict: it must contain a real bank + 10-digit account number. */
export async function payDetailsReply(actor: Actor, cmd: { text: string } | 'show'): Promise<Reply> {
  const r = reply(actor.phone);
  if (actor.isStaff) return r.text('Only the shop owner can set the bank details that appear on quotes.');
  if (cmd === 'show') {
    return actor.business.pay_details
      ? r.text(`🏦 Your quotes show: *${actor.business.pay_details}*`, 'To change it: _MY ACCOUNT GTBank 0123456789 Ada Fabrics_')
      : r.text('Add the bank details customers should pay into. They print on every quote:', '_MY ACCOUNT GTBank 0123456789 Ada Fabrics_');
  }
  const parsed = parseBankDetails(cmd.text);
  if (!parsed.ok) return r.text('I need the bank and the 10-digit account number, like: _MY ACCOUNT GTBank 0123456789 Ada Fabrics_');
  const { error } = await db.from('businesses').update({ pay_details: cmd.text }).eq('id', actor.business.id);
  if (error) return r.text('I could not save that yet. Please try again in a little while.');
  actor.business.pay_details = cmd.text;
  return r.text(`✅ Saved. Every new quote now says *Pay to: ${cmd.text}*.`);
}
