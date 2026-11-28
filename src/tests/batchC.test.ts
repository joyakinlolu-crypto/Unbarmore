import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

// An in-memory stand-in for the quotes table, so create → list → paid → extend → cancel run for real.
const m = vi.hoisted(() => ({
  quotes: [] as Record<string, any>[],
  uploaded: [] as { path: string; size: number }[],
  batches: [] as any[][],
  confirmed: [] as string[],
  quota: { ok: true },
  failInsertWith23505Once: { on: false },
  businessUpdates: [] as Record<string, unknown>[],
}));

vi.mock('../db/supabase.js', () => {
  const table = (name: string) => {
    let filters: [string, unknown][] = [], op: 'select' | 'update' | 'insert' = 'select', patch: any = null, order: [string, boolean] | null = null, lim = 100, wantRow = false;
    const rowsOf = () => {
      if (name === 'businesses') return [];
      let rows = m.quotes.filter((q) => filters.every(([k, v]) => (k.startsWith('>=') ? String(q[k.slice(2)] ?? '') >= String(v) : k.startsWith('<=') ? String(q[k.slice(2)] ?? '') <= String(v) : q[k] === v)));
      if (order) rows = [...rows].sort((a, b) => (order![1] ? a[order![0]] - b[order![0]] : b[order![0]] - a[order![0]]));
      return rows.slice(0, lim);
    };
    const exec = () => {
      if (name === 'businesses') { if (op === 'update') m.businessUpdates.push(patch); return { data: null, error: null }; }
      if (op === 'insert') {
        if (m.failInsertWith23505Once.on) { m.failInsertWith23505Once.on = false; return { data: null, error: { code: '23505' } }; }
        const row = { id: `q-${m.quotes.length + 1}`, status: 'open', paid_method: null, ...patch };
        m.quotes.push(row); return { data: row, error: null };
      }
      if (op === 'update') { const hit = rowsOf(); hit.forEach((r) => Object.assign(r, patch)); return { data: wantRow ? (hit[0] ?? null) : hit, error: null }; }
      const rows = rowsOf(); return { data: wantRow ? (rows[0] ?? null) : rows, error: null };
    };
    const api: any = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (res: any) => res(exec());
        return (...args: any[]) => {
          if (prop === 'insert') { op = 'insert'; patch = args[0]; }
          else if (prop === 'update') { op = 'update'; patch = args[0]; }
          else if (prop === 'eq') filters.push([args[0], args[1]]);
          else if (prop === 'gte') filters.push([`>=${args[0]}`, args[1]]);
          else if (prop === 'lte') filters.push([`<=${args[0]}`, args[1]]);
          else if (prop === 'order') order = [args[0], !!args[1]?.ascending];
          else if (prop === 'limit') lim = args[0];
          else if (prop === 'maybeSingle' || prop === 'single') wantRow = true;
          return api;
        };
      },
    });
    return api;
  };
  return {
    db: { from: (n: string) => table(n) },
    consumeQuota: vi.fn(async () => m.quota.ok),
    uploadFile: vi.fn(async (_b: string, p: string, d: Buffer) => { m.uploaded.push({ path: p, size: d.length }); return p; }),
    signedUrl: vi.fn(async (_b: string, p: string) => `https://files.test/${p}`),
    createPendingBatch: vi.fn(async (_a: unknown, _s: string, drafts: any[]) => { m.batches.push(drafts); return { batchId: `batch-${m.batches.length}`, rows: [] }; }),
    confirmBatch: vi.fn(async () => { throw new Error('quotes must not confirm the batch themselves: confirmAndRespond does it'); }),
    downloadFile: vi.fn(), updateBusiness: vi.fn(), setSession: vi.fn(),
  };
});
vi.mock('../flows/ledger.js', () => ({
  // The real confirmAndRespond is what confirms the batch; calling confirmBatch first made it answer "Already saved".
  confirmAndRespond: vi.fn(async (_a: unknown, id: string) => { m.confirmed.push(id); return (await import('../services/whatsapp.js')).reply('2348000000001').text('✅ Saved', '📊 Today: Sales ₦105,000'); }),
  quotaReply: vi.fn(() => (globalThis as any).__reply('2348000000001').text('QUOTA')),
}));
vi.mock('../flows/branding.js', () => ({ loadLogo: vi.fn(async () => null), initials: (n: string) => n.slice(0, 2).toUpperCase(), saveLogo: vi.fn(), logoPrompt: vi.fn() }));

