/**
 * Founding-shop price + plan margins. Pure, so the numbers can be tested and read at a glance.
 * All costs are ESTIMATES (see src/lib/aiCost.ts): replace VIDEO_COST_USD / FIXED_COSTS_USD with real figures from Google's Spend page and your hosting bills.
 */
import { PLANS, PRICES_NGN } from '../config/plans.js';

/** The first FOUNDING.SLOTS shops that the admin marks get Growth at GROWTH_NGN/month for MONTHS months, then list price. */
export const FOUNDING = { GROWTH_NGN: 10_000, SLOTS: 20, MONTHS: 12 } as const;

export interface FoundingFields { founding_price_ngn?: number | null; founding_until?: string | null }

/** The locked monthly Growth price if this shop's founding window is still open, else null. */
export function foundingPrice(b: FoundingFields, now = Date.now()): number | null {
  if (!b.founding_price_ngn || !b.founding_until) return null;
  return Date.parse(b.founding_until) > now ? b.founding_price_ngn : null;
}

export const foundingUntilFrom = (now = Date.now()): string => {
  const d = new Date(now); d.setUTCMonth(d.getUTCMonth() + FOUNDING.MONTHS); return d.toISOString();
};

// ───────────── Margins ─────────────

/** Estimated AI cost of one full 3-photo HD video, in dollars (≈ ₦200 at ₦1,500/$). */
export const videoCostUsd = (): number => Number(process.env.VIDEO_COST_USD) || 0.135;
/** Monthly dollar-billed running costs (hosting, database, WhatsApp fees). */
export const fixedCostsUsd = (): number => Number(process.env.FIXED_COSTS_USD) || 40;
/** The bot warns the admin when a plan's worst-case AI cost is above this share of its price. */
export const MARGIN_ALARM = 0.5;
/** Share of the included videos a typical shop uses. */
export const TYPICAL_USE = 0.5;

/** Paystack local fee: 1.5% (+₦100 from ₦2,500), capped at ₦2,000. */
export const paystackFee = (price: number): number => Math.min(2000, Math.round(price * 0.015 + (price >= 2500 ? 100 : 0)));

export type PaidPlan = 'starter_5k' | 'growth_15k';
export interface Margin { price: number; aiWorst: number; aiTypical: number; fee: number; keepWorst: number; keepTypical: number; worstShare: number }

export function planMargin(tier: PaidPlan, rate: number, price: number = PRICES_NGN[tier].monthly): Margin {
  const perVideo = videoCostUsd() * rate;
  const videos = PLANS[tier].videos_used_this_month;
  const aiWorst = Math.round(videos * perVideo), aiTypical = Math.round(videos * TYPICAL_USE * perVideo), fee = paystackFee(price);
  return { price, aiWorst, aiTypical, fee, keepWorst: price - aiWorst - fee, keepTypical: price - aiTypical - fee, worstShare: aiWorst / price };
}

const n = (x: number) => `₦${Math.round(x).toLocaleString('en-NG')}`;

/** Admin COSTS footer: what each plan keeps at different dollar rates, and how many shops cover the fixed costs. */
export function marginTableText(rates: number[], current: number): string[] {
  const out = ['💰 *Plan margins* (estimates: per month, per shop)'];
  for (const r of rates) {
    const s = planMargin('starter_5k', r), g = planMargin('growth_15k', r);
    const fixed = fixedCostsUsd() * r;
    const growthShops = Math.ceil(fixed / g.keepTypical);
    out.push(`${r === current ? '▶' : '•'} ₦${r.toLocaleString('en-NG')}/$ → Starter keeps ${n(s.keepTypical)} (worst ${n(s.keepWorst)}) · Growth keeps ${n(g.keepTypical)} (worst ${n(g.keepWorst)}, AI ${Math.round(g.worstShare * 100)}%) · fixed ${n(fixed)} = ${growthShops} Growth shops`);
  }
  out.push(`_Assumes ${n(videoCostUsd() * current)} per video now and shops using ${Math.round(TYPICAL_USE * 100)}% of their videos. Set USD_NGN, VIDEO_COST_USD, FIXED_COSTS_USD in Railway to your real numbers._`);
  return out;
}

/** Plans whose worst-case AI cost is above the alarm line at this dollar rate. */
export function marginAlarms(rate: number): { plan: PaidPlan; share: number }[] {
  return (['starter_5k', 'growth_15k'] as PaidPlan[])
    .map((plan) => ({ plan, share: planMargin(plan, rate).worstShare }))
    .filter((x) => x.share > MARGIN_ALARM);
}
