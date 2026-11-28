/**
 * "How much should I trust this number?" A profit figure is only as good as what the owner logged. Rather than present every
 * figure as certain, say what it is based on, so one forgotten day doesn't make the owner distrust everything.
 * Pure: the database lookups live in flows/completeness.ts.
 */
export interface Completeness {
  /** Confirmed records in the period. */
  txCount: number;
  /** Sales in the period, and the part of it whose cost price we don't know. */
  revenue: number; unpriced: number;
  /** Lagos days in the period that have at least one record, out of the days elapsed so far. */
  daysWithEntries: number; daysInPeriod: number;
}

/** One short line, or null when there is nothing honest to say (no records at all). */
export function completenessLine(c: Completeness): string | null {
  if (c.txCount <= 0) return null;
  const parts: string[] = [];
  if (c.daysInPeriod <= 1) {
    parts.push(`based on ${c.txCount} record${c.txCount === 1 ? '' : 's'} you logged`);
  } else {
    const missing = c.daysInPeriod - c.daysWithEntries;
    parts.push(missing > 0
      ? `based on ${c.daysWithEntries} of ${c.daysInPeriod} days with records. A day with nothing logged counts as ₦0, so this may be low if you forgot some`
      : `based on records for all ${c.daysInPeriod} days ✅`);
  }
  if (c.revenue > 0 && c.unpriced > 0) {
    const pct = Math.max(0, Math.min(100, Math.round(((c.revenue - c.unpriced) / c.revenue) * 100)));
    parts.push(`cost prices known for ${pct}% of your sales`);
  }
  return `🧮 _This is ${parts.join(', and ')}._`;
}