import { PLANS } from '../config/plans.js';
import { createQuote, payDetailsReply, quoteCancel, quoteExtend, quotePaid, quotesListReply } from '../flows/quotes.js';
import { quotesDue } from '../flows/quotesDue.js';
import { composeMorning } from '../flows/morning.js';
import { flyerCaption, isFlyerCaption, parseFlyerOptions, pickPalette, pickTag } from '../flows/flyer.js';
import { daysLeft, extendedUntil, expiryPhrase, parsePayDetailsCommand, parseQuoteCommand, quoteLabel, quoteTotal, validUntil } from '../lib/quote.js';
import { PALETTES, renderFlyer, renderLogo, wrapText } from '../services/flyer.js';
import { quotePdf } from '../services/pdfGenerator.js';
import { reply } from '../services/whatsapp.js';
(globalThis as any).__reply = reply;

const doc = (r: { toPayload(): Record<string, any> }) => r.toPayload() as any;
const body = (r: { toPayload(): Record<string, any> }) => { const p = doc(r); return String(p.text?.body ?? p.interactive?.body?.text ?? p.document?.caption ?? ''); };
const buttons = (r: { toPayload(): Record<string, any> }) => (doc(r).interactive?.action?.buttons ?? []).map((b: any) => b.reply.id as string);
const actor = (tier: keyof typeof PLANS = 'starter_5k', extra: Record<string, unknown> = {}) => ({
  phone: '2348000000001', isStaff: false, user: { id: 'u1' },
  business: { id: 'b1', name: 'Ada Fabrics', rc_number: null, owner_phone: '2348000000001', referral_code: 'UNBAR-ABCD', subscription_tier: tier, tx_logged_this_month: 0, logo_url: null, pay_details: null, ...extra },
}) as never;
const req = { customer_name: 'Mama Tunde', lines: [{ item_name: 'Lace', quantity: 2, unit_price_ngn: 50_000 }, { item_name: 'Gele', quantity: 1, unit_price_ngn: 5_000 }], delivery_fee_ngn: 2_000 };

beforeEach(() => { m.quotes.length = 0; m.uploaded.length = 0; m.batches.length = 0; m.confirmed.length = 0; m.quota.ok = true; m.failInsertWith23505Once.on = false; m.businessUpdates.length = 0; });

