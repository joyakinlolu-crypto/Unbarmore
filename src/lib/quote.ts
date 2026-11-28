import { ngn } from './money.js';

/**
 * Invoices (what Nigerian shops call a quotation: "this is what it will cost, valid for this long"). Stored as `quotes`. The money rules live here, pure, so they are unit-tested:
 *  - an invoice is a PROMISE, not a sale: nothing is counted until the owner says it was paid
 *  - free plans get an invoice with no expiry; Starter/Growth/trial get a validity window ("price held for 3 days")
 *  - inflation is why the window exists: a Nigerian price given today may be wrong next week
 */
export interface QuoteLine { item: string; qty: number; unit: number; /** colour, size, note */ detail?: string }

/** Colour / size / note for one line: trimmed, no brackets (they delimit it), short enough for a receipt. '' when empty. */
export const cleanDetail = (d: string | undefined | null): string => (d ?? '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

export const DEFAULT_VALID_DAYS = 3;
export const MAX_VALID_DAYS = 90;

export const lineTotal = (l: QuoteLine) => Math.round(l.qty * l.unit);
export const quoteTotal = (lines: QuoteLine[], deliveryFee = 0) => lines.reduce((a, l) => a + lineTotal(l), 0) + Math.max(0, deliveryFee);
export const quoteLabel = (no: number) => `INV-${String(no).padStart(3, '0')}`;

const DAY = 86_400_000;
const ymdMs = (ymd: string) => Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
const msYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Last day the price holds, counting `days` from today (Lagos date). */
export const validUntil = (todayYmd: string, days: number) => msYmd(ymdMs(todayYmd) + Math.min(MAX_VALID_DAYS, Math.max(1, Math.round(days))) * DAY);

/** Extending an expired invoice starts from today; extending a live one adds to its current end date. */
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

/** "INV-014 PAID", "invoice 14 paid cash", "inv14 paid 50k transfer", "INV-014 extend 7", and the older "Q-014 PAID" / "quote 14 cancel". null = not an invoice command. */
export type QuoteCommand =
  | { no: number; action: 'paid'; method: 'cash' | 'transfer' | 'pos' | null; amount: number | null }
  | { no: number; action: 'extend'; days: number }
  | { no: number; action: 'cancel' };

/** "50k", "50,000", "₦50000", "1.2m" → whole naira. null = not an amount. */
export function parseMoneyToken(raw: string): number | null {
  const m = raw.trim().match(/^(?:₦|n(?=\d)|ngn\s*)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?$/i);
  if (!m) return null;
  const v = Math.round(Number(m[1]!.replace(/,/g, '')) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1000 : 1));
  return Number.isFinite(v) && v > 0 && v <= 1_000_000_000 ? v : null;
}

export function parseQuoteCommand(text: string): QuoteCommand | null {
  const m = text.trim().match(/^(?:invoice|inv|quote|q)\s*-?\s*#?\s*0*(\d{1,5})\s+(paid|extend|cancel)(?:\s+(.+))?$/i);
  if (!m) return null;
  const no = Number(m[1]), action = m[2]!.toLowerCase(), rest = (m[3] ?? '').trim().toLowerCase();
  if (action === 'cancel') return rest ? null : { no, action: 'cancel' };
  if (action === 'paid') {
    // any order: an amount ("50k") and/or how it was paid ("cash", "transfer", "pos")
    let method: 'cash' | 'transfer' | 'pos' | null = null, amount: number | null = null;
    const words = rest.replace(/\bbank transfer\b/g, 'transfer').split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (w === 'cash' || w === 'transfer' || w === 'bank' || w === 'pos') { if (method) return null; method = w === 'cash' ? 'cash' : w === 'pos' ? 'pos' : 'transfer'; continue; }
      const v = parseMoneyToken(w); if (v === null || amount !== null) return null; amount = v;
    }
    return { no, action: 'paid', method, amount };
  }
  const d = rest.match(/^(\d{1,3})(?:\s*days?)?$/);
  return d ? { no, action: 'extend', days: Math.min(MAX_VALID_DAYS, Math.max(1, Number(d[1]))) } : rest ? null : { no, action: 'extend', days: DEFAULT_VALID_DAYS };
}

