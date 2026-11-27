import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
    ADMIN_PHONE: '2348100000001', SUPPORT_WHATSAPP_URL: 'https://wa.me/2348100000002',
    PAYSTACK_SECRET_KEY: 'sk_test_placeholder_replace_me', PAYSTACK_PLAN_STARTER_MONTHLY: 'PLN_placeholder',
  });
});

const m = vi.hoisted(() => ({
  consumeQuota: vi.fn(), refundQuota: vi.fn(), confirmBatch: vi.fn(), undoBatch: vi.fn(), getBatchRows: vi.fn(), getProduct: vi.fn(),
  createPendingBatch: vi.fn(), setReceiptUrl: vi.fn(), uploadFile: vi.fn(), signedUrl: vi.fn(), isInServiceWindow: vi.fn(),
  findBankSessionReuse: vi.fn(), updateBusiness: vi.fn(), ledgerSummary: vi.fn(), customerRow: { current: null as unknown },
}));
vi.mock('../db/supabase.js', () => ({
  ...m,
  db: { from: () => new Proxy({}, { get: (_t, p: string) => (p === 'maybeSingle' ? () => Promise.resolve({ data: m.customerRow.current }) : () => new Proxy({}, { get: (_t2, p2: string) => (p2 === 'maybeSingle' ? () => Promise.resolve({ data: m.customerRow.current }) : () => new Proxy({}, { get: () => () => Promise.resolve({ data: m.customerRow.current }) })) })) }) },
}));
vi.mock('../flows/insights.js', () => ({ todayLine: async () => '📊 Today: …' }));
vi.mock('../services/googleSheets.js', () => ({ appendLedgerRows: async () => undefined }));

import { closeShopText, summariseDay } from '../flows/close.js';
import { confirmAndRespond, lowStockLines, bankAlertReply, type StockSnap } from '../flows/ledger.js';
import { adminStatsReply, isAdmin, supportReply } from '../flows/platform.js';
import { customerReceiptReply, receiptCaption } from '../flows/receipts.js';
import { withInterimNotice } from '../lib/interim.js';

const body = (r: { toPayload(): Record<string, any> }) => JSON.stringify(r.toPayload());
const actor = (extra: Record<string, unknown> = {}) => ({
  phone: '2348000000001', isStaff: false, user: { id: 'u1', full_name: 'Ada' },
  business: { id: 'b1', name: 'Ada Fabrics', owner_phone: '2348000000001', subscription_tier: 'starter_5k', tx_logged_this_month: 0, rc_number: null, total_value_recovered_ngn: 0, google_sheet_id: null, logo_url: 'none', ...extra },
}) as never;

beforeEach(() => {
  Object.values(m).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as ReturnType<typeof vi.fn>).mockReset());
  m.consumeQuota.mockResolvedValue(true); m.confirmBatch.mockResolvedValue(2); m.uploadFile.mockResolvedValue('b1/r.pdf');
  m.signedUrl.mockResolvedValue('https://signed/r.pdf'); m.isInServiceWindow.mockResolvedValue(false); m.customerRow.current = null;
});

