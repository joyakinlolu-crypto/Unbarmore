import { db, type Actor } from '../db/supabase.js';
import { ngn, watDayStart } from '../lib/money.js';
import { reply, type Reply } from '../services/whatsapp.js';

export interface DayRow { tx_type: string; payment_method: string | null; total_amount_ngn: number | string; amount_paid_ngn: number | string }

export interface DaySummary {
  cashSales: number; cashDebtsCollected: number; cashExpenses: number; cashStock: number;
  expectedCash: number;
  transfersIn: number;                 // transfers + POS received (sales and old debts)
  totalExpenses: number; stockBought: number;
  newCredit: number;                   // value of sales not paid for yet
  salesTotal: number; entries: number;
  unspecifiedIn: number; unspecifiedOut: number; unspecifiedCount: number;
}

const n = (v: unknown) => Number(v ?? 0) || 0;
const isCash = (m: string | null) => m === 'cash';
const isBank = (m: string | null) => m === 'transfer' || m === 'pos';
const isUnknown = (m: string | null) => !isCash(m) && !isBank(m) && m !== 'credit';

/**
 * End-of-day maths from confirmed rows. Pure, so it is unit-tested.
 * Cash in the drawer moves with: cash sales + cash debts collected − cash expenses − cash stock purchases.
 * Entries with no payment method are NOT guessed into the drawer; they are reported separately so the owner can fix them.
 */
export function summariseDay(rows: DayRow[]): DaySummary {
  const s: DaySummary = {
    cashSales: 0, cashDebtsCollected: 0, cashExpenses: 0, cashStock: 0, expectedCash: 0, transfersIn: 0,
    totalExpenses: 0, stockBought: 0, newCredit: 0, salesTotal: 0, entries: rows.length, unspecifiedIn: 0, unspecifiedOut: 0, unspecifiedCount: 0,
  };
  for (const r of rows) {
    const total = n(r.total_amount_ngn), paid = n(r.amount_paid_ngn), m = r.payment_method;
    if (r.tx_type === 'sale' || r.tx_type === 'debt_repayment') {
      if (r.tx_type === 'sale') { s.salesTotal += total; s.newCredit += Math.max(0, total - paid); }
      if (paid > 0) {
        if (isCash(m)) { r.tx_type === 'sale' ? (s.cashSales += paid) : (s.cashDebtsCollected += paid); }
        else if (isBank(m)) s.transfersIn += paid;
        else if (isUnknown(m)) { s.unspecifiedIn += paid; s.unspecifiedCount++; }
      }
    } else if (r.tx_type === 'expense' || r.tx_type === 'restock') {
      if (r.tx_type === 'expense') s.totalExpenses += total; else s.stockBought += total;
      if (paid > 0) {
        if (isCash(m)) { r.tx_type === 'expense' ? (s.cashExpenses += paid) : (s.cashStock += paid); }
        else if (isUnknown(m)) { s.unspecifiedOut += paid; s.unspecifiedCount++; }
        // money paid by transfer/POS leaves the bank, not the drawer
      }
    }
  }
  s.expectedCash = s.cashSales + s.cashDebtsCollected - s.cashExpenses - s.cashStock;
  return s;
}

export function closeShopText(name: string, dateLabel: string, s: DaySummary, pendingEntries: number): string[] {
  const parts = [`${ngn(s.cashSales)} cash sales`];
  if (s.cashDebtsCollected) parts.push(`+ ${ngn(s.cashDebtsCollected)} old debts paid in cash`);
  if (s.cashExpenses) parts.push(`− ${ngn(s.cashExpenses)} cash expenses`);
  if (s.cashStock) parts.push(`− ${ngn(s.cashStock)} cash stock`);
  return [
    `🏪 *${name} — closing ${dateLabel}*`,
    '',
    `💵 *Expected cash in drawer: ${ngn(s.expectedCash)}*`,
    `   _(${parts.join(' ')})_`,
    `🏦 *Expected bank transfers/POS: ${ngn(s.transfersIn)}*`,
    `💸 *Total expenses: ${ngn(s.totalExpenses)}*${s.stockBought ? ` _(+ ${ngn(s.stockBought)} stock bought)_` : ''}`,
    `📒 *New credit given today: ${ngn(s.newCredit)}*`,
    '',
    `Sales today ${ngn(s.salesTotal)} · ${s.entries} confirmed ${s.entries === 1 ? 'entry' : 'entries'}`,
    s.unspecifiedCount ? `⚠️ ${s.unspecifiedCount} entr${s.unspecifiedCount === 1 ? 'y has' : 'ies have'} no payment method (in ${ngn(s.unspecifiedIn)}, out ${ngn(s.unspecifiedOut)}) — not counted above. Say "cash" or "transfer" when you log.` : '',
    pendingEntries ? `⏳ ${pendingEntries} entr${pendingEntries === 1 ? 'y is' : 'ies are'} still waiting for you to tap Confirm — they are not counted.` : '',
    '',
    '_Count the drawer: it should hold this amount PLUS the cash you opened with. Check transfers in your bank app._',
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i !== a.length - 1));
}

export async function closeShopReply(actor: Actor): Promise<Reply> {
  if (actor.isStaff) return reply(actor.phone).text('CLOSE is for the shop owner — it shows the whole day\'s money.');
  const from = watDayStart(), to = new Date(from.getTime() + 86_400_000);
  const [txs, pending] = await Promise.all([
    db.from('transactions').select('tx_type, payment_method, total_amount_ngn, amount_paid_ngn')
      .eq('business_id', actor.business.id).eq('status', 'confirmed').gte('transaction_date', from.toISOString()).lt('transaction_date', to.toISOString()).limit(5000),
    db.from('transactions').select('batch_id').eq('business_id', actor.business.id).eq('status', 'pending_confirm').gte('created_at', from.toISOString()).limit(500),
  ]);
  const pendingBatches = new Set((pending.data ?? []).map((r) => r.batch_id as string)).size;
  const label = new Date(from.getTime() + 3600_000 + 12 * 3600_000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return reply(actor.phone).text(...closeShopText(actor.business.name, label, summariseDay((txs.data ?? []) as DayRow[]), pendingBatches));
}