describe('quote rules (pure)', () => {
  it('totals include delivery; numbers are Q-001 style', () => {
    expect(quoteTotal([{ item: 'Lace', qty: 2, unit: 50_000 }, { item: 'Gele', qty: 1, unit: 5_000 }], 2_000)).toBe(107_000);
    expect(quoteLabel(7)).toBe('Q-007'); expect(quoteLabel(1234)).toBe('Q-1234');
  });
  it('validity: counted from today; extending an expired quote starts from TODAY, a live one adds to its end date', () => {
    expect(validUntil('2026-11-27', 3)).toBe('2026-11-30');
    expect(validUntil('2026-11-27', 500)).toBe('2027-02-25');                    // capped at 90 days
    expect(extendedUntil('2026-12-05', '2026-12-01', 3)).toBe('2026-12-08');   // live: 5 Dec + 3
    expect(extendedUntil('2026-11-20', '2026-12-01', 3)).toBe('2026-12-04');   // expired: today + 3, never in the past
    expect(extendedUntil(null, '2026-12-01', 3)).toBe('2026-12-04');
  });
  it('days left and the plain-language phrase', () => {
    expect(daysLeft('2026-12-02', '2026-12-01')).toBe(1); expect(daysLeft(null, '2026-12-01')).toBeNull();
    expect([2, 1, 0, -1, -4].map((n) => expiryPhrase(n))).toEqual(['2 days left', 'expires tomorrow', 'expires today', 'expired yesterday', 'expired 4 days ago']);
    expect(expiryPhrase(null)).toBe('no expiry');
  });
  it.each([
    ['Q-014 PAID', { no: 14, action: 'paid', method: null }], ['q14 paid cash', { no: 14, action: 'paid', method: 'cash' }], ['Quote 14 paid transfer', { no: 14, action: 'paid', method: 'transfer' }],
    ['Q-014 extend 7', { no: 14, action: 'extend', days: 7 }], ['q-14 EXTEND', { no: 14, action: 'extend', days: 3 }], ['Q-014 cancel', { no: 14, action: 'cancel' }],
  ])('"%s" is a quote command', (t, want) => { expect(parseQuoteCommand(t)).toEqual(want); });
  it('lookalikes are not quote commands', () => {
    for (const no of ['Q-014', 'paid Q-014', 'Q-014 PAID maybe', 'quote for Ada 2 lace', 'quotes', 'Q-014 extend soon', 'Q-014 cancel it']) expect(parseQuoteCommand(no)).toBeNull();
  });
  it('MY ACCOUNT parsing', () => {
    expect(parsePayDetailsCommand('MY ACCOUNT GTBank 0123456789 Ada Fabrics')).toEqual({ text: 'GTBank 0123456789 Ada Fabrics' });
    expect(parsePayDetailsCommand('my account')).toBe('show'); expect(parsePayDetailsCommand('account details:')).toBe('show');
    expect(parsePayDetailsCommand('my accountant said hi')).toBeNull(); expect(parsePayDetailsCommand('sold 2 lace')).toBeNull();
  });
});

describe('creating a quote', () => {
  it('Starter: PDF built and stored, ONE message with the document + Mark paid / Extend / Cancel; held for 3 days', async () => {
    const r = await createQuote(actor('starter_5k'), req);
    const p = doc(r);
    expect(p.interactive.header.type).toBe('document'); expect(p.interactive.header.document.filename).toBe('Quote-Q-001.pdf');
    expect(buttons(r)).toEqual(['QPAID:q-1', 'QEXT:q-1', 'QCAN:q-1']);
    const t = body(r);
    expect(t).toContain('Q-001'); expect(t).toContain('Mama Tunde'); expect(t).toContain('₦107,000'); expect(t).toContain('Price held until'); expect(t).toContain('MY ACCOUNT');
    expect(m.quotes[0]).toMatchObject({ quote_no: 1, customer_name: 'Mama Tunde', total_ngn: 107_000, delivery_fee_ngn: 2_000, status: 'open' });
    expect(m.quotes[0]!.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.uploaded[0]!.path).toBe('b1/quotes/Q-001.pdf'); expect(m.uploaded[0]!.size).toBeGreaterThan(1500);
  });
  it('Free plan: a branded quote with NO expiry, no Extend button, and a nudge towards Starter', async () => {
    const r = await createQuote(actor('free_limited'), req);
    expect(m.quotes[0]!.valid_until).toBeNull();
    expect(buttons(r)).toEqual(['QPAID:q-1', 'QCAN:q-1']);
    expect(body(r)).toContain('Starter adds a price-validity window'); expect(body(r)).not.toContain('Price held until');
  });
  it('the owner\'s own validity (valid 7 days) is honoured on paid plans', async () => {
    await createQuote(actor('starter_5k'), { ...req, valid_days: 7 });
    expect(m.quotes[0]!.valid_until).toBe(validUntil(new Date(Date.now() + 3600_000).toISOString().slice(0, 10), 7));
  });
  it('numbers count up per shop; two quotes made at the same instant retry and both succeed', async () => {
    await createQuote(actor(), req);
    m.failInsertWith23505Once.on = true;
    await createQuote(actor(), req);
    expect(m.quotes.map((q) => q.quote_no)).toEqual([2 - 1, 2]);
  });
  it('with bank details saved there is no tip; nothing to quote → asks, writes nothing', async () => {
    expect(body(await createQuote(actor('starter_5k', { pay_details: 'GTBank 0123456789' }), req))).not.toContain('MY ACCOUNT');
    expect(body(await createQuote(actor(), { customer_name: 'X', lines: [] }))).toContain('items and prices');
    expect(body(await createQuote(actor(), { lines: [{ item_name: 'Gift', quantity: 1, unit_price_ngn: 0 }] }))).toContain('₦0');
    expect(m.quotes).toHaveLength(1);
  });
  it('a free plan that has used its PDFs this month is stopped by the same quota as receipts', async () => {
    m.quota.ok = false;
    expect(body(await createQuote(actor('free_limited'), req))).toBe('QUOTA'); expect(m.quotes).toHaveLength(0);
  });
});

