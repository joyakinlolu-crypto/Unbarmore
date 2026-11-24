import { PLANS } from '../config/plans.js';
import {
  confirmBatch, consumeQuota, createPendingBatch, db, findBankSessionReuse, getBatchRows, getProduct, isInServiceWindow,
  refundQuota, undoBatch, updateBusiness,
  type Actor, type PayMethod, type SourceChannel, type TxnDraft, type TxnRow,
} from '../db/supabase.js';
import type { BankAlert, TxnLine } from '../services/geminiBrain.js';
import { appendLedgerRows } from '../services/googleSheets.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { ngn, ngnShort } from '../lib/money.js';
import { todayLine } from './insights.js';
import { moneyBack, moneyBackLine } from './moneyBack.js';

export const BTN = {
  confirm: (batch: string) => `TXC:${batch}`,
  edit: (batch: string) => `TXE:${batch}`,
  discard: (batch: string) => `TXX:${batch}`,
  undo: (batch: string) => `TXU:${batch}`,
  receipt: (batch: string) => `RCPT:${batch}`,
  marginAccept: (productId: string, price: number) => `MSA:${productId}:${price}`,
  marginKeep: (productId: string) => `MSK:${productId}`,
};

const CATEGORY_DEFAULT: Record<TxnDraft['tx_type'], string> = {
  sale: 'Sales', restock: 'Inventory Restock', expense: 'Other', debt_repayment: 'Debt Repayment',
};

export function linesToDrafts(lines: TxnLine[]): TxnDraft[] {
  return lines.map((l) => {
    const pm = l.payment_method === 'unknown' ? null : (l.payment_method as PayMethod);
    const desc =
      l.type === 'expense' ? (l.category ?? 'Expense')
      : l.type === 'debt_repayment' ? `Debt repayment${l.customer_name ? ` — ${l.customer_name}` : ''}`
      : `${l.quantity} × ${l.item_name ?? 'item'}`;
    return {
      tx_type: l.type,
      description: desc,
      category: l.type === 'expense' ? (l.category ?? 'Other') : CATEGORY_DEFAULT[l.type],
      quantity: l.quantity,
      unit_price_ngn: l.unit_price_ngn ?? (l.quantity > 0 ? Math.round(l.amount_ngn / l.quantity) : null),
      total_amount_ngn: l.amount_ngn,
      amount_paid_ngn: Math.min(l.amount_paid_ngn, l.amount_ngn || l.amount_paid_ngn),
      payment_method: pm,
      item_name: l.item_name ?? null,
      customer_name: l.customer_name ?? null,
    };
  });
}

const ICON: Record<TxnDraft['tx_type'], string> = { sale: '💰', expense: '💸', restock: '📦', debt_repayment: '🤝' };

export function draftLine(d: TxnDraft): string {
  const bal = d.total_amount_ngn - d.amount_paid_ngn;
  const method = d.payment_method ? ` ${d.payment_method}` : '';
  let s = `${ICON[d.tx_type]} ${d.description} — ${ngn(d.total_amount_ngn)}`;
  if (d.tx_type === 'sale' && bal > 0) s += ` (paid ${ngnShort(d.amount_paid_ngn)}${method}, *${d.customer_name ?? '❓who'} owes ${ngnShort(bal)}*)`;
  else if (method) s += ` (${method.trim()})`;
  return s;
}

/**
 * Metering rule: ONE confirmed inbound message = ONE unit of `tx_logged_this_month`, however many line items
 * Gemini extracts from it ("sold 2 lace, buy fuel, collect from Tunde" = 1). Only voice, text and forwarded SMS count;
 * screenshots/receipts are already metered by the OCR quota and must not be charged twice.
 */
export const countsTowardTxQuota = (source: SourceChannel): boolean =>
  source === 'whatsapp_voice' || source === 'whatsapp_text' || source === 'sms_forward';

/** Soft guard so "1 message = 1 unit" can't be abused by pasting a whole notebook into a single message. */
export const MAX_LINES_PER_MESSAGE = 25;

