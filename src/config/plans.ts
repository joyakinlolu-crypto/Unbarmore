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
  themes: boolean;
  dailyCheckin: boolean;
  inflationShield: boolean;
  outboundCeoTemplate: boolean;
  maxStaff: number;
  sheetsSync: boolean;
}

export const PLANS: Record<Tier, PlanCaps> = {
  trial: {
    videos_used_this_month: 2, tx_logged_this_month: 20, ocr_scans_used_this_month: 10, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: 1,
    voiceNotes: true, watermark: 'full', themes: true, dailyCheckin: true, inflationShield: true,
    outboundCeoTemplate: true, maxStaff: 0, sheetsSync: false,
  },
  free_limited: {
    videos_used_this_month: 1, tx_logged_this_month: 20, ocr_scans_used_this_month: 0, pdf_receipts_used_this_month: 3, ceo_reports_used_this_month: 0,
    voiceNotes: false, watermark: 'full', themes: false, dailyCheckin: true, inflationShield: false,
    outboundCeoTemplate: false, maxStaff: 0, sheetsSync: false,
  },
  starter_5k: {
    videos_used_this_month: 15, tx_logged_this_month: 250, ocr_scans_used_this_month: 150, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: -1,
    voiceNotes: true, watermark: 'subtle', themes: true, dailyCheckin: true, inflationShield: true,
    outboundCeoTemplate: true, maxStaff: 0, sheetsSync: false,
  },
  growth_15k: {
    videos_used_this_month: 50, tx_logged_this_month: -1, ocr_scans_used_this_month: 500, pdf_receipts_used_this_month: -1, ceo_reports_used_this_month: -1,
    voiceNotes: true, watermark: 'none', themes: true, dailyCheckin: true, inflationShield: true,
    outboundCeoTemplate: true, maxStaff: 10, sheetsSync: true,
  },
};

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
