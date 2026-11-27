import { describe, expect, it } from 'vitest';
import { allocateVideo, type VideoDeps } from '../lib/videoAllocation.js';

/** A fake shop: monthly allowance, credits, and a today counter, behaving like the real atomic checks. */
function shop(o: { allowance: number; credits: number; today?: number; dailyLimit?: number }) {
  const s = { allowance: o.allowance, credits: o.credits, today: o.today ?? 0 };
  const deps: VideoDeps = {
    dailyLimit: o.dailyLimit ?? 2,
    usedToday: async () => s.today,
    consumeIncluded: async () => (s.allowance > 0 ? (s.allowance--, true) : false),
    countToday: async () => { s.today++; },
    consumeCredit: async () => (s.credits > 0 ? (s.credits--, true) : false),
  };
  return { s, deps, left: () => s.allowance > 0 };
}

describe('allocateVideo', () => {
  it('uses an included video first, and counts it against today', async () => {
    const x = shop({ allowance: 3, credits: 2 });
    expect(await allocateVideo(x.deps, x.left())).toEqual({ source: 'included' });
    expect(x.s).toMatchObject({ allowance: 2, credits: 2, today: 1 });
  });

  it('2 included videos a day: the 3rd the same day does NOT use the allowance, it uses a credit if there is one', async () => {
    const x = shop({ allowance: 8, credits: 1 });
    await allocateVideo(x.deps, true); await allocateVideo(x.deps, true);
    expect(x.s).toMatchObject({ allowance: 6, today: 2 });
    expect(await allocateVideo(x.deps, true)).toEqual({ source: 'credit' });
    expect(x.s).toMatchObject({ allowance: 6, credits: 0, today: 2 });  // allowance untouched: it keeps for tomorrow
  });

  it('daily limit with no credits → blocked for "daily" (come back tomorrow), allowance NOT burned', async () => {
    const x = shop({ allowance: 5, credits: 0, today: 2 });
    expect(await allocateVideo(x.deps, true)).toEqual({ source: 'none', reason: 'daily' });
    expect(x.s.allowance).toBe(5);
  });

  it('allowance used up, no credits → blocked for "allowance" (offer to buy)', async () => {
    const x = shop({ allowance: 0, credits: 0 });
    expect(await allocateVideo(x.deps, false)).toEqual({ source: 'none', reason: 'allowance' });
  });

  it('allowance used up but credits bought → a credit pays, even past the daily limit', async () => {
    const x = shop({ allowance: 0, credits: 5, today: 9 });
    for (let i = 0; i < 5; i++) expect(await allocateVideo(x.deps, false)).toEqual({ source: 'credit' });
    expect(await allocateVideo(x.deps, false)).toEqual({ source: 'none', reason: 'allowance' });
    expect(x.s.credits).toBe(0);
  });

  it('a trial shop: 3 included videos, 2 a day → day 1 gives 2, the 3rd waits for tomorrow (or ₦500)', async () => {
    const x = shop({ allowance: 3, credits: 0 });
    expect((await allocateVideo(x.deps, x.left())).source).toBe('included');
    expect((await allocateVideo(x.deps, x.left())).source).toBe('included');
    expect(await allocateVideo(x.deps, x.left())).toEqual({ source: 'none', reason: 'daily' });
    x.s.today = 0; // next day
    expect((await allocateVideo(x.deps, x.left())).source).toBe('included');
    expect(await allocateVideo(x.deps, x.left())).toEqual({ source: 'none', reason: 'allowance' });
  });
});
