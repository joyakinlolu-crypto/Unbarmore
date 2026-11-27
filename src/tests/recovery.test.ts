import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

const m = vi.hoisted(() => ({
  debtors: vi.fn(),
  updated: [] as { table: string; patch: unknown }[],
  customers: { current: [] as Record<string, unknown>[] },
}));

// A tiny chainable stand-in for the Supabase client: records updates, answers customer lookups.
vi.mock('../db/supabase.js', () => {
  const chain = (table: string, patch?: unknown): any => new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: (v: unknown) => void) => { if (patch !== undefined) m.updated.push({ table, patch }); res({ data: table === 'customers' ? m.customers.current : [], error: null }); };
      if (prop === 'update') return (p: unknown) => chain(table, p);
      return () => chain(table, patch);
    },
  });
  return { db: { from: (t: string) => chain(t) }, debtors: m.debtors, setSession: vi.fn(), updateBusiness: vi.fn(), findBusinessByReferralCode: vi.fn() };
});

import { creditWarningText } from '../flows/creditWarning.js';
import { composeMorning } from '../flows/morning.js';
import { recordPromise } from '../flows/promises.js';
import { rankCandidates, scoreMatch } from '../flows/referral.js';
import { chaseDebtsReply } from '../flows/reports.js';
import { parseChaseCommand, parsePromise, parsePromiseDate, reminderText, toneForAge } from '../lib/debtReminders.js';
import { watDayLabel } from '../lib/money.js';
import { occurredAt } from '../lib/sentAt.js';
import { waLink } from '../lib/waLink.js';

const body = (r: { toPayload(): Record<string, any> }) => { const p = r.toPayload(); return String(p.type === 'text' ? p.text.body : JSON.stringify(p)); };
const actor = { phone: '2348000000001', isStaff: false, user: { id: 'u1' }, business: { id: 'b1', name: 'Ada Fabrics' } } as never;

beforeEach(() => { m.debtors.mockReset(); m.updated.length = 0; m.customers.current = []; });

describe('late-delivered messages keep the time they were SENT', () => {
  const now = Date.parse('2026-11-30T09:00:00Z');
  const at = (iso: string) => String(Date.parse(iso) / 1000);
  it('sent last night, delivered this morning → dated last night', () => {
    expect(occurredAt(at('2026-11-29T20:40:00Z'), now)).toBe('2026-11-29T20:40:00.000Z');
  });
  it('ordinary network lag (a minute) stays "now"', () => { expect(occurredAt(at('2026-11-30T08:59:00Z'), now)).toBeNull(); });
  it('a replayed webhook from last month never rewrites the books', () => { expect(occurredAt(at('2026-10-30T09:00:00Z'), now)).toBeNull(); });
  it('a time in the future, junk or missing is ignored', () => {
    for (const bad of [at('2026-12-02T09:00:00Z'), 'abc', '', undefined, null, 0]) expect(occurredAt(bad as never, now)).toBeNull();
  });
  it('the owner is told which day it was dated, in Lagos time', () => {
    expect(watDayLabel('2026-11-29T20:40:00.000Z')).toBe('Sunday 29 Nov, 9:40 PM');
  });
});

describe('debt reminder templates (no AI)', () => {
  const o = { customer: 'Femi Adeyemi', amountNgn: 14_000, business: 'Ada Fabrics' };
  it('gets firmer as the debt ages', () => {
    expect([toneForAge(2), toneForAge(7), toneForAge(29), toneForAge(30)]).toEqual(['soft', 'firm', 'firm', 'final']);
    expect(reminderText({ ...o, days: 2 })).toContain('small reminder');
    expect(reminderText({ ...o, days: 12 })).toContain('pending for 12 days');
    expect(reminderText({ ...o, days: 45 })).toContain('outstanding for 45 days');
  });
  it('greets by first name, states the exact amount and the business, never threatens', () => {
    for (const lang of ['english', 'pidgin', 'yoruba'] as const) for (const days of [1, 10, 40]) {
      const t = reminderText({ ...o, days, lang });
      expect(t).toContain('Femi'); expect(t).not.toContain('Adeyemi'); expect(t).toContain('₦14,000'); expect(t).toContain('Ada Fabrics');
      expect(t).not.toMatch(/police|court|arrest|sue/i);
      expect(t.split(/\s+/).length).toBeLessThanOrEqual(45);
    }
  });
  it('pidgin and yoruba are different from english', () => {
    const [e, p, y] = (['english', 'pidgin', 'yoruba'] as const).map((lang) => reminderText({ ...o, days: 10, lang }));
    expect(new Set([e, p, y]).size).toBe(3);
    expect(p).toContain('abeg'.charAt(0).toUpperCase() + 'beg');
  });
  it('CHASE, CHASE PIDGIN, CHASE YORUBA; nothing else', () => {
    expect(parseChaseCommand('chase')).toEqual({ lang: 'english' });
    expect(parseChaseCommand('CHASE Pidgin')).toEqual({ lang: 'pidgin' });
    expect(parseChaseCommand('chase in yoruba')).toEqual({ lang: 'yoruba' });
    for (const no of ['chase Femi', 'who owes me', 'chasers']) expect(parseChaseCommand(no)).toBeNull();
  });
  it('wa.me link opens the customer chat with the message encoded; no number → null', () => {
    const l = waLink('0803 123 4567', 'Hello Femi & co')!;
    expect(l.startsWith('https://wa.me/2348031234567?text=')).toBe(true);
    expect(decodeURIComponent(l.split('text=')[1]!)).toBe('Hello Femi & co');
    expect(waLink(null, 'x')).toBeNull(); expect(waLink('12345', 'x')).toBeNull();
  });
});

