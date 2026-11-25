import crypto from 'node:crypto';
import { db, upsertCustomer, upsertProduct, type Actor } from '../db/supabase.js';
import { ngn } from '../lib/money.js';
import { reply, type Reply } from '../services/whatsapp.js';

/**
 * Things an owner TELLS the bot that are not sales or expenses: debts that already existed, stock they already have,
 * a price change, a customer's phone number. Each one is previewed first, applied only on ✅ Confirm, and can be undone.
 * Nothing here touches the transactions ledger, so none of it can distort sales, expenses or profit.
 */

/** The two Redis calls we use, so tests can run on a tiny in-memory fake. */
export interface KV {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

export const PENDING_TTL_S = 30 * 60;
export const UNDO_TTL_S = 10 * 60;
export const MAX_RECORD_LINES = 25;
const MAX_AMOUNT = 1_000_000_000;

export interface DebtItem { name: string; amount: number; due: string | null; since: string | null }
export interface ProductItem { name: string; quantity?: number; cost?: number; price?: number }
export interface ClientItem { name: string; phone: string | null }
type Pending = { kind: 'debts'; businessId: string; items: DebtItem[] } | { kind: 'products'; businessId: string; items: ProductItem[] } | { kind: 'clients'; businessId: string; items: ClientItem[] };

const key = (phone: string, token: string) => `pending:${phone}:${token}`;
const undoKey = (phone: string, token: string) => `undo:${phone}:${token}`;
const normName = (s: string) => s.trim().replace(/\s+/g, ' ');
const nameKey = (s: string) => normName(s).toLowerCase();
const token = () => crypto.randomBytes(4).toString('hex');
const isoDate = (s: unknown): string | null => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);
const fmtDate = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// ═════════════════════════ DEBTS ═════════════════════════

/** Clean what the AI extracted: sane names/amounts, same person listed twice → one line. */
export function cleanDebts(raw: { customer_name: string; amount_ngn: number; due_date?: string; owing_since?: string }[] | undefined): DebtItem[] {
  const by = new Map<string, DebtItem>();
  for (const r of raw ?? []) {
    const name = normName(String(r.customer_name ?? '')).slice(0, 60);
    const amount = Math.round(Number(r.amount_ngn));
    if (name.length < 2 || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) continue;
    const k = nameKey(name);
    const prev = by.get(k);
    if (prev) { prev.amount += amount; prev.due ??= isoDate(r.due_date); continue; }
    by.set(k, { name, amount, due: isoDate(r.due_date), since: isoDate(r.owing_since) });
  }
  return [...by.values()];
}

export async function proposeDebts(actor: Actor, kv: KV, raw: Parameters<typeof cleanDebts>[0]): Promise<Reply> {
  const items = cleanDebts(raw);
  if (!items.length) return reply(actor.phone).text('I couldn\'t read the names and amounts. Send them like: _Femi owes me 14k, Kalu 28k_');
  if (items.length > MAX_RECORD_LINES) return reply(actor.phone).text(`That's ${items.length} people. Please send ${MAX_RECORD_LINES} or fewer at a time.`);

  const { data } = await db.from('customers').select('name_key, outstanding_debt_ngn').eq('business_id', actor.business.id).in('name_key', items.map((i) => nameKey(i.name)));
  const existing = new Map((data ?? []).map((c) => [c.name_key as string, Number(c.outstanding_debt_ngn)]));
  const total = items.reduce((a, i) => a + i.amount, 0);
  const tk = token();
  await kv.set(key(actor.phone, tk), JSON.stringify({ kind: 'debts', businessId: actor.business.id, items } satisfies Pending), 'EX', PENDING_TTL_S);

  return reply(actor.phone)
    .text(
      `📒 *Add these to who owes you?*`,
      ...items.map((i, n) => {
        const had = existing.get(nameKey(i.name)) ?? 0;
        return `${n + 1}. ${i.name} — ${ngn(i.amount)}${i.due ? ` (to pay ${fmtDate(i.due)})` : ''}${had > 0 ? ` _(already owes ${ngn(had)})_` : ''}`;
      }),
      `*Total: ${ngn(total)}*`,
      '',
      '_These are old debts: they are not counted as new sales or income._',
    )
    .button(`ACTOK:${tk}`, '✅ Confirm')
    .button(`ACTNO:${tk}`, '✖ Cancel');
}

