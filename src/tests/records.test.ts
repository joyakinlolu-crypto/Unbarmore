import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

/* A tiny in-memory Supabase: tables of rows, supporting the few query shapes records.ts uses. */
const store = vi.hoisted(() => ({
  customers: [] as Record<string, any>[], products: [] as Record<string, any>[], seq: 0,
}));
vi.mock('../db/supabase.js', () => {
  const table = (name: 'customers' | 'products') => {
    const filters: ((r: any) => boolean)[] = [];
    let op: 'select' | 'update' | 'delete' = 'select'; let patch: any = null;
    const run = () => {
      const rows = store[name].filter((r) => filters.every((f) => f(r)));
      if (op === 'update') rows.forEach((r) => Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))));
      if (op === 'delete') store[name] = store[name].filter((r) => !rows.includes(r));
      return { data: rows, error: null };
    };
    const q: any = {
      select: () => q, update: (p: any) => { op = 'update'; patch = p; return q; }, delete: () => { op = 'delete'; return q; },
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      single: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      then: (res: any) => Promise.resolve(run()).then(res),
    };
    return q;
  };
  const add = (name: 'customers' | 'products', name_: string) => {
    const row = { id: `${name[0]}${++store.seq}`, business_id: 'b1', name: name_, name_key: name_.trim().replace(/\s+/g, ' ').toLowerCase(), outstanding_debt_ngn: 0, debt_since: null, debt_due_date: null, phone_number: null, stock_qty: 0, cost_price_ngn: 0, selling_price_ngn: 0 };
    store[name].push(row); return row;
  };
  return {
    db: { from: (t: string) => table(t as 'customers') },
    upsertCustomer: async (_b: string, n: string) => (store.customers.find((c) => c.name_key === n.trim().replace(/\s+/g, ' ').toLowerCase()) ?? add('customers', n)).id,
    upsertProduct: async (_b: string, n: string) => store.products.find((c) => c.name_key === n.trim().replace(/\s+/g, ' ').toLowerCase()) ?? add('products', n),
  };
});

import {
  cancelAction, cleanDebts, cleanProducts, confirmAction, normalisePhone, notSupportedReply, owingContext, proposeDebts, proposeProducts, saveCustomerPhone, undoAction, type KV,
} from '../flows/records.js';

const kv = () => {
  const m = new Map<string, string>();
  return { m, kv: { set: async (k: string, v: string) => { m.set(k, v); }, getdel: async (k: string) => { const v = m.get(k) ?? null; m.delete(k); return v; } } satisfies KV };
};
const actor = { phone: '2348000000001', isStaff: false, user: { id: 'u1', full_name: 'Ada' }, business: { id: 'b1', name: 'Ada Shop' } } as never;
const text = (r: { toPayload(): any }) => { const p = r.toPayload(); return p.type === 'interactive' ? p.interactive.body.text : p.text.body; };
const btn = (r: { toPayload(): any }, n: number) => r.toPayload().interactive.action.buttons[n].reply.id as string;

beforeEach(() => { store.customers = []; store.products = []; store.seq = 0; });

