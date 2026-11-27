import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

const m = vi.hoisted(() => ({
  last: { current: null as null | { counted_at: string; counted_ngn: number } },
  rows: { current: [] as Record<string, unknown>[] },
  week: { current: [] as { variance_ngn: number }[] },
  inserted: [] as Record<string, unknown>[],
  tableMissing: { current: false },
  updateBusiness: vi.fn(),
}));

// Chainable stand-in for Supabase: answers by table, records inserts.
vi.mock('../db/supabase.js', () => {
  const chain = (table: string, mode: { insert?: Record<string, unknown>; selectCols?: string }): any => new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: (v: unknown) => void) => {
        if (mode.insert) { m.inserted.push(mode.insert); return res({ data: null, error: m.tableMissing.current ? { message: 'no table' } : null }); }
        if (table === 'cash_counts') return res({ data: mode.selectCols?.includes('variance_ngn') ? m.week.current : m.last.current, error: m.tableMissing.current ? { message: 'no table' } : null });
        return res({ data: m.rows.current, error: null });
      };
      if (prop === 'maybeSingle') return () => chain(table, mode);
      if (prop === 'insert') return (row: Record<string, unknown>) => chain(table, { insert: row });
      if (prop === 'select') return (cols: string) => chain(table, { selectCols: cols });
      return () => chain(table, mode);
    },
  });
  return { db: { from: (t: string) => chain(t, {}) }, updateBusiness: m.updateBusiness };
});

import { cashCountReply, splitCommandReply } from '../flows/cashCount.js';
import { composeMorning } from '../flows/morning.js';
import { countText, parseCount } from '../lib/cashCount.js';
import { runOutFocus, runOutLine, runOutRisk } from '../lib/runOut.js';
import { computeSetAside, DEFAULT_SPLIT, parseSplitCommand, setAsideText, splitFromString } from '../lib/setAside.js';

const body = (r: { toPayload(): Record<string, any> }) => String((r.toPayload() as any).text?.body ?? '');
const owner = { phone: '2348000000001', isStaff: false, user: { id: 'u' }, business: { id: 'b1', name: 'Ada Fabrics', setaside_split: null } } as never;
beforeEach(() => { m.last.current = null; m.rows.current = []; m.week.current = []; m.inserted.length = 0; m.tableMissing.current = false; m.updateBusiness.mockReset(); });