// ───────────────────────── 2. CLOSE ─────────────────────────
describe('CLOSE — end-of-day maths', () => {
  const rows = [
    { tx_type: 'sale', payment_method: 'cash', total_amount_ngn: 40000, amount_paid_ngn: 40000 },
    { tx_type: 'sale', payment_method: 'transfer', total_amount_ngn: 50000, amount_paid_ngn: 30000 },   // ₦20k credit given
    { tx_type: 'sale', payment_method: 'pos', total_amount_ngn: 10000, amount_paid_ngn: 10000 },
    { tx_type: 'debt_repayment', payment_method: 'cash', total_amount_ngn: 5000, amount_paid_ngn: 5000 },
    { tx_type: 'expense', payment_method: 'cash', total_amount_ngn: 8000, amount_paid_ngn: 8000 },
    { tx_type: 'expense', payment_method: 'transfer', total_amount_ngn: 3000, amount_paid_ngn: 3000 }, // leaves the bank, not the drawer
    { tx_type: 'restock', payment_method: 'cash', total_amount_ngn: 12000, amount_paid_ngn: 12000 },
    { tx_type: 'sale', payment_method: null, total_amount_ngn: 7000, amount_paid_ngn: 7000 },          // no method → reported, not guessed
  ];
  const s = summariseDay(rows);
  it('expected cash = cash sales + cash debts − cash expenses − cash stock', () => { expect(s.expectedCash).toBe(40000 + 5000 - 8000 - 12000); });
  it('transfers/POS counted separately from the drawer', () => { expect(s.transfersIn).toBe(30000 + 10000); });
  it('total expenses and stock bought; new credit given', () => {
    expect([s.totalExpenses, s.stockBought, s.newCredit]).toEqual([11000, 12000, 20000]);
  });
  it('entries with no payment method are flagged, never silently added to the drawer', () => {
    expect([s.unspecifiedIn, s.unspecifiedCount]).toEqual([7000, 1]);
  });
  it('message shows all four headline numbers and the reconcile reminder', () => {
    const t = closeShopText('Ada Fabrics', 'Fri 20 Nov', s, 2).join('\n');
    expect(t).toContain('Expected cash in drawer: ₦25,000');
    expect(t).toContain('Expected bank transfers/POS: ₦40,000');
    expect(t).toContain('Total expenses: ₦11,000');
    expect(t).toContain('New credit given today: ₦20,000');
    expect(t).toContain('no payment method');
    expect(t).toContain('2 entries are still waiting');
    expect(t).toContain('COUNT 85000');
  });
  it('an empty day is all zeros, no crash', () => { expect(summariseDay([]).expectedCash).toBe(0); });
});

// ───────────────────────── 3. low stock ─────────────────────────
describe('low-stock warning', () => {
  const snap = (stock: number, cost = 15000): StockSnap => ({ name: 'Swiss Lace', stock, cost });
  const run = (b: StockSnap, a: StockSnap) => lowStockLines(new Map([['p', b]]), new Map([['p', a]]));
  it('warns when a tracked product drops to 2 or fewer', () => {
    expect(run(snap(3), snap(2))[0]).toContain('only 2 left');
    expect(run(snap(3), snap(1))[0]).toContain('only 1 left');
  });
  it('says sold out at 0 (or below, if oversold)', () => {
    expect(run(snap(1), snap(0))[0]).toContain('sold out');
    expect(run(snap(1), snap(-1))[0]).toContain('sold out');
  });
  it('stays quiet above the threshold', () => { expect(run(snap(10), snap(8))).toEqual([]); });
  it('stays quiet for a product that was never restocked (no stock history, no cost) — otherwise every sale would warn', () => {
    expect(run(snap(0, 0), snap(-2, 0))).toEqual([]);
  });
  it('is concise: max 3 products + a one-line restock hint', () => {
    const b = new Map(['a', 'b', 'c', 'd'].map((k) => [k, { name: k, stock: 3, cost: 1 }]));
    const a = new Map(['a', 'b', 'c', 'd'].map((k) => [k, { name: k, stock: 1, cost: 1 }]));
    const lines = lowStockLines(b, a);
    expect(lines.filter((l) => l.startsWith('⚠️'))).toHaveLength(3);
    expect(lines.some((l) => l.includes('and 1 more'))).toBe(true);
    expect(lines.at(-1)).toContain('Restock');
  });
});

const row = (o: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), business_id: 'b1', batch_id: 'batch1', tx_type: 'sale', status: 'pending_confirm', source_channel: 'whatsapp_text',
  description: '2 × Swiss Lace', quantity: 2, unit_price_ngn: 25000, total_amount_ngn: 50000, amount_paid_ngn: 30000, payment_method: 'transfer',
  product_id: 'p1', customer_id: 'c1', customers: { name: 'Mama Tunde' }, transaction_date: '2026-11-20T09:00:00Z', receipt_pdf_url: null, ...o,
});

