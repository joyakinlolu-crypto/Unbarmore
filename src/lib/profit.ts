import { ngn } from './money.js';

/**
 * What "profit" means in every message and report:
 *   profit = sales − cost of the goods sold − running costs
 * Stock BOUGHT is shown separately: it is stock on the shelf, not money lost.
 * If the cost price of some sold items isn't known, true profit is at most what we show, and we say so.
 *
 * `basis: 'cash'` is only used if the database hasn't been upgraded yet (migration 005): then the number is honestly
 * labelled "cash left", never "profit".
 */
export interface ProfitInput {
  revenue_ngn: number; expenses_ngn: number; restock_ngn: number; net_profit_ngn: number;
  cogs_ngn?: number; unpriced_revenue_ngn?: number;
}
export interface ProfitView {
  basis: 'true' | 'cash';
  revenue: number; cogs: number; running: number; stockBought: number; profit: number;
  /** Sales whose cost price we don't know (their profit is not subtracted). */
  unpriced: number; incomplete: boolean;
}

export function profitView(s: ProfitInput): ProfitView {
  const revenue = Number(s.revenue_ngn), running = Number(s.expenses_ngn), stockBought = Number(s.restock_ngn);
  if (s.cogs_ngn === undefined) {
    return { basis: 'cash', revenue, cogs: 0, running, stockBought, profit: revenue - running - stockBought, unpriced: 0, incomplete: false };
  }
  const cogs = Number(s.cogs_ngn), unpriced = Number(s.unpriced_revenue_ngn ?? 0);
  return { basis: 'true', revenue, cogs, running, stockBought, profit: revenue - cogs - running, unpriced, incomplete: unpriced > 0 };
}

export const profitLabel = (v: ProfitView) => (v.basis === 'true' ? 'Profit' : 'Cash left');
/** "₦68,000" or "up to ₦68,000" when some cost prices are missing. */
export const profitPhrase = (v: ProfitView) => `${v.incomplete ? 'up to ' : ''}${ngn(v.profit)}`;

export function incompleteNote(v: ProfitView): string | null {
  return v.incomplete
    ? `⚠️ ${ngn(v.unpriced)} of your sales have no cost price yet, so your real profit is lower. Tell me what each item costs you, like _lace costs me 15k_.`
    : null;
}

/** One line for confirmations and the 9 PM check-in. */
export function dayLine(s: ProfitInput): string {
  const v = profitView(s);
  return v.basis === 'true'
    ? `📊 Today: Sales ${ngn(v.revenue)} · Spent ${ngn(v.running + v.stockBought)} · Profit *${profitPhrase(v)}*`
    : `📊 Today: Sales ${ngn(v.revenue)} · Spent ${ngn(v.running + v.stockBought)} · Cash left *${ngn(v.profit)}*`;
}

/** The full breakdown people see when they ask "what's my profit?". */
export function profitBlock(title: string, s: ProfitInput & { cash_in_ngn?: number; debt_collected_ngn?: number }): string[] {
  const v = profitView(s);
  const lines = v.basis === 'true'
    ? [
        `*${title}*`,
        `Sales: ${ngn(v.revenue)}`,
        `Money spent: ${ngn(v.running + v.stockBought)}`,
        `   • Running costs (transport, food, fuel, rent…): ${ngn(v.running)}`,
        `   • Stock you bought: ${ngn(v.stockBought)}`,
        `Cost of what you sold: ${ngn(v.cogs)}`,
        `*Profit: ${profitPhrase(v)}*`,
        '_Stock you bought is money out today, but it only becomes a cost when you sell it._',
      ]
    : [
        `*${title}*`,
        `Sales: ${ngn(v.revenue)}`,
        `Expenses: ${ngn(v.running)}`,
        `Stock bought: ${ngn(v.stockBought)}`,
        `*Cash left: ${ngn(v.profit)}*`,
        '_This is cash left, not profit: cost prices aren\'t set up yet._',
      ];
  if (s.cash_in_ngn !== undefined) {
    lines.push(`Money received: ${ngn(s.cash_in_ngn)}${s.debt_collected_ngn ? ` (incl. ${ngn(s.debt_collected_ngn)} old debts)` : ''}`);
    lines.push(`*Cash left: ${ngn(Number(s.cash_in_ngn) - v.running - v.stockBought)}* _(money received − money spent)_`);
  }
  const note = incompleteNote(v);
  if (note) lines.push('', note);
  return lines;
}
