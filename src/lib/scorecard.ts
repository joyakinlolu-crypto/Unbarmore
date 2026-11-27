import { ngn } from './money.js';

/**
 * The pilot scorecard: is each shop building a habit, and is it worth what it costs?
 * Pure maths over facts we already hold, so it is unit-tested. Answers the one question that decides the next investment
 * (card payments, staff tier): do real owners come back on their own?
 */
export interface ShopFacts {
  name: string; tier: string; ageDays: number;
  /** ISO times; null when it never happened */
  firstEntryAt: string | null; createdAt: string; lastInboundAt: string | null;
  /** WAT dates (YYYY-MM-DD) on which at least one entry was confirmed, within the window */
  activeDates: string[];
  entries: number; revenueNgn: number;
  debtOpenNgn: number; debtCollectedNgn: number;
  costPricesSet: boolean; receipts: number; videos: number; quotes: number; counts: number;
  openedApp: boolean; aiCostNgn: number;
}

export type ShopStatus = 'habit' | 'trying' | 'stalled' | 'never_started' | 'new';

export const HABIT_DAYS = 4;          // active on 4+ of the last 7 days
export const NEW_SHOP_HOURS = 24;     // too young to judge

export function shopStatus(s: Pick<ShopFacts, 'ageDays' | 'firstEntryAt'> & { active: number }): ShopStatus {
  if (s.ageDays < NEW_SHOP_HOURS / 24 && s.active === 0) return 'new';
  if (!s.firstEntryAt) return 'never_started';
  if (s.active >= HABIT_DAYS) return 'habit';
  return s.active >= 1 ? 'trying' : 'stalled';
}

const ICON: Record<ShopStatus, string> = { habit: '🟢', trying: '🟡', stalled: '🟠', never_started: '🔴', new: '⚪' };
const LABEL: Record<ShopStatus, string> = { habit: 'habit', trying: 'trying', stalled: 'went quiet', never_started: 'never started', new: 'new today' };

export interface ShopRow extends ShopFacts { status: ShopStatus; active: number; hoursToFirst: number | null; hoursSinceSeen: number | null }
export interface Cohort {
  shops: number; counts: Record<ShopStatus, number>;
  activatedPct: number; fastActivationPct: number; habitPct: number; costPricePct: number; appPct: number;
  entries: number; revenueNgn: number; debtCollectedNgn: number; debtOpenNgn: number; aiCostNgn: number; aiCostPerActiveNgn: number | null;
  verdict: { level: 'green' | 'amber' | 'red' | 'wait'; text: string };
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const hours = (a: string, b: string) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000));

export function buildScorecard(facts: ShopFacts[], now = Date.now()): { rows: ShopRow[]; cohort: Cohort } {
  const rows: ShopRow[] = facts.map((f) => {
    const active = new Set(f.activeDates).size;
    return {
      ...f, active, status: shopStatus({ ageDays: f.ageDays, firstEntryAt: f.firstEntryAt, active }),
      hoursToFirst: f.firstEntryAt ? hours(f.createdAt, f.firstEntryAt) : null,
      hoursSinceSeen: f.lastInboundAt ? hours(f.lastInboundAt, new Date(now).toISOString()) : null,
    };
  }).sort((a, b) => b.active - a.active || b.entries - a.entries || a.name.localeCompare(b.name));

  const counts: Record<ShopStatus, number> = { habit: 0, trying: 0, stalled: 0, never_started: 0, new: 0 };
  rows.forEach((r) => { counts[r.status] += 1; });
  const judged = rows.filter((r) => r.status !== 'new');            // shops under a day old are not counted against us
  const activated = judged.filter((r) => r.firstEntryAt).length;
  const activeShops = rows.filter((r) => r.active > 0).length;
  const aiCost = rows.reduce((a, r) => a + r.aiCostNgn, 0);
  const cohort: Cohort = {
    shops: rows.length, counts,
    activatedPct: pct(activated, judged.length),
    fastActivationPct: pct(judged.filter((r) => r.hoursToFirst !== null && r.hoursToFirst <= 24).length, judged.length),
    habitPct: pct(counts.habit, judged.length),
    costPricePct: pct(judged.filter((r) => r.costPricesSet).length, judged.length),
    appPct: pct(judged.filter((r) => r.openedApp).length, judged.length),
    entries: rows.reduce((a, r) => a + r.entries, 0), revenueNgn: rows.reduce((a, r) => a + r.revenueNgn, 0),
    debtCollectedNgn: rows.reduce((a, r) => a + r.debtCollectedNgn, 0), debtOpenNgn: rows.reduce((a, r) => a + r.debtOpenNgn, 0),
    aiCostNgn: aiCost, aiCostPerActiveNgn: activeShops ? Math.round(aiCost / activeShops) : null,
    verdict: verdict(rows, judged.length, counts.habit),
  };
  return { rows, cohort };
}

