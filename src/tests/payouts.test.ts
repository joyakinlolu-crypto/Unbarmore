import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
    ADMIN_PHONE: '2348100000001', SUPPORT_WHATSAPP_URL: 'https://wa.me/2348100000002',
    PAYSTACK_SECRET_KEY: 'sk_live_9f8e7d6c5b4a39281716', PAYSTACK_PLAN_STARTER_MONTHLY: 'PLN_abc12345xyz',
  });
});

const m = vi.hoisted(() => ({
  setSession: vi.fn(), pendingPayout: vi.fn(), requestPayout: vi.fn(), decidePayout: vi.fn(), listPendingPayouts: vi.fn(),
  bizRow: { current: { name: 'Ada Fabrics', owner_phone: '2348000000001' } as unknown },
}));
vi.mock('../db/supabase.js', () => ({
  setSession: m.setSession,
  getBusiness: vi.fn(),
  db: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: m.bizRow.current }) }) }) }) },
}));
vi.mock('../services/payouts.js', async () => {
  const real = await vi.importActual<typeof import('../services/payouts.js')>('../services/payouts.js');
  return { ...real, pendingPayout: m.pendingPayout, requestPayout: m.requestPayout, decidePayout: m.decidePayout, listPendingPayouts: m.listPendingPayouts };
});

import { REFERRAL, rewardForTier } from '../config/plans.js';
import { adminPayoutCommand, maskAccount, parseBankDetails, submitPayout, withdrawStart } from '../flows/payouts.js';
import { PayoutsNotReadyError } from '../services/payouts.js';

const text = (r: { toPayload(): Record<string, any> }) => { const p = r.toPayload(); return JSON.stringify(p.type === 'text' ? p.text.body : p); };
const actor = (wallet: number, extra: Record<string, unknown> = {}, isStaff = false) => ({
  phone: '2348000000001', isStaff, user: { id: 'u1', full_name: 'Ada' },
  business: { id: 'b1', name: 'Ada Fabrics', owner_phone: '2348000000001', subscription_tier: 'starter_5k', referral_wallet_ngn: wallet, ...extra },
}) as never;

beforeEach(() => { Object.values(m).forEach((f) => typeof f === 'function' && (f as ReturnType<typeof vi.fn>).mockReset()); m.pendingPayout.mockResolvedValue(null); m.bizRow.current = { name: 'Ada Fabrics', owner_phone: '2348000000001' }; });

describe('the referral numbers are the same everywhere (bot, SQL, web)', () => {
  it('₦1,000 cash-out minimum; Starter ₦1,000, Growth ₦3,000; only the referrer is paid', () => {
    expect(REFERRAL.WITHDRAW_MIN_NGN).toBe(1000);
    expect(REFERRAL.DISCOUNT_MIN_NGN).toBe(1000);
    expect(rewardForTier('starter_5k')).toBe(1000);
    expect(rewardForTier('growth_15k')).toBe(3000);
    expect(rewardForTier('free_limited')).toBe(0);
    const sql = fs.readFileSync('supabase/migrations/009_referral_v2.sql', 'utf8');
    expect(sql).toMatch(/min_payout CONSTANT NUMERIC := 1000;/);
    expect(sql).toMatch(/WHEN 'growth_15k' THEN 3000 WHEN 'starter_5k' THEN 1000/);
    expect(sql).toMatch(/CHECK \(amount_ngn >= 1000\)/); // payout_requests had its own hidden ₦5,000 floor
    expect(sql).not.toMatch(/signup_bonus/);   // the new shop is NOT paid
    const web = fs.readFileSync('web/src/lib/referral.ts', 'utf8');
    expect(web).toContain('WITHDRAW_MIN_NGN: 1000');
    expect(web).toContain('DISCOUNT_MIN_NGN: 1000');
    expect(web).toContain('growth_15k: 3000');
  });
});

describe('parseBankDetails — decides where real money goes, so it is strict', () => {
  const ok = (s: string) => { const r = parseBankDetails(s); expect(r.ok).toBe(true); return r as { ok: true; bankName: string; account: string }; };
  it.each([
    ['GTBank 0123456789', 'GTBank', '0123456789'],
    ['0123456789 Access Bank', 'Access Bank', '0123456789'],
    ['Opay, 8101234567', 'Opay', '8101234567'],
    ['Bank name: First Bank  Account number: 3012345678', 'First Bank', '3012345678'],
    ['my account is Zenith bank 2012345678 pls', 'Zenith bank', '2012345678'],
    ['Kuda: 0123 456 789', 'Kuda', '0123456789'],
    ['UBA - 1012345678', 'UBA', '1012345678'],
    ['Moniepoint MFB 6012345678', 'Moniepoint MFB', '6012345678'],
  ])('%s', (input, bank, acct) => { const r = ok(input); expect([r.bankName, r.account]).toEqual([bank, acct]); });
  it('an 11-digit Nigerian PHONE number is not an account number', () => { expect(parseBankDetails('GTBank 08012345678')).toEqual({ ok: false, error: 'no_account' }); });
  it('too short / too long / words only / junk like "ok" are refused', () => {
    for (const bad of ['GTBank 123456789', 'GTBank 012345678901', 'GTBank', 'ok', 'hmm', 'yes please', '']) expect(parseBankDetails(bad).ok).toBe(false);
  });
  it('two different account numbers → ambiguous, refused', () => { expect(parseBankDetails('GTBank 0123456789 or 9876543210')).toEqual({ ok: false, error: 'many_accounts' }); });
  it('a number with no bank → asks for the bank', () => { expect(parseBankDetails('0123456789')).toEqual({ ok: false, error: 'no_bank' }); });
  it('the account is masked everywhere it is shown back to a user', () => { expect(maskAccount('0123456789')).toBe('****6789'); });
});

