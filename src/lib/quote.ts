import { ngn } from './money.js';

/**
 * Quotes (branded quotations / invoices). The money rules live here, pure, so they are unit-tested:
 *  - a quote is a PROMISE, not a sale: nothing is counted until the owner says it was paid
 *  - free plans get a quote with no expiry; Starter/Growth/trial get a validity window ("price held for 3 days")
 *  - inflation is why the window exists: a Nigerian price quoted today may be wrong next week
 */
export interface QuoteLine { item: string; qty: number; unit: number }

export const DEFAULT_VALID_DAYS = 3;
export const MAX_VALID_DAYS = 90;

export const lineTotal = (l: QuoteLine) => Math.round(l.qty * l.unit);
export const quoteTotal = (lines: QuoteLine[], deliveryFee = 0) => lines.reduce((a, l) => a + lineTotal(l), 0) + Math.max(0, deliveryFee);
export const quoteLabel = (no: number) => `Q-${String(no).padStart(3, '0')}`;

const DAY = 86_400_000;
const ymdMs = (ymd: string) => Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
const msYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Last day the price holds, counting `days` from today (Lagos date). */
export const validUntil = (todayYmd: string, days: number) => msYmd(ymdMs(todayYmd) + Math.min(MAX_VALID_DAYS, Math.max(1, Math.round(days))) * DAY);

/** Extending an expired quote starts from today; extending a live one adds to its current end date. */
export const extendedUntil = (current: string | null, todayYmd: string, days: number) => {
  const base = current && ymdMs(current) >= ymdMs(todayYmd) ? current.slice(0, 10) : todayYmd;
  return validUntil(base, days);
};

/** Days left: 0 = last day is today, 1 = tomorrow, -1 = expired yesterday. null = no expiry. */
export const daysLeft = (until: string | null, todayYmd: string): number | null => (until ? Math.round((ymdMs(until) - ymdMs(todayYmd)) / DAY) : null);

export function expiryPhrase(left: number | null): string {
  if (left === null) return 'no expiry';
  if (left < -1) return `expired ${-left} days ago`;
  if (left === -1) return 'expired yesterday';
  if (left === 0) return 'expires today';
  if (left === 1) return 'expires tomorrow';
  return `${left} days left`;
}

export const dateLabel = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Q-014 PAID", "q14 paid cash", "Q-014 extend 7", "quote 14 cancel". null = not a quote command. */
export type QuoteCommand = { no: number; action: 'paid'; method: 'cash' | 'transfer' | 'pos' | null } | { no: number; action: 'extend'; days: number } | { no: number; action: 'cancel' };
export function parseQuoteCommand(text: string): QuoteCommand | null {
  const m = text.trim().match(/^(?:quote\s*#?|q\s*-?\s*#?)\s*0*(\d{1,5})\s+(paid|extend|cancel)(?:\s+(.+))?$/i);
  if (!m) return null;
  const no = Number(m[1]), action = m[2]!.toLowerCase(), rest = (m[3] ?? '').trim().toLowerCase();
  if (action === 'cancel') return rest ? null : { no, action: 'cancel' };
  if (action === 'paid') {
    if (!rest) return { no, action: 'paid', method: null };
    const method = /^(cash)$/.test(rest) ? 'cash' : /^(transfer|bank|bank transfer)$/.test(rest) ? 'transfer' : /^(pos)$/.test(rest) ? 'pos' : undefined;
    return method ? { no, action: 'paid', method } : null;
  }
  const d = rest.match(/^(\d{1,3})(?:\s*days?)?$/);
  return d ? { no, action: 'extend', days: Math.min(MAX_VALID_DAYS, Math.max(1, Number(d[1]))) } : rest ? null : { no, action: 'extend', days: DEFAULT_VALID_DAYS };
}

/** Owner's own sentence about their bank account: "MY ACCOUNT GTBank 0123456789 Ada Fabrics". `show` = just asked to see it. */
export function parsePayDetailsCommand(text: string): { text: string } | 'show' | null {
  const m = text.trim().match(/^(?:my account|account details|pay details|bank details)\b\s*[:=-]?\s*(.*)$/i);
  if (!m) return null;
  const rest = m[1]!.trim().replace(/\s+/g, ' ');
  return rest ? { text: rest.slice(0, 160) } : 'show';
}

export function quoteSummaryLines(no: number, customer: string | null, lines: QuoteLine[], delivery: number, total: number): string[] {
  return [
    `📄 *${quoteLabel(no)}*${customer ? ` for *${customer}*` : ''}`,
    ...lines.map((l) => `• ${l.qty} × ${l.item}: ${ngn(lineTotal(l))}`),
    delivery > 0 ? `• Delivery: ${ngn(delivery)}` : '',
    `*Total ${ngn(total)}*`,
  ].filter(Boolean);
}