/** Step 1 of HITL: parse → pending batch → one reply with summary + [Confirm] [Edit]. */
export async function proposeBatch(
  actor: Actor, source: SourceChannel, drafts: TxnDraft[], opts: { clarification?: string; prefix?: string } = {},
): Promise<Reply> {
  const r = reply(actor.phone);
  // Pre-check only (no charge yet): don't walk a user through Confirm just to block them at the end.
  // The atomic charge happens at confirmation, in confirmAndRespond.
  const cap = PLANS[actor.business.subscription_tier].tx_logged_this_month;
  if (countsTowardTxQuota(source) && cap >= 0 && actor.business.tx_logged_this_month >= cap) return quotaReply(actor, 'tx_logged_this_month');

  const { batchId } = await createPendingBatch(actor, source, drafts);
  r.text(opts.prefix, drafts.length > 1 ? `I got ${drafts.length} entries:` : 'I got:', ...drafts.map(draftLine));
  if (opts.clarification) r.text('', `⚠️ ${opts.clarification} Tap Edit to fix.`);
  r.text('', '_Reply UNDO within 5 min to reverse._')
    .button(BTN.confirm(batchId), '✅ Confirm')
    .button(BTN.edit(batchId), '✏️ Edit');
  return r;
}

// ───────────── Low-stock warning ─────────────

export const LOW_STOCK_AT = 2;
export interface StockSnap { name: string; stock: number; cost: number }

async function stockSnapshot(rows: TxnRow[]): Promise<Map<string, StockSnap>> {
  const ids = [...new Set(rows.filter((t) => t.tx_type === 'sale' && t.product_id).map((t) => t.product_id!))];
  const out = new Map<string, StockSnap>();
  for (const id of ids) { const p = await getProduct(id); out.set(id, { name: p.name, stock: Number(p.stock_qty), cost: Number(p.cost_price_ngn) }); }
  return out;
}

/**
 * Warn when a sale leaves a TRACKED product at LOW_STOCK_AT units or fewer. "Tracked" = the owner has restocked it at some point
 * (it had stock before this sale, or a recorded cost). A product that was never restocked just sits at 0/negative and would
 * otherwise trigger a warning on every sale, which would train the owner to ignore the warnings that matter.
 */
export function lowStockLines(before: Map<string, StockSnap>, after: Map<string, StockSnap>): string[] {
  const lines: string[] = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a || !(b.stock > 0 || b.cost > 0 || a.cost > 0) || a.stock > LOW_STOCK_AT) continue;
    lines.push(a.stock <= 0 ? `⚠️ *${a.name}* is sold out — restock soon.` : `⚠️ *${a.name}*: only ${a.stock} left — restock soon.`);
  }
  if (!lines.length) return [];
  return [...lines.slice(0, 3), ...(lines.length > 3 ? [`…and ${lines.length - 3} more running low.`] : []), 'Restock: say "bought 10 lace 15k each".'];
}

/** Step 2: confirm → apply → ONE reply carrying receipt PDF + today's profit (+ margin shield if a restock got dearer). */
/**
 * `askCostOnce(productId)`: returns true the first time we should ask about this product (the caller rate-limits it, e.g. once per 3 days).
 * Without a cost price a sale's profit is unknown, so after selling an item with no cost price we ask for it.
 */