describe('marking a quote paid records the sale exactly once', () => {
  it('asks HOW it was paid (cash vs transfer matter for the drawer) when not told', async () => {
    await createQuote(actor(), req);
    const r = await quotePaid(actor(), { id: 'q-1' }, null);
    expect(buttons(r)).toEqual(['QPM:q-1:transfer', 'QPM:q-1:cash', 'QPM:q-1:pos']); expect(m.batches).toHaveLength(0);
  });
  it('paid by cash → one sale line per item + delivery, fully paid, attached to the customer; quote closed', async () => {
    await createQuote(actor(), req);
    const r = await quotePaid(actor(), { no: 1 }, 'cash');
    expect(m.batches[0]!.map((d: any) => [d.description, d.total_amount_ngn, d.amount_paid_ngn, d.payment_method, d.customer_name])).toEqual([
      ['2 × Lace', 100_000, 100_000, 'cash', 'Mama Tunde'], ['1 × Gele', 5_000, 5_000, 'cash', 'Mama Tunde'], ['Delivery', 2_000, 2_000, 'cash', 'Mama Tunde'],
    ]);
    expect(m.batches[0]![2].item_name).toBeNull();                                   // delivery is not a product
    expect(m.confirmed).toEqual(['batch-1']); expect(m.quotes[0]).toMatchObject({ status: 'paid', paid_method: 'cash' });
    expect(body(r)).toContain('Saved'); expect(body(r)).toContain('Q-001 marked paid (cash)');
  });
  it('saying PAID twice never records the sale twice', async () => {
    await createQuote(actor(), req);
    await quotePaid(actor(), { no: 1 }, 'transfer');
    const again = await quotePaid(actor(), { no: 1 }, 'transfer');
    expect(m.batches).toHaveLength(1); expect(body(again)).toContain('already marked paid');
  });
  it('cancelled or unknown quotes record nothing', async () => {
    await createQuote(actor(), req); await quoteCancel(actor(), { no: 1 });
    expect(body(await quotePaid(actor(), { no: 1 }, 'cash'))).toContain('was cancelled');
    expect(body(await quotePaid(actor(), { no: 99 }, 'cash'))).toContain('can\'t find'); expect(m.batches).toHaveLength(0);
  });
  it('a shop that has used its logging allowance is stopped BEFORE the quote is marked paid (nothing half-done)', async () => {
    await createQuote(actor('free_limited'), req);
    const r = await quotePaid(actor('free_limited', { tx_logged_this_month: 20 }), { no: 1 }, 'cash');
    expect(body(r)).toBe('QUOTA'); expect(m.quotes[0]!.status).toBe('open'); expect(m.batches).toHaveLength(0);
  });
  it('another shop cannot touch this shop\'s quote', async () => {
    await createQuote(actor(), req);
    expect(body(await quotePaid({ ...(actor() as object), business: { ...(actor() as any).business, id: 'OTHER' } } as never, { no: 1 }, 'cash'))).toContain('can\'t find');
    expect(m.batches).toHaveLength(0);
  });
});

