import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
    VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv',
  });
});

const m = vi.hoisted(() => ({
  ledgerSummary: vi.fn(), debtors: vi.fn(),
  subs: { rows: [] as Record<string, unknown>[], error: null as null | { code: string }, deleted: [] as unknown[], updated: [] as { patch: Record<string, unknown>; id: unknown }[] },
  send: vi.fn(),
}));

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: m.send } }));
vi.mock('../flows/insights.js', () => ({ periodRange: () => ({ from: new Date(0), to: new Date() }), daysSince: () => 5 }));
vi.mock('../db/supabase.js', () => ({
  ledgerSummary: m.ledgerSummary,
  debtors: m.debtors,
  db: {
    from: (table: string) => {
      if (table !== 'push_subscriptions') throw new Error(`unexpected table ${table}`);
      return {
        select: () => {
          const res = { data: m.subs.error ? null : m.subs.rows, error: m.subs.error };
          const p: Promise<typeof res> & { eq?: () => Promise<typeof res>; limit?: () => Promise<typeof res> } = Promise.resolve(res);
          p.eq = () => Promise.resolve(res); p.limit = () => Promise.resolve(res);
          return p;
        },
        update: (patch: Record<string, unknown>) => ({ eq: (_c: string, id: unknown) => { m.subs.updated.push({ patch, id }); return Promise.resolve({}); } }),
        delete: () => ({ eq: (_c: string, id: unknown) => { m.subs.deleted.push(id); return Promise.resolve({}); } }),
      };
    },
  },
}));

import { buildDailyPush } from '../flows/dailyPush.js';
import { moneyBack, moneyBackLine } from '../flows/moneyBack.js';
import { receiptPdf } from '../services/pdfGenerator.js';
import { businessesWithPush, pushEnabled, sendPushToBusiness } from '../services/push.js';

const biz = { id: 'b1', name: 'Ada Fabrics', total_value_recovered_ngn: 0 } as never;
const sum = (o: Record<string, number> = {}) => ({ revenue_ngn: 0, cash_in_ngn: 0, expenses_ngn: 0, restock_ngn: 0, debt_collected_ngn: 0, net_profit_ngn: 0, tx_count: 0, ...o });

beforeEach(() => {
  m.ledgerSummary.mockReset(); m.debtors.mockReset(); m.send.mockReset();
  Object.assign(m.subs, { rows: [], error: null, deleted: [], updated: [] });
});

describe('web-push delivery', () => {
  const sub = (id: string, fails = 0) => ({ id, endpoint: `https://push.example/${id}`, p256dh: 'k', auth: 'a', fail_count: fails });

  it('is on only when both VAPID keys are set', () => { expect(pushEnabled()).toBe(true); });

  it('counts delivered devices, removes gone ones (404/410), and only counts a failure against flaky ones', async () => {
    m.subs.rows = [sub('ok'), sub('gone'), sub('flaky', 2)];
    m.send.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      if (s.endpoint.endsWith('flaky')) throw Object.assign(new Error('boom'), { statusCode: 500 });
    });
    expect(await sendPushToBusiness('b1', { title: 't', body: 'b' })).toBe(1);
    expect(m.subs.deleted).toEqual(['gone']);
    expect(m.subs.updated.find((u) => u.id === 'flaky')?.patch).toEqual({ fail_count: 3 });
    expect(m.subs.updated.find((u) => u.id === 'ok')?.patch).toMatchObject({ fail_count: 0 });
  });

  it('drops a device after 10 failed sends in a row', async () => {
    m.subs.rows = [sub('dead', 9)];
    m.send.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
    await sendPushToBusiness('b1', { title: 't', body: 'b' });
    expect(m.subs.deleted).toEqual(['dead']);
  });

  it('never throws, and sends nothing, when the table is missing or has no devices', async () => {
    m.subs.error = { code: '42P01' };
    expect(await sendPushToBusiness('b1', { title: 't', body: 'b' })).toBe(0);
    expect(await businessesWithPush()).toEqual([]);
    m.subs.error = null; m.subs.rows = [];
    expect(await sendPushToBusiness('b1', { title: 't', body: 'b' })).toBe(0);
    expect(m.send).not.toHaveBeenCalled();
  });

  it('lists each business once however many devices it has', async () => {
    m.subs.rows = [{ business_id: 'b1' }, { business_id: 'b1' }, { business_id: 'b2' }];
    expect(await businessesWithPush()).toEqual(['b1', 'b2']);
  });

  it('sends a plain JSON payload the service worker can read', async () => {
    m.subs.rows = [sub('ok')];
    await sendPushToBusiness('b1', { title: 'Hello', body: 'World', url: '/dashboard' });
    expect(JSON.parse(m.send.mock.calls[0]![1] as string)).toEqual({ title: 'Hello', body: 'World', url: '/dashboard' });
  });
});