// ═════════════════════════ PRODUCTS (opening stock, prices) ═════════════════════════

export function cleanProducts(raw: { name: string; quantity?: number; cost_price_ngn?: number; selling_price_ngn?: number }[] | undefined): ProductItem[] {
  const by = new Map<string, ProductItem>();
  for (const r of raw ?? []) {
    const name = normName(String(r.name ?? '')).slice(0, 80);
    if (name.length < 2) continue;
    const num = (v: unknown, max: number, allowZero: boolean) => { const n = Number(v); return v !== undefined && v !== null && Number.isFinite(n) && n >= (allowZero ? 0 : 1) && n <= max ? n : undefined; };
    const item: ProductItem = { name, quantity: num(r.quantity, 10_000_000, true), cost: num(r.cost_price_ngn, MAX_AMOUNT, false), price: num(r.selling_price_ngn, MAX_AMOUNT, false) };
    if (item.quantity === undefined && item.cost === undefined && item.price === undefined) continue;
    const k = nameKey(name);
    by.set(k, { ...by.get(k), ...Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)), name } as ProductItem);
  }
  return [...by.values()];
}

export async function proposeProducts(actor: Actor, kv: KV, raw: Parameters<typeof cleanProducts>[0]): Promise<Reply> {
  const items = cleanProducts(raw);
  if (!items.length) return reply(actor.phone).text('Tell me the item with a stock count or a price, e.g. _I have 50 lace, cost 15k, I sell 20k_');
  if (items.length > MAX_RECORD_LINES) return reply(actor.phone).text(`That's ${items.length} items. Please send ${MAX_RECORD_LINES} or fewer at a time.`);

  const { data } = await db.from('products').select('name_key, stock_qty, cost_price_ngn, selling_price_ngn').eq('business_id', actor.business.id).in('name_key', items.map((i) => nameKey(i.name)));
  const old = new Map((data ?? []).map((p) => [p.name_key as string, p]));
  const tk = token();
  await kv.set(key(actor.phone, tk), JSON.stringify({ kind: 'products', businessId: actor.business.id, items } satisfies Pending), 'EX', PENDING_TTL_S);

  const change = (label: string, was: number | undefined, now: number | undefined, money: boolean) => {
    if (now === undefined) return null;
    const f = (v: number) => (money ? ngn(v) : String(v));
    return was !== undefined && was !== now && (was > 0 || money === false) ? `${label} ${f(was)} → ${f(now)}` : `${label} ${f(now)}`;
  };
  return reply(actor.phone)
    .text(
      '📦 *Update your products?*',
      ...items.map((i, n) => {
        const o = old.get(nameKey(i.name));
        const parts = [change('stock', o ? Math.max(0, Number(o.stock_qty)) : undefined, i.quantity, false), change('cost', o ? Number(o.cost_price_ngn) : undefined, i.cost, true), change('price', o ? Number(o.selling_price_ngn) : undefined, i.price, true)].filter(Boolean);
        return `${n + 1}. *${i.name}*${o ? '' : ' _(new)_'} — ${parts.join(' · ')}`;
      }),
      ...items.flatMap((i) => {
        // The classic mistake: a TOTAL paid for goods typed as the cost of ONE piece (₦15,550 for 5 pieces → "cost ₦15,550").
        const o = old.get(nameKey(i.name));
        const sells = i.price ?? (o ? Number(o.selling_price_ngn) : 0);
        return i.cost !== undefined && sells > 0 && i.cost > sells
          ? ['', `⚠️ *${i.name}*: a cost of ${ngn(i.cost)} per piece is MORE than you sell it for (${ngn(sells)}). If ${ngn(i.cost)} is the *total* you paid for all of them, tap Cancel and send: _bought 5 ${i.name.toLowerCase()} ${i.cost.toLocaleString('en-NG')}_ (use your real number of pieces).`]
          : [];
      }),
      '',
      '_This only sets the numbers. It is not counted as a sale or a purchase._',
    )
    .button(`ACTOK:${tk}`, '✅ Confirm')
    .button(`ACTNO:${tk}`, '✖ Cancel');
}