// ───────────── Payment plan on an invoice ─────────────

export interface PlanInstalment { no: number; amount: number; due: string; label: string }
export interface PlanRequest { instalments: { percent?: number; amount_ngn?: number; due_in_days?: number; label?: string }[] }
export const MAX_INSTALMENTS = 6, MAX_PLAN_DAYS = 365, DEFAULT_GAP_DAYS = 14;

const addDays = (ymd: string, n: number) => msYmd(ymdMs(ymd) + n * DAY);

/**
 * Turn what the owner said ("50% now, the rest in 2 weeks") into dated instalments that add up to the invoice total EXACTLY:
 * the last instalment is always the remainder, so rounding can never leave a kobo unaccounted for.
 * null = not a usable plan (fewer than 2 instalments, a zero or negative amount, earlier instalments already above the total).
 */
export function buildPlan(total: number, req: PlanRequest | undefined | null, today: string): PlanInstalment[] | null {
  const ins = req?.instalments?.slice(0, MAX_INSTALMENTS) ?? [];
  if (ins.length < 2 || !(total > 0)) return null;
  const out: PlanInstalment[] = [];
  let paid = 0, prevDays = -1;
  for (const [i, x] of ins.entries()) {
    const last = i === ins.length - 1;
    const amount = last ? total - paid : Math.round(x.amount_ngn ?? (x.percent ? (total * x.percent) / 100 : 0));
    if (!(amount > 0) || (!last && paid + amount >= total)) return null;
    const days = Math.min(MAX_PLAN_DAYS, Math.max(0, Math.round(x.due_in_days ?? (i === 0 ? 0 : prevDays + DEFAULT_GAP_DAYS))));
    if (days < prevDays) return null;
    prevDays = days; paid += amount;
    const label = (x.label ?? '').replace(/[^\p{L}\p{N} .,'&-]/gu, '').trim().slice(0, 24) || (i === 0 && days === 0 ? 'Deposit' : last ? 'Balance' : `Instalment ${i + 1}`);
    out.push({ no: i + 1, amount, due: addDays(today, days), label });
  }
  return out;
}

/** "Deposit ₦53,500 (on issue) · Balance ₦53,500 by Sat 12 Dec" for the WhatsApp message and the PDF. */
export function planLine(p: PlanInstalment, issued: string): string {
  return `${p.label}: ${ngn(p.amount)} ${p.due === issued ? 'on issue' : `by ${dateLabel(p.due)}`}`;
}

/** After `paid` naira has been received, when is the next instalment due? null = the plan is fully covered. */
export function nextDueAfterPaid(plan: PlanInstalment[], paid: number): string | null {
  let covered = 0;
  for (const p of plan) { covered += p.amount; if (covered > paid) return p.due; }
  return null;
}

/** "MY ADDRESS 12 Bode Street, Ibadan". `show` = just asked to see it. */
export function parseAddressCommand(text: string): { text: string } | 'show' | null {
  const m = text.trim().match(/^(?:my address|business address|shop address)\b\s*[:=-]?\s*(.*)$/i);
  if (!m) return null;
  const rest = m[1]!.trim().replace(/\s+/g, ' ');
  return rest ? { text: rest.slice(0, 120) } : 'show';
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
    ...lines.map((l) => `• ${l.qty} × ${l.item}${l.detail ? ` (${l.detail})` : ''}: ${ngn(lineTotal(l))}`),
    delivery > 0 ? `• Delivery: ${ngn(delivery)}` : '',
    `*Total ${ngn(total)}*`,
  ].filter(Boolean);
}
