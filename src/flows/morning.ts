import { PLANS } from '../config/plans.js';
import { db, ledgerSummary, type Business } from '../db/supabase.js';
import { ngn, watDateKey } from '../lib/money.js';
import { profitLabel, profitPhrase, profitView } from '../lib/profit.js';
import { clientStats, lapsed } from './clients.js';
import { periodRange } from './insights.js';
import { firstName, reminderText } from '../lib/debtReminders.js';
import { waLink } from '../lib/waLink.js';
import { quotesDue, type QuoteDue } from './quotesDue.js';
import { runOutFocus, runOutLine, runOutRisk, WINDOW_DAYS, type RunOut } from '../lib/runOut.js';

/**
 * The 7 AM note: who to follow up with TODAY. Built from the owner's own records, so it works for a shop (stock, customers who
 * owe, customers gone quiet) and for a service business (clients who owe, clients to win back) alike.
 */
export interface DueDebt { name: string; phone?: string | null; amount: number; /** >0 days overdue, 0 today, <0 due in N days, null = no due date, owed for `age` days */ late: number | null; age: number }
export interface MorningFacts {
  businessName: string;
  yesterday: { count: number; line: string } | null;
  debts: DueDebt[];
  quiet: { name: string; days: number; spent: number }[];
  lowStock: { name: string; left: number }[];
  /** Open quotes that expire tomorrow/today or expired yesterday (Starter+ only: free quotes have no expiry). */
  quotes?: QuoteDue[];
  /** Items that will sell out within days at their real selling speed (see lib/runOut.ts). Preferred over the flat lowStock line. */
  runningOut?: RunOut[];
  isMonday: boolean;
  /** Gentle invitation to the web app: 'open' = hasn't opened it yet, 'install' = opened it but no Home Screen alert yet, null = nothing today. */
  appNudge?: AppNudge;
}
export type AppNudge = 'open' | 'install' | null;
export interface Button { id: string; title: string }
export interface MorningMessage { lines: string[]; buttons: Button[]; hasWork: boolean }

export function appNudgeText(kind: Exclude<AppNudge, null>): string {
  return kind === 'open'
    ? '📲 *Also in your app:* your charts, who owes you and your profit, all in one place. Tap *Open my app* below. It\'s free.'
    : '📲 *Make it an app on your phone:* open it, tap *Add to Home Screen*, then *Turn on my evening alert*. Then you never have to remember to open WhatsApp.';
}

/** 'none' = never opened the web app, 'opened' = opened it, 'alerts' = installed and alerts on. */
export type AppUsage = 'none' | 'opened' | 'alerts';
export async function appUsage(businessId: string): Promise<AppUsage> {
  const [push, opened] = await Promise.all([
    db.from('push_subscriptions').select('id', { count: 'exact', head: true }).eq('business_id', businessId),
    db.from('web_magic_tokens').select('token_hash', { count: 'exact', head: true }).eq('business_id', businessId).not('used_at', 'is', null),
  ]);
  if ((push.count ?? 0) > 0) return 'alerts';
  return (opened.count ?? 0) > 0 ? 'opened' : 'none';
}

/**
 * Twice a week (mornings Tue/Fri, evenings Wed/Sat, Lagos time), for accounts under 45 days old that haven't finished setting up the app:
 * invite them to open the app, then to put it on the Home Screen. Never for someone who already has alerts on.
 */
