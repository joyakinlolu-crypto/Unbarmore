import { db, ledgerSummary, type Business } from '../db/supabase.js';
import { ngn, watDateKey } from '../lib/money.js';
import { profitLabel, profitPhrase, profitView } from '../lib/profit.js';
import { clientStats, lapsed } from './clients.js';
import { periodRange } from './insights.js';

/**
 * The 7 AM note: who to follow up with TODAY. Built from the owner's own records, so it works for a shop (stock, customers who
 * owe, customers gone quiet) and for a service business (clients who owe, clients to win back) alike.
 */
export interface DueDebt { name: string; amount: number; /** >0 days overdue, 0 today, <0 due in N days, null = no due date, owed for `age` days */ late: number | null; age: number }
export interface MorningFacts {
  businessName: string;
  yesterday: { count: number; line: string } | null;
  debts: DueDebt[];
  quiet: { name: string; days: number; spent: number }[];
  lowStock: { name: string; left: number }[];
  isMonday: boolean;
}
export interface Button { id: string; title: string }
export interface MorningMessage { lines: string[]; buttons: Button[]; hasWork: boolean }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function debtLine(d: DueDebt): string {
  if (d.late === null) return `• ${d.name} has owed you ${ngn(d.amount)} for ${plural(d.age, 'day')}`;
  if (d.late > 0) return `• ${d.name} owes you ${ngn(d.amount)}: ${plural(d.late, 'day')} overdue`;
  if (d.late === 0) return `• ${d.name} owes you ${ngn(d.amount)}: due today`;
  return `• ${d.name} owes you ${ngn(d.amount)}: due in ${plural(-d.late, 'day')}`;
}

/** Pure: facts in, message out. Priority of the single "start with" line: overdue/today debts > upcoming > quiet customers > low stock > log yesterday. */
export function composeMorning(f: MorningFacts): MorningMessage {
  const debts = f.debts.slice(0, 3), quiet = f.quiet.slice(0, 1), low = f.lowStock.slice(0, 1);
  const lines: string[] = [`☀️ *Good morning, ${f.businessName}!*`];
  lines.push(f.yesterday && f.yesterday.count > 0 ? `Yesterday: ${f.yesterday.line}` : 'Nothing was recorded yesterday.');

  const items = [
    ...debts.map(debtLine),
    ...quiet.map((c) => `• ${c.name} hasn't bought in ${plural(c.days, 'day')} (spent ${ngn(c.spent)})`),
    ...low.map((p) => `• ${p.name}: only ${p.left} left`),
  ];
  if (items.length) lines.push('', '*Follow up today:*', ...items);

  const urgent = debts.find((d) => d.late !== null && d.late >= 0);
  const upcoming = debts.find((d) => d.late !== null && d.late < 0);
  let focus: string;
  if (urgent) focus = `👉 *Start with ${urgent.name}: ${ngn(urgent.amount)}.* A kind message this morning beats chasing later.`;
  else if (debts[0] && debts[0].late === null) focus = `👉 *Start with ${debts[0].name}:* ${ngn(debts[0].amount)} is still waiting. A friendly nudge today.`;
  else if (upcoming) focus = `👉 Get ready: ${upcoming.name}'s ${ngn(upcoming.amount)} is due soon. Remind them early.`;
  else if (quiet[0]) focus = `👉 *Message ${quiet[0].name} today.* A past customer is the cheapest sale you can make.`;
  else if (low[0]) focus = `👉 Restock *${low[0].name}* before you miss a sale.`;
  else if (!f.yesterday || f.yesterday.count === 0) focus = '👉 Send me yesterday\'s sales and expenses in one voice note so your books stay right.';
  else focus = '👉 Have a great day! Send a voice note when the first sale or expense happens.';
  lines.push('', focus);
  if (f.isMonday) lines.push('', '_Reply REMINDERS OFF to pause these morning and evening notes._');

  // A tap is an inbound message: it keeps the free 24-hour WhatsApp window open for tomorrow's note too.
  const buttons: Button[] = [];
  if (debts.length) buttons.push({ id: 'BTN_CHASE_DEBT', title: '💬 Chase debts' });
  if (quiet.length) buttons.push({ id: 'WINBACK', title: '👋 Win back' });
  buttons.push({ id: 'LOGHOW', title: '📝 Log a sale' });
  return { lines, buttons: buttons.slice(0, 3), hasWork: items.length > 0 };
}

const DAY = 86_400_000;
const dayNum = (ymd: string) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY);

/** Debts that need attention: overdue, due today, or due within `horizonDays`; plus the oldest undated debt if nothing else. Most urgent first. */
export async function dueDebts(businessId: string, horizonDays = 2, today = watDateKey()): Promise<DueDebt[]> {
  const { data } = await db.from('customers').select('name, outstanding_debt_ngn, debt_due_date, debt_since').eq('business_id', businessId).gt('outstanding_debt_ngn', 0).limit(500);
  const t = dayNum(today);
  const rows = (data ?? []).map((c) => ({
    name: c.name as string, amount: Number(c.outstanding_debt_ngn),
    late: c.debt_due_date ? t - dayNum(String(c.debt_due_date).slice(0, 10)) : null,
    age: c.debt_since ? Math.max(0, Math.floor((Date.now() - new Date(c.debt_since as string).getTime()) / DAY)) : 0,
  }));
  const dated = rows.filter((d) => d.late !== null && d.late >= -horizonDays).sort((a, b) => (b.late! - a.late!) || b.amount - a.amount);
  const oldest = rows.filter((d) => d.late === null && d.age >= 14).sort((a, b) => b.amount - a.amount)[0];
  return oldest && dated.length < 3 ? [...dated, oldest] : dated;
}

export async function gatherMorning(biz: Business): Promise<MorningFacts> {
  const { from, to } = periodRange('yesterday');
  const [s, debts, clients, prods] = await Promise.all([
    ledgerSummary(biz.id, from, to),
    dueDebts(biz.id),
    clientStats(biz.id).catch(() => []),
    db.from('products').select('name, stock_qty').eq('business_id', biz.id).gt('cost_price_ngn', 0).lte('stock_qty', 2).order('stock_qty', { ascending: true }).limit(2),
  ]);
  const v = profitView(s);
  return {
    businessName: biz.name,
    yesterday: { count: s.tx_count, line: `Sales ${ngn(v.revenue)} · ${profitLabel(v)} ${profitPhrase(v)}` },
    debts,
    quiet: lapsed(clients).slice(0, 2).map((c) => ({ name: c.name, days: Math.floor((Date.now() - new Date(c.lastBuy!).getTime()) / DAY), spent: c.spent })),
    lowStock: (prods.data ?? []).map((p) => ({ name: p.name as string, left: Math.max(0, Number(p.stock_qty)) })),
    isMonday: new Date(Date.now() + 3600_000).getUTCDay() === 1,
  };
}

/** One line for the 9 PM note: what is due tomorrow. */
export async function tomorrowLine(businessId: string): Promise<string | null> {
  const due = (await dueDebts(businessId, 1)).filter((d) => d.late !== null && d.late >= -1 && d.late <= 0);
  if (!due.length) return null;
  const tomorrow = due.filter((d) => d.late === -1), today = due.filter((d) => d.late === 0);
  const bits = [...today.map((d) => `${d.name} ${ngn(d.amount)} (due today)`), ...tomorrow.map((d) => `${d.name} ${ngn(d.amount)}`)];
  return `📅 *Follow up ${tomorrow.length && !today.length ? 'tomorrow' : 'soon'}:* ${bits.slice(0, 3).join(' · ')}`;
}
