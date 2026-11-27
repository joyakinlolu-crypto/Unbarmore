/**
 * When did the owner actually SEND a message?
 *
 * WhatsApp queues a message typed while offline and delivers it when data returns, so "sold 2 bags 30k" typed on Monday night can
 * reach us on Tuesday morning. Meta's webhook carries the original send time (unix seconds). Without this, that sale is dated
 * Tuesday and Monday's profit is wrong.
 *
 * Only trust a send time that is clearly in the past (not just a few seconds of network lag) and not absurdly old
 * (a replayed webhook from last month must never rewrite the books). Anything else = "now" (return null).
 */
export const LATE_AFTER_MS = 10 * 60_000;          // under 10 minutes is ordinary lag, keep "now"
export const MAX_BACKDATE_MS = 3 * 86_400_000;     // never back-date more than 3 days

export function occurredAt(timestampSec: string | number | undefined | null, now = Date.now()): string | null {
  const sec = Number(timestampSec);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const sent = sec * 1000;
  const age = now - sent;
  if (age < LATE_AFTER_MS || age > MAX_BACKDATE_MS) return null;
  return new Date(sent).toISOString();
}
