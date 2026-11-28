import { PLANS } from '../config/plans.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { type Actor } from '../db/supabase.js';
import { MONTH_NAMES, PLAYS, monthNudge, movableNotes, type CalendarCmd } from '../lib/calendar.js';

const wat = () => new Date(Date.now() + 3600_000);

/** What the owner sees for one month: the theme, what to do now, what to prepare for next month, and a message to send. */
export function monthText(month: number, year: number, shop: string): string[] {
  const p = PLAYS[month - 1]!;
  const nextName = PLAYS[month % 12]!.name;
  const lines = [
    `📅 *${p.name} ${year}*`,
    p.theme,
    '',
    '*Do now:*',
    ...p.now.map((x) => `• ${x}`),
    '',
    `*Prepare for ${nextName}:*`,
    ...p.next.map((x) => `• ${x}`),
  ];
  const moving = [...movableNotes(month, year)];
  if (moving.length) lines.push('', ...moving);
  lines.push('', '*A message you can send to customers:*', `_${p.message(shop)}_`);
  if (p.tag) lines.push('', `🖼️ *Make the flyer:* send a product photo with the caption _flyer <item> <price> ${p.tag}_`);
  lines.push('', 'Send it to the right people: *WIN BACK* (customers gone quiet) or *THANK* (your best customers).');
  return lines;
}

/** Twelve one-line summaries. */
export function yearText(year: number): string[] {
  return [`📅 *Your ${year} marketing calendar*`, ...PLAYS.map((p, i) => `*${p.name.slice(0, 3)}* ${p.theme.split(/[.:]/)[0]}`), '', 'Send *CALENDAR MARCH* (any month) for what to do, what to prepare and a message to send.'];
}

export function calendarReply(actor: Actor, cmd: CalendarCmd): Reply {
  const now = wat(), year = now.getUTCFullYear(), thisMonth = now.getUTCMonth() + 1;
  const plan = PLANS[actor.business.subscription_tier];
  if (!plan.marketingCalendar) {
    const p = PLAYS[thisMonth - 1]!;
    return reply(actor.phone).text(`📅 *${p.name}:* ${p.theme}`, '', 'The full plan for every month (what to do, what to prepare, and a message to send your customers) comes with *Starter* and *Growth*.', 'Send *PLANS* to see them.');
  }
  if (cmd.kind === 'year') return reply(actor.phone).text(...yearText(year));
  let month = cmd.kind === 'month' ? cmd.month : thisMonth;
  let y = year;
  if (month === -1) { month = (thisMonth % 12) + 1; if (month === 1) y += 1; }
  else if (cmd.kind === 'month' && month < thisMonth) y += 1;                        // "CALENDAR MARCH" in November means next March
  return reply(actor.phone).text(...monthText(month, y, actor.business.name));
}

/** The line added to the 7 AM note on the 1st of the month, for plans that include the calendar. */
export const firstOfMonthLine = (tier: keyof typeof PLANS): string | null => {
  const d = wat();
  return PLANS[tier].marketingCalendar && d.getUTCDate() === 1 ? monthNudge(d.getUTCMonth() + 1) : null;
};