describe('confirmation message: receipt button + low-stock', () => {
  it('no more auto-attached PDF; a 🧾 Customer Receipt button and Undo instead; low-stock appended', async () => {
    m.getBatchRows.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row({ status: 'confirmed' })]);
    m.getProduct.mockResolvedValueOnce({ id: 'p1', name: 'Swiss Lace', stock_qty: 3, cost_price_ngn: 15000, selling_price_ngn: 25000 })   // before
      .mockResolvedValueOnce({ id: 'p1', name: 'Swiss Lace', stock_qty: 1, cost_price_ngn: 15000, selling_price_ngn: 25000 });             // after
    const p = (await confirmAndRespond(actor(), 'batch1')).toPayload() as any;
    expect(p.type).toBe('interactive');
    expect(p.interactive.header).toBeUndefined();
    expect(p.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['RCPT:batch1', 'TXU:batch1']);
    expect(p.interactive.action.buttons[0].reply.title).toContain('Customer Receipt');
    expect(p.interactive.body.text).toContain('Swiss Lace');
    expect(p.interactive.body.text).toContain('only 1 left');
    expect(m.consumeQuota.mock.calls.some((c) => c[1] === 'pdf_receipts_used_this_month')).toBe(false);   // PDF quota untouched until asked
  });
  it('a debt payment celebrates the money coming back and shows the running total', async () => {
    const d = row({ tx_type: 'debt_repayment', product_id: null, description: 'Debt repayment', amount_paid_ngn: 20000, total_amount_ngn: 20000 });
    m.getBatchRows.mockResolvedValueOnce([d]).mockResolvedValueOnce([{ ...d, status: 'confirmed' }]);
    m.ledgerSummary.mockResolvedValue({ revenue_ngn: 0, cash_in_ngn: 0, expenses_ngn: 0, restock_ngn: 0, debt_collected_ngn: 184000, net_profit_ngn: 0, tx_count: 1 });
    const text = ((await confirmAndRespond(actor({ total_value_recovered_ngn: 16000 }), 'batch1')).toPayload() as any).interactive.body.text as string;
    expect(text).toContain('🎉 ₦20,000 collected from your customers.');
    expect(text).toContain('Money Unbarmore got back for you: ₦200,000');
  });
  it('a plain sale shows no money-back line, and a failing lookup never breaks the reply', async () => {
    m.getBatchRows.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row({ status: 'confirmed' })]);
    m.getProduct.mockResolvedValue({ id: 'p1', name: 'Swiss Lace', stock_qty: 10, cost_price_ngn: 15000, selling_price_ngn: 25000 });
    expect(JSON.stringify((await confirmAndRespond(actor(), 'batch1')).toPayload())).not.toContain('got back');
    const d = row({ tx_type: 'debt_repayment', product_id: null, amount_paid_ngn: 5000 });
    m.getBatchRows.mockResolvedValueOnce([d]).mockResolvedValueOnce([{ ...d, status: 'confirmed' }]);
    m.ledgerSummary.mockRejectedValue(new Error('db down'));
    const t = ((await confirmAndRespond(actor(), 'batch1')).toPayload() as any).interactive.body.text as string;
    expect(t).toContain('🎉 ₦5,000 collected');
    expect(t).not.toContain('got back');
  });
  it('after selling an item with no cost price, asks once what it costs (so profit can be real)', async () => {
    m.getBatchRows.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row({ status: 'confirmed' })]);
    m.getProduct.mockResolvedValue({ id: 'p1', name: 'Swiss Lace', stock_qty: 9, cost_price_ngn: 0, selling_price_ngn: 25000 });
    const ask = vi.fn().mockResolvedValueOnce(true);
    const t = ((await confirmAndRespond(actor(), 'batch1', ask)).toPayload() as any).interactive.body.text as string;
    expect(ask).toHaveBeenCalledWith('p1');
    expect(t).toContain('What does *Swiss Lace* cost you?');
    expect(t).toContain('swiss lace costs me 15k');
  });
  it('…but not again within the cooldown, and never when the cost price is already known', async () => {
    m.getBatchRows.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row({ status: 'confirmed' })]);
    m.getProduct.mockResolvedValue({ id: 'p1', name: 'Swiss Lace', stock_qty: 9, cost_price_ngn: 0, selling_price_ngn: 25000 });
    expect(((await confirmAndRespond(actor(), 'batch1', async () => false)).toPayload() as any).interactive.body.text).not.toContain('cost you');
    m.getBatchRows.mockResolvedValueOnce([row()]).mockResolvedValueOnce([row({ status: 'confirmed' })]);
    m.getProduct.mockResolvedValue({ id: 'p1', name: 'Swiss Lace', stock_qty: 9, cost_price_ngn: 15000, selling_price_ngn: 25000 });
    const ask = vi.fn().mockResolvedValue(true);
    expect(((await confirmAndRespond(actor(), 'batch1', ask)).toPayload() as any).interactive.body.text).not.toContain('cost you');
    expect(ask).not.toHaveBeenCalled();
  });
  it('an expense-only entry has no receipt button', async () => {
    const e = row({ tx_type: 'expense', product_id: null, customer_id: null, customers: null, description: 'Fuel' });
    m.getBatchRows.mockResolvedValueOnce([e]).mockResolvedValueOnce([{ ...e, status: 'confirmed' }]);
    const p = (await confirmAndRespond(actor(), 'batch1')).toPayload() as any;
    expect(p.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['TXU:batch1']);
  });
});

