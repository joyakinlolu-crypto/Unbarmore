import { describe, expect, it } from 'vitest';
import { FOUNDING, foundingPrice, foundingUntilFrom, marginAlarms, marginTableText, paystackFee, planMargin } from '../lib/pricing.js';

describe('founding price', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  it('applies only while the window is open', () => {
    expect(foundingPrice({ founding_price_ngn: 10000, founding_until: '2027-06-01T00:00:00Z' }, now)).toBe(10000);
    expect(foundingPrice({ founding_price_ngn: 10000, founding_until: '2026-11-01T00:00:00Z' }, now)).toBeNull();
    expect(foundingPrice({}, now)).toBeNull();
  });
  it('locks for 12 months', () => {
    expect(foundingUntilFrom(now).slice(0, 10)).toBe('2027-12-01');
    expect(FOUNDING.SLOTS).toBe(20);
  });
});

describe('plan margins', () => {
  it('matches the numbers we quoted at 2,000 naira to the dollar', () => {
    const g = planMargin('growth_15k', 2000), s = planMargin('starter_5k', 2000);
    expect(g.aiWorst).toBe(8100);
    expect(s.aiWorst).toBe(2160);
    expect(g.worstShare).toBeGreaterThan(0.5);
    expect(s.worstShare).toBeLessThan(0.5);
  });
  it('alarms only when worst-case AI cost passes half the price', () => {
    expect(marginAlarms(1500)).toEqual([]);
    expect(marginAlarms(2000).map((a) => a.plan)).toEqual(['growth_15k']);
  });
  it('founding price lowers what Growth keeps', () => {
    expect(planMargin('growth_15k', 2000, 10000).keepWorst).toBeLessThan(planMargin('growth_15k', 2000).keepWorst);
  });
  it('fee is capped and the table prints every rate', () => {
    expect(paystackFee(15000)).toBe(325);
    expect(paystackFee(1_000_000)).toBe(2000);
    const t = marginTableText([1500, 2000], 2000).join('\n');
    expect(t).toMatch(/₦1,500\/\$/); expect(t).toMatch(/▶ ₦2,000\/\$/);
  });
});
