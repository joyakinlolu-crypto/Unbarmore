export const ngn = (n: number | null | undefined) => '₦' + Math.round(Number(n ?? 0)).toLocaleString('en-NG');
export const ngnShort = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `₦${+(n / 1_000_000).toFixed(1)}m`;
  if (a >= 1_000) return `₦${+(n / 1_000).toFixed(1)}k`;
  return `₦${Math.round(n)}`;
};
/** Lagos (UTC+1, no DST) wall-clock helpers */
const WAT = 3600_000;
export const watDayStart = (d = new Date()) => { const l = new Date(d.getTime() + WAT); l.setUTCHours(0, 0, 0, 0); return new Date(l.getTime() - WAT); };
export const watMonthStart = (d = new Date()) => { const l = new Date(d.getTime() + WAT); return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1) - WAT); };
export const watMonthEnd = (start: Date) => { const l = new Date(start.getTime() + WAT); return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + 1, 1) - WAT); };
export const watDate = (iso: string) => new Date(new Date(iso).getTime() + WAT).toISOString().slice(0, 10);

/** E.164-ish for wa.me: digits only, Nigerian 0-prefix → 234 */
export function waNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('0')) d = '234' + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}
export const waLink = (phone: string | null, text: string) => `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`;
