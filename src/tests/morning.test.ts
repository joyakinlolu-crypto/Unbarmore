import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});
const rows = vi.hoisted(() => ({ customers: [] as any[], log: [] as any[], logError: null as null | { code: string } }));
vi.mock('../db/supabase.js', () => ({
  db: {
    from: (t: string) => {
      const q: any = {
        select: () => q, eq: (c: string, v: unknown) => { (q.f ??= []).push([c, v]); return q; }, gt: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({ data: t === 'outbound_log' ? rows.log.find((r) => (q.f ?? []).every(([c, v]: [string, unknown]) => r[c] === v)) ?? null : null }),
        insert: (r: any) => { if (rows.logError) return Promise.resolve({ error: rows.logError }); rows.log.push(r); return Promise.resolve({ error: null }); },
        delete: () => ({ eq: (_c: string, id: string) => ({ eq: (_k: string, kind: string) => { rows.log = rows.log.filter((r) => !(r.business_id === id && r.kind === kind)); return Promise.resolve({}); } }) }),
        then: (res: any) => Promise.resolve({ data: t === 'customers' ? rows.customers : [], error: null }).then(res),
      };
      return q;
    },
  },
  ledgerSummary: vi.fn(), claimOutbound: vi.fn(),
}));
vi.mock('../flows/clients.js', () => ({ clientStats: vi.fn(), lapsed: vi.fn() }));
vi.mock('../flows/insights.js', () => ({ periodRange: () => ({ from: new Date(0), to: new Date() }) }));

import { appNudgeFor, appNudgeText, composeMorning, dueDebts, tomorrowLine, type MorningFacts } from '../flows/morning.js';
import { remindersOff, setReminders } from '../flows/reminders.js';

const facts = (o: Partial<MorningFacts> = {}): MorningFacts => ({
  businessName: 'Ada Fabrics', yesterday: { count: 3, line: 'Sales ₦95,000 · Profit ₦40,000' }, debts: [], quiet: [], lowStock: [], isMonday: false, ...o,
});
const ids = (m: ReturnType<typeof composeMorning>) => m.buttons.map((b) => b.id);
const text = (m: ReturnType<typeof composeMorning>) => m.lines.join('\n');

