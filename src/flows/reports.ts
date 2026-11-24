import {
  consumeQuota, deadStock, debtors, expensesByCategory, ledgerSummary, signedUrl, topProducts, uploadFile, db,
  type Actor, type Business,
} from '../db/supabase.js';
import { ngn, ngnShort, watWeekKey } from '../lib/money.js';
import { writeDebtReminders } from '../services/geminiBrain.js';
import { weeklyStatementPdf } from '../services/pdfGenerator.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { loadLogo } from './branding.js';
import { incompleteNote, profitPhrase, profitView } from '../lib/profit.js';
import { moneyBack, moneyBackLine, type MoneyBack } from './moneyBack.js';
import { daysSince, periodRange } from './insights.js';
import { startClearanceVideo } from './video.js';

export interface WeeklyReport {
  revenue: number; expenses: number; restock: number; netProfit: number; cashIn: number; debtCollected: number;
  /** Cost of the goods sold, sales with no known cost price, and whether netProfit is true profit (migration 005) or only cash left. */
  cogs: number; unpriced: number; trueProfit: boolean;
  anomalies: { category: string; amount: number; changePct: number }[];
  expenseByCategory: { category: string; amount: number; changePct: number | null }[];
  debtors: { name: string; amount: number; days: number }[];
  deadStock: { id: string; name: string; qty: number; days: number }[];
  topProducts: { name: string; qty: number; revenue: number }[];
  valueRecovered: number;
  /** All-time debt collected + margin protected; undefined only in hand-built test fixtures. */
  moneyBack?: MoneyBack;
  periodLabel: string;
}

/** "Week" for a Sunday 6 PM report = Monday 00:00 → now (WAT). */
export async function buildWeeklyReport(b: Business): Promise<WeeklyReport> {
  const cur = periodRange('this_week');
  const prev = periodRange('last_week');
  const [s, catNow, catPrev, debt, dead, top, mb] = await Promise.all([
    ledgerSummary(b.id, cur.from, cur.to),
    expensesByCategory(b.id, cur.from, cur.to),
    expensesByCategory(b.id, prev.from, prev.to),
    debtors(b.id, 10),
    deadStock(b.id, 21),
    topProducts(b.id, cur.from, cur.to, 5),
    moneyBack(b).catch(() => undefined),
  ]);
  const prevMap = new Map(catPrev.map((c) => [c.category, c.amount]));
  const expenseByCategory = catNow.map((c) => {
    const p = prevMap.get(c.category);
    return { ...c, changePct: p && p > 0 ? ((c.amount - p) / p) * 100 : null };
  });
  const fmt = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(5, 10);
  return {
    revenue: s.revenue_ngn, expenses: s.expenses_ngn, restock: s.restock_ngn, netProfit: profitView(s).profit,
    cogs: s.cogs_ngn ?? 0, unpriced: s.unpriced_revenue_ngn ?? 0, trueProfit: s.cogs_ngn !== undefined,
    cashIn: s.cash_in_ngn, debtCollected: s.debt_collected_ngn,
    expenseByCategory,
    anomalies: expenseByCategory.filter((e): e is typeof e & { changePct: number } => e.changePct !== null && e.changePct > 20),
    debtors: debt.map((d) => ({ name: d.name, amount: d.outstanding_debt_ngn, days: daysSince(d.debt_since) })),
    deadStock: dead.map((p) => ({ id: p.id, name: p.name, qty: Number(p.stock_qty), days: daysSince(p.last_sold_at) })),
    topProducts: top,
    valueRecovered: Number(b.total_value_recovered_ngn),
    moneyBack: mb,
    periodLabel: `${fmt(cur.from)} → ${fmt(new Date(cur.to.getTime() - 1))} (${watWeekKey()})`,
  };
}