describe('evening set-aside: the exact naira to move', () => {
  it('splits profit into three pots that always add up to the profit', () => {
    for (const p of [1000, 4321, 18_400, 250_000, 999_999]) {
      const a = computeSetAside(p, DEFAULT_SPLIT)!;
      expect(a.restock + a.reserve + a.pay).toBe(p);
      expect(a.restock % 100).toBe(0); expect(a.reserve % 100).toBe(0);
    }
    expect(computeSetAside(18_400, DEFAULT_SPLIT)).toEqual({ restock: 9200, reserve: 3700, pay: 5500 });
  });
  it('says nothing on a loss, a tiny profit, or zero', () => { for (const p of [-5000, 0, 400, 999]) expect(computeSetAside(p, DEFAULT_SPLIT)).toBeNull(); });
  it('when some cost prices are missing it asks for them instead of splitting an overstated profit', () => {
    const t = setAsideText(18_400, true, DEFAULT_SPLIT)!.join('\n');
    expect(t).toContain('cost price'); expect(t).not.toContain('₦9,200');
  });
  it('the evening lines name the three pots and the amount, and are not tax advice', () => {
    const t = setAsideText(18_400, false, DEFAULT_SPLIT)!.join('\n');
    for (const s of ['₦18,400', 'Restock fund: *₦9,200*', 'reserve: *₦3,700*', 'Pay yourself: *₦5,500*', 'SET ASIDE 50/20/30', 'not tax advice']) expect(t).toContain(s);
  });
  it('SET ASIDE parsing: three numbers adding to 100 only', () => {
    expect(parseSplitCommand('SET ASIDE 40 20 40')).toEqual({ restock: 40, reserve: 20, pay: 40 });
    expect(parseSplitCommand('split 50/20/30')).toEqual({ restock: 50, reserve: 20, pay: 30 });
    expect(parseSplitCommand('my split 60-10-30')).toEqual({ restock: 60, reserve: 10, pay: 30 });
    expect(parseSplitCommand('set aside 50 20 40')).toBe('bad');
    expect(parseSplitCommand('SET ASIDE')).toBe('show');
    for (const no of ['split the bill', 'set aside 20k', 'sold 2 lace 50']) expect(parseSplitCommand(no)).toBeNull();
  });
  it('a stored split that is malformed or does not add to 100 falls back to the default', () => {
    expect(splitFromString('40/20/40')).toEqual({ restock: 40, reserve: 20, pay: 40 });
    for (const bad of [null, undefined, '', 'abc', '50/50/50', '50/20']) expect(splitFromString(bad)).toEqual(DEFAULT_SPLIT);
  });
  it('the owner can change it; staff cannot; bad numbers are explained and nothing is saved', async () => {
    expect(body((await splitCommandReply(owner, 'SET ASIDE 40 20 40'))!)).toContain('Restock 40%');
    expect(m.updateBusiness).toHaveBeenCalledWith('b1', { setaside_split: '40/20/40' });
    m.updateBusiness.mockReset();
    expect(body((await splitCommandReply(owner, 'SET ASIDE 50 20 40'))!)).toContain('add up to 100'); expect(m.updateBusiness).not.toHaveBeenCalled();
    expect(body((await splitCommandReply({ ...(owner as object), isStaff: true } as never, 'SET ASIDE 40 20 40'))!)).toContain('Only the shop owner');
    expect(await splitCommandReply(owner, 'sold 2 lace')).toBeNull();
  });
});

describe('drawer count: catching missing money', () => {
  it.each([['COUNT 85000', 85000], ['count 85,000', 85000], ['counted cash ₦85k', 85000], ['Count: 1.2m', 1_200_000], ['count N7500', 7500], ['count 0', 0]])('%s → %s', (t, v) => expect(parseCount(t)).toBe(v));
  it('other sentences are not counts', () => { for (const no of ['count my customers', 'sold 3 count', 'counting', 'count', 'count 85000 naira please']) expect(parseCount(no)).toBeNull(); });
  it('the wording: matches, short (with likely causes), over, and the weekly total', () => {
    const base = { counted: 80_000, unspecified: 0, weekShort: 0, weekCounts: 1 };
    expect(countText({ ...base, expected: 80_050, variance: -50 }).join('\n')).toContain('Your cash matches');
    const short = countText({ ...base, expected: 85_000, variance: -5000, weekShort: 9000, weekCounts: 3 }).join('\n');
    expect(short).toContain('₦5,000 is missing'); expect(short).toContain('money taken out for yourself'); expect(short).toContain('₦9,000 has gone missing across 3 counts');
    expect(countText({ ...base, expected: 75_000, variance: 5000 }).join('\n')).toContain('₦5,000 more than expected');
    expect(countText({ ...base, expected: 85_000, variance: -5000, unspecified: 2 }).join('\n')).toContain('no payment method');
  });
  it('the FIRST count only sets the starting cash (nothing to compare against), and is saved', async () => {
    const t = body(await cashCountReply(owner, 85_000));
    expect(t).toContain('starting cash'); expect(m.inserted[0]).toMatchObject({ business_id: 'b1', counted_ngn: 85_000, expected_ngn: null, variance_ngn: null });
  });
  it('a later count = last count + cash movement since; the gap is saved and reported', async () => {
    m.last.current = { counted_at: new Date(Date.now() - 86_400_000).toISOString(), counted_ngn: 50_000 };
    m.rows.current = [
      { tx_type: 'sale', payment_method: 'cash', total_amount_ngn: 30_000, amount_paid_ngn: 30_000 },
      { tx_type: 'sale', payment_method: 'transfer', total_amount_ngn: 20_000, amount_paid_ngn: 20_000 },  // not in the drawer
      { tx_type: 'expense', payment_method: 'cash', total_amount_ngn: 4_000, amount_paid_ngn: 4_000 },
      { tx_type: 'debt_repayment', payment_method: 'cash', total_amount_ngn: 5_000, amount_paid_ngn: 5_000 },
    ];
    const t = body(await cashCountReply(owner, 76_000));   // expected 50,000 + 30,000 + 5,000 − 4,000 = 81,000
    expect(t).toContain('₦5,000 is missing'); expect(t).toContain('expected ₦81,000');
    expect(m.inserted[0]).toMatchObject({ counted_ngn: 76_000, expected_ngn: 81_000, variance_ngn: -5_000 });
  });
  it('an exact match is celebrated, not questioned', async () => {
    m.last.current = { counted_at: new Date(Date.now() - 3600_000).toISOString(), counted_ngn: 10_000 };
    m.rows.current = [{ tx_type: 'sale', payment_method: 'cash', total_amount_ngn: 2_000, amount_paid_ngn: 2_000 }];
    expect(body(await cashCountReply(owner, 12_000))).toContain('Your cash matches');
  });
  it('staff cannot count the shop\'s cash; a database that is not upgraded gives a calm message, not a crash', async () => {
    expect(body(await cashCountReply({ ...(owner as object), isStaff: true } as never, 1))).toContain('shop owner');
    m.tableMissing.current = true;
    expect(body(await cashCountReply(owner, 1000))).toContain('quick update');
  });
});

