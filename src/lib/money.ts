/** Naira formatting + WAT (UTC+1, no DST) date helpers. */

export const ngn = (n: number | null | undefined): string =>
  '₦' + Math.round(Number(n ?? 0)).toLocaleString('en-NG');

/** Compact: ₦50k, ₦1.2m — for tight WhatsApp lines and button titles. */
export const ngnShort = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `₦${+(n / 1_000_000).toFixed(1)}m`;
  if (a >= 1_000) return `₦${+(n / 1_000).toFixed(1)}k`;
  return `₦${Math.round(n)}`;
};

const WAT_OFFSET_MS = 3600_000;

/** Start of "today" in Lagos, as a UTC Date. */
export function watDayStart(d = new Date()): Date {
  const local = new Date(d.getTime() + WAT_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - WAT_OFFSET_MS);
}

export function watDateKey(d = new Date()): string {
  return new Date(d.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO week key in WAT, e.g. 2026-W47. */
export function watWeekKey(d = new Date()): string {
  const t = new Date(d.getTime() + WAT_OFFSET_MS);
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function randomCode(len: number, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'): string {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
