import { describe, expect, it } from 'vitest';
import { buildScorecard, HABIT_DAYS, scorecardText, shopStatus, type ShopFacts } from '../lib/scorecard.js';

const NOW = Date.parse('2026-12-01T12:00:00Z');
const shop = (o: Partial<ShopFacts> = {}): ShopFacts => ({
  name: 'Ada Fabrics', tier: 'trial', ageDays: 10, createdAt: '2026-11-21T09:00:00Z', firstEntryAt: '2026-11-21T10:30:00Z', lastInboundAt: '2026-12-01T08:00:00Z',
  activeDates: ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-30'], entries: 20, revenueNgn: 300_000, debtOpenNgn: 50_000, debtCollectedNgn: 14_000,
  costPricesSet: true, receipts: 3, videos: 1, quotes: 0, counts: 0, openedApp: true, aiCostNgn: 120, ...o,
});

describe('shop status', () => {
  it('habit = active on 4+ days; trying = 1–3; went quiet = started but 0 this week; never started; new today', () => {
    expect(HABIT_DAYS).toBe(4);
    expect(shopStatus({ ageDays: 10, firstEntryAt: 'x', active: 4 })).toBe('habit');
    expect(shopStatus({ ageDays: 10, firstEntryAt: 'x', active: 3 })).toBe('trying');
    expect(shopStatus({ ageDays: 10, firstEntryAt: 'x', active: 0 })).toBe('stalled');
    expect(shopStatus({ ageDays: 6, firstEntryAt: null, active: 0 })).toBe('never_started');
    expect(shopStatus({ ageDays: 0, firstEntryAt: null, active: 0 })).toBe('new');
  });
  it('a brand-new shop that already logged something is judged, not "new"', () => { expect(shopStatus({ ageDays: 0, firstEntryAt: 'x', active: 1 })).toBe('trying'); });
});

describe('cohort numbers', () => {
  const facts = [
    shop({ name: 'A' }),                                                                                                                       // habit
    shop({ name: 'B', activeDates: ['2026-11-30'], entries: 2, costPricesSet: false, openedApp: false }),                                      // trying
    shop({ name: 'C', activeDates: [], entries: 0, lastInboundAt: '2026-11-22T08:00:00Z' }),                                                   // went quiet
    shop({ name: 'D', firstEntryAt: null, activeDates: [], entries: 0, costPricesSet: false, openedApp: false, lastInboundAt: null, ageDays: 5, debtOpenNgn: 0, debtCollectedNgn: 0, revenueNgn: 0, aiCostNgn: 5 }),  // never started
    shop({ name: 'E', ageDays: 0, firstEntryAt: null, activeDates: [], entries: 0, createdAt: '2026-12-01T09:00:00Z', lastInboundAt: null }),   // new today
  ];
  const { rows, cohort: c } = buildScorecard(facts, NOW);
  it('counts every status; shops under a day old are not held against the rates', () => {
    expect(c.counts).toEqual({ habit: 1, trying: 1, stalled: 1, never_started: 1, new: 1 });
    expect(c.shops).toBe(5);
    expect(c.habitPct).toBe(25); expect(c.activatedPct).toBe(75);                     // 1/4 and 3/4 of the 4 judged shops
  });
  it('hours to first entry, last seen, totals and AI cost per active shop', () => {
    const a = rows.find((r) => r.name === 'A')!;
    expect(a.hoursToFirst).toBe(2); expect(a.hoursSinceSeen).toBe(4);
    expect(c.fastActivationPct).toBe(75); expect(c.entries).toBe(22); expect(c.debtCollectedNgn).toBe(14_000 * 4);
    expect(c.aiCostNgn).toBe(120 * 4 + 5); expect(c.aiCostPerActiveNgn).toBe(Math.round((120 * 4 + 5) / 2));   // only A and B were active
    expect(c.costPricePct).toBe(50);
  });
  it('sorted by days active, then entries', () => { expect(rows.map((r) => r.name).slice(0, 2)).toEqual(['A', 'B']); });
});

describe('the verdict (what decides card payments and tiers)', () => {
  const many = (n: number, habit: number, age = 10) => Array.from({ length: n }, (_, i) => shop({ name: `S${i}`, ageDays: age, activeDates: i < habit ? ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-30'] : ['2026-11-30'] }));
  it('waits while there are too few or too young shops', () => {
    expect(buildScorecard(many(3, 3), NOW).cohort.verdict.level).toBe('wait');
    expect(buildScorecard(many(8, 8, 2), NOW).cohort.verdict.level).toBe('wait');
  });
  it('green at half or more, amber at a quarter, red below', () => {
    expect(buildScorecard(many(8, 4), NOW).cohort.verdict.level).toBe('green');
    expect(buildScorecard(many(8, 2), NOW).cohort.verdict.level).toBe('amber');
    expect(buildScorecard(many(8, 1), NOW).cohort.verdict.level).toBe('red');
  });
  it('the verdict says what to do in plain words', () => {
    expect(buildScorecard(many(8, 4), NOW).cohort.verdict.text).toContain('safe to switch on card payments');
    expect(buildScorecard(many(8, 1), NOW).cohort.verdict.text).toContain('Fix the first-week experience');
  });
});

describe('the WhatsApp text', () => {
  it('verdict first, one line per shop, readable, and always under WhatsApp\'s size limit even with 60 shops', () => {
    const t = scorecardText(buildScorecard([shop({ name: 'Ada Fabrics', quotes: 2, counts: 3 }), shop({ name: 'Kalu', costPricesSet: false, firstEntryAt: null, activeDates: [], entries: 0, lastInboundAt: null, ageDays: 4 })], NOW), 7).join('\n');
    expect(t.indexOf('Pilot scorecard')).toBeLessThan(t.indexOf('Shops:'));
    for (const s of ['4/7 days', '20 entries', 'collected ₦14,000', '3 receipts', '2 invoices', '3 counts', 'never started', 'No cost prices', 'never seen', 'seen 4h ago']) expect(t).toContain(s);
    const big = scorecardText(buildScorecard(Array.from({ length: 60 }, (_, i) => shop({ name: `Shop number ${i} with a fairly long business name`, quotes: 5, counts: 5 })), NOW), 7).join('\n');
    expect(big.length).toBeLessThan(4000); expect(big).toContain('and 45 more');
  });
});