describe('promise dates ("Femi will pay Friday")', () => {
  const today = '2026-11-25'; // a Wednesday
  it.each([
    ['today', '2026-11-25'], ['tomorrow', '2026-11-26'], ['Friday', '2026-11-27'], ['wednesday', '2026-11-25'], ['next wednesday', '2026-12-02'],
    ['monday', '2026-11-30'], ['next week', '2026-12-02'], ['in 3 days', '2026-11-28'], ['month end', '2026-11-30'], ['end of the month', '2026-11-30'],
    ['the 5th', '2026-12-05'], ['28th', '2026-11-28'], ['3/12', '2026-12-03'], ['2/11', '2027-11-02'],
  ])('%s → %s', (words, ymd) => { expect(parsePromiseDate(words, today)).toBe(ymd); });
  it('words that are not a day return null (so ordinary sentences are not swallowed)', () => {
    for (const w of ['20k', 'soon', 'when he gets paid', 'the 45th', '31/2']) expect(parsePromiseDate(w, today)).toBeNull();
  });
  it('full sentences in English, Pidgin and shorthand', () => {
    expect(parsePromise('Femi will pay Friday', today)).toEqual({ name: 'Femi', date: '2026-11-27' });
    expect(parsePromise('Mama Tunde promised tomorrow', today)).toEqual({ name: 'Mama Tunde', date: '2026-11-26' });
    expect(parsePromise('Kalu go pay next week', today)).toEqual({ name: 'Kalu', date: '2026-12-02' });
    expect(parsePromise('Chika pays on the 5th', today)).toEqual({ name: 'Chika', date: '2026-12-05' });
  });
  it('a payment amount is NOT a promise: those go to the normal router', () => {
    for (const t of ['Femi will pay 20k', 'sold 2 lace 50k', 'Femi paid today', 'who will pay Friday maybe if']) expect(parsePromise(t, today)).toBeNull();
  });
  it('saves the day on a customer who owes, and tells the owner when they will be reminded', async () => {
    m.customers.current = [{ id: 'c1', name: 'Femi Ade', outstanding_debt_ngn: 14000 }];
    const t = body((await recordPromise(actor, 'Femi', '2026-11-27'))!);
    expect(t).toContain('Femi Ade'); expect(t).toContain('₦14,000'); expect(t).toContain('Friday'); expect(t).toContain('7 AM');
    expect(m.updated).toContainEqual({ table: 'customers', patch: { debt_due_date: '2026-11-27' } });
  });
  it('nobody owing by that name → null, nothing written', async () => {
    expect(await recordPromise(actor, 'Nobody', '2026-11-27')).toBeNull(); expect(m.updated).toHaveLength(0);
  });
  it('two people match → asks which, writes nothing', async () => {
    m.customers.current = [{ id: 'c1', name: 'Femi Ade', outstanding_debt_ngn: 1 }, { id: 'c2', name: 'Femi Bello', outstanding_debt_ngn: 2 }];
    const t = body((await recordPromise(actor, 'Femi', '2026-11-27'))!);
    expect(t).toContain('Which one'); expect(t).toContain('Femi Ade'); expect(t).toContain('Femi Bello'); expect(m.updated).toHaveLength(0);
  });
});