describe('WITHDRAW (owner)', () => {
  it('below ₦1,000: says what one referral pays, does NOT start a payout', async () => {
    const t = text(await withdrawStart(actor(0)));
    expect(t).toContain('₦0'); expect(t.replace(/\*/g, '')).toContain('starts at ₦1,000'); expect(t).toContain('₦3,000');
    expect(m.setSession).not.toHaveBeenCalled();
  });
  it('exactly ₦1,000 unlocks: asks for bank name + 10-digit account and waits', async () => {
    const t = text(await withdrawStart(actor(1000)));
    expect(t).toContain('₦1,000'); expect(t).toContain('bank name'); expect(t).toContain('10-digit account number'); expect(t).toContain('CANCEL');
    expect(m.setSession).toHaveBeenCalledWith('2348000000001', 'AWAITING_PAYOUT_DETAILS', expect.objectContaining({ at: expect.any(Number) }));
  });
  it('a pending payout blocks a second request, even with a full wallet', async () => {
    m.pendingPayout.mockResolvedValue({ ref: 'WD-ABC123', amountNgn: 5000, bankName: 'GTBank', accountNumber: '0123456789', businessId: 'b1' });
    const t = text(await withdrawStart(actor(9000)));
    expect(t).toContain('already have a payout waiting'); expect(t).toContain('WD-ABC123'); expect(t).toContain('****6789'); expect(t).not.toContain('0123456789');
    expect(m.setSession).not.toHaveBeenCalled();
  });
  it('staff cannot withdraw the owner\'s referral money', async () => {
    expect(text(await withdrawStart(actor(9000, {}, true)))).toContain('Only the business owner');
  });
});

describe('submitting bank details', () => {
  it('invalid details → asks again, never touches the wallet', async () => {
    const r = await submitPayout(actor(5000), 'ok');
    expect(m.requestPayout).not.toHaveBeenCalled(); expect(r.done).toBe(false); expect(text(r.reply)).toContain('10-digit');
  });
  it('success → pending reference, masked account to the user, FULL details + PAID/REJECT instructions to the admin', async () => {
    m.requestPayout.mockResolvedValue({ ok: true, reason: 'ok', ref: 'WD-ABC123', amountNgn: 5000 });
    const r = await submitPayout(actor(5000), 'Access Bank 0123456789');
    expect(m.requestPayout).toHaveBeenCalledWith('b1', 'Access Bank', '0123456789');
    const u = text(r.reply); expect(u).toContain('WD-ABC123'); expect(u).toContain('pending'); expect(u).toContain('****6789'); expect(u).not.toContain('0123456789'); expect(u).toContain('wallet is now ₦0');
    expect(r.adminNotice!.to).toBe('2348100000001');                                // goes to ADMIN_PHONE
    const a = (r.adminNotice!.toPayload() as any).text.body;
    for (const needle of ['WD-ABC123', '₦5,000', 'Access Bank', '0123456789', 'Ada Fabrics', 'PAID WD-ABC123', 'REJECT WD-ABC123']) expect(a).toContain(needle);
    expect(m.setSession).toHaveBeenCalledWith('2348000000001', 'IDLE', {});
    expect(r.done).toBe(true);
  });
  it.each([
    ['already_pending', 'already have a payout waiting'],
    ['below_minimum', 'starts at ₦1,000'],
    ['no_business', "couldn't find your account"],
  ])('database says %s → clear message, no admin ping, nothing double-charged', async (reason, needle) => {
    m.requestPayout.mockResolvedValue({ ok: false, reason, ref: null, amountNgn: 3000 });
    const r = await submitPayout(actor(5000), 'GTBank 0123456789');
    expect(text(r.reply)).toContain(needle); expect(r.adminNotice).toBeNull(); expect(r.done).toBe(true);
  });
  it('migration 003 missing → honest message, wallet untouched, no crash', async () => {
    m.requestPayout.mockRejectedValue(new PayoutsNotReadyError());
    const r = await submitPayout(actor(5000), 'GTBank 0123456789');
    expect(text(r.reply)).toContain('nothing was taken'); expect(r.adminNotice).toBeNull();
  });
});

