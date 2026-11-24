import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

const db = vi.hoisted(() => ({ counts: {} as Record<string, number | null>, customers: [] as any[], tx: [] as any[], msgs: [] as { customer: string; message: string }[] }));
vi.mock('../services/geminiBrain.js', () => ({ writeCustomerMessages: async () => db.msgs }));
vi.mock('../db/supabase.js', () => ({
  db: {
    from: (table: string) => {
      const f: { col: string; op: string; v?: unknown }[] = [];
      const q: any = {
        select: (_c?: string, opts?: { head?: boolean }) => { q.head = !!opts?.head; return q; },
        eq: (col: string, v: unknown) => { f.push({ col, op: 'eq', v }); return q; },
        gt: (col: string, v: unknown) => { f.push({ col, op: 'gt', v }); return q; },
        not: (col: string, op: string, v: unknown) => { f.push({ col, op: `not-${op}`, v }); return q; },
        order: () => q, limit: () => q,
        then: (res: any) => {
          if (q.head) {
            const key = table + ':' + f.map((x) => `${x.col}${x.op === 'gt' ? '>' : x.op === 'not-is' ? '!null' : '='}${x.op === 'eq' ? x.v : ''}`).join(',');
            const hit = Object.entries(db.counts).find(([k]) => key.includes(k));
            return Promise.resolve({ count: hit ? hit[1] : 0, error: null }).then(res);
          }
          return Promise.resolve({ data: table === 'customers' ? db.customers : db.tx, error: null }).then(res);
        },
      };
      return q;
    },
  },
}));

import { clientStats, customerMessagesReply, lapsed, lapsedText, myClientsText, type ClientStat } from '../flows/clients.js';
import { checklistText, nextStep, nudgeLine, onboardingSteps } from '../flows/onboarding.js';

const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
const stat = (o: Partial<ClientStat>): ClientStat => ({ id: 'x', name: 'X', phone: null, spent: 0, owes: 0, lastBuy: ago(1), createdAt: ago(100), ...o });
const actor = { phone: '2348000000001', isStaff: false, business: { id: 'b1', name: 'Ada Shop' } } as never;
const text = (r: { toPayload(): any }) => (r.toPayload() as any).text.body as string;
beforeEach(() => { db.counts = {}; db.customers = []; db.tx = []; db.msgs = []; });

describe('client list and win-back', () => {
  const stats = [
    stat({ id: 'a', name: 'Mama Tunde', spent: 120000, lastBuy: ago(5), owes: 20000, phone: '2348031234567' }),
    stat({ id: 'b', name: 'Kalu', spent: 90000, lastBuy: ago(45) }),
    stat({ id: 'c', name: 'Bisi', spent: 30000, lastBuy: ago(60), phone: '2348051234567' }),
    stat({ id: 'd', name: 'New Lead', spent: 0, lastBuy: null }),
  ];
  it('lists clients by spend with last purchase, what they owe, and a 📞 when we have their number', () => {
    const t = myClientsText(stats);
    expect(t).toContain('4 on your list');
    expect(t).toContain('1. Mama Tunde — ₦120,000 spent · last bought 5 days ago · owes ₦20,000 📞');
    expect(t).toContain('2. Kalu — ₦90,000 spent · last bought 45 days ago');
    expect(t).toContain('New Lead — ₦0 spent · no purchase yet');
    expect(t).toContain('2 customers haven\'t bought in 30+ days');
  });
  it('an empty list explains how to start', () => { expect(myClientsText([])).toContain('no customers on your list yet'); });
  it('"gone quiet" = bought before, not in 30+ days, biggest spenders first; never-bought leads are not "lapsed"', () => {
    expect(lapsed(stats).map((c) => c.name)).toEqual(['Kalu', 'Bisi']);
    expect(lapsedText(stats)).toContain('1. Kalu — last bought 45 days ago');
    expect(lapsedText([stat({})])).toContain('Nobody has gone quiet');
  });
  it('win-back: AI-written messages with a tap-to-send link only for people whose number we have', async () => {
    db.customers = [{ id: 'b', name: 'Kalu', phone_number: null, total_spent_ngn: 90000, outstanding_debt_ngn: 0, created_at: ago(100) }, { id: 'c', name: 'Bisi', phone_number: '2348051234567', total_spent_ngn: 30000, outstanding_debt_ngn: 0, created_at: ago(100) }];
    db.tx = [{ customer_id: 'b', transaction_date: ago(45) }, { customer_id: 'c', transaction_date: ago(60) }];
    db.msgs = [{ customer: 'Kalu', message: 'Hi Kalu, we miss you!' }, { customer: 'Bisi', message: 'Hi Bisi, long time!' }];
    const t = text(await customerMessagesReply(actor, 'winback'));
    expect(t).toContain('*Kalu* (last bought 45 days ago)');
    expect(t).toContain('Hi Kalu, we miss you!');
    expect(t).toContain('_(no number saved: copy and send)_');
    expect(t).toContain('https://wa.me/2348051234567?text=Hi%20Bisi%2C%20long%20time!');
  });
  it('win-back with nobody quiet says so, and never calls the AI', async () => {
    db.customers = [{ id: 'a', name: 'Fresh', phone_number: null, total_spent_ngn: 5000, outstanding_debt_ngn: 0, created_at: ago(10) }];
    db.tx = [{ customer_id: 'a', transaction_date: ago(2) }];
    expect(text(await customerMessagesReply(actor, 'winback'))).toContain('Nobody has gone quiet');
  });
  it('builds stats with the latest purchase per customer', async () => {
    db.customers = [{ id: 'a', name: 'Mama Tunde', phone_number: null, total_spent_ngn: 100, outstanding_debt_ngn: 5, created_at: ago(3) }];
    db.tx = [{ customer_id: 'a', transaction_date: ago(2) }, { customer_id: 'a', transaction_date: ago(9) }];
    const [s] = await clientStats('b1');
    expect(s).toMatchObject({ name: 'Mama Tunde', spent: 100, owes: 5 });
    expect(Math.round((Date.now() - new Date(s!.lastBuy!).getTime()) / day)).toBe(2);
  });
});

