import { ngn } from '@/lib/format';

/**
 * profit = sales − cost of the goods sold − running costs. Stock BOUGHT is shown separately (it is on the shelf, not lost).
 * `basis: 'cash'` only appears until the database has migration 005; then the number is labelled "cash left", never "profit".
 * Mirror of the bot's src/lib/profit.ts.
 */
export interface ProfitView {
  basis: 'true' | 'cash';
  revenue: number; cogs: number; running: number; stockBought: number; profit: number;
  unpriced: number; incomplete: boolean; marginPct: number | null;
}

/** `row` is one result row of the ledger_summary RPC (numbers arrive as strings). */
export function profitFromRow(row: Record<string, string | number | null | undefined>): ProfitView {
  const n = (k: string) => Number(row[k] ?? 0);
  const revenue = n('revenue_ngn'), running = n('expenses_ngn'), stockBought = n('restock_ngn');
  const basis = 'cogs_ngn' in row ? 'true' : 'cash';
  const cogs = basis === 'true' ? n('cogs_ngn') : 0;
  const unpriced = basis === 'true' ? n('unpriced_revenue_ngn') : 0;
  const profit = basis === 'true' ? revenue - cogs - running : revenue - running - stockBought;
  return { basis, revenue, cogs, running, stockBought, profit, unpriced, incomplete: unpriced > 0, marginPct: revenue > 0 ? Math.round((profit / revenue) * 100) : null };
}

export const profitLabel = (v: ProfitView) => (v.basis === 'true' ? 'Profit' : 'Cash left');
export const profitPhrase = (v: ProfitView) => `${v.incomplete ? 'up to ' : ''}${ngn(v.profit)}`;