// ───────────────────────── 1. customer receipt ─────────────────────────
describe('customer receipt (button + RECEIPT)', () => {
  it('caption has business, customer, items, amount paid, remaining balance and date — and the PDF is one document message', async () => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed' })]);
    m.customerRow.current = { outstanding_debt_ngn: '20000' };
    const r = await customerReceiptReply(actor(), 'batch1');
    const p = r.toPayload() as any;
    expect(p.type).toBe('document');
    expect(p.document.link).toBe('https://signed/r.pdf');
    for (const needle of ['Ada Fabrics', 'Mama Tunde', '2 × Swiss Lace', 'Paid: ₦30,000 (transfer)', 'Balance remaining: ₦20,000', 'Nov 2026']) expect(p.document.caption).toContain(needle);
    expect(m.uploadFile.mock.calls[0]![2].subarray(0, 4).toString()).toBe('%PDF');
    expect(m.consumeQuota).toHaveBeenCalledWith(expect.anything(), 'pdf_receipts_used_this_month');
  });
  it('re-sending the same receipt does not use up another PDF from the quota', async () => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed', receipt_pdf_url: 'b1/old.pdf' })]);
    m.customerRow.current = { outstanding_debt_ngn: '0' };
    const p = (await customerReceiptReply(actor(), 'batch1')).toPayload() as any;
    expect(m.consumeQuota).not.toHaveBeenCalled();
    expect(p.document.caption).toContain('fully paid');
  });
  it('a debt payment gets a receipt too, showing what is still owed', async () => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed', tx_type: 'debt_repayment', description: 'Debt repayment — Mama Tunde', total_amount_ngn: 5000, amount_paid_ngn: 5000, payment_method: 'cash', product_id: null })]);
    m.customerRow.current = { outstanding_debt_ngn: '15000' };
    const p = (await customerReceiptReply(actor(), 'batch1')).toPayload() as any;
    expect(p.document.caption).toContain('Payment towards your balance');
    expect(p.document.caption).toContain('Balance remaining: ₦15,000');
  });
  it('free plan out of PDFs → upsell instead; unconfirmed / foreign / missing entries are refused politely', async () => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed' })]); m.consumeQuota.mockResolvedValueOnce(false);
    expect(body(await customerReceiptReply(actor({ subscription_tier: 'free_limited' }), 'batch1'))).toContain('PLANS');
    m.getBatchRows.mockResolvedValueOnce([row()]);
    expect(body(await customerReceiptReply(actor(), 'batch1'))).toContain('Confirm');
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed', business_id: 'OTHER' })]);
    expect(body(await customerReceiptReply(actor(), 'batch1'))).toContain("can't find");
    expect(body(await customerReceiptReply(actor(), null))).toContain('No receipt yet');
  });
  it('caption helper: walk-in customer, fully paid', () => {
    const c = receiptCaption({ businessName: 'X', receiptNumber: '1', customer: null, lines: [], amountPaid: 100, method: '', remaining: 0, date: 'd' });
    expect(c).toContain('Walk-in customer'); expect(c).toContain('fully paid');
  });
});