export async function confirmAndRespond(actor: Actor, batchId: string, askCostOnce?: (productId: string) => Promise<boolean>): Promise<Reply> {
  const before = await getBatchRows(batchId);
  if (!before.length || before[0]!.business_id !== actor.business.id) return reply(actor.phone).text('That entry has expired. Send it again.');
  if (before.every((t) => t.status !== 'pending_confirm')) {
    return reply(actor.phone).text(before[0]!.status === 'confirmed' ? 'Already saved ✅' : 'That entry was cancelled.');
  }

  // Inflation Shield: capture old prices BEFORE confirm_batch overwrites cost_price_ngn.
  const shield = await marginShieldCandidate(actor, before);
  const stockBefore = await stockSnapshot(before); // for the low-stock warning

  // Charge exactly 1 unit per confirmed message (atomic cap check in SQL). Over the cap → discard the pending entry.
  const metered = countsTowardTxQuota(before[0]!.source_channel);
  if (metered && !(await consumeQuota(actor.business, 'tx_logged_this_month', 1))) {
    await undoBatch(batchId);
    return quotaReply(actor, 'tx_logged_this_month');
  }
  let applied = 0;
  try {
    applied = await confirmBatch(batchId);
  } catch (err) {
    if (metered) await refundQuota(actor.business.id, 'tx_logged_this_month', 1);
    throw err;
  }
  if (applied === 0) { // lost a race with a concurrent confirm: nothing was confirmed by us, so don't keep the charge
    if (metered) await refundQuota(actor.business.id, 'tx_logged_this_month', 1);
    return reply(actor.phone).text('Already saved ✅');
  }
  const rows = await getBatchRows(batchId);
  const r = reply(actor.phone);

  r.text(`✅ Saved ${rows.length > 1 ? `${rows.length} entries` : ''}`.trim(), await todayLine(actor.business.id));

  // Very first entry ever: celebrate and point at the next step (keeps new owners from stalling after one try).
  if (actor.business.tx_logged_this_month === 0 && metered && !actor.isStaff && Date.now() - new Date(actor.business.created_at ?? Date.now()).getTime() < 3 * 86_400_000) {
    r.text('', '🎉 *First entry saved!* Next: tell me who owes you, like _Femi owes me 14k_');
  }

  // The moment that sells the app: money owed to them just came in.
  const collected = rows.filter((t) => t.tx_type === 'debt_repayment').reduce((a, t) => a + Number(t.amount_paid_ngn), 0);
  if (collected > 0) {
    const mbLine = await moneyBack(actor.business).then(moneyBackLine).catch(() => null);
    r.text('', `🎉 ${ngn(collected)} collected from your customers.`, ...(mbLine ? [mbLine] : []));
  }

  // Low stock after this sale?
  const stockAfter = await stockSnapshot(rows);
  const lows = lowStockLines(stockBefore, stockAfter);
  if (lows.length) r.text('', ...lows);

  // Profit needs the cost price. Ask (rarely) for items sold without one.
  if (askCostOnce) {
    const unknown: string[] = [];
    for (const [id, p] of stockAfter) if (p.cost <= 0 && (await askCostOnce(id).catch(() => false))) unknown.push(p.name);
    if (unknown.length) {
      const list = unknown.slice(0, 2).map((n) => `*${n}*`).join(' and ');
      r.text('', `💡 What ${unknown.length > 1 ? 'do' : 'does'} ${list} cost you? Say _${unknown[0]!.toLowerCase()} costs me 15k_ and I'll show your real profit, not just your sales.`);
    }
  }

  // Customer receipt is on demand (button / RECEIPT): saves the free-plan PDF quota and keeps this reply fast.
  const hasReceipt = rows.some((t) => t.tx_type === 'sale' || t.tx_type === 'debt_repayment');

  if (shield) {
    r.text(
      '',
      `🛡️ *Inflation Shield:* ${shield.name} cost went up ${ngn(shield.oldCost)} → ${ngn(shield.newCost)} (+${shield.pct}%).`,
      `If you still sell at ${ngn(shield.oldSell)}, you lose ${ngn(shield.lossPerUnit)} profit on every one.`,
      `Suggested new price: *${ngn(shield.suggested)}*`,
    );
    r.button(BTN.marginAccept(shield.productId, shield.suggested), `Update to ${ngnShort(shield.suggested)}`);
    r.button(BTN.marginKeep(shield.productId), 'Keep old price');
    if (hasReceipt) r.button(BTN.receipt(batchId), '🧾 Customer Receipt');
  } else {
    if (hasReceipt) r.button(BTN.receipt(batchId), '🧾 Customer Receipt');
    r.button(BTN.undo(batchId), '↩️ Undo');
  }

  // Fire-and-forget side effects (never block or duplicate the user's reply).
  void afterConfirm(actor, rows).catch(() => undefined);
  return r;
}

async function afterConfirm(actor: Actor, rows: (TxnRow & { customers: { name: string } | null })[]) {
  if (actor.business.google_sheet_id && PLANS[actor.business.subscription_tier].sheetsSync) {
    await appendLedgerRows(actor.business.google_sheet_id, rows, actor.user.full_name).catch(() => undefined);
  }
  // Growth staff audit: free only if the owner is inside their 24h window; otherwise it lands in the 9 PM EOD audit.
  if (actor.isStaff && (await isInServiceWindow(actor.business.owner_phone))) {
    const sales = rows.filter((t) => t.tx_type === 'sale' || t.tx_type === 'debt_repayment');
    if (sales.length) {
      await reply(actor.business.owner_phone)
        .text(`👤 ${actor.user.full_name} logged:`, ...sales.map((s) => `• ${s.description} — ${ngn(s.total_amount_ngn)} (paid ${ngn(s.amount_paid_ngn)} ${s.payment_method ?? ''})`))
        .send()
        .catch(() => undefined);
    }
  }
}