describe('extend, cancel, list', () => {
  it('extend gives a NEW PDF (same number, later date) to forward; free plans are told there is no expiry', async () => {
    await createQuote(actor(), req);
    const before = m.quotes[0]!.valid_until as string;
    const r = await quoteExtend(actor(), { no: 1 }, 5);
    expect(m.quotes[0]!.valid_until > before).toBe(true); expect(doc(r).interactive.header.document.filename).toBe('Quote-Q-001.pdf'); expect(body(r)).toContain('extended to');
    expect(m.uploaded).toHaveLength(2);
    expect(body(await quoteExtend(actor('free_limited'), { no: 1 }, 5))).toContain('no expiry');
  });
  it('cannot extend a paid or cancelled quote', async () => {
    await createQuote(actor(), req); await quotePaid(actor(), { no: 1 }, 'cash');
    expect(body(await quoteExtend(actor(), { no: 1 }, 3))).toContain('is paid');
  });
  it('QUOTES lists open ones with the total waiting and how long each has left', async () => {
    await createQuote(actor(), req); await createQuote(actor(), { ...req, customer_name: 'Ada' });
    const t = body(await quotesListReply(actor()));
    expect(t).toContain('₦214,000 waiting'); expect(t).toContain('Q-001'); expect(t).toContain('Q-002'); expect(t).toContain('days left');
    await quoteCancel(actor(), { no: 1 });
    expect(body(await quotesListReply(actor()))).not.toContain('Q-001');
  });
  it('MY ACCOUNT: strict (needs a bank and a 10-digit number), owner only, saved on the business', async () => {
    expect(body(await payDetailsReply(actor(), { text: 'my number is 0803' }))).toContain('10-digit');
    expect(body(await payDetailsReply({ ...(actor() as object), isStaff: true } as never, { text: 'GTBank 0123456789' }))).toContain('Only the shop owner');
    expect(body(await payDetailsReply(actor(), { text: 'GTBank 0123456789 Ada Fabrics' }))).toContain('Pay to: GTBank 0123456789 Ada Fabrics');
    expect(m.businessUpdates).toEqual([{ pay_details: 'GTBank 0123456789 Ada Fabrics' }]);
  });
});

describe('7 AM note: expiring quotes', () => {
  const base = { businessName: 'Ada', yesterday: null, debts: [], quiet: [], lowStock: [], isMonday: false };
  it('quotes expiring tomorrow / today / expired yesterday are named, with the command to act', async () => {
    const t = composeMorning({ ...base, quotes: [{ label: 'Q-014', customer: 'Mama Tunde', total: 105_000, left: 1 }, { label: 'Q-012', customer: null, total: 20_000, left: -1 }] }).lines.join('\n');
    expect(t).toContain('Quote Q-014 (Mama Tunde, ₦105,000) expires tomorrow'); expect(t).toContain('Quote Q-012 (₦20,000) expired yesterday');
    expect(t).toContain('Ask Mama Tunde to pay Q-014 before it expires tomorrow'); expect(t).toContain('Q-014 EXTEND 3');
    expect(composeMorning({ ...base, quotes: [{ label: 'Q-012', customer: 'Ada', total: 1, left: -1 }] }).lines.join('\n')).toContain('Q-012 PAID');
  });
  it('an overdue debt still comes first; no quotes → no quote lines', () => {
    const t = composeMorning({ ...base, debts: [{ name: 'Kalu', amount: 28_000, late: 3, age: 20 }], quotes: [{ label: 'Q-014', customer: 'X', total: 1, left: 0 }] }).lines.join('\n');
    expect(t).toContain('Start with Kalu');
    expect(composeMorning(base).lines.join('\n')).not.toContain('Quote');
  });
  it('quotesDue only returns open quotes within a day either side of today', async () => {
    m.quotes.push(
      { quote_no: 1, status: 'open', customer_name: 'A', total_ngn: '10', valid_until: '2026-12-02' }, { quote_no: 2, status: 'open', customer_name: 'B', total_ngn: '20', valid_until: '2026-12-01' },
      { quote_no: 3, status: 'open', customer_name: 'C', total_ngn: '30', valid_until: '2026-11-30' }, { quote_no: 4, status: 'open', customer_name: 'D', total_ngn: '40', valid_until: '2026-12-09' },
      { quote_no: 5, status: 'paid', customer_name: 'E', total_ngn: '50', valid_until: '2026-12-01' }, { quote_no: 6, status: 'open', customer_name: 'F', total_ngn: '60', valid_until: null },
    );
    m.quotes.forEach((q) => { q.business_id = 'b1'; });
    const due = await quotesDue('b1', '2026-12-01');
    expect(due.map((d) => [d.label, d.left]).sort()).toEqual([['Q-001', 1], ['Q-002', 0], ['Q-003', -1]]);
  });
});

