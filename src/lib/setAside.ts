import { ngn } from './money.js';

/**
 * "Profit discipline": every evening, turn today's profit into the exact naira to move into three pots before the money
 * gets spent. Nigerian owners save, but from what is left after spending, and the shop's capital quietly leaks.
 *
 * The default favours the restock fund first because replacement stock costs more every month (inflation): an owner who
 * pays themselves from the stock money slowly runs out of shop. Pure arithmetic: costs nothing, no AI.
 * This is a saving habit, not tax advice; the "rent & tax" pot is a reserve, not a tax calculation.
 */
export interface Split { restock: number; reserve: number; pay: number }
export const DEFAULT_SPLIT: Split = { restock: 50, reserve: 20, pay: 30 };

export const splitToString = (s: Split) => `${s.restock}/${s.reserve}/${s.pay}`;

/** "50/20/30" (as stored) → Split. Anything malformed → the default. */
export function splitFromString(raw: string | null | undefined): Split {
  const m = raw?.match(/^(\d{1,3})\/(\d{1,3})\/(\d{1,3})$/);
  if (!m) return DEFAULT_SPLIT;
  const s = { restock: Number(m[1]), reserve: Number(m[2]), pay: Number(m[3]) };
  return s.restock + s.reserve + s.pay === 100 ? s : DEFAULT_SPLIT;
}

/** "SET ASIDE 50 20 30", "split 40/20/40", "my split 50-20-30". `null` = not that command, `'show'` = no numbers (just show it), `'bad'` = numbers that don't add to 100. */
export function parseSplitCommand(text: string): Split | 'show' | 'bad' | null {
  const t = text.trim();
  if (/^(?:set aside|my split|split|profit split)$/i.test(t)) return 'show';
  const m = t.match(/^(?:set aside|my split|split|profit split)\s*[:=]?\s*(\d{1,3})\s*(?:%|\/|-|,|\s)\s*(\d{1,3})\s*(?:%|\/|-|,|\s)\s*(\d{1,3})\s*%?$/i);
  if (!m) return null;
  const s = { restock: Number(m[1]), reserve: Number(m[2]), pay: Number(m[3]) };
  return s.restock + s.reserve + s.pay === 100 ? s : 'bad';
}

const MIN_PROFIT = 1000;                  // below this a split is just noise
const to100 = (n: number) => Math.round(n / 100) * 100;

/** Exact naira per pot. The first two round to ₦100 so they are easy to move; "pay yourself" takes the remainder so it always adds up. */
export function computeSetAside(profit: number, split: Split): { restock: number; reserve: number; pay: number } | null {
  if (!(profit >= MIN_PROFIT)) return null;
  const restock = to100(profit * split.restock / 100), reserve = to100(profit * split.reserve / 100);
  const pay = Math.max(0, profit - restock - reserve);
  return { restock, reserve, pay };
}

/**
 * The evening lines. Skipped (null) on a loss, a tiny profit, or when some sales have no cost price: setting money aside from an
 * overstated profit is worse than saying nothing, so we ask for the cost prices instead.
 */
export function setAsideText(profit: number, incomplete: boolean, split: Split): string[] | null {
  if (incomplete) return ['💼 *Set-aside:* add the cost price of what you sold (_lace costs me 15k_) and I\'ll tell you exactly how much to put away tonight.'];
  const a = computeSetAside(profit, split);
  if (!a) return null;
  return [
    `💼 *Move this from today's ${ngn(profit)} profit before you sleep:*`,
    `   📦 Restock fund: *${ngn(a.restock)}*`,
    `   🏠 Rent & tax reserve: *${ngn(a.reserve)}*`,
    `   🙋 Pay yourself: *${ngn(a.pay)}*`,
    `_Change the split: SET ASIDE ${splitToString(split)}. This is a saving habit, not tax advice._`,
  ];
}
