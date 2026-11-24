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
  outboundCeoTemplate: boolean;
  maxStaff: number;
  sheetsSync: boolean;
}

export const PLANS: Record<Tier, PlanCaps> = {
  trial: {
    videos_used_this_month: 5, tx_logged_this_month: 20, ocr_scans_used_this_month: 10, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: 1,
    voiceNotes: true, watermark: 'full', videoLength: 'mini', themes: true, dailyCheckin: true, inflationShield: true,
    outboundCeoTemplate: true, maxStaff: 0, sheetsSync: false,
  },
  free_limited: {
    videos_used_this_month: 1, tx_logged_this_month: 20, ocr_scans_used_this_month: 0, pdf_receipts_used_this_month: 3, ceo_reports_used_this_month: 0,
    voiceNotes: false, watermark: 'full', videoLength: 'mini', themes: false, dailyCheckin: true, inflationShield: false,
    outboundCeoTemplate: false, maxStaff: 0, sheetsSync: false,
  },
  starter_5k: {
    videos_used_this_month: 15, tx_logged_this_month: 250, ocr_scans_used_this_month: 150, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: -1,
    voiceNotes: true, watermark: 'subtle', videoLength: 'full', themes: true, dailyCheckin: true, inflationShield: true,
    outboundCeoTemplate: true, maxStaff: 0, sheetsSync: false,
  },
  growth_15k: {
    videos_used_this_month: 50, tx_logged_this_month: -1, ocr_scans_used_this_month: 500, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: -1,
    voiceNotes: true, watermark: 'none', videoLength: 'full', themes: true, dailyCheckin: true, inflationShield: true,
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

export const METRIC_LABEL: Record<Metric, string> = {
  videos_used_this_month: 'sales videos',
  tx_logged_this_month: 'logged messages',
  ocr_scans_used_this_month: 'alert/receipt scans',
  pdf_receipts_used_this_month: 'PDF receipts',
  ceo_reports_used_this_month: 'CEO reports',
};

/**
 * Referral wallet rules — single source for the bot (the web app mirrors these in web/src/lib/referral.ts; a test keeps all three in sync,
 * including the 5000 hard-coded in supabase/migrations/003_referral_payouts.sql).
 */
export const REFERRAL = {
  /** Credited to BOTH sides when a referred business makes its first paid subscription. */
  REWARD_NGN: 1000,
  /** Any wallet balance from here up automatically discounts the owner's own renewal. */
  DISCOUNT_MIN_NGN: 1000,
  /** Cash payout unlocks here: 5 paid referrals × ₦1,000. */
  WITHDRAW_MIN_NGN: 5000,
} as const;
export const WITHDRAW_MIN_REFERRALS = REFERRAL.WITHDRAW_MIN_NGN / REFERRAL.REWARD_NGN;