export function appNudgeFor(createdAt: string, usage: AppUsage, slot: 'morning' | 'evening', now = Date.now()): AppNudge {
  if (usage === 'alerts') return null;
  if (now - new Date(createdAt).getTime() > 45 * 86_400_000) return null;
  const dow = new Date(now + 3600_000).getUTCDay();                       // Lagos weekday
  if (!(slot === 'morning' ? [2, 5] : [3, 6]).includes(dow)) return null;
  return usage === 'none' ? 'open' : 'install';
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function debtLine(d: DueDebt): string {
  if (d.late === null) return `• ${d.name} has owed you ${ngn(d.amount)} for ${plural(d.age, 'day')}`;
  if (d.late > 0) return `• ${d.name} owes you ${ngn(d.amount)}: ${plural(d.late, 'day')} overdue`;
  if (d.late === 0) return `• ${d.name} owes you ${ngn(d.amount)}: due today`;
  return `• ${d.name} owes you ${ngn(d.amount)}: due in ${plural(-d.late, 'day')}`;
}

const whoFor = (q: QuoteDue) => `${q.label}${q.customer ? ` (${q.customer}, ${ngn(q.total)})` : ` (${ngn(q.total)})`}`;
const quoteWhen = (left: number) => (left < 0 ? 'expired yesterday' : left === 0 ? 'expires today' : 'expires tomorrow');
function quoteLine(q: QuoteDue): string { return `• Quote ${whoFor(q)} ${quoteWhen(q.left)}`; }
function quoteFocus(q: QuoteDue): string {
  return q.left < 0
    ? `👉 *Quote ${q.label} has expired.* Did they pay? Say *${q.label} PAID*, or give more time: *${q.label} EXTEND 3*.`
    : `👉 *Ask ${q.customer ?? 'the customer'} to pay ${q.label} ${q.left === 0 ? 'today' : 'before it expires tomorrow'}.* Or say *${q.label} EXTEND 3* to hold the price longer.`;
}

/** Pure: facts in, message out. Priority of the single "start with" line: overdue/today debts > upcoming > quiet customers > low stock > log yesterday. */
export function composeMorning(f: MorningFacts): MorningMessage {
  const quotes = (f.quotes ?? []).slice(0, 2), debts = f.debts.slice(0, 3), quiet = f.quiet.slice(0, 1), ro = f.runningOut?.[0], low = ro ? [] : f.lowStock.slice(0, 1);
  const lines: string[] = [`☀️ *Good morning, ${f.businessName}!*`];
  lines.push(f.yesterday && f.yesterday.count > 0 ? `Yesterday: ${f.yesterday.line}` : 'Nothing was recorded yesterday.');

  const items = [
    ...debts.map(debtLine),
    ...quotes.map(quoteLine),
    ...quiet.map((c) => `• ${c.name} hasn't bought in ${plural(c.days, 'day')} (spent ${ngn(c.spent)})`),
    ...(ro ? [`• ${runOutLine(ro)}`] : []),
    ...low.map((p) => `• ${p.name}: only ${p.left} left`),
  ];
  if (items.length) lines.push('', '*Follow up today:*', ...items);

  const urgent = debts.find((d) => d.late !== null && d.late >= 0);
  const upcoming = debts.find((d) => d.late !== null && d.late < 0);
  let focus: string;
  if (urgent) focus = `👉 *Start with ${urgent.name}: ${ngn(urgent.amount)}.* A kind message this morning beats chasing later.`;
  else if (debts[0] && debts[0].late === null) focus = `👉 *Start with ${debts[0].name}:* ${ngn(debts[0].amount)} is still waiting. A friendly nudge today.`;
  else if (upcoming) focus = `👉 Get ready: ${upcoming.name}'s ${ngn(upcoming.amount)} is due soon. Remind them early.`;
  else if (quotes[0]) focus = quoteFocus(quotes[0]);
  else if (quiet[0]) focus = `👉 *Message ${quiet[0].name} today.* A past customer is the cheapest sale you can make.`;
  else if (ro) focus = runOutFocus(ro);
  else if (low[0]) focus = `👉 Restock *${low[0].name}* before you miss a sale.`;
  else if (!f.yesterday || f.yesterday.count === 0) focus = '👉 Send me yesterday\'s sales and expenses in one voice note so your books stay right.';
  else focus = '👉 Have a great day! Send a voice note when the first sale or expense happens.';
  lines.push('', focus);
  const target = urgent ?? (debts[0] && debts[0].late === null ? debts[0] : undefined);
  const link = target ? waLink(target.phone, reminderText({ customer: target.name, amountNgn: target.amount, business: f.businessName, days: target.age })) : null;
  if (target && link) lines.push(`👉 Tap to send ${firstName(target.name)}'s reminder: ${link}`);
  if (f.appNudge) lines.push('', appNudgeText(f.appNudge));
  if (f.isMonday) lines.push('', '_Reply REMINDERS OFF to pause these morning and evening notes._');

  // A tap is an inbound message: it keeps the free 24-hour WhatsApp window open for tomorrow's note too.
  const buttons: Button[] = [];
  if (debts.length) buttons.push({ id: 'BTN_CHASE_DEBT', title: '💬 Chase debts' });
  if (quiet.length) buttons.push({ id: 'WINBACK', title: '👋 Win back' });
  if (f.appNudge) buttons.push({ id: 'DASHLINK', title: '📲 Open my app' });
  buttons.push({ id: 'LOGHOW', title: '📝 Log a sale' });
  return { lines, buttons: buttons.slice(0, 3), hasWork: items.length > 0 };
}

const DAY = 86_400_000;
const dayNum = (ymd: string) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY);

