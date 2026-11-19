import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123',
    GEMINI_API_KEY: 'x', PAYSTACK_SECRET_KEY: 'x', PAYSTACK_PLAN_STARTER_MONTHLY: 'a', PAYSTACK_PLAN_STARTER_ANNUAL: 'b',
    PAYSTACK_PLAN_GROWTH_MONTHLY: 'c', PAYSTACK_PLAN_GROWTH_ANNUAL: 'd',
  });
});

const m = vi.hoisted(() => ({
  consumeQuota: vi.fn(), refundQuota: vi.fn(), confirmBatch: vi.fn(), undoBatch: vi.fn(), getBatchRows: vi.fn(),
  createPendingBatch: vi.fn(), setReceiptUrl: vi.fn(), uploadFile: vi.fn(), signedUrl: vi.fn(), getProduct: vi.fn(),
  isInServiceWindow: vi.fn(), findBankSessionReuse: vi.fn(), updateBusiness: vi.fn(),
}));
vi.mock('../db/supabase.js', () => ({ ...m, db: {} }));
vi.mock('../flows/insights.js', () => ({ todayLine: async () => '📊 Today: …' }));
vi.mock('../services/pdfGenerator.js', () => ({ receiptPdf: async () => Buffer.from('%PDF') }));
vi.mock('../services/googleSheets.js', () => ({ appendLedgerRows: async () => undefined }));

import { PLANS } from '../config/plans.js';
import { confirmAndRespond, countsTowardTxQuota, linesToDrafts, proposeBatch, undoAndRespond } from '../flows/ledger.js';
import type { TxnLine } from '../services/geminiBrain.js';

const actor = (tier: keyof typeof PLANS, used: number) => ({
  phone: '2348000000001', isStaff: false,
  user: { id: 'u1', full_name: 'Ada' },
  business: { id: 'b1', name: 'Ada Fabrics', owner_phone: '2348000000001', subscription_tier: tier, tx_logged_this_month: used, rc_number: null, total_value_recovered_ngn: 0, google_sheet_id: null },
}) as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), business_id: 'b1', batch_id: 'batch1', tx_type: 'expense', status: 'pending_confirm', source_channel: 'whatsapp_text',
  description: 'Fuel', quantity: 1, unit_price_ngn: null, total_amount_ngn: 5000, amount_paid_ngn: 5000, payment_method: 'cash', product_id: null, customers: null, ...over,
});
const rows = (n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, () => row(over));
const quotaCalls = (metric: string) => m.consumeQuota.mock.calls.filter((c) => c[1] === metric);
const body = (r: { toPayload(): Record<string, any> }) => JSON.stringify(r.toPayload());

const line = (type: TxnLine['type'], extra: Partial<TxnLine> = {}): TxnLine =>
  ({ type, quantity: 1, amount_ngn: 5000, amount_paid_ngn: 5000, payment_method: 'cash', ...extra }) as TxnLine;

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.consumeQuota.mockResolvedValue(true);
  m.confirmBatch.mockResolvedValue(1);
  m.undoBatch.mockResolvedValue(true);
  m.createPendingBatch.mockResolvedValue({ batchId: 'batch1', rows: [] });
  m.uploadFile.mockResolvedValue('b1/r.pdf');
  m.signedUrl.mockResolvedValue('https://signed');
  m.isInServiceWindow.mockResolvedValue(false);
});

describe('plan caps (spec)', () => {
  it('free_limited: 20 text/SMS messages, voice gated off', () => {
    expect(PLANS.free_limited.tx_logged_this_month).toBe(20);
    expect(PLANS.free_limited.voiceNotes).toBe(false);
  });
  it('trial 20 + voice; starter 250 + voice; growth unlimited + voice', () => {
    expect([PLANS.trial.tx_logged_this_month, PLANS.trial.voiceNotes]).toEqual([20, true]);
    expect([PLANS.starter_5k.tx_logged_this_month, PLANS.starter_5k.voiceNotes]).toEqual([250, true]);
    expect([PLANS.growth_15k.tx_logged_this_month, PLANS.growth_15k.voiceNotes]).toEqual([-1, true]);
  });
});