/** Body text for the in-window (free) version of the CEO report. */
export function reportText(b: Business, r: WeeklyReport): string[] {
  const owed = r.debtors.reduce((s, d) => s + d.amount, 0);
  return [
    `📈 *${b.name} — Weekly CEO Report*`,
    r.trueProfit
      ? `Sales ${ngn(r.revenue)} · Cost of goods ${ngn(r.cogs)} · Running costs ${ngn(r.expenses)}`
      : `Sales ${ngn(r.revenue)} · Costs ${ngn(r.expenses + r.restock)}`,
    `*${r.trueProfit ? 'Profit' : 'Cash left'}: ${profitPhrase(profitView({ revenue_ngn: r.revenue, expenses_ngn: r.expenses, restock_ngn: r.restock, net_profit_ngn: r.netProfit, ...(r.trueProfit ? { cogs_ngn: r.cogs, unpriced_revenue_ngn: r.unpriced } : {}) }))}*`,
    r.trueProfit && r.restock > 0 ? `_Stock bought this week: ${ngn(r.restock)} (on your shelf, not a cost)_` : '',
    ...r.anomalies.slice(0, 2).map((a) => `⚠️ ${a.category} up ${Math.round(a.changePct)}% (${ngn(a.amount)})`),
    owed > 0 ? `💳 ${r.debtors.length} customer${r.debtors.length > 1 ? 's' : ''} owe you ${ngn(owed)}` : '💳 Nobody owes you 🎉',
    r.deadStock[0] ? `🧊 ${r.deadStock[0].name}: no sale in ${r.deadStock[0].days} days` : '',
    (r.moneyBack ? moneyBackLine(r.moneyBack) : null) ?? (r.valueRecovered > 0 ? `🛡️ Profit protected by Unbarmore: ${ngn(r.valueRecovered)}` : ''),
  ].concat(r.trueProfit && r.unpriced > 0 ? ['', incompleteNote(profitView({ revenue_ngn: r.revenue, expenses_ngn: r.expenses, restock_ngn: r.restock, net_profit_ngn: r.netProfit, cogs_ngn: r.cogs, unpriced_revenue_ngn: r.unpriced }))!] : []).filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '' && i < a.length - 1));
}

/** Template body params for unbarmore_weekly_ceo_report (approve in Meta with exactly 5 variables). */
export function reportTemplateParams(b: Business, r: WeeklyReport): string[] {
  const owed = r.debtors.reduce((s, d) => s + d.amount, 0);
  return [
    b.name,
    ngnShort(r.revenue),
    ngnShort(r.netProfit),
    owed > 0 ? `${ngnShort(owed)} (${r.debtors.length} customers)` : '₦0',
    r.anomalies[0] ? `${r.anomalies[0].category} up ${Math.round(r.anomalies[0].changePct)}%` : 'none',
  ];
}

// ───────────── 1-tap action buttons ─────────────

export async function chaseDebtsReply(actor: Actor): Promise<Reply> {
  const list = (await debtors(actor.business.id, 8)).filter((d) => d.outstanding_debt_ngn > 0);
  if (!list.length) return reply(actor.phone).text('🎉 Nobody owes you money right now.');
  const msgs = await writeDebtReminders(actor.business.name, list.map((d) => ({ name: d.name, amount: ngn(d.outstanding_debt_ngn), days: daysSince(d.debt_since) })));
  await db.from('customers').update({ last_reminder_sent_at: new Date().toISOString() }).in('id', list.map((d) => d.id));
  return reply(actor.phone).text(
    '💬 *Copy & forward these:*',
    ...msgs.flatMap((m) => ['', `*→ ${m.customer}*`, m.message]),
  );
}

export async function deadStockPromoReply(actor: Actor): Promise<Reply> {
  const dead = await deadStock(actor.business.id, 21);
  if (!dead[0]) return reply(actor.phone).text('No dead stock — everything sold in the last 21 days. 💪');
  return startClearanceVideo(actor, actor.business, dead[0].id);
}

export async function statementReply(actor: Actor): Promise<Reply> {
  if (!(await consumeQuota(actor.business, 'pdf_receipts_used_this_month'))) {
    return reply(actor.phone).text('You\'ve used your free PDFs this month.').button('PLANS', '⭐ See plans');
  }
  const r = await buildWeeklyReport(actor.business);
  const pdf = await weeklyStatementPdf({
    businessName: actor.business.name, rcNumber: actor.business.rc_number, periodLabel: r.periodLabel, logo: await loadLogo(actor.business),
    revenue: r.revenue, expenses: r.expenses, restock: r.restock, netProfit: r.netProfit, cogs: r.cogs, unpriced: r.unpriced, trueProfit: r.trueProfit, cashIn: r.cashIn,
    debtCollected: r.debtCollected, expenseByCategory: r.expenseByCategory, topProducts: r.topProducts,
    debtors: r.debtors, deadStock: r.deadStock, valueRecovered: r.valueRecovered,
  });
  const name = `Statement-${watWeekKey()}.pdf`;
  const path = await uploadFile('pdf-receipts', `${actor.business.id}/statements/${name}`, pdf, 'application/pdf');
  return reply(actor.phone)
    .document(await signedUrl('pdf-receipts', path), name)
    .text(`📄 Income & Expense Statement, ${r.periodLabel}. ${r.trueProfit ? 'Profit' : 'Cash left'} ${ngn(r.netProfit)}${r.unpriced > 0 ? ' (up to: some cost prices are missing)' : ''}.`, 'Good for loan applications & your accountant.');
}
