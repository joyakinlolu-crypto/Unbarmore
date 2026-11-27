/**
 * "Restock before you run out": from how fast an item really sells. Pure arithmetic on sales we already hold: no AI, no cost.
 * A flat "only 2 left" alert misses a fast seller with 8 left and nags about something that sells once a month.
 */
export interface RunOut { name: string; left: number; perWeek: number; daysLeft: number; suggestQty: number }

export const WINDOW_DAYS = 14;
export const HORIZON_DAYS = 4;       // warn when stock covers this many days or fewer
export const MIN_PER_WEEK = 2;       // ignore things that rarely sell

export function runOutRisk(
  products: { id: string; name: string; stock: number }[],
  soldInWindow: Map<string, number>,
  windowDays = WINDOW_DAYS,
): RunOut[] {
  const out: RunOut[] = [];
  for (const p of products) {
    const sold = soldInWindow.get(p.id) ?? 0;
    const perDay = sold / windowDays, perWeek = perDay * 7;
    if (perWeek < MIN_PER_WEEK) continue;
    const left = Math.max(0, p.stock);
    const daysLeft = left / perDay;
    if (daysLeft > HORIZON_DAYS) continue;
    out.push({ name: p.name, left, perWeek: Math.round(perWeek), daysLeft: Math.floor(daysLeft), suggestQty: Math.max(1, Math.ceil(perWeek * 2) - left) });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || b.perWeek - a.perWeek);
}

export function runOutLine(r: RunOut): string {
  const cover = r.left <= 0 ? 'and it is sold out' : `and only ${r.left} left (about ${r.daysLeft === 0 ? 'less than a day' : r.daysLeft === 1 ? '1 day' : `${r.daysLeft} days`})`;
  return `${r.name}: you sell about ${r.perWeek} a week ${cover}`;
}

export const runOutFocus = (r: RunOut) =>
  `👉 *Restock ${r.name} today.* You sell about ${r.perWeek} a week; ${r.left <= 0 ? 'it is sold out' : `${r.left} left`}. Two weeks of stock is about ${r.suggestQty} more.`;
