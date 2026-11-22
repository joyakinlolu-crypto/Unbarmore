import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { PRICES_NGN } from '../config/plans.js';
import { db, getBusiness, type Business } from '../db/supabase.js';

const API = 'https://api.paystack.co';
type PaidTier = 'starter_5k' | 'growth_15k';
type Interval = 'monthly' | 'annual';

/** A value counts as "real" only if it is set and not an obvious placeholder (so a half-filled .env can't pretend payments work). */
const isReal = (v?: string) => !!v && v.trim().length > 8 && !/placeholder|replace_me|paste_|unused|changeme|xxxx/i.test(v);

/** True only when a real Paystack secret key is configured. Until then the bot runs normally and payments say "opening soon". */
export const paymentsLive = (): boolean => isReal(env.PAYSTACK_SECRET_KEY);

export class PaymentsNotLiveError extends Error {
  constructor() { super('payments are not live yet'); this.name = 'PaymentsNotLiveError'; }
}

export function verifyPaystackSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !paymentsLive()) return false;
  const expected = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY!).update(rawBody).digest('hex');
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header, 'hex'), Buffer.from(expected, 'hex'));
}

const PLAN_CODES: Record<PaidTier, Record<Interval, string>> = {
  starter_5k: { monthly: env.PAYSTACK_PLAN_STARTER_MONTHLY ?? '', annual: env.PAYSTACK_PLAN_STARTER_ANNUAL ?? '' },
  growth_15k: { monthly: env.PAYSTACK_PLAN_GROWTH_MONTHLY ?? '', annual: env.PAYSTACK_PLAN_GROWTH_ANNUAL ?? '' },
};

function planFromCode(code: string | undefined): { tier: PaidTier; interval: Interval } | null {
  if (!code || !isReal(code)) return null;
  for (const tier of Object.keys(PLAN_CODES) as PaidTier[]) {
    for (const interval of ['monthly', 'annual'] as Interval[]) {
      if (PLAN_CODES[tier][interval] === code) return { tier, interval };
    }
  }
  return null;
}

async function paystack<T>(path: string, body: unknown): Promise<T> {
  if (!paymentsLive()) throw new PaymentsNotLiveError();
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { status: boolean; message: string; data: T };
  if (!res.ok || !json.status) throw new Error(`Paystack ${path}: ${json.message}`);
  return json.data;
}

/** WhatsApp users have no email; Paystack needs one. Stable synthetic address per business. */
const syntheticEmail = (b: Business) => `${b.owner_phone}@wa.unbarmore.com`;

/**
 * Checkout link the user taps inside WhatsApp.
 * - No wallet credit → Paystack plan subscription (auto-renews by card).
 * - Wallet credit → single charge for (price − wallet); renewals stay manual until wallet is used up.
 */
export async function createCheckoutLink(b: Business, tier: PaidTier, interval: Interval): Promise<{ url: string; amountNgn: number; walletApplied: number }> {
  if (!paymentsLive() || !isReal(PLAN_CODES[tier][interval])) throw new PaymentsNotLiveError();
  const price = PRICES_NGN[tier][interval];
  const walletApplied = Math.min(Number(b.referral_wallet_ngn), price - 100); // Paystack minimum ₦100
  const amountNgn = price - Math.max(0, walletApplied);
  const metadata = { business_id: b.id, tier, interval, wallet_applied: Math.max(0, walletApplied) };

  const data = await paystack<{ authorization_url: string }>('/transaction/initialize', {
    email: syntheticEmail(b),
    amount: amountNgn * 100, // kobo
    currency: 'NGN',
    ...(walletApplied > 0 ? {} : { plan: PLAN_CODES[tier][interval] }),
    channels: ['card', 'bank_transfer', 'ussd', 'bank'],
    callback_url: `https://wa.me/${env.WHATSAPP_DISPLAY_NUMBER}?text=${encodeURIComponent('I have paid')}`,
    metadata: { ...metadata, custom_fields: [{ display_name: 'Business', variable_name: 'business', value: b.name }] },
  });
  return { url: data.authorization_url, amountNgn, walletApplied: Math.max(0, walletApplied) };
}