interface ShieldInfo { productId: string; name: string; oldCost: number; newCost: number; oldSell: number; suggested: number; pct: number; lossPerUnit: number }

async function marginShieldCandidate(actor: Actor, rows: TxnRow[]): Promise<ShieldInfo | null> {
  if (!PLANS[actor.business.subscription_tier].inflationShield) return null;
  let best: ShieldInfo | null = null;
  for (const t of rows) {
    if (t.tx_type !== 'restock' || !t.product_id || !t.unit_price_ngn) continue;
    const p = await getProduct(t.product_id);
    const oldCost = Number(p.cost_price_ngn);
    const newCost = Number(t.unit_price_ngn);
    const oldSell = Number(p.selling_price_ngn);
    if (oldCost <= 0 || oldSell <= 0 || newCost <= oldCost) continue;
    // Keep the same margin % the seller was used to, rounded up to the nearest ₦100.
    const suggested = Math.ceil((oldSell * (newCost / oldCost)) / 100) * 100;
    const info: ShieldInfo = {
      productId: p.id, name: p.name, oldCost, newCost, oldSell, suggested,
      pct: Math.round(((newCost - oldCost) / oldCost) * 100), lossPerUnit: newCost - oldCost,
    };
    if (!best || info.lossPerUnit > best.lossPerUnit) best = info;
  }
  return best;
}

export async function acceptMarginShield(actor: Actor, productId: string, newPrice: number): Promise<Reply> {
  const p = await getProduct(productId);
  const oldSell = Number(p.selling_price_ngn);
  const stock = Math.max(0, Number(p.stock_qty));
  const recovered = Math.max(0, (newPrice - oldSell) * stock);
  await db.from('products').update({ selling_price_ngn: newPrice, updated_at: new Date().toISOString() }).eq('id', productId);
  const total = Number(actor.business.total_value_recovered_ngn) + recovered;
  await updateBusiness(actor.business.id, { total_value_recovered_ngn: total });
  return reply(actor.phone).text(
    `✅ ${p.name} is now ${ngn(newPrice)}.`,
    recovered > 0 ? `🛡️ That protects ${ngn(recovered)} on your current ${stock} in stock. Total protected so far: *${ngn(total)}*` : '',
  );
}

export async function undoAndRespond(actor: Actor, batchId: string | null): Promise<Reply> {
  const r = reply(actor.phone);
  const none = r.text('Nothing to undo — UNDO works within 5 minutes of saving.');
  if (!batchId) return none;
  const rows = await getBatchRows(batchId);
  if (!rows.length || rows[0]!.business_id !== actor.business.id) return none;
  const wasConfirmed = rows.some((t) => t.status === 'confirmed');
  if (!(await undoBatch(batchId))) return none;
  // An undone message is no longer a confirmed message → give the unit back.
  if (wasConfirmed && countsTowardTxQuota(rows[0]!.source_channel)) await refundQuota(actor.business.id, 'tx_logged_this_month', 1);
  return r.text('↩️ Reversed. Nothing from that entry is counted.', await todayLine(actor.business.id));
}

/** "Ignore" on a pending entry (e.g. a flagged bank alert). Ownership-checked; nothing was charged yet. */
export async function discardPending(actor: Actor, batchId: string): Promise<Reply> {
  const rows = await getBatchRows(batchId);
  if (rows.length && rows[0]!.business_id === actor.business.id) await undoBatch(batchId);
  return reply(actor.phone).text('❌ Ignored. Nothing was recorded.');
}

// ───────────── Bank alert verification ─────────────