// ═════════════════════════ CLIENT LIST ═════════════════════════

export function cleanClients(raw: { name: string; phone?: string }[] | undefined): ClientItem[] {
  const by = new Map<string, ClientItem>();
  for (const r of raw ?? []) {
    const name = normName(String(r.name ?? '')).slice(0, 60);
    if (name.length < 2) continue;
    const phone = r.phone ? normalisePhone(r.phone) : null;
    const k = nameKey(name);
    by.set(k, { name, phone: phone ?? by.get(k)?.phone ?? null });
  }
  return [...by.values()];
}

export async function proposeClients(actor: Actor, kv: KV, raw: Parameters<typeof cleanClients>[0]): Promise<Reply> {
  const items = cleanClients(raw);
  if (!items.length) return reply(actor.phone).text('Send me the names, with phone numbers if you have them, like: _add my customers: Femi 08031234567, Kalu 08051234567_');
  if (items.length > MAX_RECORD_LINES * 2) return reply(actor.phone).text(`That's ${items.length} people. Please send ${MAX_RECORD_LINES * 2} or fewer at a time.`);
  const { data } = await db.from('customers').select('name_key').eq('business_id', actor.business.id).in('name_key', items.map((i) => nameKey(i.name)));
  const have = new Set((data ?? []).map((c) => c.name_key as string));
  const tk = token();
  await kv.set(key(actor.phone, tk), JSON.stringify({ kind: 'clients', businessId: actor.business.id, items } satisfies Pending), 'EX', PENDING_TTL_S);
  const fresh = items.filter((i) => !have.has(nameKey(i.name))).length;
  return reply(actor.phone)
    .text(
      '👥 *Add to your customer list?*',
      ...items.map((i, n) => `${n + 1}. ${i.name}${i.phone ? ` — ${i.phone}` : ''}${have.has(nameKey(i.name)) ? ' _(already on your list)_' : ''}`),
      '',
      `${fresh} new · ${items.length - fresh} already saved. This doesn't change any money figures.`,
    )
    .button(`ACTOK:${tk}`, '✅ Confirm')
    .button(`ACTNO:${tk}`, '✖ Cancel');
}

// ═════════════════════════ CONFIRM / CANCEL / UNDO ═════════════════════════

type Undo =
  | { kind: 'debts'; rows: { id: string; added: number; prevSince: string | null; prevDue: string | null }[] }
  | { kind: 'products'; rows: { id: string; created: boolean; prev: { stock: number; cost: number; price: number } }[] }
  | { kind: 'clients'; rows: { id: string; created: boolean; prevPhone: string | null }[] };