describe('7 AM note: who to follow up today', () => {
  it('overdue and due-today debts come first, named, with the amount, and the focus is the most urgent one', () => {
    const m = composeMorning(facts({ debts: [{ name: 'Kalu', amount: 28000, late: 3, age: 20 }, { name: 'Olowoyeye', amount: 20000, late: 0, age: 9 }, { name: 'Femi', amount: 14000, late: -2, age: 5 }] }));
    const t = text(m);
    expect(t).toContain('☀️ *Good morning, Ada Fabrics!*');
    expect(t).toContain('Yesterday: Sales ₦95,000 · Profit ₦40,000');
    expect(t).toContain('• Kalu owes you ₦28,000: 3 days overdue');
    expect(t).toContain('• Olowoyeye owes you ₦20,000: due today');
    expect(t).toContain('• Femi owes you ₦14,000: due in 2 days');
    expect(t).toContain('👉 *Start with Kalu: ₦28,000.*');
    expect(ids(m)).toEqual(['BTN_CHASE_DEBT', 'LOGHOW']);
  });
  it('an old debt with no due date is still surfaced (once), with how long it has been', () => {
    const t = text(composeMorning(facts({ debts: [{ name: 'Bisi', amount: 8000, late: null, age: 30 }] })));
    expect(t).toContain('• Bisi has owed you ₦8,000 for 30 days');
    expect(t).toContain('👉 *Start with Bisi:*');
  });
  it('no debts → a past customer who went quiet; then low stock; then "log yesterday"; then a plain cheer', () => {
    const quiet = composeMorning(facts({ quiet: [{ name: 'Mama Tunde', days: 45, spent: 120000 }] }));
    expect(text(quiet)).toContain("• Mama Tunde hasn't bought in 45 days (spent ₦120,000)");
    expect(text(quiet)).toContain('👉 *Message Mama Tunde today.*');
    expect(ids(quiet)).toEqual(['WINBACK', 'LOGHOW']);
    expect(text(composeMorning(facts({ lowStock: [{ name: 'Lace', left: 1 }] })))).toContain('👉 Restock *Lace*');
    expect(text(composeMorning(facts({ yesterday: { count: 0, line: '' } })))).toContain('Nothing was recorded yesterday.');
    expect(text(composeMorning(facts({ yesterday: { count: 0, line: '' } })))).toContain('one voice note');
    expect(text(composeMorning(facts()))).toContain('Have a great day!');
  });
  it('always carries at least one button: a tap keeps tomorrow\'s free window open', () => {
    expect(composeMorning(facts()).buttons).toEqual([{ id: 'LOGHOW', title: '📝 Log a sale' }]);
    const busy = composeMorning(facts({ debts: [{ name: 'A', amount: 1, late: 1, age: 1 }], quiet: [{ name: 'B', days: 40, spent: 1 }] }));
    expect(ids(busy)).toEqual(['BTN_CHASE_DEBT', 'WINBACK', 'LOGHOW']);          // WhatsApp allows at most 3
  });
  it('lists at most 3 debts + 1 customer + 1 item, and tells people how to pause only on Mondays', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `P${i}`, amount: 1000, late: 1, age: 1 }));
    const m = composeMorning(facts({ debts: many, quiet: [{ name: 'Q', days: 40, spent: 1 }, { name: 'R', days: 50, spent: 1 }], lowStock: [{ name: 'L', left: 1 }, { name: 'M', left: 0 }], isMonday: false }));
    expect(text(m).match(/^• /gm)).toHaveLength(5);
    expect(text(m)).not.toContain('REMINDERS OFF');
    expect(text(composeMorning(facts({ isMonday: true })))).toContain('REMINDERS OFF');
  });
  it('works for service businesses too: nothing in it assumes a product or stock', () => {
    const t = text(composeMorning(facts({ businessName: 'Zara Hair Studio', debts: [{ name: 'Chioma', amount: 15000, late: 0, age: 4 }] })));
    expect(t).toContain('Good morning, Zara Hair Studio!');
    expect(t).not.toMatch(/stock|restock/i);
  });
});

describe('what is due', () => {
  beforeEach(() => { rows.customers = []; rows.log = []; rows.logError = null; });
  const c = (name: string, amt: number, due: string | null, ageDays = 3) => ({ name, outstanding_debt_ngn: amt, debt_due_date: due, debt_since: new Date(Date.now() - ageDays * 86_400_000).toISOString() });

  it('orders overdue first (most overdue first), then today, then upcoming; ignores far-off due dates', async () => {
    rows.customers = [c('Soon', 5000, '2026-11-26'), c('Today', 6000, '2026-11-24'), c('Late', 7000, '2026-11-20'), c('Far', 9000, '2026-12-30')];
    const d = await dueDebts('b1', 2, '2026-11-24');
    expect(d.map((x) => [x.name, x.late])).toEqual([['Late', 4], ['Today', 0], ['Soon', -2]]);
  });
  it('adds the biggest old undated debt when there is room', async () => {
    rows.customers = [c('Dated', 5000, '2026-11-24'), c('OldA', 3000, null, 40), c('OldB', 9000, null, 20), c('New', 1000, null, 2)];
    expect((await dueDebts('b1', 2, '2026-11-24')).map((x) => x.name)).toEqual(['Dated', 'OldB']);
  });
  it('9 PM "follow up tomorrow" line, or nothing', async () => {
    rows.customers = [c('Femi', 14000, '2026-11-25'), c('Today', 6000, '2026-11-24')];
    const orig = Date.now; // dueDebts uses today's real Lagos date by default: pin it
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-24T20:00:00Z'));
    expect(await tomorrowLine('b1')).toBe('📅 *Follow up soon:* Today ₦6,000 (due today) · Femi ₦14,000');
    rows.customers = [c('Femi', 14000, '2026-11-25')];
    expect(await tomorrowLine('b1')).toBe('📅 *Follow up tomorrow:* Femi ₦14,000');
    rows.customers = [c('Far', 14000, '2026-12-25')];
    expect(await tomorrowLine('b1')).toBeNull();
    vi.useRealTimers(); void orig;
  });
});

