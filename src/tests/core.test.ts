import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_VERIFY_TOKEN: 'verify-token-123',
    GEMINI_API_KEY: 'x', PAYSTACK_SECRET_KEY: 'sk_test_abc', PAYSTACK_PLAN_STARTER_MONTHLY: 'a', PAYSTACK_PLAN_STARTER_ANNUAL: 'b',
    PAYSTACK_PLAN_GROWTH_MONTHLY: 'c', PAYSTACK_PLAN_GROWTH_ANNUAL: 'd',
  });
});

import { MINI_VIDEO, PLANS, TRIAL_DAYS } from '../config/plans.js';
import { ngn, ngnShort, watDateKey, watDayStart, watWeekKey } from '../lib/money.js';
import { periodRange } from '../flows/insights.js';
import { linesToDrafts, draftLine } from '../flows/ledger.js';
import { reply, templateComponents } from '../services/whatsapp.js';
import { verifyMetaSignature } from '../services/whatsapp.js';
import { verifyPaystackSignature } from '../services/paystack.js';
import { receiptPdf, weeklyStatementPdf } from '../services/pdfGenerator.js';

describe('webhook signatures', () => {
  const body = Buffer.from('{"hello":"world"}');
  it('accepts a valid Meta signature and rejects tampering', () => {
    const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(body).digest('hex');
    expect(verifyMetaSignature(body, sig)).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"hello":"w0rld"}'), sig)).toBe(false);
    expect(verifyMetaSignature(body, undefined)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=abc')).toBe(false);
  });
  it('accepts a valid Paystack HMAC-SHA512 and rejects bad ones', () => {
    const sig = crypto.createHmac('sha512', 'sk_test_abc').update(body).digest('hex');
    expect(verifyPaystackSignature(body, sig)).toBe(true);
    expect(verifyPaystackSignature(body, sig.replace(/.$/, '0'))).toBe(false);
    expect(verifyPaystackSignature(body, undefined)).toBe(false);
  });
});

describe('plan caps match the spec', () => {
  it('trial', () => {
    const t = PLANS.trial;
    expect([t.videos_used_this_month, t.tx_logged_this_month, t.ocr_scans_used_this_month, t.pdf_receipts_used_this_month, t.ceo_reports_used_this_month]).toEqual([5, 20, 10, -1, 1]);   // pilot: 5 short videos over the 14-day trial (was 2 full ones)
  });
  it('trial lasts 14 days; short (~10 s) videos on the free tiers, full HD on paid', () => {
    expect(TRIAL_DAYS).toBe(14);
    expect([PLANS.trial.videoLength, PLANS.free_limited.videoLength, PLANS.starter_5k.videoLength, PLANS.growth_15k.videoLength]).toEqual(['mini', 'mini', 'full', 'full']);
    expect(MINI_VIDEO.maxPhotos).toBeLessThan(5);                         // fewer photos → fewer image-model calls → cheaper
    expect(MINI_VIDEO.maxSeconds).toBeLessThanOrEqual(12);
  });
  it('free_limited never gets voice, OCR or paid outbound', () => {
    const f = PLANS.free_limited;
    expect([f.videos_used_this_month, f.tx_logged_this_month, f.pdf_receipts_used_this_month]).toEqual([1, 20, 3]);
    expect(f.voiceNotes).toBe(false);
    expect(f.ocr_scans_used_this_month).toBe(0);
    expect(f.outboundCeoTemplate).toBe(false);
  });
  it('starter and growth', () => {
    expect([PLANS.starter_5k.videos_used_this_month, PLANS.starter_5k.tx_logged_this_month, PLANS.starter_5k.ocr_scans_used_this_month]).toEqual([15, 250, 150]);
    expect([PLANS.growth_15k.videos_used_this_month, PLANS.growth_15k.tx_logged_this_month, PLANS.growth_15k.ocr_scans_used_this_month, PLANS.growth_15k.maxStaff]).toEqual([50, -1, 500, 10]);
    expect(PLANS.growth_15k.watermark).toBe('none');
  });
});

describe('WAT time helpers', () => {
  it('day boundary is midnight Lagos, not UTC', () => {
    // 23:30 UTC on 18 Nov = 00:30 WAT on 19 Nov
    const d = new Date('2026-11-18T23:30:00Z');
    expect(watDateKey(d)).toBe('2026-11-19');
    expect(watDayStart(d).toISOString()).toBe('2026-11-18T23:00:00.000Z');
  });
  it('week starts Monday WAT', () => {
    const sunday = new Date('2026-11-22T17:00:00Z'); // Sunday 6 PM WAT
    const { from } = periodRange('this_week', sunday);
    expect(from.toISOString()).toBe('2026-11-15T23:00:00.000Z'); // Mon 16 Nov 00:00 WAT
    expect(watWeekKey(sunday)).toBe('2026-W47');
  });
  it('formats naira', () => {
    expect(ngn(1234567)).toBe('₦1,234,567');
    expect(ngnShort(50000)).toBe('₦50k');
    expect(ngnShort(1_200_000)).toBe('₦1.2m');
  });
});