describe('logos: made-for-you versus the owner\'s own', () => {
  it('generated logos are stored under a different name, so a real logo can always be told apart', async () => {
    const real = await vi.importActual<typeof import('../flows/branding.js')>('../flows/branding.js').catch(() => null);
    if (real) { expect(real.isGeneratedLogo({ logo_url: 'abc/logo-auto.png' })).toBe(true); expect(real.isGeneratedLogo({ logo_url: 'abc/logo.png' })).toBe(false); expect(real.isGeneratedLogo({ logo_url: 'none' })).toBe(false); expect(real.isGeneratedLogo({ logo_url: null })).toBe(false); }
  });
});

describe('plans: what each tier gets', () => {
  it('quote validity windows are on trial/Starter/Growth, off on the free plan', () => {
    expect([PLANS.trial.quoteExpiry, PLANS.starter_5k.quoteExpiry, PLANS.growth_15k.quoteExpiry, PLANS.free_limited.quoteExpiry]).toEqual([true, true, true, false]);
  });
});

describe('free flyer + logo (no AI, no cost)', () => {
  it('flyer captions', () => {
    expect(flyerCaption('flyer Ankara gown 15k')).toMatchObject({ name: expect.stringMatching(/ankara gown/i), price: 15_000 });
    expect(flyerCaption('FLYER: gele 5,000')).toMatchObject({ price: 5_000 });
    expect(flyerCaption('flyer')).toBeNull(); expect(isFlyerCaption('flyer')).toBe(true);
    expect(isFlyerCaption('Cord lace 17500')).toBe(false); expect(isFlyerCaption('my flyer is nice')).toBe(false);
  });
  it('NAVY / WINE at the end picks the colour', () => {
    expect(pickPalette('flyer gele 5k navy')).toEqual({ caption: 'flyer gele 5k', palette: 1 });
    expect(pickPalette('flyer gele 5k WINE')).toEqual({ caption: 'flyer gele 5k', palette: 2 });
    expect(pickPalette('flyer gele 5k')).toEqual({ caption: 'flyer gele 5k', palette: 0 });
  });
  it('SALE / NEW / RESTOCK change the headline; colour and tag work in either order and never end up in the product name', () => {
    expect(pickTag('flyer gele 5k sale')).toEqual({ caption: 'flyer gele 5k', tag: 'SALE' });
    expect(pickTag('flyer gele 5k NEW')).toEqual({ caption: 'flyer gele 5k', tag: 'NEW ARRIVAL' });
    expect(pickTag('flyer gele 5k restock')).toEqual({ caption: 'flyer gele 5k', tag: 'BACK IN STOCK' });
    expect(parseFlyerOptions('flyer gele 5k sale navy')).toEqual({ caption: 'flyer gele 5k', palette: 1, tag: 'SALE' });
    expect(parseFlyerOptions('flyer gele 5k wine new')).toEqual({ caption: 'flyer gele 5k', palette: 2, tag: 'NEW ARRIVAL' });
    expect(parseFlyerOptions('flyer gele 5k')).toEqual({ caption: 'flyer gele 5k', palette: 0, tag: undefined });
    expect(parseFlyerOptions('flyer new look gown 15k')).toMatchObject({ tag: undefined });       // "new" in the middle is part of the name
  });
  it('long names wrap onto at most two lines and never overflow', () => {
    expect(wrapText('Premium Ankara Gown Two Piece Set', 20, 2)).toEqual(['Premium Ankara Gown', 'Two Piece Set']);
    expect(wrapText('A very very very very long product name that keeps going on', 20, 2)).toHaveLength(2);
    expect(wrapText('Supercalifragilisticexpialidocious', 12, 2)[0]!.length).toBeLessThanOrEqual(12);
  });
  const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasFfmpeg)('draws a real 1080×1920 PNG flyer and a 512×512 PNG logo in every colour', async () => {
    const photo = await renderLogo('XY', 0);                       // any valid image works as the "product photo"
    for (let i = 0; i < PALETTES.length; i++) {
      const f = await renderFlyer({ photo, businessName: 'Ada Fabrics & Gele Hub', product: 'Premium Ankara Gown Two Piece Set', priceNgn: 45_000, contact: '0803 123 4567', logo: photo, footer: i === 0, palette: i });
      expect(f.subarray(1, 4).toString()).toBe('PNG'); expect(f.readUInt32BE(16)).toBe(1080); expect(f.readUInt32BE(20)).toBe(1920);
      const l = await renderLogo('AF', i);
      expect(l.readUInt32BE(16)).toBe(512); expect(l.readUInt32BE(20)).toBe(512);
    }
    const bare = await renderFlyer({ photo, businessName: 'Tewe', product: 'Gele', priceNgn: null, contact: null, footer: false });
    expect(bare.length).toBeGreaterThan(1000);
  });
  it.skipIf(!hasFfmpeg)('a corrupt photo fails loudly (so the owner is told) instead of producing a blank picture', async () => {
    await expect(renderFlyer({ photo: Buffer.from('not an image'), businessName: 'A', product: 'B', priceNgn: 1000, contact: null, footer: false })).rejects.toThrow();
  });
});