describe('pause / resume', () => {
  beforeEach(() => { rows.log = []; rows.logError = null; });
  it('REMINDERS OFF is remembered, once, and ON undoes it', async () => {
    expect(await remindersOff('b1')).toBe(false);
    await setReminders('b1', false);
    await setReminders('b1', false);
    expect(await remindersOff('b1')).toBe(true);
    await setReminders('b1', true);
    expect(await remindersOff('b1')).toBe(false);
  });
  it('a duplicate insert (already paused) is not an error', async () => {
    rows.logError = { code: '23505' };
    await expect(setReminders('b1', false)).resolves.toBeUndefined();
  });
});


describe('inviting owners into the app (until they have it)', () => {
  const day = (ymd: string) => new Date(`${ymd}T10:00:00Z`).getTime();           // 11:00 Lagos
  const young = new Date(day('2026-11-20')).toISOString();
  // 2026-11-24 Tue · 25 Wed · 26 Thu · 27 Fri · 28 Sat

  it('mornings on Tuesday and Friday, evenings on Wednesday and Saturday: twice a week each, never daily', () => {
    expect([24, 25, 26, 27, 28].map((d) => appNudgeFor(young, 'none', 'morning', day(`2026-11-${d}`)) !== null)).toEqual([true, false, false, true, false]);
    expect([24, 25, 26, 27, 28].map((d) => appNudgeFor(young, 'none', 'evening', day(`2026-11-${d}`)) !== null)).toEqual([false, true, false, false, true]);
  });
  it('first "open the app", then "put it on your Home Screen"; nothing once alerts are on', () => {
    expect(appNudgeFor(young, 'none', 'morning', day('2026-11-24'))).toBe('open');
    expect(appNudgeFor(young, 'opened', 'morning', day('2026-11-24'))).toBe('install');
    expect(appNudgeFor(young, 'alerts', 'morning', day('2026-11-24'))).toBeNull();
  });
  it('stops pestering accounts older than 45 days', () => {
    expect(appNudgeFor(new Date(day('2026-09-01')).toISOString(), 'none', 'morning', day('2026-11-24'))).toBeNull();
  });
  it('the morning note carries the invitation and an "Open my app" button; buttons never exceed WhatsApp\'s 3', () => {
    const m = composeMorning(facts({ appNudge: 'open' }));
    expect(m.lines.join('\n')).toContain('Also in your app');
    expect(m.buttons.map((b) => b.id)).toEqual(['DASHLINK', 'LOGHOW']);
    const busy = composeMorning(facts({ appNudge: 'install', debts: [{ name: 'A', amount: 1, late: 1, age: 1 }], quiet: [{ name: 'B', days: 40, spent: 1 }] }));
    expect(busy.buttons).toHaveLength(3);
    expect(busy.buttons.map((b) => b.id)).toEqual(['BTN_CHASE_DEBT', 'WINBACK', 'DASHLINK']);   // the app button wins a place over "Log a sale"
    expect(busy.lines.join('\n')).toContain('Add to Home Screen');
  });
  it('no invitation text or button on other days', () => {
    const m = composeMorning(facts({ appNudge: null }));
    expect(m.lines.join('\n')).not.toMatch(/in your app|Home Screen|Open my app/);
    expect(m.buttons.map((b) => b.id)).toEqual(['LOGHOW']);
    expect(appNudgeText('open')).toContain('free');
  });
});