describe('ADMIN: PAYOUTS / PAID / REJECT', () => {
  it('PAYOUTS lists pending requests with the details needed to pay', async () => {
    m.listPendingPayouts.mockResolvedValue([{ ref: 'WD-ABC123', amountNgn: 5000, bankName: 'GTBank', accountNumber: '0123456789', businessId: 'b1', businessName: 'Ada Fabrics', ownerPhone: '2348000000001' }]);
    const r = (await adminPayoutCommand('2348100000001', 'payouts'))!;
    const t = text(r.reply); expect(t).toContain('1 payout pending'); expect(t).toContain('0123456789'); expect(t).toContain('Ada Fabrics');
  });
  it('PAID → marks it, tells the admin, and tells the business (masked account)', async () => {
    m.decidePayout.mockResolvedValue({ ok: true, reason: 'ok', businessId: 'b1', amountNgn: 5000, bankName: 'GTBank', accountNumber: '0123456789' });
    const r = (await adminPayoutCommand('2348100000001', 'paid wd-abc123'))!;
    expect(m.decidePayout).toHaveBeenCalledWith('WD-ABC123', 'paid');
    expect(text(r.reply)).toContain('marked *paid*');
    const n = r.userNotice!; expect(n.to).toBe('2348000000001'); expect(n.reply.to).toBe('2348000000001');
    const body = (n.reply.toPayload() as any).text.body; expect(body).toContain('sent'); expect(body).toContain('****6789'); expect(body).not.toContain('0123456789');
  });
  it('REJECT → wallet refunded message to the business', async () => {
    m.decidePayout.mockResolvedValue({ ok: true, reason: 'ok', businessId: 'b1', amountNgn: 5000, bankName: 'GTBank', accountNumber: '0123456789' });
    const r = (await adminPayoutCommand('2348100000001', 'REJECT WD-ABC123'))!;
    expect(m.decidePayout).toHaveBeenCalledWith('WD-ABC123', 'rejected');
    expect((r.userNotice!.reply.toPayload() as any).text.body).toContain('back in your wallet');
  });
  it('an already-decided or unknown reference changes nothing and notifies nobody', async () => {
    m.decidePayout.mockResolvedValue({ ok: false, reason: 'already_decided', businessId: 'b1', amountNgn: 5000, bankName: 'x', accountNumber: 'y' });
    const r = (await adminPayoutCommand('2348100000001', 'PAID WD-ABC123'))!;
    expect(text(r.reply)).toContain('already decided'); expect(r.userNotice).toBeNull();
    m.decidePayout.mockResolvedValue({ ok: false, reason: 'not_found', businessId: null, amountNgn: 0, bankName: null, accountNumber: null });
    expect(text((await adminPayoutCommand('2348100000001', 'PAID WD-FFFFFF'))!.reply)).toContain("can't find");
  });
  it('ordinary text is not a payout command (returns null so normal handling continues)', async () => {
    for (const t of ['hello', 'sold 2 lace 50k', 'paid', 'paid me', 'PAID WD-12', 'reject']) expect(await adminPayoutCommand('2348100000001', t)).toBeNull();
    expect(m.decidePayout).not.toHaveBeenCalled();
  });
});

describe('own renewal: wallet money only discounts it when the owner chose USE CREDIT', () => {
  const run = async (wallet: number, useCredit = true) => {
    const calls: { amount: number }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: true, message: 'ok', data: { authorization_url: 'https://pay.test/x' } }), { status: 200 }); }));
    vi.resetModules();
    const { createCheckoutLink } = await import('../services/paystack.js');
    const r = await createCheckoutLink({ id: 'b1', owner_phone: '2348000000001', name: 'Ada', referral_wallet_ngn: wallet, referral_apply_to_renewal: useCredit } as never, 'starter_5k', 'monthly');
    vi.unstubAllGlobals();
    return { ...r, sentKobo: calls[0]!.amount };
  };
  it('₦3,000 wallet on the ₦5,000 plan → pays ₦2,000', async () => { const r = await run(3000); expect([r.walletApplied, r.amountNgn, r.sentKobo]).toEqual([3000, 2000, 200000]); });
  it('₦1,000 (the minimum) is applied', async () => { expect((await run(1000)).amountNgn).toBe(4000); });
  it('under ₦1,000 is not applied', async () => { const r = await run(500); expect([r.walletApplied, r.amountNgn]).toEqual([0, 5000]); });
  it('a wallet bigger than the plan never takes the charge below Paystack\'s ₦100 minimum', async () => { const r = await run(9000); expect([r.walletApplied, r.amountNgn]).toEqual([4900, 100]); });
  it('cash is the default: a wallet is NOT spent on renewal unless the owner chose it', async () => {
    const r = await run(3000, false); expect([r.walletApplied, r.amountNgn]).toEqual([0, 5000]);
  });
});