// ───────────────────────── 4. bank screenshot reminder ─────────────────────────
describe('bank screenshot reminder', () => {
  const alert = (o: Record<string, unknown> = {}) => ({
    is_bank_alert: true, sender_name: 'Ada Okafor', bank_name: 'OPAY', amount_ngn: 25000, session_id: '100004261119104207583920461738',
    timestamp_iso: new Date(Date.now() - 3600_000).toISOString(), anomalies: [], is_supplier_receipt: false, ...o,
  }) as never;
  beforeEach(() => { m.findBankSessionReuse.mockResolvedValue(null); m.createPendingBatch.mockResolvedValue({ batchId: 'bb', rows: [] }); });
  const REMINDER = '✅ Receipt details look valid (Session ID logged). Still confirm credit in your bank app before releasing high-value goods.';
  it('clean pass → the exact honest reminder', async () => { expect(body(await bankAlertReply(actor(), alert(), null))).toContain(REMINDER); });
  it('red flags (reused session id) → no "looks valid" line', async () => {
    m.findBankSessionReuse.mockResolvedValue({ business_id: 'b1', transaction_date: '2026-11-19' });
    const t = body(await bankAlertReply(actor(), alert(), null));
    expect(t).not.toContain('look valid'); expect(t).toContain('Be careful');
  });
  it('wrong-length session id → red, no reminder', async () => {
    expect(body(await bankAlertReply(actor(), alert({ session_id: '12345' }), null))).not.toContain('look valid');
  });
  it('AI-only doubt → yellow, and still not claiming the receipt "looks valid"', async () => {
    const t = body(await bankAlertReply(actor(), alert({ anomalies: ['layout looks unusual'] }), null));
    expect(t).toContain('double-check'); expect(t).not.toContain('look valid');
  });
});

// ───────────────────────── 5. SUPPORT ─────────────────────────
describe('SUPPORT', () => {
  it('lists the 5 core commands and the support link from SUPPORT_WHATSAPP_URL', () => {
    const t = body(supportReply('234'));
    for (const c of ['VOICE NOTE', 'WHO DEY OWE ME', 'CLOSE', 'RECEIPT', 'LOGIN']) expect(t).toContain(c);
    expect(t).toContain('https://wa.me/2348100000002');
  });
});

// ───────────────────────── 6. admin, interim notice, payments ─────────────────────────
describe('ADMIN gate', () => {
  it('only ADMIN_PHONE passes', () => { expect(isAdmin('2348100000001')).toBe(true); expect(isAdmin('2348100000009')).toBe(false); expect(isAdmin('')).toBe(false); });
  it('adminStatsReply is exported and builds a reply (stats come from the database)', () => { expect(typeof adminStatsReply).toBe('function'); });
});

