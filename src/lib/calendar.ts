/**
 * The Nigerian marketing calendar: for every month, what to do NOW and what to PREPARE for next month, plus a message the
 * owner can send to customers. Static and free to run (no AI call). Fixed dates are only the ones that never move;
 * Easter and Black Friday are computed; Ramadan and Eid move every year, so they are shown as "around" with a reminder to confirm.
 */
export interface MonthPlay {
  name: string;
  theme: string;
  now: string[];
  next: string[];
  /** A message the owner can send to customers. */
  message: (shop: string) => string;
  /** Suggested flyer tag word (see services/flyer.ts TAGS). */
  tag?: 'sale' | 'new' | 'restock';
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

export const PLAYS: MonthPlay[] = [
  { name: 'January', theme: 'Money is tight after December. Win with small, affordable and "new year" offers.', tag: 'new',
    now: ['Collect old debts first: people pay best early in the month. Say *CHASE*.', 'Push smaller sizes and cheaper items. School fees and resumption make customers careful.', 'Find out what December really made you: ask me _what was my profit last month_.'],
    next: ['Valentine\'s is 14 Feb: decide your gift bundles now and take the photos this month.', 'Buy stock for February early. Buying before the rush usually costs less.'],
    message: (s) => `Happy new year from ${s}! 🎉 We start the year with fresh stock and fair prices. Tell me what you need and I will keep it for you.` },
  { name: 'February', theme: 'Valentine\'s (14th) is your first big gifting week of the year.', tag: 'new',
    now: ['Make gift bundles and put one clear price on each, like "Gift set ₦15,000".', 'Send your flyer 7 to 10 days BEFORE the 14th, not on the day. People buy gifts early.', 'Thank your best customers personally. Say *THANK*.'],
    next: ['March: Mother\'s Day (check which date your customers use) and possibly Easter or Eid. Plan stock and photos now.'],
    message: (s) => `Looking for a gift? ${s} has ready-to-give sets, wrapped and delivered. Reply GIFT and I will send you the options. 🎁` },
  { name: 'March', theme: 'Mother\'s Day, and often Easter or Eid, fall around now. Gifts and family spending.', tag: 'sale',
    now: ['Offer a "for mum" or "for the family" bundle with a clear price.', 'If a festival is coming, stock the items people buy for it and tell customers a week ahead.', 'End of the first quarter: count what you made since January and set a target for April.'],
    next: ['April is often quieter after the festivals. Plan a clearance for items that have not sold.'],
    message: (s) => `A little something for the special woman in your life. 💐 ${s} has gifts and family bundles at honest prices. Reply to see them.` },
  { name: 'April', theme: 'Often quieter after the festivals. Use it to clear slow stock and restock smart.', tag: 'sale',
    now: ['Check which items have not sold (your Sunday report lists them) and put them on a small discount.', 'Message customers who have gone quiet. Say *WIN BACK*.', 'Restock your fast sellers while demand is low.'],
    next: ['May has Workers\' Day (1st) and Children\'s Day (27th). Plan a small offer for each.'],
    message: (s) => `We have not seen you in a while! ${s} has a special offer this week just for you. Reply and I will tell you more.` },
  { name: 'May', theme: 'Workers\' Day (1st) and Children\'s Day (27th). Eid al-Adha may fall in May.', tag: 'sale',
    now: ['Run a short "workers\' treat" offer on or just before the 1st.', 'For Children\'s Day, bundle child-friendly items with one clear price.', 'If Eid is near, tell customers a week before so they can order early.'],
    next: ['June: Democracy Day (12th) and Father\'s Day (3rd Sunday). Plan a "for dad" offer.'],
    message: (s) => `Treat yourself or your family. 🎉 ${s} has a short offer running now. Reply to see what is on.` },
  { name: 'June', theme: 'Mid-year: Democracy Day (12th) and Father\'s Day (3rd Sunday).', tag: 'sale',
    now: ['Make a "for dad" offer and send it to customers about a week before Father\'s Day.', 'A public holiday means people are free to shop: post your offer the day before.', 'Mid-year check: which 3 items made you the most money so far? Ask me _top products this month_.'],
    next: ['July: schools are on holiday. Think about what families at home will buy.'],
    message: (s) => `Dad deserves something good this Sunday. 👔 ${s} has gifts he will use. Reply to see them.` },
  { name: 'July', theme: 'School holidays. Families are at home and spending shifts.', tag: 'new',
    now: ['Offer things for kids and families who are home, with one clear price.', 'Use the slower weeks to photograph your products properly for the busy months ahead.', 'Collect old debts: say *CHASE*.'],
    next: ['August: parents start buying for the new school session. Remind them early.'],
    message: (s) => `The holidays are here! ${s} has fresh items for the whole family. Reply to see what is new.` },
  { name: 'August', theme: 'Back-to-school preparation. Parents buy early when reminded.', tag: 'sale',
    now: ['Make a back-to-school offer (bags, shoes, uniforms, stationery, lunch items, whatever fits your shop).', 'Remind parents two weeks before school starts, then again one week before.', 'Order stock now for September.'],
    next: ['September opens your busiest run-up to the end of the year. Get your stock and cash ready.'],
    message: (s) => `School is almost back! 🎒 ${s} has what you need at fair prices. Reply and I will hold yours.` },
  { name: 'September', theme: 'New school session, and the start of the "ember months" run-up to Christmas.', tag: 'restock',
    now: ['Tell customers when you restock: they check back.', 'Collect old debts before the festive rush needs your cash. Say *CHASE*.', 'Start saving a part of each day\'s profit for December stock. Say *SET ASIDE*.'],
    next: ['October: Independence Day (1st) offers, then the festive stock-up.'],
    message: (s) => `New session, new stock! ${s} is back in stock with the items you ask for most. Reply to order.` },
  { name: 'October', theme: 'Independence Day (1st), then the festive stock-up begins.', tag: 'sale',
    now: ['Run a short Independence offer around the 1st.', 'Start ordering festive stock now. The best items go early.', 'Check your margins: costs may have moved. Tell me when a cost changes, like _bought lace at 17k_, so your prices stay right.'],
    next: ['November: Black Friday, and getting every best-seller in stock for December.'],
    message: (s) => `Happy Independence Day! 🇳🇬 ${s} has a short celebration offer. Reply to see it.` },
  { name: 'November', theme: 'Black Friday, and stocking up for December.', tag: 'sale',
    now: ['Pick 3 items for a real Black Friday offer and make the discount clear. Do not discount everything.', 'Tell your customers a week before so they save money for it.', 'Make sure your best sellers will not run out in December.'],
    next: ['December is your biggest month. Opening hours, delivery and stock must be ready.'],
    message: (s) => `Black Friday is coming. 🛍️ ${s} will have 3 special prices. Reply NOTIFY and I will tell you first.` },
  { name: 'December', theme: 'Your biggest month: Detty December, Christmas, owambe, travel and gifting.', tag: 'sale',
    now: ['Every best seller must be in stock by the 15th.', 'Collect old debts before about the 20th. People travel and go quiet after that. Say *CHASE*.', 'Post your opening and closing days and your delivery cut-off so customers know.'],
    next: ['January is slow: put some of December\'s profit aside now. Say *SET ASIDE*.', 'Plan a "new year" offer for the first week of January.'],
    message: (s) => `Christmas is coming! 🎄 ${s} is open and fully stocked. Order early so we can deliver before the holidays.` },
];

// ───────────── Movable dates ─────────────

/** Easter Sunday (Gregorian), computed. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Black Friday = the Friday after US Thanksgiving = the 4th Friday of November. */
export function blackFridayDay(year: number): number {
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay();          // 0 = Sunday
  return 1 + ((5 - first + 7) % 7) + 21;
}

/** Islamic festivals move about 11 days earlier each year. Months only, approximate: the owner is told to confirm. */
const ISLAMIC: Record<number, { ramadan: number; fitr: number; adha: number }> = {
  2026: { ramadan: 2, fitr: 3, adha: 5 },
  2027: { ramadan: 2, fitr: 3, adha: 5 },
  2028: { ramadan: 1, fitr: 2, adha: 5 },
};

/** Extra "dates that move" lines for this month (1–12) and year. Empty when nothing applies. */
export function movableNotes(month: number, year: number): string[] {
  const out: string[] = [];
  const easter = easterSunday(year);
  if (easter.month === month) out.push(`✝️ Easter Sunday is ${easter.day} ${MONTH_NAMES[month - 1]} ${year}. Plan your offer for the days before it.`);
  else if (easter.month === month + 1) out.push(`✝️ Easter is next month (${easter.day} ${MONTH_NAMES[easter.month - 1]}). Start planning now.`);
  const isl = ISLAMIC[year];
  if (isl) {
    if (isl.ramadan === month) out.push('🌙 Ramadan is expected to begin around now. Shop hours and what people buy both change: confirm the exact date.');
    if (isl.fitr === month) out.push('🌙 Eid al-Fitr is expected around now. Confirm the exact date and tell customers a week ahead.');
    if (isl.adha === month) out.push('🌙 Eid al-Adha is expected around now. Confirm the exact date and tell customers a week ahead.');
  }
  if (month === 11) out.push(`🛍️ Black Friday is ${blackFridayDay(year)} November ${year}.`);
  return out;
}

/** One line for the 1st-of-the-month note. */
export const monthNudge = (month: number): string => `📅 *${PLAYS[month - 1]!.name} plan:* ${PLAYS[month - 1]!.theme} Say *CALENDAR* for what to do and a message to send.`;

// ───────────── Command ─────────────

export type CalendarCmd = { kind: 'now' } | { kind: 'year' } | { kind: 'month'; month: number };

/** "CALENDAR", "CALENDAR YEAR", "CALENDAR MARCH", "MARKETING CALENDAR", "MY CALENDAR". null = not a calendar command. */
export function parseCalendarCommand(upper: string): CalendarCmd | null {
  const m = upper.trim().match(/^(?:MARKETING |MY |BUSINESS )?CALENDAR(?:\s+(.+))?$/);
  if (!m) return null;
  const arg = (m[1] ?? '').trim();
  if (!arg || arg === 'NOW' || arg === 'THIS MONTH') return { kind: 'now' };
  if (['YEAR', 'ALL', 'FULL', 'FULL YEAR'].includes(arg)) return { kind: 'year' };
  if (arg === 'NEXT' || arg === 'NEXT MONTH') return { kind: 'month', month: -1 };   // resolved against today by the caller
  const idx = MONTH_NAMES.findIndex((n) => n.toUpperCase() === arg || n.slice(0, 3).toUpperCase() === arg);
  return idx >= 0 ? { kind: 'month', month: idx + 1 } : null;
}