describe('recording debts that already existed (the real bug)', () => {
  const list = [
    { customer_name: 'Olowoyeye', amount_ngn: 20000, due_date: '2026-12-01' },
    { customer_name: 'Femi', amount_ngn: 14000 },
    { customer_name: 'kalu', amount_ngn: 28000, due_date: '2026-11-30' },
  ];

  it('previews the list with a total and Confirm / Cancel, and changes nothing yet', async () => {
    const { kv: k } = kv();
    const r = await proposeDebts(actor, k, list);
    const t = text(r);
    expect(t).toContain('1. Olowoyeye — ₦20,000 (to pay 1 Dec)');
    expect(t).toContain('2. Femi — ₦14,000');
    expect(t).toContain('*Total: ₦62,000*');
    expect(t).toContain('not counted as new sales or income');
    expect(btn(r, 0)).toMatch(/^ACTOK:/); expect(btn(r, 1)).toMatch(/^ACTNO:/);
    expect(store.customers).toHaveLength(0);
  });

  it('Confirm adds the debts; a second tap does nothing (no double-adding)', async () => {
    const { kv: k } = kv();
    const tk = btn(await proposeDebts(actor, k, list), 0).split(':')[1]!;
    const done = await confirmAction(actor, k, tk);
    expect(text(done)).toContain('Added 3 debts: *₦62,000*');
    expect(store.customers.map((c) => [c.name, c.outstanding_debt_ngn])).toEqual([['Olowoyeye', 20000], ['Femi', 14000], ['kalu', 28000]]);
    expect(store.customers[0]!.debt_due_date).toBe('2026-12-01');
    expect(store.customers[1]!.debt_since).toBeTruthy();
    expect(text(await confirmAction(actor, k, tk))).toContain('expired or was already handled');
    expect(store.customers.reduce((a, c) => a + c.outstanding_debt_ngn, 0)).toBe(62000);
  });

  it('adds on top of a debt the customer already has, and says so in the preview', async () => {
    store.customers.push({ id: 'c0', business_id: 'b1', name: 'Femi', name_key: 'femi', outstanding_debt_ngn: 5000, debt_since: '2026-11-01T00:00:00Z', debt_due_date: null });
    const { kv: k } = kv();
    const r = await proposeDebts(actor, k, [{ customer_name: 'Femi', amount_ngn: 14000 }]);
    expect(text(r)).toContain('already owes ₦5,000');
    await confirmAction(actor, k, btn(r, 0).split(':')[1]!);
    expect(store.customers[0]!.outstanding_debt_ngn).toBe(19000);
    expect(store.customers[0]!.debt_since).toBe('2026-11-01T00:00:00Z'); // the older date is kept
  });

  it('Cancel changes nothing and kills the token', async () => {
    const { kv: k } = kv();
    const tk = btn(await proposeDebts(actor, k, list), 1).split(':')[1]!;
    expect(text(await cancelAction(actor, k, tk))).toContain('Nothing was changed');
    expect(text(await confirmAction(actor, k, tk))).toContain('expired');
    expect(store.customers).toHaveLength(0);
  });

  it('Undo removes exactly what was added', async () => {
    store.customers.push({ id: 'c0', business_id: 'b1', name: 'Femi', name_key: 'femi', outstanding_debt_ngn: 5000, debt_since: '2026-11-01T00:00:00Z', debt_due_date: null });
    const { kv: k } = kv();
    const tk = btn(await proposeDebts(actor, k, [{ customer_name: 'Femi', amount_ngn: 14000 }, { customer_name: 'Kalu', amount_ngn: 28000 }]), 0).split(':')[1]!;
    const done = await confirmAction(actor, k, tk);
    expect(text(await undoAction(actor, k, btn(done, 0).split(':')[1]!))).toContain('removed');
    expect(store.customers.find((c) => c.name === 'Femi')!.outstanding_debt_ngn).toBe(5000);
    expect(store.customers.find((c) => c.name === 'Kalu')!.outstanding_debt_ngn).toBe(0);
  });

  it('a pending entry belongs to one business: another shop cannot confirm it', async () => {
    const { kv: k } = kv();
    const tk = btn(await proposeDebts(actor, k, list), 0).split(':')[1]!;
    const other = { ...(actor as object), business: { id: 'b2', name: 'Other' } } as never;
    expect(text(await confirmAction(other, k, tk))).toContain('expired'); // key is per phone anyway
    expect(store.customers).toHaveLength(0);
  });

  it('with no names or amounts it asks for them instead of saying "nobody owes you"', async () => {
    const { kv: k } = kv();
    const t = text(await proposeDebts(actor, k, []));
    expect(t).toContain('names and amounts');
    expect(t).not.toContain('Nobody owes');
  });

  it('cleans junk: bad amounts, one-letter names, duplicates are merged, size is capped', () => {
    expect(cleanDebts([
      { customer_name: 'A', amount_ngn: 5000 }, { customer_name: 'Femi', amount_ngn: 0 }, { customer_name: 'Femi', amount_ngn: -5 },
      { customer_name: 'Kalu', amount_ngn: 1000 }, { customer_name: ' kalu ', amount_ngn: 2000 }, { customer_name: 'Big', amount_ngn: 5_000_000_000 },
      { customer_name: 'Tunde', amount_ngn: 3000, due_date: 'next week' },
    ])).toEqual([{ name: 'Kalu', amount: 3000, due: null, since: null }, { name: 'Tunde', amount: 3000, due: null, since: null }]);
  });
  it('more than 25 at once is refused politely', async () => {
    const { kv: k } = kv();
    const many = Array.from({ length: 26 }, (_, i) => ({ customer_name: `Person ${i}`, amount_ngn: 1000 }));
    expect(text(await proposeDebts(actor, k, many))).toContain('25 or fewer');
  });
});

