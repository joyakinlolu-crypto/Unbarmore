import { ngn } from './money.js';

/** "COUNT 85000", "count 85,000", "counted cash ₦85k", "count 1.2m". null = not a count. Whole naira only. */
export function parseCount(text: string): number | null {
  const m = text.trim().match(/^count(?:ed)?(?:\s+cash)?(?:\s+is|\s*[:=])?\s*(?:₦|n(?=\d)|ngn\s*)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?$/i);
  if (!m) return null;
  const base = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const v = Math.round(base * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1000 : 1));
  return v >= 0 && v <= 1_000_000_000 ? v : null;
}

export const TOLERANCE_NGN = 100; // coins and rounding: not worth a worry

export interface CountFacts {
  counted: number; expected: number | null; variance: number | null;
  /** entries with no payment method since the last count (their cash is unknown, so they can explain a gap) */
  unspecified: number;
  /** total shortage over the last 7 days, naira (positive = money missing), and how many counts that covers */
  weekShort: number; weekCounts: number;
}

/** Pure: the message after a count. */
export function countText(f: CountFacts): string[] {
  if (f.expected === null || f.variance === null) {
    return [
      `📝 Counted: *${ngn(f.counted)}*. I'll use this as your starting cash.`,
      'Tomorrow evening, count again and send *COUNT <amount>*. I\'ll tell you if the drawer is short or over, and by how much.',
    ];
  }
  const v = f.variance;
  const head = Math.abs(v) <= TOLERANCE_NGN
    ? `✅ *Your cash matches.* Counted ${ngn(f.counted)}, expected ${ngn(f.expected)}.`
    : v < 0
      ? `⚠️ *${ngn(-v)} is missing.* Counted ${ngn(f.counted)}, expected ${ngn(f.expected)}.`
      : `❓ *${ngn(v)} more than expected.* Counted ${ngn(f.counted)}, expected ${ngn(f.expected)}.`;
  const why = Math.abs(v) <= TOLERANCE_NGN ? [] : v < 0
    ? ['Where could it have gone? An expense or change you didn\'t tell me, a sale paid in cash but not logged, or money taken out for yourself. Tell me what you remember and I\'ll record it.']
    : ['A sale or a debt payment in cash that was never logged? Tell me and I\'ll add it.'];
  const unspec = f.unspecified > 0 ? [`${f.unspecified} recent entr${f.unspecified === 1 ? 'y has' : 'ies have'} no payment method, so I couldn't tell cash from transfer. Say "cash" or "transfer" next time.`] : [];
  const week = f.weekShort > TOLERANCE_NGN && f.weekCounts >= 2 ? [`📉 Over the last 7 days, ${ngn(f.weekShort)} has gone missing across ${f.weekCounts} counts.`] : [];
  return [head, ...why, ...unspec, ...week];
}
