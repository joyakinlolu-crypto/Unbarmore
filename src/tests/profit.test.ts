import { describe, expect, it } from 'vitest';
import { dayLine, incompleteNote, profitBlock, profitPhrase, profitView } from '../lib/profit.js';

const sum = (o: Record<string, number | undefined> = {}) => ({ revenue_ngn: 200000, expenses_ngn: 10000, restock_ngn: 0, net_profit_ngn: 0, cash_in_ngn: 200000, ...o }) as never;

describe('profit = sales − cost of goods sold − running costs', () => {
  it('selling 10 lace at ₦20k that cost ₦15k, with ₦10k rent: profit ₦40k (it used to say ₦190k)', () => {
    const v = profitView(sum({ cogs_ngn: 150000, unpriced_revenue_ngn: 0 }));
    expect(v).toMatchObject({ basis: 'true', revenue: 200000, cogs: 150000, running: 10000, profit: 40000, incomplete: false });
  });
  it('buying ₦700k of stock does not turn a good week into a loss', () => {
    const v = profitView(sum({ cogs_ngn: 150000, unpriced_revenue_ngn: 0, restock_ngn: 700000 }));
    expect(v.profit).toBe(40000);
    expect(v.stockBought).toBe(700000);
  });
  it('unknown cost prices: profit is "up to", and the gap is spelled out', () => {
    const v = profitView(sum({ cogs_ngn: 60000, unpriced_revenue_ngn: 100000 }));
    expect(v.incomplete).toBe(true);
    expect(profitPhrase(v)).toBe('up to ₦130,000');
    expect(incompleteNote(v)).toContain('₦100,000 of your sales have no cost price yet');
    expect(incompleteNote(profitView(sum({ cogs_ngn: 1, unpriced_revenue_ngn: 0 })))).toBeNull();
  });
  it('before the database upgrade it says "cash left", never "profit"', () => {
    const v = profitView(sum({ restock_ngn: 50000 }));            // no cogs_ngn → old database
    expect(v.basis).toBe('cash');
    expect(v.profit).toBe(140000);                                 // 200k − 10k − 50k
    expect(dayLine(sum({ restock_ngn: 50000 }))).toContain('Cash left');
    expect(dayLine(sum({ restock_ngn: 50000 }))).not.toContain('Profit');
    expect(profitBlock('X', sum()).join('\n')).toContain('not profit');
  });
  it('the day line and the full block say the same thing', () => {
    const s = sum({ cogs_ngn: 150000, unpriced_revenue_ngn: 0, restock_ngn: 90000 });
    // Buying stock IS money out (₦90,000 + ₦10,000 running costs), shown immediately; profit only counts it once the goods are sold.
    expect(dayLine(s)).toBe('📊 Today: Sales ₦200,000 · Spent ₦100,000 · Profit *₦40,000*');
    const block = profitBlock('Ada Shop: this week', s).join('\n');
    expect(block).toContain('Cost of what you sold: ₦150,000');
    expect(block).toContain('*Profit: ₦40,000*');
    expect(block).toContain('Money spent: ₦100,000');
    expect(block).toContain('Stock you bought: ₦90,000');
    expect(block).toContain('Running costs (transport, food, fuel, rent…): ₦10,000');
    expect(block).toContain('only becomes a cost when you sell it');
  });

  it('cash left = money received − money spent (running costs AND stock bought), so a purchase is visible at once', () => {
    const block = profitBlock('Today', { ...sum({ cogs_ngn: 0, unpriced_revenue_ngn: 94000, restock_ngn: 15550, expenses_ngn: 1600 }), cash_in_ngn: 94000 }).join('\n');
    expect(block).toContain('Money spent: ₦17,150');
    expect(block).toContain('*Cash left: ₦76,850*');
  });
});