describe('quote PDF', () => {
  const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasPdftotext)('shows the validity date, the pay-to box, the lines and the total; free plans omit the date', async () => {
    const mk = async (extra: object) => {
      const pdf = await quotePdf({ businessName: 'Ada Fabrics', rcNumber: null, quoteLabel: 'Q-014', dateWat: 'Fri 27 Nov', customerName: 'Mama Tunde', lines: [{ item: 'Lace', qty: 2, unit: 50_000, amount: 100_000 }], deliveryFee: 2_000, total: 102_000, ...extra });
      fs.writeFileSync('/tmp/q-test.pdf', pdf); return execFileSync('pdftotext', ['/tmp/q-test.pdf', '-'], { encoding: 'utf8' });
    };
    const paid = await mk({ validUntilLabel: 'Mon 30 Nov', payDetails: 'GTBank 0123456789 Ada Fabrics', promo: { botNumber: '2348000000000', referralCode: 'UNBAR-ABCD', businessName: 'Ada Fabrics' } });
    for (const s of ['QUOTATION', 'Q-014', 'Mama Tunde', 'Price valid until: Mon 30 Nov', 'PAY TO', 'GTBank 0123456789 Ada Fabrics', '₦102,000', 'Delivery', 'referred by Ada Fabrics']) expect(paid).toContain(s);
    const free = await mk({});
    expect(free).not.toContain('valid until'); expect(free).not.toContain('PAY TO');
  });
});

describe('migration 011 matches what the code expects', () => {
  const sql = fs.readFileSync('supabase/migrations/011_quotes_and_pay_details.sql', 'utf8');
  it('quotes are private to the bot, unique per shop, and never negative', () => {
    expect(sql).toMatch(/UNIQUE \(business_id, quote_no\)/); expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/); expect(sql).toMatch(/REVOKE ALL ON quotes FROM anon, authenticated/);
    expect(sql).toMatch(/total_ngn NUMERIC\(14, 2\) NOT NULL CHECK \(total_ngn >= 0\)/); expect(sql).toMatch(/status IN \('open', 'paid', 'cancelled'\)/);
    expect(sql).toMatch(/ON DELETE CASCADE/);
  });
});