describe('opening stock and price changes (never a sale or an expense)', () => {
  it('opening stock: preview, confirm sets stock+cost, undo restores', async () => {
    const { kv: k } = kv();
    const pr = await proposeProducts(actor, k, [{ name: 'Lace', quantity: 50, cost_price_ngn: 15000, selling_price_ngn: 20000 }]);
    expect(text(pr)).toContain('*Lace* _(new)_ — stock 50 · cost ₦15,000 · price ₦20,000');
    expect(text(pr)).toContain('not counted as a sale or a purchase');
    const done = await confirmAction(actor, k, btn(pr, 0).split(':')[1]!);
    expect(text(done)).toContain('Updated 1 product');
    expect(store.products[0]).toMatchObject({ stock_qty: 50, cost_price_ngn: 15000, selling_price_ngn: 20000 });
    await undoAction(actor, k, btn(done, 0).split(':')[1]!);
    expect(store.products).toHaveLength(0); // it was created by this action, so undo removes it
  });
  it('a price-only change leaves stock alone, shows old → new, and undo puts it back', async () => {
    store.products.push({ id: 'p0', business_id: 'b1', name: 'Lace', name_key: 'lace', stock_qty: 7, cost_price_ngn: 15000, selling_price_ngn: 18000 });
    const { kv: k } = kv();
    const pr = await proposeProducts(actor, k, [{ name: 'lace', selling_price_ngn: 20000 }]);
    expect(text(pr)).toContain('price ₦18,000 → ₦20,000');
    expect(text(pr)).not.toContain('stock');
    const done = await confirmAction(actor, k, btn(pr, 0).split(':')[1]!);
    expect(store.products[0]).toMatchObject({ stock_qty: 7, cost_price_ngn: 15000, selling_price_ngn: 20000 });
    await undoAction(actor, k, btn(done, 0).split(':')[1]!);
    expect(store.products[0]).toMatchObject({ stock_qty: 7, selling_price_ngn: 18000 });
  });
  it('ignores empty or nonsense items', () => {
    expect(cleanProducts([{ name: 'Lace' }, { name: 'x', quantity: 5 }, { name: 'Gele', quantity: -3 }, { name: 'Ankara', selling_price_ngn: 4500 }])).toEqual([{ name: 'Ankara', price: 4500 }]);
  });
});

describe('customer phone numbers', () => {
  it('normalises Nigerian formats', () => {
    for (const [raw, out] of [['08031234567', '2348031234567'], ['+234 803 123 4567', '2348031234567'], ['2348031234567', '2348031234567'], ['8031234567', '2348031234567']] as const) expect(normalisePhone(raw)).toBe(out);
    for (const bad of ['0803123', '', 'abc', '12345678901234567']) expect(normalisePhone(bad)).toBeNull();
  });
  it('saves it on the customer (creating them if new) and refuses a bad number', async () => {
    expect(text(await saveCustomerPhone(actor, 'Femi', '08031234567'))).toContain('Saved Femi\'s number: 2348031234567');
    expect(store.customers[0]!.phone_number).toBe('2348031234567');
    expect(text(await saveCustomerPhone(actor, 'Femi', '123'))).toContain('doesn\'t look right');
  });
});

describe('honest answers for what is not built yet', () => {
  const t = (k?: string) => text(notSupportedReply('234', k));
  it('never pretends it did anything', () => {
    expect(t('I_OWE_SUPPLIER')).toContain('haven\'t recorded this');
    expect(t('BANK_BALANCE')).toContain('haven\'t recorded this');
    expect(t('PERSONAL_SPENDING')).toContain('haven\'t counted it against your shop profit');
    expect(t('INVOICE')).toContain('can\'t send invoices yet');
    expect(t('OTHER')).toContain('can\'t do that one yet');
    for (const k of ['I_OWE_SUPPLIER', 'OPENING_CASH', 'INVOICE', 'OTHER', undefined]) expect(t(k)).not.toMatch(/\b(noted|saved|recorded it|done)\b/i);
  });
  it('formats who-owes context for the AI', () => {
    expect(owingContext([{ name: 'Femi', outstanding_debt_ngn: 14000 }, { name: 'Paid', outstanding_debt_ngn: 0 }])).toEqual(['Femi ₦14,000']);
  });
});

describe('client list', () => {
  it('previews a list (phones normalised), confirms, and undo removes only the new ones', async () => {
    store.customers.push({ id: 'c0', business_id: 'b1', name: 'Femi', name_key: 'femi', outstanding_debt_ngn: 0, phone_number: null });
    const { kv: k } = kv();
    const { proposeClients } = await import('../flows/records.js');
    const r = await proposeClients(actor, k, [{ name: 'Femi', phone: '08031234567' }, { name: 'Kalu', phone: '+234 805 123 4567' }, { name: 'Bisi' }]);
    const t = text(r);
    expect(t).toContain('1. Femi — 2348031234567 _(already on your list)_');
    expect(t).toContain('2. Kalu — 2348051234567');
    expect(t).toContain('2 new · 1 already saved');
    expect(store.customers).toHaveLength(1);                         // nothing saved yet
    const done = await confirmAction(actor, k, btn(r, 0).split(':')[1]!);
    expect(text(done)).toContain('3 customers on your list');
    expect(store.customers.map((c) => [c.name, c.phone_number])).toEqual([['Femi', '2348031234567'], ['Kalu', '2348051234567'], ['Bisi', null]]);
    await undoAction(actor, k, btn(done, 0).split(':')[1]!);
    expect(store.customers.map((c) => [c.name, c.phone_number])).toEqual([['Femi', null]]); // Kalu & Bisi removed, Femi's phone restored
  });
  it('drops junk names and bad phone numbers instead of saving them', async () => {
    const { cleanClients } = await import('../flows/records.js');
    expect(cleanClients([{ name: 'A' }, { name: 'Tunde', phone: '123' }, { name: 'tunde', phone: '08031234567' }, { name: '  ' }])).toEqual([{ name: 'tunde', phone: '2348031234567' }]);
  });
});