describe('onboarding checklist', () => {
  const b = { id: 'b1', videos_used_this_month: 0, created_at: ago(1) } as never;
  it('a brand-new account: nothing done, first step is logging a sale', async () => {
    const steps = await onboardingSteps(b);
    expect(steps.map((s) => s.done)).toEqual([false, false, false, false, false, false]);
    expect(nextStep(steps)!.id).toBe('first_entry');
    const t = checklistText(steps);
    expect(t).toContain('How Unbarmore works');
    expect(t).toContain('0 of 6 done');
    expect(t).toContain('👉 *Next:* Tell me a sale or an expense');
  });
  it('detects real progress and moves the "next" pointer', async () => {
    db.counts = { 'transactions:business_id=b1,status=confirmed': 3, 'customers:business_id=b1,outstanding_debt_ngn>': 2 };
    const steps = await onboardingSteps(b);
    expect(steps.map((s) => s.done)).toEqual([true, false, true, false, false, false]);
    expect(nextStep(steps)!.id).toBe('costs');      // cost prices come next: they are what makes the profit figure real
    expect(checklistText(steps)).toContain('2 of 6 done');
    expect(checklistText(steps)).toContain('lace costs me 15k');
  });
  it('everything done → celebrates, and nudges stop', async () => {
    db.counts = { 'transactions:business_id=b1,status=confirmed': 1, 'products:': 1, 'customers:': 1, 'transactions:business_id=b1,receipt_pdf_url!null': 1, 'push_subscriptions:': 1 };
    const steps = await onboardingSteps({ id: 'b1', videos_used_this_month: 2 } as never);
    expect(steps.every((s) => s.done)).toBe(true);
    expect(checklistText(steps)).toContain('running your shop on Unbarmore');
    expect(await nudgeLine({ ...(b as object), videos_used_this_month: 2 } as never)).toBeNull();
  });
  it('a missing push table (migration not run) just means "not done", never an error', async () => {
    db.counts = { 'push_subscriptions:': null };
    expect((await onboardingSteps(b)).find((s) => s.id === 'app')!.done).toBe(false);
  });
  it('gentle nudge only during the first weeks', async () => {
    expect(await nudgeLine(b)).toContain('Next step');
    expect(await nudgeLine({ ...(b as object), created_at: ago(40) } as never)).toBeNull();
  });
});