/** The go / no-go for the next investment, in plain words. Thresholds are deliberately simple and stated in the report. */
function verdict(rows: ShopRow[], judged: number, habit: number): Cohort['verdict'] {
  const oldEnough = rows.filter((r) => r.ageDays >= 7).length;
  if (judged < 5) return { level: 'wait', text: `Only ${judged} shop${judged === 1 ? '' : 's'} old enough to judge. Aim for 5 to 10 before deciding anything.` };
  if (oldEnough < 3) return { level: 'wait', text: `Most shops are under 7 days old. Look again once at least 3 have been with you a full week.` };
  const rate = pct(habit, judged);
  if (rate >= 50) return { level: 'green', text: `${habit} of ${judged} shops use it on 4+ days a week. People come back on their own: safe to switch on card payments.` };
  if (rate >= 25) return { level: 'amber', text: `${habit} of ${judged} shops use it on 4+ days a week. Some stickiness, not enough yet. Call the quiet ones and find out why before spending on payments.` };
  return { level: 'red', text: `Only ${habit} of ${judged} shops use it on 4+ days a week. Fix the first-week experience before adding payments or tiers.` };
}

const VERDICT_ICON = { green: '✅', amber: '🟡', red: '🛑', wait: '⏳' } as const;

/** WhatsApp text: the verdict first, then the numbers, then one line per shop. Stays under WhatsApp's size limit. */
export function scorecardText(sc: { rows: ShopRow[]; cohort: Cohort }, days: number): string[] {
  const c = sc.cohort;
  const lines = [
    `📋 *Pilot scorecard: last ${days} days*`,
    `${VERDICT_ICON[c.verdict.level]} ${c.verdict.text}`,
    '',
    `Shops: ${c.shops}  ·  🟢 habit ${c.counts.habit}  🟡 trying ${c.counts.trying}  🟠 quiet ${c.counts.stalled}  🔴 never started ${c.counts.never_started}  ⚪ new ${c.counts.new}`,
    `Started within a day: ${c.fastActivationPct}%  ·  Ever started: ${c.activatedPct}%  ·  Set cost prices: ${c.costPricePct}%  ·  Opened the app: ${c.appPct}%`,
    `Entries ${c.entries}  ·  Sales recorded ${ngn(c.revenueNgn)}  ·  Debt collected ${ngn(c.debtCollectedNgn)} (still owed ${ngn(c.debtOpenNgn)})`,
    `AI cost ${ngn(c.aiCostNgn)}${c.aiCostPerActiveNgn !== null ? ` (about ${ngn(c.aiCostPerActiveNgn)} per active shop)` : ''}`,
    '',
  ];
  const MAX = 15;
  for (const r of sc.rows.slice(0, MAX)) {
    const seen = r.hoursSinceSeen === null ? 'never seen' : r.hoursSinceSeen < 24 ? `seen ${r.hoursSinceSeen}h ago` : `seen ${Math.floor(r.hoursSinceSeen / 24)}d ago`;
    const bits = [`${r.active}/${days} days`, `${r.entries} entries`];
    if (r.debtCollectedNgn > 0) bits.push(`collected ${ngn(r.debtCollectedNgn)}`);
    const extras = [r.receipts ? `${r.receipts} receipts` : '', r.videos ? `${r.videos} videos` : '', r.quotes ? `${r.quotes} quotes` : '', r.counts ? `${r.counts} counts` : ''].filter(Boolean).join(', ');
    lines.push(`${ICON[r.status]} *${r.name}* (${LABEL[r.status]}): ${bits.join(', ')}${extras ? `, ${extras}` : ''}. ${r.costPricesSet ? '' : 'No cost prices. '}${seen}.`);
  }
  if (sc.rows.length > MAX) lines.push(`…and ${sc.rows.length - MAX} more.`);
  lines.push('', '_🟢 = active on 4+ of the last 7 days. The verdict turns green when half the shops are 🟢._');
  return lines;
}
