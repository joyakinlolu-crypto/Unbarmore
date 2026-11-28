import { describe, expect, it } from 'vitest';
import { completenessLine } from '../lib/completeness.js';
import { followupDue, followupQuestion, isVideoResult, resultAnswer } from '../lib/videoResults.js';

describe('how complete is this number?', () => {
  const base = { txCount: 6, revenue: 100000, unpriced: 0, daysWithEntries: 1, daysInPeriod: 1 };
  it('says nothing when there are no records', () => expect(completenessLine({ ...base, txCount: 0 })).toBeNull());
  it('a single day says how many records it rests on', () => {
    expect(completenessLine(base)).toMatch(/based on 6 records you logged/);
    expect(completenessLine({ ...base, txCount: 1 })).toMatch(/1 record you logged/);
  });
  it('a week with missing days warns it may be low', () => {
    const t = completenessLine({ ...base, daysWithEntries: 4, daysInPeriod: 6 })!;
    expect(t).toMatch(/4 of 6 days/); expect(t).toMatch(/may be low/);
  });
  it('a full week is reassuring', () => expect(completenessLine({ ...base, daysWithEntries: 6, daysInPeriod: 6 })).toMatch(/all 6 days ✅/));
  it('reports cost-price coverage when some sales have no cost', () => expect(completenessLine({ ...base, unpriced: 30000 })).toMatch(/70% of your sales/));
  it('never claims more than 100% or less than 0%', () => {
    expect(completenessLine({ ...base, unpriced: 300000 })).toMatch(/0% of your sales/);
  });
});

describe('did this video bring a customer?', () => {
  const now = Date.parse('2026-12-10T08:00:00Z'), ago = (d: number) => new Date(now - d * 86_400_000).toISOString();
  it('is asked only 3 to 10 days after the video', () => {
    expect(followupDue(ago(1), now)).toBe(false);
    expect(followupDue(ago(3), now)).toBe(true);
    expect(followupDue(ago(9), now)).toBe(true);
    expect(followupDue(ago(12), now)).toBe(false);
  });
  it('names the product and the age', () => expect(followupQuestion('Ankara gown', ago(3), now).join(' ')).toMatch(/3 days ago.*Ankara gown/));
  it('accepts exactly three answers', () => {
    expect(['yes', 'no', 'unposted'].every(isVideoResult)).toBe(true);
    expect(isVideoResult('maybe')).toBe(false);
  });
  it('every answer gets a useful reply', () => {
    for (const r of ['yes', 'no', 'unposted'] as const) expect(resultAnswer(r).join(' ').length).toBeGreaterThan(20);
    expect(resultAnswer('no').join(' ')).toMatch(/WIN BACK/);
  });
});
