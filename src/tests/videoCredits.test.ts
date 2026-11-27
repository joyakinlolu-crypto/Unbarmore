import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
    PAYSTACK_SECRET_KEY: 'sk_test_realistic_key_123', PAYSTACK_PLAN_STARTER_MONTHLY: 'a', PAYSTACK_PLAN_STARTER_ANNUAL: 'b',
    PAYSTACK_PLAN_GROWTH_MONTHLY: 'c', PAYSTACK_PLAN_GROWTH_ANNUAL: 'd',
  });
});

const m = vi.hoisted(() => ({ addVideoCredits: vi.fn(), seen: new Set<string>() }));
vi.mock('../db/supabase.js', () => ({
  addVideoCredits: m.addVideoCredits,
  getBusiness: async () => ({ id: 'b1', name: 'Ada Fabrics', owner_phone: '2348000000001' }),
  db: {
    from: () => ({
      upsert: (row: { event_type: string; paystack_reference: string }) => ({
        select: () => ({
          maybeSingle: async () => {
            const k = `${row.event_type}|${row.paystack_reference}`;
            if (m.seen.has(k)) return { data: null, error: null };   // duplicate delivery
            m.seen.add(k);
            return { data: { id: `evt-${m.seen.size}` }, error: null };
          },
        }),
      }),
      update: () => ({ eq: async () => ({}) }),
    }),
  },
}));

const { handlePaystackEvent } = await import('../services/paystack.js');

const charge = (reference: string, amountNgn: number, qty: unknown, kind = 'video_credits') => ({
  event: 'charge.success',
  data: { reference, amount: amountNgn * 100, status: 'success', metadata: { business_id: 'b1', kind, qty } },
});

describe('pay-as-you-go video credits via the Paystack webhook', () => {
  beforeEach(() => { m.seen.clear(); m.addVideoCredits.mockReset(); m.addVideoCredits.mockResolvedValue(3); });

  it('₦1,200 for the 3-video pack adds 3 credits and says so', async () => {
    const out = await handlePaystackEvent(charge('r1', 1200, 3));
    expect(out).toMatchObject({ kind: 'video_credits', qty: 3, balance: 3, amountNgn: 1200 });
    expect(m.addVideoCredits).toHaveBeenCalledWith('b1', 3);
  });
  it('₦500 for 1 video adds 1 credit', async () => {
    m.addVideoCredits.mockResolvedValue(1);
    expect(await handlePaystackEvent(charge('r2', 500, 1))).toMatchObject({ kind: 'video_credits', qty: 1, balance: 1 });
  });
  it('a replayed webhook (same reference) never adds credits twice', async () => {
    await handlePaystackEvent(charge('r3', 1200, 3));
    expect(await handlePaystackEvent(charge('r3', 1200, 3))).toBeNull();
    expect(m.addVideoCredits).toHaveBeenCalledTimes(1);
  });
  it('underpaying is refused: ₦100 for the 3-video pack gets nothing', async () => {
    expect(await handlePaystackEvent(charge('r4', 100, 3))).toBeNull();
    expect(m.addVideoCredits).not.toHaveBeenCalled();
  });
  it('a quantity that is not a real pack is refused (cannot buy 50 videos for ₦500)', async () => {
    expect(await handlePaystackEvent(charge('r5', 500, 50))).toBeNull();
    expect(await handlePaystackEvent(charge('r6', 500, 'abc'))).toBeNull();
    expect(m.addVideoCredits).not.toHaveBeenCalled();
  });
});