// ───────────── Webhook processing ─────────────

interface PaystackEvent {
  event: string;
  data: {
    reference?: string;
    amount?: number;
    status?: string;
    customer?: { email?: string; customer_code?: string };
    plan?: { plan_code?: string } | Record<string, never>;
    subscription_code?: string;
    metadata?: { business_id?: string; tier?: PaidTier; interval?: Interval; wallet_applied?: number } | string | null;
  };
}

export interface PaymentOutcome {
  business: Business;
  tier: PaidTier;
  interval: Interval;
  amountNgn: number;
  referrerId: string | null;
  referralCredited: boolean;
}

async function resolveBusinessId(e: PaystackEvent): Promise<string | null> {
  const meta = typeof e.data.metadata === 'object' && e.data.metadata ? e.data.metadata : {};
  if (meta.business_id) return meta.business_id;
  const code = e.data.customer?.customer_code;
  if (code) {
    const { data } = await db.from('businesses').select('id').eq('paystack_customer_code', code).maybeSingle();
    if (data) return data.id as string;
  }
  const email = e.data.customer?.email;
  if (email?.endsWith('@wa.unbarmore.com')) {
    const { data } = await db.from('businesses').select('id').eq('owner_phone', email.split('@')[0]).maybeSingle();
    if (data) return data.id as string;
  }
  return null;
}

/** Idempotent. Returns an outcome only the first time a successful charge is applied. */
export async function handlePaystackEvent(e: PaystackEvent): Promise<PaymentOutcome | null> {
  const reference = e.data.reference ?? e.data.subscription_code ?? crypto.createHash('sha1').update(JSON.stringify(e)).digest('hex');
  const businessId = await resolveBusinessId(e);
  const amountNgn = (e.data.amount ?? 0) / 100;

  const ins = await db
    .from('billing_events')
    .upsert(
      {
        event_type: e.event, paystack_reference: reference, business_id: businessId,
        amount_ngn: amountNgn, status: e.data.status ?? 'n/a', raw_payload: e,
      },
      { onConflict: 'event_type,paystack_reference', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  if (ins.error) throw new Error(`billing_events: ${ins.error.message}`);
  if (!ins.data) return null; // duplicate delivery

  if (!businessId) return null;

  if (e.event === 'subscription.create' && e.data.subscription_code) {
    await db.from('businesses').update({
      paystack_subscription_code: e.data.subscription_code,
      paystack_customer_code: e.data.customer?.customer_code ?? null,
    }).eq('id', businessId);
    return null;
  }
  if (e.event !== 'charge.success' || e.data.status !== 'success') return null;

  const meta = typeof e.data.metadata === 'object' && e.data.metadata ? e.data.metadata : {};
  const plan = (meta.tier && meta.interval ? { tier: meta.tier, interval: meta.interval } : null)
    ?? planFromCode((e.data.plan as { plan_code?: string } | undefined)?.plan_code);
  if (!plan) return null; // not a subscription charge

  if (e.data.customer?.customer_code) {
    await db.from('businesses').update({ paystack_customer_code: e.data.customer.customer_code }).eq('id', businessId);
  }

  const { data, error } = await db.rpc('apply_subscription_payment', {
    p_billing_event_id: ins.data.id,
    p_business_id: businessId,
    p_tier: plan.tier,
    p_cycle: plan.interval,
    p_amount_ngn: amountNgn,
    p_wallet_applied: Number(meta.wallet_applied ?? 0),
  });
  if (error) throw new Error(`apply_subscription_payment: ${error.message}`);
  const row = (data as { processed: boolean; referrer_id: string | null; referral_credited: boolean }[])[0];
  if (!row?.processed) return null;

  return {
    business: await getBusiness(businessId),
    tier: plan.tier,
    interval: plan.interval,
    amountNgn,
    referrerId: row.referrer_id,
    referralCredited: row.referral_credited,
  };
}

export async function requestPayout(businessId: string, bankDetails: string): Promise<number> {
  const { data, error } = await db.rpc('request_payout', { p_business_id: businessId, p_bank_details: bankDetails });
  if (error) throw new Error(`request_payout: ${error.message}`);
  return Number(data ?? 0);
}