describe('compound voice note → atomic drafts', () => {
  it('"Sold 2 laces 50k, transfer 30k balance 20k, buy fuel 5k"', () => {
    const drafts = linesToDrafts([
      { type: 'sale', item_name: 'Lace', quantity: 2, amount_ngn: 50000, amount_paid_ngn: 30000, payment_method: 'transfer', customer_name: 'Mama Tunde' },
      { type: 'expense', quantity: 1, amount_ngn: 5000, amount_paid_ngn: 5000, payment_method: 'cash', category: 'Fuel/Diesel' },
    ]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ tx_type: 'sale', total_amount_ngn: 50000, amount_paid_ngn: 30000, unit_price_ngn: 25000, customer_name: 'Mama Tunde' });
    expect(drafts[1]).toMatchObject({ tx_type: 'expense', category: 'Fuel/Diesel', item_name: null });
    expect(draftLine(drafts[0]!)).toContain('Mama Tunde owes ₦20k');
  });
  it('never records more paid than the total', () => {
    const [d] = linesToDrafts([{ type: 'sale', item_name: 'Bag', quantity: 1, amount_ngn: 10000, amount_paid_ngn: 99999, payment_method: 'cash' }]);
    expect(d!.amount_paid_ngn).toBe(10000);
  });
});

describe('single-reply bundler', () => {
  it('folds text + PDF + buttons into ONE interactive payload', () => {
    const p = reply('234').text('✅ Saved', '📊 Today').document('https://x/y.pdf', 'R.pdf').button('a', '✅ Confirm').button('b', '↩️ Undo').toPayload() as any;
    expect(p.type).toBe('interactive');
    expect(p.interactive.header.type).toBe('document');
    expect(p.interactive.action.buttons).toHaveLength(2);
    expect(p.interactive.body.text).toContain('Saved');
  });
  it('video + caption is one message; max 3 buttons enforced; titles clipped to 20', () => {
    const v = reply('234').video('https://x/v.mp4').text('cap').toPayload() as any;
    expect(v.type).toBe('video');
    expect(v.video.caption).toBe('cap');
    expect(() => reply('1').button('1', 'a').button('2', 'b').button('3', 'c').button('4', 'd')).toThrow();
    expect((reply('1').text('x').button('1', 'This title is far too long for WhatsApp').toPayload() as any).interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
  });
});

describe('PDF generation', () => {
  it('renders a receipt with ₦ and a statement', async () => {
    const r = await receiptPdf({
      businessName: 'Ada Fabrics', rcNumber: '1234567', receiptNumber: '261119-AB12', dateWat: '2026-11-19 10:00 WAT', customerName: 'Mama Tunde',
      lines: [{ description: '2 × Lace', quantity: 2, unitPrice: 25000, amount: 50000 }], amountPaid: 50000, paymentMethod: 'transfer',
    });
    expect(r.subarray(0, 4).toString()).toBe('%PDF');
    const s = await weeklyStatementPdf({
      businessName: 'Ada Fabrics', rcNumber: null, periodLabel: '11-16 → 11-22', revenue: 500000, expenses: 80000, restock: 200000, netProfit: 220000,
      cashIn: 400000, debtCollected: 20000, expenseByCategory: [{ category: 'Fuel/Diesel', amount: 40000, changePct: 35 }],
      topProducts: [{ name: 'Lace', qty: 10, revenue: 250000 }], debtors: [{ name: 'Mama Tunde', amount: 20000, days: 23 }],
      deadStock: [{ name: 'Gele', qty: 12, days: 30 }], valueRecovered: 15000,
    });
    expect(s.subarray(0, 4).toString()).toBe('%PDF');
    expect(r.length).toBeGreaterThan(2000);
  });
});

describe('Meta template components', () => {
  const tok = 'ab'.repeat(32);
  it('URL button carries the per-user token at index 0; quick replies shift to 1..3', () => {
    const c = templateComponents(['Ada', '₦500k'], ['BTN_CHASE_DEBT', 'BTN_DEADSTOCK_PROMO', 'BTN_EXPORT_PDF'], tok);
    expect(c[1]).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] });
    expect(c.slice(2).map((x: any) => [x.sub_type, x.index, x.parameters[0].payload])).toEqual([
      ['quick_reply', '1', 'BTN_CHASE_DEBT'], ['quick_reply', '2', 'BTN_DEADSTOCK_PROMO'], ['quick_reply', '3', 'BTN_EXPORT_PDF'],
    ]);
  });
  it('without a token, quick replies start at index 0', () => {
    const c = templateComponents(['x'], ['A', 'B']);
    expect(c.map((x: any) => x.index)).toEqual([undefined, '0', '1']);
  });
});

describe('Sunday CEO template payload: URL button only', () => {
  it('body + exactly ONE button (dynamic URL, index 0) and no quick replies', () => {
    const tok = 'cd'.repeat(32);
    const c = templateComponents(['Ada', '₦500k', '₦120k', '₦20k (2 customers)', 'Fuel up 40%'], [], tok) as any[];
    expect(c).toHaveLength(2);
    expect(c[0].type).toBe('body');
    expect(c[0].parameters).toHaveLength(5);
    expect(c[1]).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: tok }] });
    expect(c.some((x) => x.sub_type === 'quick_reply')).toBe(false);
  });
});

describe('BullMQ custom job ids', () => {
  it('contain no ":" (BullMQ throws "Custom Id cannot contain :", which silently dropped every inbound message)', async () => {
    const fs = await import('node:fs');
    for (const f of ['src/server.ts', 'src/flows/video.ts']) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/jobId:\s*`([^`]*)`/g)) expect(m[1]).not.toContain(':');
    }
  });
});