export async function confirmAction(actor: Actor, kv: KV, tk: string): Promise<Reply> {
  const raw = await kv.getdel(key(actor.phone, tk)); // atomic: a double-tap can only apply once
  if (!raw) return reply(actor.phone).text('That one has expired or was already handled. Send it again.');
  const p = JSON.parse(raw) as Pending;
  if (p.businessId !== actor.business.id) return reply(actor.phone).text('That one has expired. Send it again.');

  const undoToken = token();
  if (p.kind === 'debts') {
    const undo: Undo = { kind: 'debts', rows: [] };
    const since = new Date().toISOString();
    for (const d of p.items) {
      const id = await upsertCustomer(actor.business.id, d.name);
      const { data: c } = await db.from('customers').select('outstanding_debt_ngn, debt_since, debt_due_date').eq('id', id).single();
      const prev = Number(c?.outstanding_debt_ngn ?? 0);
      await db.from('customers').update({
        outstanding_debt_ngn: prev + d.amount,
        debt_since: (c?.debt_since as string | null) ?? (d.since ? `${d.since}T12:00:00Z` : since),
        debt_due_date: d.due ?? ((c?.debt_due_date as string | null) ?? null),
      }).eq('id', id);
      undo.rows.push({ id, added: d.amount, prevSince: (c?.debt_since as string | null) ?? null, prevDue: (c?.debt_due_date as string | null) ?? null });
    }
    await kv.set(undoKey(actor.phone, undoToken), JSON.stringify(undo), 'EX', UNDO_TTL_S);
    const total = p.items.reduce((a, i) => a + i.amount, 0);
    return reply(actor.phone)
      .text(`✅ Added ${p.items.length} ${p.items.length === 1 ? 'debt' : 'debts'}: *${ngn(total)}* owed to you.`, '', 'Say *WHO DEY OWE ME* to see them, or *CHASE* for ready-to-send reminders.')
      .button(`ACTUNDO:${undoToken}`, '↩️ Undo');
  }

  if (p.kind === 'clients') {
    const undo: Undo = { kind: 'clients', rows: [] };
    for (const c of p.items) {
      const { data: ex } = await db.from('customers').select('id, phone_number').eq('business_id', actor.business.id).eq('name_key', nameKey(c.name)).maybeSingle();
      const prevPhone = (ex?.phone_number as string | null) ?? null; // read BEFORE we overwrite it
      const id = ex?.id ?? (await upsertCustomer(actor.business.id, c.name));
      if (c.phone) await db.from('customers').update({ phone_number: c.phone }).eq('id', id).eq('business_id', actor.business.id);
      undo.rows.push({ id: id as string, created: !ex, prevPhone });
    }
    await kv.set(undoKey(actor.phone, undoToken), JSON.stringify(undo), 'EX', UNDO_TTL_S);
    return reply(actor.phone)
      .text(`✅ ${p.items.length} ${p.items.length === 1 ? 'customer' : 'customers'} on your list.`, '', 'Say *MY CLIENTS* to see them, or *WIN BACK* when some go quiet.')
      .button(`ACTUNDO:${undoToken}`, '↩️ Undo');
  }

  const undo: Undo = { kind: 'products', rows: [] };
  for (const i of p.items) {
    const { data: ex } = await db.from('products').select('id, stock_qty, cost_price_ngn, selling_price_ngn').eq('business_id', actor.business.id).eq('name_key', nameKey(i.name)).maybeSingle();
    const prod = ex ?? (await upsertProduct(actor.business.id, i.name));
    const prev = { stock: Number(prod.stock_qty ?? 0), cost: Number(prod.cost_price_ngn ?? 0), price: Number(prod.selling_price_ngn ?? 0) };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (i.quantity !== undefined) patch.stock_qty = i.quantity;
    if (i.cost !== undefined) { patch.cost_price_ngn = i.cost; patch.previous_cost_price_ngn = prev.cost > 0 ? prev.cost : null; }
    if (i.price !== undefined) patch.selling_price_ngn = i.price;
    await db.from('products').update(patch).eq('id', prod.id);
    undo.rows.push({ id: prod.id as string, created: !ex, prev });
  }
  await kv.set(undoKey(actor.phone, undoToken), JSON.stringify(undo), 'EX', UNDO_TTL_S);
  return reply(actor.phone)
    .text(`✅ Updated ${p.items.length} ${p.items.length === 1 ? 'product' : 'products'}: ${p.items.map((i) => i.name).join(', ')}.`)
    .button(`ACTUNDO:${undoToken}`, '↩️ Undo');
}

export async function cancelAction(actor: Actor, kv: KV, tk: string): Promise<Reply> {
  await kv.getdel(key(actor.phone, tk));
  return reply(actor.phone).text('👍 Cancelled. Nothing was changed.');
}