export async function bankAlertReply(actor: Actor, a: BankAlert, imagePath: string | null): Promise<Reply> {
  // HARD reasons are checkable facts (we looked it up / measured it) → red warning.
  // SOFT reasons are only the AI's visual impression ("layout looks odd"); an AI can be wrong about a genuine receipt from a
  // bank it has seen less of, and accusing an honest customer is costly → yellow "double-check", never "fake".
  const reasons: string[] = [];
  const soft = a.anomalies.filter(Boolean);
  if (a.session_id) {
    const reuse = await findBankSessionReuse(a.session_id);
    if (reuse) {
      reasons.unshift(reuse.business_id === actor.business.id
        ? `This exact transfer (session ID) was already logged on ${reuse.transaction_date.slice(0, 10)} — likely a re-sent screenshot.`
        : 'This transfer session ID has already been used at another business — strong sign of a recycled/fake screenshot.');
    }
    if (/^\d+$/.test(a.session_id) && a.session_id.length !== 30) reasons.push(`Session ID has ${a.session_id.length} digits; NIP session IDs have 30.`);
  } else {
    reasons.push('No session ID/reference visible.');
  }
  if (a.timestamp_iso) {
    const t = new Date(a.timestamp_iso).getTime();
    if (t > Date.now() + 10 * 60_000) reasons.push('Transfer time is in the future.');
    else if (Date.now() - t > 72 * 3600_000) reasons.push('Transfer is more than 3 days old.');
  }
  const flagged = reasons.length > 0;            // hard evidence
  const uneasy = !flagged && soft.length > 0;     // only the AI's impression

  const draft: TxnDraft = {
    tx_type: 'sale', description: `Transfer from ${a.sender_name ?? 'customer'}`, category: 'Sales',
    quantity: 1, unit_price_ngn: a.amount_ngn ?? 0, total_amount_ngn: a.amount_ngn ?? 0, amount_paid_ngn: a.amount_ngn ?? 0,
    payment_method: 'transfer', item_name: null, customer_name: a.sender_name ?? null,
    bank_session_id: a.session_id ?? null, sender_bank_name: a.bank_name ?? null,
    ocr_fraud_flag: flagged, ocr_fraud_reason: flagged || uneasy ? [...reasons, ...soft.map((x) => `(AI impression) ${x}`)].join(' | ') : null,
  };
  const { batchId } = await createPendingBatch(actor, 'whatsapp_image', [draft]);
  void imagePath;

  const r = reply(actor.phone).text(
    flagged ? '🔴 *Be careful — check your bank app before releasing goods*'
      : uneasy ? '🟡 *Looks mostly fine, but please double-check in your bank app*'
      : '🟢 *Screenshot looks consistent*',
    `${ngn(a.amount_ngn)} from ${a.sender_name ?? 'unknown'} (${a.bank_name ?? 'bank ?'})`,
    a.session_id ? `Session: …${a.session_id.slice(-8)}` : null,
    ...(flagged ? reasons.map((x) => `• ${x}`) : []),
    ...(uneasy ? ['_My eye noticed something unusual, but I can\'t be sure:_', ...soft.slice(0, 2).map((x) => `• ${x}`)] : []),
    '',
    flagged ? '' : uneasy ? '_A screenshot is not money. Confirm the credit in your bank app._' : '✅ Receipt details look valid (Session ID logged). Still confirm credit in your bank app before releasing high-value goods.',
  );
  r.button(BTN.confirm(batchId), flagged ? 'Received anyway' : '✅ Log as sale');
  r.button(BTN.discard(batchId), '❌ Ignore');
  return r;
}

// ───────────── Upsell replies ─────────────

export function quotaReply(actor: Actor, metric: keyof typeof QUOTA_MSG): Reply {
  return reply(actor.phone)
    .text(QUOTA_MSG[metric](actor.business.subscription_tier))
    .button('PLANS', '⭐ See plans');
}

export const QUOTA_MSG = {
  tx_logged_this_month: (t: string) => `You've used all your logged messages for this ${t === 'trial' ? 'trial' : 'month'}. Starter (₦5k/mo) gives you 250 — each message can hold as many sales and expenses as you like.`,
  videos_used_this_month: (t: string) => `You've used your ${t === 'trial' ? 'trial' : 'monthly'} videos. Starter gives you 15 HD sales videos/month — one new ad every 2 days.`,
  ocr_scans_used_this_month: (t: string) => t === 'free_limited'
    ? 'Screenshot checking is on paid plans. One fake alert costs more than a year of Starter (₦5k/mo).'
    : 'You\'ve used your screenshot checks for this period. Upgrade for more.',
  pdf_receipts_used_this_month: () => 'You\'ve used your free receipts this month.',
  ceo_reports_used_this_month: () => 'CEO reports are on paid plans.',
};
