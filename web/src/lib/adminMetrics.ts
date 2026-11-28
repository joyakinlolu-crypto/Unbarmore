import { ngn } from '@/lib/format';

/**
 * Pure maths behind the admin console, so it is unit-tested. Mirrors the bot's pilot scorecard (src/lib/scorecard.ts):
 * 🟢 habit = active on 4+ of the last 7 days.
 */
export type ShopStatus = 'habit' | 'trying' | 'stalled' | 'never_started' | 'new';
export const HABIT_DAYS = 4;

export function shopStatus(s: { ageDays: number; hasEntries: boolean; activeDays7: number }): ShopStatus {
  if (s.ageDays < 1 && s.activeDays7 === 0) return 'new';
  if (!s.hasEntries) return 'never_started';
  if (s.activeDays7 >= HABIT_DAYS) return 'habit';
  return s.activeDays7 >= 1 ? 'trying' : 'stalled';
}
export const STATUS_LABEL: Record<ShopStatus, string> = { habit: 'Habit', trying: 'Trying', stalled: 'Went quiet', never_started: 'Never started', new: 'New today' };
export const STATUS_ICON: Record<ShopStatus, string> = { habit: '🟢', trying: '🟡', stalled: '🟠', never_started: '🔴', new: '⚪' };

const PRICE = { starter_5k: { monthly: 5000, annual: 50000 / 12 }, growth_15k: { monthly: 15000, annual: 150000 / 12 } } as const;
/** Monthly recurring revenue from shops whose paid plan is currently active. */
export function mrrNgn(shops: { tier: string; cycle: string; expiresAt: string }[], now = Date.now()): number {
  return Math.round(shops.reduce((a, s) => {
    const p = (PRICE as Record<string, { monthly: number; annual: number }>)[s.tier];
    return a + (p && new Date(s.expiresAt).getTime() > now ? (s.cycle === 'annual' ? p.annual : p.monthly) : 0);
  }, 0));
}

export interface GapInput {
  tier: string; trialEndsAt: string; ageDays: number; activeDays7: number; everActive: boolean;
  unpricedRevenue: number; debtOverdue30: number; debtorsWithoutPhone: number; unconfirmedOld: number;
  lastCountVariance: number | null; failedVideos7d: number;
  /** last 30 days: sales and the cost of the goods sold (both known) */
  revenue30?: number; cogs30?: number; negativeStock?: number; now?: number;
}
export interface Gap { level: 'warn' | 'info' | 'chance'; text: string }

/** "What is this shop missing?": the reasons its numbers can't be trusted yet, and the chances to help or to sell. */
export function shopGaps(g: GapInput): Gap[] {
  const out: Gap[] = [];
  const now = g.now ?? Date.now();
  if ((g.revenue30 ?? 0) > 0 && (g.cogs30 ?? 0) > (g.revenue30 ?? 0) && !(g.unpricedRevenue > 0)) out.push({ level: 'warn', text: `Selling at a loss: the goods sold cost ${ngn(g.cogs30!)} but were sold for ${ngn(g.revenue30!)} (${Math.round(((g.revenue30! - g.cogs30!) / g.revenue30!) * 100)}%). Check their selling prices against what they pay.` });
  if ((g.negativeStock ?? 0) > 0) out.push({ level: 'info', text: `${g.negativeStock} product${g.negativeStock === 1 ? '' : 's'} show negative stock: they sold more than they ever recorded buying. Opening stock was probably never entered, so stock alerts are unreliable.` });
  if (g.unpricedRevenue > 0) out.push({ level: 'warn', text: `${ngn(g.unpricedRevenue)} of sales have no cost price, so the profit this shop sees is only an upper limit.` });
  if (g.debtOverdue30 > 0) out.push({ level: 'warn', text: `${ngn(g.debtOverdue30)} has been owed to them for over 30 days.` });
  if (g.debtorsWithoutPhone > 0) out.push({ level: 'info', text: `${g.debtorsWithoutPhone} customer${g.debtorsWithoutPhone === 1 ? '' : 's'} who owe money have no phone number saved, so the one-tap reminder can't open their chat.` });
  if (g.unconfirmedOld > 0) out.push({ level: 'warn', text: `${g.unconfirmedOld} entr${g.unconfirmedOld === 1 ? 'y was' : 'ies were'} never confirmed (older than a day): that money is missing from their books.` });
  if (g.lastCountVariance !== null && g.lastCountVariance < -100) out.push({ level: 'warn', text: `Their last drawer count was ${ngn(-g.lastCountVariance)} short.` });
  if (g.failedVideos7d > 0) out.push({ level: 'warn', text: `${g.failedVideos7d} video${g.failedVideos7d === 1 ? '' : 's'} failed in the last 7 days.` });
  if (g.everActive && g.activeDays7 === 0 && g.ageDays >= 3) out.push({ level: 'warn', text: 'Used it before, but nothing recorded in the last 7 days. Message them.' });
  if (!g.everActive && g.ageDays >= 1) out.push({ level: 'warn', text: 'Signed up but has never recorded a single entry. Message them and walk them through the first sale.' });
  const trialLeft = Math.ceil((new Date(g.trialEndsAt).getTime() - now) / 86_400_000);
  if (g.tier === 'trial' && trialLeft >= 0 && trialLeft <= 3) out.push({ level: 'chance', text: `Trial ends in ${trialLeft} day${trialLeft === 1 ? '' : 's'}${g.activeDays7 >= 2 ? ': they are using it, a good moment to ask them to subscribe.' : '. They have barely used it, so find out why first.'}` });
  return out;
}

export interface AttentionInput {
  id: string; name: string; tier: string; status: ShopStatus; ageDays: number; trialEndsAt: string; expiresAt: string; activeDays7: number;
}
export interface Attention { trialsEnding: AttentionInput[]; paidExpiring: AttentionInput[]; neverStarted: AttentionInput[]; wentQuiet: AttentionInput[] }

/** The shops that need a human today, in four short lists. */
export function attention(shops: AttentionInput[], now = Date.now()): Attention {
  const days = (iso: string) => Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
  return {
    trialsEnding: shops.filter((s) => s.tier === 'trial' && days(s.trialEndsAt) >= 0 && days(s.trialEndsAt) <= 3).sort((a, b) => days(a.trialEndsAt) - days(b.trialEndsAt)),
    paidExpiring: shops.filter((s) => (s.tier === 'starter_5k' || s.tier === 'growth_15k') && days(s.expiresAt) >= 0 && days(s.expiresAt) <= 3).sort((a, b) => days(a.expiresAt) - days(b.expiresAt)),
    neverStarted: shops.filter((s) => s.status === 'never_started'),
    wentQuiet: shops.filter((s) => s.status === 'stalled'),
  };
}

// ───────────── What an admin may change, with hard limits ─────────────
export const GRANT_MAX = 50, TRIAL_EXTEND_MAX = 30, COMP_MAX_DAYS = 90;
export const COMP_TIERS = ['starter_5k', 'growth_15k'] as const;

/** Parse and bound a whole number from a form field. null = invalid. */
export const boundedInt = (v: unknown, min: number, max: number): number | null => {
  const s = String(v ?? '').trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
};

/** New trial end: extends from whichever is later, now or the current end (so extending an expired trial never lands in the past). */
export const extendedTrialEnd = (currentIso: string, days: number, now = Date.now()) => new Date(Math.max(now, new Date(currentIso).getTime()) + days * 86_400_000).toISOString();