describe('descriptions on receipts and quotes (colour, size, notes)', () => {
  it('a sale line keeps what the owner said about the item; brackets and junk are cleaned', async () => {
    const { linesToDrafts } = await vi.importActual<typeof import('../flows/ledger.js')>('../flows/ledger.js');
    const mk = (item_detail?: string) => ({ type: 'sale' as const, item_name: 'Lace', item_detail, quantity: 2, unit_price_ngn: 50_000, amount_ngn: 100_000, amount_paid_ngn: 100_000, payment_method: 'cash' as const });
    expect(linesToDrafts([mk('blue Swiss voile, 5 yards')])[0]!.description).toBe('2 × Lace (blue Swiss voile, 5 yards)');
    expect(linesToDrafts([mk()])[0]!.description).toBe('2 × Lace');
    expect(linesToDrafts([mk('   ')])[0]!.description).toBe('2 × Lace');
    expect(linesToDrafts([mk('(blue) (x)')])[0]!.description).toBe('2 × Lace (blue x)');                 // brackets removed: they delimit the detail
    expect(linesToDrafts([mk('a'.repeat(200))])[0]!.description.length).toBeLessThanOrEqual('2 × Lace ()'.length + 60);
  });
  it('splitItem separates the item from its detail and drops the "2 ×" (quantity has its own column)', async () => {
    const { splitItem } = await import('../services/pdfGenerator.js');
    expect(splitItem('2 × Lace (blue, size 14)')).toEqual({ name: 'Lace', detail: 'blue, size 14' });
    expect(splitItem('3 × Ankara Gown')).toEqual({ name: 'Ankara Gown', detail: null });
    expect(splitItem('1.5 x Rice (50kg bag)')).toEqual({ name: 'Rice', detail: '50kg bag' });
    expect(splitItem('Delivery')).toEqual({ name: 'Delivery', detail: null });
    expect(splitItem('Payment towards your balance')).toEqual({ name: 'Payment towards your balance', detail: null });
  });
  const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasPdftotext)('the receipt PDF shows the description under the item, once, and the quantity only in its column', async () => {
    const { receiptPdf } = await import('../services/pdfGenerator.js');
    const pdf = await receiptPdf({ businessName: 'Ada Fabrics', rcNumber: null, receiptNumber: 'R1', dateWat: '28 Nov 2026', customerName: 'Mama Tunde', lines: [{ description: '2 × Lace (blue Swiss voile, 5 yards)', quantity: 2, unitPrice: 50_000, amount: 100_000 }, { description: '1 × Gele', quantity: 1, unitPrice: 5_000, amount: 5_000 }], amountPaid: 105_000, paymentMethod: 'cash' });
    fs.writeFileSync('/tmp/r-detail.pdf', pdf); const t = execFileSync('pdftotext', ['-layout', '/tmp/r-detail.pdf', '-'], { encoding: 'utf8' });
    expect(t).toContain('Lace'); expect(t).toContain('blue Swiss voile, 5 yards'); expect(t).toContain('Gele');
    expect(t).not.toContain('2 × Lace'); expect(t).not.toContain('1 × Gele');           // the old, duplicated "2 × " form
    expect(t.match(/Gele/g)!.length).toBe(1);
  });
  it('quotes carry the description too: on the PDF, in the summary, and into the sale when marked paid', async () => {
    const r = await createQuote(actor(), { customer_name: 'Mama Tunde', lines: [{ item_name: 'Lace', item_detail: 'blue, 5 yards', quantity: 2, unit_price_ngn: 50_000 }] });
    expect(m.quotes[0]!.lines[0]).toMatchObject({ item: 'Lace', detail: 'blue, 5 yards' });
    expect(body(r)).toContain('2 × Lace (blue, 5 yards)');
    await quotePaid(actor(), { no: 1 }, 'cash');
    expect(m.batches[0]![0].description).toBe('2 × Lace (blue, 5 yards)');
  });
});
