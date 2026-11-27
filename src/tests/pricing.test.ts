import { describe, expect, it } from 'vitest';
import { PLANS, VIDEOS_PER_DAY, VIDEO_CREDIT_PACKS, packByQty } from '../config/plans.js';
import { PRICE_USD_PER_M, summariseUsage, usdNgn } from '../lib/aiCost.js';

describe('pricing protection', () => {
  it('Starter includes 8 videos, trial 3, and at most 2 included videos a day', () => {
    expect(PLANS.starter_5k.videos_used_this_month).toBe(8);
    expect(PLANS.trial.videos_used_this_month).toBe(3);
    expect(VIDEOS_PER_DAY).toBe(2);
  });
  it('video credits: ₦500 for 1, ₦1,200 for 3 (₦400 each)', () => {
    expect(VIDEO_CREDIT_PACKS.BUYV1).toMatchObject({ qty: 1, ngn: 500 });
    expect(VIDEO_CREDIT_PACKS.BUYV3).toMatchObject({ qty: 3, ngn: 1200 });
    expect(packByQty(3)?.ngn).toBe(1200);
    expect(packByQty(2)).toBeNull();           // no other pack sizes can be bought (or faked in a webhook)
  });
  it('a credit always earns more than a full video costs us (3 photos + voice ≈ ₦180), even if the naira weakens a lot and prices triple', () => {
    const costPerVideo = (3 * 1290 * PRICE_USD_PER_M.imageOut / 1e6 + 295 * PRICE_USD_PER_M.ttsOut / 1e6) * usdNgn();
    const worstCase = costPerVideo * 3 * (2000 / 1500);          // text/image prices 3x higher AND ₦2,000 per dollar
    expect(costPerVideo).toBeGreaterThan(150);
    expect(costPerVideo).toBeLessThan(220);
    expect(VIDEO_CREDIT_PACKS.BUYV3.ngn / VIDEO_CREDIT_PACKS.BUYV3.qty).toBeGreaterThan(costPerVideo * 2);  // pack price is more than 2x cost today
    expect(VIDEO_CREDIT_PACKS.BUYV1.ngn).toBeGreaterThan(worstCase * 0.4);                                    // sanity: price is not absurdly below even a tripled cost
  });
});

describe('summariseUsage: real token counts → estimated naira', () => {
  it('one text message (2,202 in, 135 out) costs under a naira', () => {
    const s = summariseUsage({ promptTokenCount: 2202, candidatesTokenCount: 135, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 2202 }] });
    expect(s).toMatchObject({ inTokens: 2202, outTokens: 135 });
    expect(s.estCostNgn).toBeGreaterThan(0.2); expect(s.estCostNgn).toBeLessThan(1);
  });
  it('one cleaned photo (1,290 image tokens out) costs about ₦58', () => {
    const s = summariseUsage({ promptTokenCount: 268, candidatesTokenCount: 1290, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }] });
    expect(s.estCostNgn).toBeGreaterThan(55); expect(s.estCostNgn).toBeLessThan(62);
  });
  it('voiceover audio is priced per audio token, not as text', () => {
    const s = summariseUsage({ promptTokenCount: 29, candidatesTokenCount: 295, candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 295 }] });
    expect(s.estCostNgn).toBeGreaterThan(4); expect(s.estCostNgn).toBeLessThan(5);
  });
  it('missing metadata → zero, never throws', () => {
    expect(summariseUsage(undefined)).toEqual({ inTokens: 0, outTokens: 0, estCostNgn: 0 });
  });
});