describe('which inbound messages count', () => {
  it('voice, text and forwarded SMS count; screenshots/receipts do not (OCR quota covers them)', () => {
    expect(countsTowardTxQuota('whatsapp_voice')).toBe(true);
    expect(countsTowardTxQuota('whatsapp_text')).toBe(true);
    expect(countsTowardTxQuota('sms_forward')).toBe(true);
    expect(countsTowardTxQuota('whatsapp_image')).toBe(false);
  });
});

describe('proposing never charges; it only pre-checks the cap', () => {
  const three = linesToDrafts([line('sale', { item_name: 'Lace', amount_ngn: 50000, amount_paid_ngn: 30000, customer_name: 'Tunde' }), line('expense', { category: 'Fuel/Diesel' }), line('restock', { item_name: 'Gele' })]);

  it('a 3-item message creates a pending batch and charges nothing yet', async () => {
    const r = await proposeBatch(actor('trial', 5), 'whatsapp_voice', three);
    expect(m.createPendingBatch).toHaveBeenCalledOnce();
    expect(m.consumeQuota).not.toHaveBeenCalled();
    expect(body(r)).toContain('Confirm');
  });
  it('free_limited at 20/20 is blocked before a batch exists; at 19/20 it is allowed', async () => {
    expect(body(await proposeBatch(actor('free_limited', 20), 'whatsapp_text', three))).toContain('logged messages');
    expect(m.createPendingBatch).not.toHaveBeenCalled();
    await proposeBatch(actor('free_limited', 19), 'whatsapp_text', three);
    expect(m.createPendingBatch).toHaveBeenCalledOnce();
  });
  it('starter at 250/250 blocked, 249 allowed; growth never blocked', async () => {
    await proposeBatch(actor('starter_5k', 250), 'whatsapp_voice', three);
    expect(m.createPendingBatch).not.toHaveBeenCalled();
    await proposeBatch(actor('starter_5k', 249), 'whatsapp_voice', three);
    await proposeBatch(actor('growth_15k', 99999), 'whatsapp_voice', three);
    expect(m.createPendingBatch).toHaveBeenCalledTimes(2);
  });
  it('a supplier-receipt photo is not gated by the message cap', async () => {
    await proposeBatch(actor('free_limited', 20), 'whatsapp_image', three);
    expect(m.createPendingBatch).toHaveBeenCalledOnce();
  });
});

