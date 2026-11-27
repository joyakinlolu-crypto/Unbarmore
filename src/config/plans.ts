/** Single source of truth for tiers, caps and prices. -1 = unlimited. */
export type Tier = 'trial' | 'free_limited' | 'starter_5k' | 'growth_15k';
export type Metric = 'videos_used_this_month' | 'tx_logged_this_month' | 'ocr_scans_used_this_month' | 'pdf_receipts_used_this_month' | 'ceo_reports_used_this_month';

export interface PlanCaps {
  videos_used_this_month: number;
  tx_logged_this_month: number;
  ocr_scans_used_this_month: number;
  pdf_receipts_used_this_month: number;
  ceo_reports_used_this_month: number;
  voiceNotes: boolean;
  watermark: 'full' | 'subtle' | 'none';
  /** 'mini' = ~10-second preview video (cheaper to make); 'full' = the 15–18 second HD ad. */
  videoLength: 'mini' | 'full';
  themes: boolean;
  dailyCheckin: boolean;
  inflationShield: boolean;
  /** Quotes get a validity window ("price held for 3 days") + expiry nudges. Free plans still get a branded quote, with no expiry. */
  quoteExpiry: boolean;
  outboundCeoTemplate: boolean;
  maxStaff: number;
  sheetsSync: boolean;
}

export const PLANS: Record<Tier, PlanCaps> = {
  trial: {
    videos_used_this_month: 3, tx_logged_this_month: 20, ocr_scans_used_this_month: 10, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: 1,
    voiceNotes: true, watermark: 'full', videoLength: 'mini', themes: true, dailyCheckin: true, inflationShield: true, quoteExpiry: true,
    outboundCeoTemplate: true, maxStaff: 0, sheetsSync: false,
  },
  free_limited: {
    videos_used_this_month: 1, tx_logged_this_month: 20, ocr_scans_used_this_month: 0, pdf_receipts_used_this_month: 3, ceo_reports_used_this_month: 0,
    voiceNotes: false, watermark: 'full', videoLength: 'mini', themes: false, dailyCheckin: true, inflationShield: false, quoteExpiry: false,
    outboundCeoTemplate: false, maxStaff: 0, sheetsSync: false,
  },
  starter_5k: {
    videos_used_this_month: 8, tx_logged_this_month: 250, ocr_scans_used_this_month: 150, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: -1,
    voiceNotes: true, watermark: 'subtle', videoLength: 'full', themes: true, dailyCheckin: true, inflationShield: true, quoteExpiry: true,
    outboundCeoTemplate: true, maxStaff: 0, sheetsSync: false,
  },
  growth_15k: {
    videos_used_this_month: 30, tx_logged_this_month: -1, ocr_scans_used_this_month: 500, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: -1,
    voiceNotes: true, watermark: 'none', videoLength: 'full', themes: true, dailyCheckin: true, inflationShield: true, quoteExpiry: true,
    outboundCeoTemplate: true, maxStaff: 10, sheetsSync: true,
  },
};

/** Business-advice chat on WhatsApp: replies per owner per day (keeps AI cost predictable; deeper help lives in the web advisor). */
export const ADVICE_PER_DAY = 20;

/** Free trial length. Applied when a business is created (the SQL column default of 7 days is overridden in code). */
export const TRIAL_DAYS = 14;

/** Mini preview video: ~10 s, at most 3 photos, ~13-word script. Fewer image-model calls + a shorter voiceover + a faster render = a fraction of the cost. */
export const MINI_VIDEO = { maxPhotos: 3, minSeconds: 8, maxSeconds: 12, words: '12–15' } as const;

export const PRICES_NGN = {
  starter_5k: { monthly: 5_000, annual: 50_000 },
  growth_15k: { monthly: 15_000, annual: 150_000 },
} as const;

/**
 * Included videos a shop can make per day. Applies to videos that come with the plan; a bought video credit is never blocked by it
 * (someone who pays for a video should get it). Protects the AI bill from one afternoon of regenerating.
 */
export const VIDEOS_PER_DAY = 2;

/** Pay-as-you-go extra videos. Each credit = one full 15–18 s HD video (3 photos), with the small watermark. Works on trial and paid plans. */
export const VIDEO_CREDIT_PACKS = {
  BUYV1: { qty: 1, ngn: 500, label: '1 video · ₦500' },
  BUYV3: { qty: 3, ngn: 1_200, label: '3 videos · ₦1,200' },
} as const;
export type VideoPackId = keyof typeof VIDEO_CREDIT_PACKS;
export const packByQty = (qty: number) => Object.values(VIDEO_CREDIT_PACKS).find((p) => p.qty === qty) ?? null;

export const METRIC_LABEL: Record<Metric, string> = {
  videos_used_this_month: 'sales videos',
  tx_logged_this_month: 'logged messages',
  ocr_scans_used_this_month: 'alert/receipt scans',
  pdf_receipts_used_this_month: 'PDF receipts',
  ceo_reports_used_this_month: 'CEO reports',
};

/**
 * Referral wallet rules — single source for the bot (the web app mirrors these in web/src/lib/referral.ts; a test keeps all
 * copies in sync, including the numbers hard-coded in supabase/migrations/009_referral_v2.sql).
 *
 * v2: ONLY the referrer is paid (the new shop gets its free trial; paying both sides doubled the cost and invited fake accounts),
 * the reward scales with the plan the referred shop buys, and one referral is enough to cash out.
 */
export const REFERRAL = {
  /** Paid to the REFERRER when the referred business makes its first paid subscription, by the plan it bought. */
  REWARD_BY_TIER: { starter_5k: 1000, growth_15k: 3000 },
  /** The Starter amount: the headline number we quote ("get ₦1,000 for every shop you bring"). */
  REWARD_NGN: 1000,
  /** Wallet money can discount the owner's own renewal, but only if they choose that (USE CREDIT). Cash is the default. */
  DISCOUNT_MIN_NGN: 1000,
  /** Cash payout unlocks here: one Starter referral. */
  WITHDRAW_MIN_NGN: 1000,
} as const;
export const rewardForTier = (tier: string): number => (REFERRAL.REWARD_BY_TIER as Record<string, number>)[tier] ?? 0;
export const WITHDRAW_MIN_REFERRALS = REFERRAL.WITHDRAW_MIN_NGN / REFERRAL.REWARD_NGN;
