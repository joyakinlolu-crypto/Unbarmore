// Mirrors the bot's REFERRAL constants (src/config/plans.ts) and the SQL minimum in migration 009.
// A test in the bot's test-suite fails if any of the three copies drift apart.
export const REFERRAL = { REWARD_NGN: 1000, REWARD_BY_TIER: { starter_5k: 1000, growth_15k: 3000 }, DISCOUNT_MIN_NGN: 1000, WITHDRAW_MIN_NGN: 1000 } as const;
export const WITHDRAW_MIN_REFERRALS = REFERRAL.WITHDRAW_MIN_NGN / REFERRAL.REWARD_NGN;

export type WalletState =
  | { kind: 'pending' }
  | { kind: 'unlocked' }
  | { kind: 'locked'; referralsToGo: number; progressPct: number; canDiscount: boolean };

/** What the wallet card should show. Pure, so it is unit-tested. */
export function walletState(wallet: number, hasPendingPayout: boolean): WalletState {
  if (hasPendingPayout) return { kind: 'pending' };
  if (wallet >= REFERRAL.WITHDRAW_MIN_NGN) return { kind: 'unlocked' };
  return {
    kind: 'locked',
    referralsToGo: Math.ceil((REFERRAL.WITHDRAW_MIN_NGN - wallet) / REFERRAL.REWARD_NGN),
    progressPct: Math.max(0, Math.min(100, Math.round((wallet / REFERRAL.WITHDRAW_MIN_NGN) * 100))),
    canDiscount: wallet >= REFERRAL.DISCOUNT_MIN_NGN,
  };
}