describe('confirming charges exactly 1 per message, whatever the line count', () => {
  it.each([[1], [3], [8]])('a %i-line text message costs 1', async (n) => {
    m.getBatchRows.mockResolvedValueOnce(rows(n)).mockResolvedValueOnce(rows(n, { status: 'confirmed' }));
    await confirmAndRespond(actor('starter_5k', 10), 'batch1');
    expect(quotaCalls('tx_logged_this_month')).toEqual([[expect.anything(), 'tx_logged_this_month', 1]]);
    expect(m.confirmBatch).toHaveBeenCalledOnce();
  });
  it('voice note and forwarded SMS each cost 1', async () => {
    for (const source_channel of ['whatsapp_voice', 'sms_forward']) {
      m.consumeQuota.mockClear();
      m.getBatchRows.mockResolvedValueOnce(rows(4, { source_channel })).mockResolvedValueOnce(rows(4, { source_channel, status: 'confirmed' }));
      await confirmAndRespond(actor('trial', 0), 'batch1');
      expect(quotaCalls('tx_logged_this_month')).toHaveLength(1);
    }
  });
  it('an OCR-sourced batch is not charged as a logged message', async () => {
    m.getBatchRows.mockResolvedValueOnce(rows(1, { source_channel: 'whatsapp_image' })).mockResolvedValueOnce(rows(1, { source_channel: 'whatsapp_image', status: 'confirmed' }));
    await confirmAndRespond(actor('trial', 0), 'batch1');
    expect(quotaCalls('tx_logged_this_month')).toHaveLength(0);
  });
  it('over the cap at confirm time → entry discarded, nothing confirmed, upsell shown', async () => {
    m.consumeQuota.mockImplementation(async (_b, metric) => metric !== 'tx_logged_this_month');
    m.getBatchRows.mockResolvedValueOnce(rows(3));
    const r = await confirmAndRespond(actor('free_limited', 19), 'batch1');
    expect(m.undoBatch).toHaveBeenCalledWith('batch1');
    expect(m.confirmBatch).not.toHaveBeenCalled();
    expect(body(r)).toContain('logged messages');
  });
  it('a failed or raced confirm returns the unit', async () => {
    m.getBatchRows.mockResolvedValueOnce(rows(2));
    m.confirmBatch.mockRejectedValueOnce(new Error('db down'));
    await expect(confirmAndRespond(actor('trial', 0), 'batch1')).rejects.toThrow('db down');
    expect(m.refundQuota).toHaveBeenCalledWith('b1', 'tx_logged_this_month', 1);

    m.refundQuota.mockClear();
    m.getBatchRows.mockResolvedValueOnce(rows(2));
    m.confirmBatch.mockResolvedValueOnce(0);
    await confirmAndRespond(actor('trial', 0), 'batch1');
    expect(m.refundQuota).toHaveBeenCalledWith('b1', 'tx_logged_this_month', 1);
  });
  it('double-tapping Confirm on an already-confirmed batch does not charge again', async () => {
    m.getBatchRows.mockResolvedValueOnce(rows(3, { status: 'confirmed' }));
    await confirmAndRespond(actor('trial', 3), 'batch1');
    expect(m.consumeQuota).not.toHaveBeenCalled();
  });
});

describe('undo gives the unit back (once, only if it was charged)', () => {
  it('undoing a confirmed text message refunds exactly 1, not one per line', async () => {
    m.getBatchRows.mockResolvedValueOnce(rows(5, { status: 'confirmed' }));
    await undoAndRespond(actor('trial', 1), 'batch1');
    expect(m.refundQuota).toHaveBeenCalledOnce();
    expect(m.refundQuota).toHaveBeenCalledWith('b1', 'tx_logged_this_month', 1);
  });
  it('undoing a still-pending entry refunds nothing (it was never charged)', async () => {
    m.getBatchRows.mockResolvedValueOnce(rows(2));
    await undoAndRespond(actor('trial', 1), 'batch1');
    expect(m.undoBatch).toHaveBeenCalled();
    expect(m.refundQuota).not.toHaveBeenCalled();
  });
  it('an OCR batch refunds no message unit; another business\'s batch is untouchable', async () => {
    m.getBatchRows.mockResolvedValueOnce(rows(1, { status: 'confirmed', source_channel: 'whatsapp_image' }));
    await undoAndRespond(actor('trial', 1), 'batch1');
    expect(m.refundQuota).not.toHaveBeenCalled();

    m.undoBatch.mockClear();
    m.getBatchRows.mockResolvedValueOnce(rows(1, { status: 'confirmed', business_id: 'OTHER' }));
    await undoAndRespond(actor('trial', 1), 'batch1');
    expect(m.undoBatch).not.toHaveBeenCalled();
    expect(m.refundQuota).not.toHaveBeenCalled();
  });
  it('failed undo (past the 5-minute window) refunds nothing', async () => {
    m.undoBatch.mockResolvedValueOnce(false);
    m.getBatchRows.mockResolvedValueOnce(rows(2, { status: 'confirmed' }));
    await undoAndRespond(actor('trial', 1), 'batch1');
    expect(m.refundQuota).not.toHaveBeenCalled();
  });
});