describe('restock before you run out (from real selling speed)', () => {
  const prods = [{ id: 'a', name: 'Rice', stock: 4 }, { id: 'b', name: 'Beans', stock: 30 }, { id: 'c', name: 'Salt', stock: 1 }, { id: 'd', name: 'Gele', stock: 0 }];
  const sold = new Map([['a', 28], ['b', 28], ['c', 1], ['d', 14]]);   // per 14 days: Rice 2/day, Beans 2/day, Salt rarely, Gele 1/day
  it('flags fast sellers about to run out; ignores plenty of stock and rare sellers', () => {
    const r = runOutRisk(prods, sold);
    expect(r.map((x) => x.name)).toEqual(['Gele', 'Rice']);           // Beans has 15 days of cover; Salt sells once a fortnight
    expect(r[1]).toMatchObject({ perWeek: 14, left: 4, daysLeft: 2 });
  });
  it('suggests two weeks of stock minus what is left', () => { expect(runOutRisk(prods, sold).find((x) => x.name === 'Rice')!.suggestQty).toBe(24); });
  it('plain-language lines', () => {
    const rice = runOutRisk(prods, sold)[1]!;
    expect(runOutLine(rice)).toBe('Rice: you sell about 14 a week and only 4 left (about 2 days)');
    expect(runOutFocus(rice)).toContain('Restock Rice today'); expect(runOutFocus(runOutRisk(prods, sold)[0]!)).toContain('sold out');
  });
  it('the 7 AM note uses it in place of the flat "only 2 left" line, and debts still come first', () => {
    const ro = runOutRisk(prods, sold);
    const f = { businessName: 'Ada', yesterday: null, debts: [], quiet: [], lowStock: [{ name: 'Rice', left: 2 }], runningOut: ro, isMonday: false };
    const t = composeMorning(f).lines.join('\n');
    expect(t).toContain('Gele: you sell about 7 a week and it is sold out'); expect(t).not.toContain('only 2 left'); expect(t).toContain('Restock Gele today');
    const withDebt = composeMorning({ ...f, debts: [{ name: 'Kalu', amount: 28_000, late: 3, age: 20 }] }).lines.join('\n');
    expect(withDebt).toContain('Start with Kalu');
  });
  it('with no sales history the old low-stock line still works', () => {
    const t = composeMorning({ businessName: 'Ada', yesterday: null, debts: [], quiet: [], lowStock: [{ name: 'Rice', left: 1 }], isMonday: false }).lines.join('\n');
    expect(t).toContain('Rice: only 1 left');
  });
});