export async function undoAction(actor: Actor, kv: KV, tk: string): Promise<Reply> {
  const raw = await kv.getdel(undoKey(actor.phone, tk));
  if (!raw) return reply(actor.phone).text('Nothing to undo. Undo works for 10 minutes after confirming.');
  const u = JSON.parse(raw) as Undo;
  if (u.kind === 'debts') {
    for (const r of u.rows) {
      const { data: c } = await db.from('customers').select('outstanding_debt_ngn').eq('id', r.id).eq('business_id', actor.business.id).maybeSingle();
      if (!c) continue;
      const left = Math.max(0, Number(c.outstanding_debt_ngn) - r.added);
      await db.from('customers').update({ outstanding_debt_ngn: left, debt_since: left > 0 ? undefined : null, debt_due_date: r.prevDue }).eq('id', r.id).eq('business_id', actor.business.id);
    }
    return reply(actor.phone).text('↩️ Done. Those debts are removed.');
  }
  if (u.kind === 'clients') {
    for (const r of u.rows) {
      if (r.created) { const del = await db.from('customers').delete().eq('id', r.id).eq('business_id', actor.business.id); if (!del.error) continue; }
      await db.from('customers').update({ phone_number: r.prevPhone }).eq('id', r.id).eq('business_id', actor.business.id);
    }
    return reply(actor.phone).text('↩️ Done. Your customer list is back as it was.');
  }
  for (const r of u.rows) {
    if (r.created) { const del = await db.from('products').delete().eq('id', r.id).eq('business_id', actor.business.id); if (!del.error) continue; }
    await db.from('products').update({ stock_qty: r.prev.stock, cost_price_ngn: r.prev.cost, selling_price_ngn: r.prev.price, updated_at: new Date().toISOString() }).eq('id', r.id).eq('business_id', actor.business.id);
  }
  return reply(actor.phone).text('↩️ Done. Your products are back as they were.');
}

// ═════════════════════════ CUSTOMER PHONE ═════════════════════════

/** 0803… / 803… / +234 803… → 234803…; anything else → null. */
export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (/^234\d{10}$/.test(d)) return d;
  if (/^0\d{10}$/.test(d)) return '234' + d.slice(1);
  if (/^\d{10}$/.test(d)) return '234' + d;
  return null;
}

export async function saveCustomerPhone(actor: Actor, nameRaw: string, phoneRaw: string): Promise<Reply> {
  const name = normName(nameRaw).slice(0, 60);
  const phone = normalisePhone(phoneRaw);
  if (name.length < 2) return reply(actor.phone).text('Whose number is it? Try: _Femi\'s number is 08031234567_');
  if (!phone) return reply(actor.phone).text(`That number doesn't look right (${phoneRaw.slice(0, 20)}). Send the 11 digits, like 08031234567.`);
  const id = await upsertCustomer(actor.business.id, name);
  await db.from('customers').update({ phone_number: phone }).eq('id', id).eq('business_id', actor.business.id);
  return reply(actor.phone).text(`✅ Saved ${name}'s number: ${phone}.`, 'In your dashboard, the reminder button for them now opens their WhatsApp directly.');
}

// ═════════════════════════ HONEST "NOT YET" REPLIES ═════════════════════════

export function notSupportedReply(phone: string, kind: string | undefined): Reply {
  switch (kind) {
    case 'I_OWE_SUPPLIER':
      return reply(phone).text('I don\'t track money *you* owe suppliers yet, so I haven\'t recorded this.', 'To record stock you bought, say: _bought 10 lace 15k each_ (add _paid 100k_ if you only paid part).');
    case 'OPENING_CASH':
    case 'BANK_BALANCE':
      return reply(phone).text('I track your sales and spending, not your cash or bank balance, so I haven\'t recorded this.', 'At the end of the day say *CLOSE* and I\'ll tell you the cash you should be holding.');
    case 'PERSONAL_SPENDING':
      return reply(phone).text('That sounds like personal money, so I haven\'t counted it against your shop profit.', 'If it was a shop cost, tell me what it was for and I\'ll record it.');
    case 'INVOICE':
      return reply(phone).text('I can\'t send invoices yet. I make *customer receipts*: tap 🧾 after a sale, or say *RECEIPT*.');
    default:
      return reply(phone).text('I can\'t do that one yet. I can log sales and expenses, track who owes you, make sales videos and check transfer alerts. Type *MENU* to see everything.');
  }
}

export const ACKNOWLEDGE_REPLY = '🙏 Anytime. Send a voice note whenever you sell or spend.';
export const CORRECT_LAST_REPLY = 'To fix the last entry: reply *UNDO* (works for 5 minutes after saving), then send it again with the right amount.';

/** Compact text of who owes, for the AI's context ("Femi ₦14,000"). */
export function owingContext(list: { name: string; outstanding_debt_ngn: number }[]): string[] {
  return list.filter((d) => d.outstanding_debt_ngn > 0).slice(0, 30).map((d) => `${d.name} ${ngn(d.outstanding_debt_ngn)}`);
}