describe('"Processing your entry..." notice', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('fires once if the work takes longer than the limit', async () => {
    const notify = vi.fn();
    const p = withInterimNotice(() => new Promise<string>((r) => setTimeout(() => r('done'), 20_000)), 12_000, notify);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBe('done');
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('never fires when the work finishes in time', async () => {
    const notify = vi.fn();
    const p = withInterimNotice(() => new Promise<string>((r) => setTimeout(() => r('fast'), 3_000)), 12_000, notify);
    await vi.advanceTimersByTimeAsync(3_001); expect(await p).toBe('fast');
    await vi.advanceTimersByTimeAsync(20_000); expect(notify).not.toHaveBeenCalled();
  });
  it('a failing notice cannot break the work; a failing work still stops the timer', async () => {
    const p = withInterimNotice(() => new Promise<string>((r) => setTimeout(() => r('ok'), 15_000)), 12_000, () => { throw new Error('send failed'); });
    await vi.advanceTimersByTimeAsync(15_001); expect(await p).toBe('ok');
    const notify = vi.fn();
    const bad = withInterimNotice(() => Promise.reject(new Error('boom')), 12_000, notify);
    await expect(bad).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(20_000); expect(notify).not.toHaveBeenCalled();
  });
});

describe('payments not live', () => {
  it('a placeholder / missing Paystack key means payments are OFF (bot still works)', async () => {
    vi.resetModules();
    const { paymentsLive, verifyPaystackSignature, createCheckoutLink, PaymentsNotLiveError } = await import('../services/paystack.js');
    expect(paymentsLive()).toBe(false);
    expect(verifyPaystackSignature(Buffer.from('{}'), 'abcd')).toBe(false);   // can't "verify" with a fake key
    await expect(createCheckoutLink({ id: 'b', owner_phone: '1', referral_wallet_ngn: 0, name: 'x' } as never, 'starter_5k', 'monthly')).rejects.toBeInstanceOf(PaymentsNotLiveError);
  });
  it('a real-looking key switches payments ON', async () => {
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_9f8e7d6c5b4a39281716';
    const { paymentsLive } = await import('../services/paystack.js');
    expect(paymentsLive()).toBe(true);
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_placeholder_replace_me';
  });
});

const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!hasPdftotext)('receipt invite follows the plan watermark', () => {
  const pdfText = async (tier: string) => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed' })]);
    await customerReceiptReply(actor({ subscription_tier: tier, referral_code: 'UNBAR-X87X' }), 'batch1');
    const file = join(mkdtempSync(join(tmpdir(), 'rcpt-')), 'r.pdf');
    writeFileSync(file, m.uploadFile.mock.calls[0]![2]);
    return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
  };
  it('trial / free / Starter receipts invite the customer with the owner\'s referral code', async () => {
    for (const tier of ['trial', 'free_limited', 'starter_5k']) {
      m.uploadFile.mockClear();
      const t = await pdfText(tier);
      expect(t, tier).toContain('wa.me/2348000000000');
      expect(t, tier).toContain('UNBAR-X87X');
    }
  });
  it('Growth (no watermark) receipts stay clean', async () => {
    m.uploadFile.mockClear();
    const t = await pdfText('growth_15k');
    expect(t).not.toContain('wa.me/');
    expect(t).not.toContain('UNBAR-X87X');
    expect(t).toContain('Ada Fabrics');
  });
});

