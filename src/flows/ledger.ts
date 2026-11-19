import { PLANS } from '../config/plans.js';
import {
  confirmBatch, consumeQuota, createPendingBatch, db, findBankSessionReuse, getBatchRows, getProduct, isInServiceWindow,
  refundQuota, setReceiptUrl, signedUrl, undoBatch, updateBusiness, uploadFile,
  type Actor, type PayMethod, type SourceChannel, type TxnDraft, type TxnRow,
} from '../db/supabase.js';
import type { BankAlert, TxnLine } from '../services/geminiBrain.js';
import { appendLedgerRows } from '../services/googleSheets.js';
import { receiptPdf } from '../services/pdfGenerator.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { ngn, ngnShort, watDateKey } from '../lib/money.js';
import { todayLine } from './insights.js';

export const BTN = {
  confirm: (batch: string) => `TXC:${batch}`,
  edit: (batch: string) => `TXE:${batch}`,
  discard: (batch: string) => `TXX:${batch}`,
  undo: (batch: string) => `TXU:${batch}`,
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

/** Step 2: confirm → apply → ONE reply carrying receipt PDF + today's profit (+ margin shield if a restock got dearer). */
export async function confirmAndRespond(actor: Actor, batchId: string): Promise<Reply> {
  const before = await getBatchRows(batchId);
  if (!before.length || before[0]!.business_id !== actor.business.id) return reply(actor.phone).text('That entry has expired. Send it again.');
  if (before.every((t) => t.status !== 'pending_confirm')) {
    return reply(actor.phone).text(before[0]!.status === 'confirmed' ? 'Already saved ✅' : 'That entry was cancelled.');
  }

  // Inflation Shield: capture old prices BEFORE confirm_batch overwrites cost_price_ngn.
  const shield = await marginShieldCandidate(actor, before);

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

  // Receipt for sales — attached to this same message.
  const sales = rows.filter((t) => t.tx_type === 'sale');
  if (sales.length && (await consumeQuota(actor.business, 'pdf_receipts_used_this_month'))) {
    const receiptNo = `${watDateKey().replace(/-/g, '').slice(2)}-${batchId.slice(0, 4).toUpperCase()}`;
    const pdf = await receiptPdf({
      businessName: actor.business.name,
      rcNumber: actor.business.rc_number,
      receiptNumber: receiptNo,
      dateWat: new Date(Date.now() + 3600_000).toISOString().replace('T', ' ').slice(0, 16) + ' WAT',
      customerName: sales.find((s) => s.customers?.name)?.customers?.name ?? null,
      lines: sales.map((s) => ({ description: s.description, quantity: Number(s.quantity), unitPrice: s.unit_price_ngn ? Number(s.unit_price_ngn) : null, amount: Number(s.total_amount_ngn) })),
      amountPaid: sales.reduce((a, s) => a + Number(s.amount_paid_ngn), 0),
      paymentMethod: sales[0]!.payment_method ?? 'cash',
      staffName: actor.isStaff ? actor.user.full_name : null,
    });
    const path = await uploadFile('pdf-receipts', `${actor.business.id}/${receiptNo}.pdf`, pdf, 'application/pdf');
    await setReceiptUrl(batchId, path);
    r.document(await signedUrl('pdf-receipts', path), `Receipt-${receiptNo}.pdf`);
    r.text('🧾 Receipt attached — forward it to your customer.');
  }

  if (shield) {
    r.text(
      '',
      `🛡️ *Inflation Shield:* ${shield.name} cost went up ${ngn(shield.oldCost)} → ${ngn(shield.newCost)} (+${shield.pct}%).`,
      `If you still sell at ${ngn(shield.oldSell)}, you lose ${ngn(shield.lossPerUnit)} profit on every one.`,
      `Suggested new price: *${ngn(shield.suggested)}*`,
    );
    r.button(BTN.marginAccept(shield.productId, shield.suggested), `Update to ${ngnShort(shield.suggested)}`);
    r.button(BTN.marginKeep(shield.productId), 'Keep old price');
  } else {
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
  const reasons = [...a.anomalies];
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
  const flagged = reasons.length > 0;

  const draft: TxnDraft = {
    tx_type: 'sale', description: `Transfer from ${a.sender_name ?? 'customer'}`, category: 'Sales',
    quantity: 1, unit_price_ngn: a.amount_ngn ?? 0, total_amount_ngn: a.amount_ngn ?? 0, amount_paid_ngn: a.amount_ngn ?? 0,
    payment_method: 'transfer', item_name: null, customer_name: a.sender_name ?? null,
    bank_session_id: a.session_id ?? null, sender_bank_name: a.bank_name ?? null,
    ocr_fraud_flag: flagged, ocr_fraud_reason: flagged ? reasons.join(' | ') : null,
  };
  const { batchId } = await createPendingBatch(actor, 'whatsapp_image', [draft]);
  void imagePath;

  const r = reply(actor.phone).text(
    flagged ? '🔴 *Be careful — check your bank app before releasing goods*' : '🟢 *Screenshot looks consistent*',
    `${ngn(a.amount_ngn)} from ${a.sender_name ?? 'unknown'} (${a.bank_name ?? 'bank ?'})`,
    a.session_id ? `Session: …${a.session_id.slice(-8)}` : null,
    ...(flagged ? reasons.map((x) => `• ${x}`) : []),
    '',
    flagged ? '' : '_A screenshot is not money. Confirm the credit in your bank app._',
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