describe('CHASE: one message, a tap-to-send link per customer', () => {
  const d = (over: Record<string, unknown>) => ({ id: 'x', name: 'Femi Ade', phone_number: '08031234567', outstanding_debt_ngn: 14000, debt_since: new Date(Date.now() - 12 * 86400_000).toISOString(), debt_due_date: null, last_reminder_sent_at: null, ...over });
  it('customers with a number get a wa.me link; without get the text to copy; total shown; reminders stamped', async () => {
    m.debtors.mockResolvedValue([d({ id: 'a' }), d({ id: 'b', name: 'Kalu', phone_number: null, outstanding_debt_ngn: 28000 })]);
    const t = body(await chaseDebtsReply(actor));
    expect(t).toContain('₦42,000 is waiting for you');
    expect(t).toContain('https://wa.me/2348031234567?text=');
    expect(t).toContain('no number saved'); expect(t).toContain('Hello Kalu');
    expect(t).toContain('Femi will pay Friday'); expect(t).toContain('CHASE PIDGIN');
    expect(m.updated.some((u) => u.table === 'customers' && 'last_reminder_sent_at' in (u.patch as object))).toBe(true);
  });
  it('shows a promised day and how long ago they were last reminded', async () => {
    m.debtors.mockResolvedValue([d({ debt_due_date: '2026-11-27', last_reminder_sent_at: new Date(Date.now() - 2 * 86400_000).toISOString() })]);
    const t = body(await chaseDebtsReply(actor));
    expect(t).toContain('promised Friday'); expect(t).toContain('reminded 2d ago');
  });
  it('never exceeds WhatsApp\'s message size, even with a long list in Yoruba', async () => {
    m.debtors.mockResolvedValue(Array.from({ length: 12 }, (_, i) => d({ id: `i${i}`, name: `Customer ${i}`, phone_number: `0803123450${i % 10}` })));
    const t = body(await chaseDebtsReply(actor, 'yoruba'));
    expect(t.length).toBeLessThan(4000); expect(t).toContain('more');
  });
  it('nobody owes → a short good-news line', async () => { m.debtors.mockResolvedValue([]); expect(body(await chaseDebtsReply(actor))).toContain('Nobody owes you'); });
});

describe('7 AM note carries a one-tap reminder for the debt to chase first', () => {
  const facts = (debts: Parameters<typeof composeMorning>[0]['debts']) => ({ businessName: 'Ada Fabrics', yesterday: null, debts, quiet: [], lowStock: [], isMonday: false });
  it('overdue debt with a number → tap-to-send link in the same message', () => {
    const t = composeMorning(facts([{ name: 'Femi Ade', phone: '08031234567', amount: 14000, late: 2, age: 12 }])).lines.join('\n');
    expect(t).toContain("Tap to send Femi's reminder: https://wa.me/2348031234567?text=");
  });
  it('no saved number → no broken link', () => {
    expect(composeMorning(facts([{ name: 'Femi', phone: null, amount: 14000, late: 2, age: 12 }])).lines.join('\n')).not.toContain('wa.me');
  });
  it('a debt due in future days gets no link (it is not time to chase yet)', () => {
    expect(composeMorning(facts([{ name: 'Femi', phone: '08031234567', amount: 14000, late: -2, age: 3 }])).lines.join('\n')).not.toContain('wa.me');
  });
});

describe('warning before another credit sale', () => {
  it('warns on a big or old balance, with the amount and days', () => {
    expect(creditWarningText('Ada', 45_000, 21)).toMatch(/Ada.*₦45,000.*21 days.*CHASE/);
    expect(creditWarningText('Ada', 3_000, 20)).toContain('₦3,000');
  });
  it('stays quiet for small, recent balances', () => {
    expect(creditWarningText('Ada', 3_000, 2)).toBeNull(); expect(creditWarningText('Ada', 0, 40)).toBeNull();
  });
});

describe('referral by business name', () => {
  const pool = [{ id: '1', name: "Joy's Fabrics" }, { id: '2', name: 'Joy Hair Studio' }, { id: '3', name: 'Ada Fabrics' }, { id: '4', name: 'TeweTegbo' }];
  it('exact and partial names match; unrelated names do not', () => {
    expect(scoreMatch('Joy Fabrics', "Joy's Fabrics")).toBeGreaterThanOrEqual(2);
    expect(scoreMatch('tewetegbo', 'TeweTegbo')).toBe(3);
    expect(scoreMatch('Chidi Electronics', 'Ada Fabrics')).toBe(0);
  });
  it('"Joy Fabrics" finds the one Joy; plain "Joy" offers both Joys and no Ada', () => {
    expect(rankCandidates('Joy Fabrics', pool).map((c) => c.id)).toEqual(['1']);
    expect(rankCandidates('Joy', pool).map((c) => c.id).sort()).toEqual(['1', '2']);
  });
  it('nothing close → empty (so we ask again instead of linking a stranger)', () => { expect(rankCandidates('Zenith Bank', pool)).toEqual([]); });
  it('never offers more than 3', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `Joy ${i}` }));
    expect(rankCandidates('Joy', many)).toHaveLength(3);
  });
});