// ───────────────────────── receipts: same customer? logo? ─────────────────────────
describe('receipt: never assume several sales are one person', () => {
  const two = (a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) => [
    row({ status: 'confirmed', customer_id: null, customers: null, description: '2 × Lace', total_amount_ngn: 50000, amount_paid_ngn: 50000, ...a }),
    row({ status: 'confirmed', customer_id: null, customers: null, description: '1 × Ankara', total_amount_ngn: 15000, amount_paid_ngn: 15000, ...b }),
  ];
  const buttons = (r: { toPayload(): any }) => (r.toPayload() as any).interactive.action.buttons.map((x: any) => x.reply.id);

  it('two sales with no customer name → asks "same customer?" instead of making one receipt', async () => {
    m.getBatchRows.mockResolvedValueOnce(two());
    const r = await customerReceiptReply(actor(), 'batch1');
    expect(body(r)).toContain('2 sales');
    expect(body(r)).toContain('same customer');
    expect(buttons(r)).toEqual(['RCPT:batch1:one', 'RCPT:batch1:pick']);
    expect(m.uploadFile).not.toHaveBeenCalled();
    expect(m.consumeQuota).not.toHaveBeenCalled(); // asking costs nothing
  });
  it('two sales to two different named customers → also asks', async () => {
    m.getBatchRows.mockResolvedValueOnce(two({ customer_id: 'c1', customers: { name: 'Mama Tunde' } }, { customer_id: 'c2', customers: { name: 'Bisi' } }));
    expect(buttons(await customerReceiptReply(actor(), 'batch1'))).toEqual(['RCPT:batch1:one', 'RCPT:batch1:pick']);
  });
  it('two sales to the SAME named customer → one receipt, no question', async () => {
    m.getBatchRows.mockResolvedValueOnce(two({ customer_id: 'c1', customers: { name: 'Mama Tunde' } }, { customer_id: 'c1', customers: { name: 'Mama Tunde' } }));
    expect((await customerReceiptReply(actor(), 'batch1')).toPayload()).toMatchObject({ type: 'document' });
  });
  it('"Same customer" → ONE receipt with both lines', async () => {
    m.getBatchRows.mockResolvedValueOnce(two());
    const p = (await customerReceiptReply(actor(), 'batch1', undefined, 'one')).toPayload() as any;
    expect(p.type).toBe('document');
    expect(p.document.caption).toContain('2 × Lace');
    expect(p.document.caption).toContain('1 × Ankara');
  });
  it('"Different customers" → lets the owner pick which sale (buttons for ≤3)', async () => {
    m.getBatchRows.mockResolvedValueOnce(two());
    const r = await customerReceiptReply(actor(), 'batch1', undefined, 'pick');
    expect(buttons(r)).toEqual(['RCPT:batch1:L0', 'RCPT:batch1:L1']);
    expect(JSON.stringify(r.toPayload())).toContain('Lace');
  });
  it('picking one sale → a receipt for THAT sale only, with its own number', async () => {
    m.getBatchRows.mockResolvedValueOnce(two());
    const p = (await customerReceiptReply(actor(), 'batch1', undefined, 'L1')).toPayload() as any;
    expect(p.document.caption).toContain('1 × Ankara');
    expect(p.document.caption).not.toContain('Lace');
    expect(p.document.filename).toMatch(/-2\.pdf$/);
  });
  it('more than 3 sales → a list to pick from', async () => {
    m.getBatchRows.mockResolvedValueOnce([...two(), ...two()]);
    const p = (await customerReceiptReply(actor(), 'batch1', undefined, 'pick')).toPayload() as any;
    expect(p.interactive.type).toBe('list');
    expect(p.interactive.action.sections[0].rows).toHaveLength(4);
  });
  it('a single sale never triggers the question', async () => {
    m.getBatchRows.mockResolvedValueOnce([two()[0]]);
    expect((await customerReceiptReply(actor(), 'batch1')).toPayload()).toMatchObject({ type: 'document' });
  });
});

describe('receipt: logo', () => {
  it('first receipt asks once: send a logo, let me make one, or use the business name', async () => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed' })]);
    const r = await customerReceiptReply(actor({ logo_url: null }), 'batch1');
    expect(body(r)).toContain('Do you have a logo');
    expect(body(r)).toContain('design a clean one for you');
    expect((r.toPayload() as any).interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(['LOGO:ask:batch1', 'LOGO:make:batch1', 'LOGO:name:batch1']);
    expect(m.uploadFile).not.toHaveBeenCalled();
  });
  it('after choosing "use my name" (logo_url = none) the receipt is produced straight away', async () => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed' })]);
    expect((await customerReceiptReply(actor({ logo_url: 'none' }), 'batch1')).toPayload()).toMatchObject({ type: 'document' });
  });
  it('staff are not asked (only the owner sets branding)', async () => {
    m.getBatchRows.mockResolvedValueOnce([row({ status: 'confirmed' })]);
    const a = { ...(actor({ logo_url: null }) as object), isStaff: true } as never;
    expect((await customerReceiptReply(a, 'batch1')).toPayload()).toMatchObject({ type: 'document' });
  });
});