describe('evening push content', () => {
  it('a day with sales: in/spent/profit, collected debts and who still owes', async () => {
    m.ledgerSummary.mockResolvedValue(sum({ tx_count: 3, revenue_ngn: 80_000, expenses_ngn: 5_000, restock_ngn: 10_000, net_profit_ngn: 65_000, debt_collected_ngn: 20_000 }));
    m.debtors.mockResolvedValue([{ name: 'Mama Tunde', outstanding_debt_ngn: 20_000, debt_since: null }]);
    const p = await buildDailyPush(biz);
    expect(p.title).toContain('Ada Fabrics');
    expect(p.body).toContain('₦80,000');
    expect(p.body).toContain('Spent ₦15,000');
    expect(p.body).toContain('🎉 ₦20,000 collected');
    expect(p.body).toContain('₦20,000 still owed to you');
    expect(p.url).toBe('/dashboard');
  });

  it('a quiet day with debtors turns the nudge into a debt chase naming the biggest debtor', async () => {
    m.ledgerSummary.mockResolvedValue(sum());
    m.debtors.mockResolvedValue([{ name: 'Mama Tunde', outstanding_debt_ngn: 20_000, debt_since: null }, { name: 'Bisi', outstanding_debt_ngn: 5_000, debt_since: null }]);
    const p = await buildDailyPush(biz);
    expect(p.title).toBe('₦25,000 is still owed to you');
    expect(p.body).toContain('Mama Tunde owes ₦20,000 (5 days)');
  });

  it('a quiet day with nobody owing asks for the next sale', async () => {
    m.ledgerSummary.mockResolvedValue(sum()); m.debtors.mockResolvedValue([]);
    expect((await buildDailyPush(biz)).title).toBe('Sold anything today?');
  });
});

describe('money back', () => {
  it('adds every naira of debt ever collected to the margin the Inflation Shield protected', async () => {
    m.ledgerSummary.mockResolvedValue(sum({ debt_collected_ngn: 184_000 }));
    const mb = await moneyBack({ id: 'b1', total_value_recovered_ngn: 16_000 } as never);
    expect(mb).toEqual({ debtCollected: 184_000, protectedMargin: 16_000, total: 200_000 });
    expect(moneyBackLine(mb)).toBe('💰 *Money Unbarmore got back for you: ₦200,000* (₦184,000 collected from customers + ₦16,000 margin protected)');
  });
  it('says nothing until there is something to say', () => {
    expect(moneyBackLine({ debtCollected: 0, protectedMargin: 0, total: 0 })).toBeNull();
    expect(moneyBackLine({ debtCollected: 5_000, protectedMargin: 0, total: 5_000 })).toBe('💰 *Money Unbarmore got back for you: ₦5,000* (₦5,000 collected from customers)');
  });
});

const hasPdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!hasPdftotext)('"Powered by Unbarmore" on customer receipts', () => {
  const base = { businessName: 'AsoEwa Fabrics', rcNumber: null, receiptNumber: 'R1', dateWat: '24 Nov 2026', customerName: 'Mama Tunde', lines: [{ description: 'Lace', quantity: 1, unitPrice: 50_000, amount: 50_000 }], amountPaid: 50_000, paymentMethod: 'cash' };
  const text = async (promo: { botNumber: string; referralCode: string; businessName?: string } | null) => {
    const file = join(mkdtempSync(join(tmpdir(), 'rcpt-')), 'r.pdf');
    writeFileSync(file, await receiptPdf({ ...base, promo }));
    return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
  };
  it('carries the invite, the bot number and the owner\'s referral code', async () => {
    const t = await text({ botNumber: '15551658238', referralCode: 'UNBAR-X87X', businessName: 'AsoEwa Fabrics' });
    expect(t).toContain('wa.me/15551658238');
    expect(t).toContain('UNBAR-X87X');
    expect(t).toContain('referred by AsoEwa Fabrics');
  });
  it('is absent when promo is off (no-watermark plan) but the receipt itself is intact', async () => {
    const t = await text(null);
    expect(t).not.toContain('wa.me/');
    expect(t).toContain('AsoEwa Fabrics');
    expect(t).toContain('₦50,000');
  });
});
