import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

import { PLANS } from '../config/plans.js';
import { PLAYS, blackFridayDay, easterSunday, monthNudge, movableNotes, parseCalendarCommand } from '../lib/calendar.js';
import { calendarReply, monthText, yearText } from '../flows/calendar.js';
import type { Actor } from '../db/supabase.js';

const actor = (tier: string) => ({ phone: '2349000000401', business: { name: 'Ada Fabrics', subscription_tier: tier } }) as unknown as Actor;
const body = (r: unknown) => JSON.stringify(r);

describe('marketing calendar content', () => {
  it('has all 12 months, each with things to do now, things to prepare and a message', () => {
    expect(PLAYS).toHaveLength(12);
    for (const p of PLAYS) {
      expect(p.now.length).toBeGreaterThanOrEqual(2);
      expect(p.next.length).toBeGreaterThanOrEqual(1);
      expect(p.message('Ada Fabrics')).toMatch(/Ada Fabrics/);
    }
  });
  it('every month fits comfortably in one WhatsApp message', () => {
    for (let m = 1; m <= 12; m++) expect(monthText(m, 2027, 'Ada Fabrics').join('\n').length).toBeLessThan(2500);
  });
  it('computes Easter and Black Friday instead of guessing', () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
    expect(easterSunday(2028)).toEqual({ month: 4, day: 16 });
    expect(blackFridayDay(2026)).toBe(27);
    expect(blackFridayDay(2027)).toBe(26);
  });
  it('says Easter and Eid dates must be confirmed or are computed, by month', () => {
    expect(movableNotes(3, 2027).join(' ')).toMatch(/Easter Sunday is 28 March 2027/);
    expect(movableNotes(2, 2027).join(' ')).toMatch(/next month/);
    expect(movableNotes(3, 2027).join(' ')).toMatch(/Eid al-Fitr.*confirm/i);
    expect(movableNotes(11, 2026).join(' ')).toMatch(/Black Friday is 27 November 2026/);
    expect(movableNotes(6, 2027)).toEqual([]);
  });
  it('the December plan tells owners to collect debts before the 20th', () => expect(PLAYS[11]!.now.join(' ')).toMatch(/before about the 20th/));
});

describe('CALENDAR command', () => {
  it('parses the ways people ask', () => {
    expect(parseCalendarCommand('CALENDAR')).toEqual({ kind: 'now' });
    expect(parseCalendarCommand('MARKETING CALENDAR')).toEqual({ kind: 'now' });
    expect(parseCalendarCommand('CALENDAR YEAR')).toEqual({ kind: 'year' });
    expect(parseCalendarCommand('CALENDAR MARCH')).toEqual({ kind: 'month', month: 3 });
    expect(parseCalendarCommand('CALENDAR DEC')).toEqual({ kind: 'month', month: 12 });
    expect(parseCalendarCommand('CALENDAR NEXT')).toEqual({ kind: 'month', month: -1 });
    expect(parseCalendarCommand('CALENDAR BANANA')).toBeNull();
    expect(parseCalendarCommand('MY CALENDAR INVITE')).toBeNull();
  });
  it('paid plans get the full month; the free plan gets a teaser and the plans pointer', () => {
    expect(body(calendarReply(actor('starter_5k'), { kind: 'month', month: 12 }))).toMatch(/Prepare for January/);
    const free = body(calendarReply(actor('free_limited'), { kind: 'month', month: 12 }));
    expect(free).toMatch(/Starter/); expect(free).not.toMatch(/Do now/);
  });
  it('plan flags: trial, Starter and Growth have it, free does not', () => {
    expect([PLANS.trial, PLANS.starter_5k, PLANS.growth_15k].every((p) => p.marketingCalendar)).toBe(true);
    expect(PLANS.free_limited.marketingCalendar).toBe(false);
  });
  it('year view has a heading, 12 months and a pointer', () => expect(yearText(2027)).toHaveLength(15));
  it('the 1st-of-month note names the month and points to CALENDAR', () => expect(monthNudge(1)).toMatch(/January plan.*CALENDAR/));
});