/** Debts that need attention: overdue, due today, or due within `horizonDays`; plus the oldest undated debt if nothing else. Most urgent first. */
export async function dueDebts(businessId: string, horizonDays = 2, today = watDateKey()): Promise<DueDebt[]> {
  const { data } = await db.from('customers').select('name, phone_number, outstanding_debt_ngn, debt_due_date, debt_since').eq('business_id', businessId).gt('outstanding_debt_ngn', 0).limit(500);
  const t = dayNum(today);
  const rows = (data ?? []).map((c) => ({
    name: c.name as string, phone: (c.phone_number as string | null) ?? null, amount: Number(c.outstanding_debt_ngn),
    late: c.debt_due_date ? t - dayNum(String(c.debt_due_date).slice(0, 10)) : null,
    age: c.debt_since ? Math.max(0, Math.floor((Date.now() - new Date(c.debt_since as string).getTime()) / DAY)) : 0,
  }));
  const dated = rows.filter((d) => d.late !== null && d.late >= -horizonDays).sort((a, b) => (b.late! - a.late!) || b.amount - a.amount);
  const oldest = rows.filter((d) => d.late === null && d.age >= 14).sort((a, b) => b.amount - a.amount)[0];
  return oldest && dated.length < 3 ? [...dated, oldest] : dated;
}

/** Items that will sell out within a few days at the speed they really sell (last 14 days of confirmed sales). */
export async function runningOutFor(businessId: string): Promise<RunOut[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * DAY).toISOString();
  const { data: sales } = await db.from('transactions').select('product_id, quantity')
    .eq('business_id', businessId).eq('tx_type', 'sale').eq('status', 'confirmed').not('product_id', 'is', null).gte('transaction_date', since).limit(5000);
  const sold = new Map<string, number>();
  for (const t of sales ?? []) sold.set(t.product_id as string, (sold.get(t.product_id as string) ?? 0) + Number(t.quantity));
  if (!sold.size) return [];
  const { data: prods } = await db.from('products').select('id, name, stock_qty').eq('business_id', businessId).in('id', [...sold.keys()]).gt('cost_price_ngn', 0);
  return runOutRisk((prods ?? []).map((p) => ({ id: p.id as string, name: p.name as string, stock: Number(p.stock_qty) })), sold).slice(0, 3);
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
    runningOut: await runningOutFor(biz.id).catch(() => []),
    quotes: PLANS[biz.subscription_tier].quoteExpiry ? await quotesDue(biz.id).catch(() => []) : [],
    isMonday: new Date(Date.now() + 3600_000).getUTCDay() === 1,
    appNudge: appNudgeFor(biz.created_at, await appUsage(biz.id).catch(() => 'alerts' as const), 'morning'),
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
