/**
 * Debt reminders without AI: fixed, warm templates that get firmer as a debt ages, in English, Pidgin or Yoruba.
 * Cost per reminder = ₦0 (no model call), the wording is predictable, and the owner sends it from their own WhatsApp via a
 * wa.me link (we never message the owner's customers ourselves).
 *
 * The Yoruba lines are plain, respectful wording; have a native speaker read them before wide release.
 */
import { ngn } from './money.js';

export type ReminderLang = 'english' | 'pidgin' | 'yoruba';
export type ReminderTone = 'soft' | 'firm' | 'final';

export const toneForAge = (days: number): ReminderTone => (days >= 30 ? 'final' : days >= 7 ? 'firm' : 'soft');

export const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;

interface Vars { name: string; amount: string; biz: string; days: number }

const T: Record<ReminderLang, Record<ReminderTone, (v: Vars) => string>> = {
  english: {
    soft: (v) => `Hello ${v.name}, hope you're doing well! A small reminder about the ${v.amount} balance with ${v.biz}. Please send it when you can. Thank you 🙏`,
    firm: (v) => `Hello ${v.name}, this is ${v.biz}. Your balance of ${v.amount} has been pending for ${v.days} days. Please settle it today, or tell me the day you will, so I can plan. Thank you.`,
    final: (v) => `Hello ${v.name}, ${v.biz} here. Your ${v.amount} has been outstanding for ${v.days} days and I really need it settled. Please pay today or call me so we agree a date. I appreciate you.`,
  },
  pidgin: {
    soft: (v) => `Hello ${v.name}, how far? Na small reminder for the ${v.amount} balance for ${v.biz}. Abeg send am when you fit. Thank you 🙏`,
    firm: (v) => `Hello ${v.name}, na ${v.biz} dey talk. Your ${v.amount} don reach ${v.days} days. Abeg settle am today, or tell me which day you go pay, make I fit plan. Thank you.`,
    final: (v) => `${v.name}, na ${v.biz}. Your ${v.amount} don dey for ${v.days} days now and I need am. Abeg pay today or call me make we agree one day. I appreciate you.`,
  },
  yoruba: {
    soft: (v) => `Pẹlẹ o ${v.name}, ìrántí kékeré ni fún ${v.amount} tí ẹ jẹ ${v.biz}. Ẹ jọ̀wọ́, ẹ san án nígbà tí ẹ bá lè. Ẹ ṣé 🙏`,
    firm: (v) => `Pẹlẹ o ${v.name}, ${v.biz} ni. ${v.amount} tí ẹ jẹ ti pé ọjọ́ ${v.days}. Ẹ jọ̀wọ́, ẹ san án lónìí tàbí kí ẹ sọ ọjọ́ tí ẹ máa san, kí n lè ṣètò. Ẹ ṣé.`,
    final: (v) => `${v.name}, ${v.biz} ni. ${v.amount} yín ti pé ọjọ́ ${v.days} báyìí, mo sì nílò rẹ̀. Ẹ jọ̀wọ́, ẹ san án lónìí tàbí kí ẹ pè mí ká fi ọjọ́ sí i. Mo mọrírì yín.`,
  },
};

export function reminderText(o: { customer: string; amountNgn: number; business: string; days: number; lang?: ReminderLang }): string {
  const days = Math.max(0, Math.round(o.days));
  return T[o.lang ?? 'english'][toneForAge(days)]({ name: firstName(o.customer), amount: ngn(o.amountNgn), biz: o.business, days });
}

/** "CHASE", "CHASE PIDGIN", "CHASE YORUBA". null = not a chase command. */
export function parseChaseCommand(text: string): { lang: ReminderLang } | null {
  const m = text.trim().match(/^chase(?:\s+(?:in\s+)?(english|pidgin|yoruba))?$/i);
  return m ? { lang: ((m[1] ?? 'english').toLowerCase() as ReminderLang) } : null;
}

// ───────────── "Ada will pay Friday": promise dates ─────────────

const DAY_MS = 86_400_000;
const ymdToMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const msToYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A promise date in Lagos time, as YYYY-MM-DD, or null when the words don't name a day. `today` = today's WAT date. */
export function parsePromiseDate(raw: string, today: string): string | null {
  const t = raw.toLowerCase().replace(/[.!,]+$/g, '').trim();
  const base = ymdToMs(today);
  if (/^(today|this evening|tonight)$/.test(t)) return today;
  if (/^(tomorrow|tomorow|tmrw|tom)$/.test(t)) return msToYmd(base + DAY_MS);
  if (/^next week$/.test(t)) return msToYmd(base + 7 * DAY_MS);
  const inDays = t.match(/^in (\d{1,2}) days?$/);
  if (inDays) return msToYmd(base + Number(inDays[1]) * DAY_MS);
  if (/^(?:the )?(?:end of (?:the )?month|month[ -]?end)$/.test(t)) {
    const d = new Date(base); return msToYmd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  }
  const wd = t.match(/^(next |this )?(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?$/);
  if (wd) {
    const idx = WEEKDAYS.findIndex((w) => w.startsWith(wd[2]!.slice(0, 3)));
    if (idx < 0) return null;
    const cur = new Date(base).getUTCDay();
    let add = (idx - cur + 7) % 7;
    if (wd[1] === 'next ' && add < 7) add += add === 0 ? 7 : 0; // "next friday" said on a Friday = a week later
    return msToYmd(base + add * DAY_MS);
  }
  const dom = t.match(/^(?:the )?(\d{1,2})(?:st|nd|rd|th)$/);
  if (dom) {
    const day = Number(dom[1]); if (day < 1 || day > 31) return null;
    const d = new Date(base); let y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (day < d.getUTCDate()) { m += 1; if (m > 11) { m = 0; y += 1; } }
    const out = new Date(Date.UTC(y, m, day));
    return out.getUTCMonth() === m ? msToYmd(out.getTime()) : null;
  }
  const dm = t.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (dm) {
    const d = new Date(base); const day = Number(dm[1]), mon = Number(dm[2]) - 1;
    if (mon < 0 || mon > 11 || day < 1 || day > 31) return null;
    let y = d.getUTCFullYear();
    if (Date.UTC(y, mon, day) < base) y += 1;
    const out = new Date(Date.UTC(y, mon, day));
    return out.getUTCMonth() === mon ? msToYmd(out.getTime()) : null;
  }
  return null;
}

/** "Ada will pay Friday" / "Ada promised tomorrow" / "Ada go pay 15th". null = not a promise sentence (let the normal router handle it). */
export function parsePromise(text: string, today: string): { name: string; date: string } | null {
  const m = text.trim().match(/^([\p{L}][\p{L} .'’-]{1,38}?)\s+(?:will pay|will settle|promised(?: to pay)?|don promise|go pay|dey pay|pays|to pay|says (?:he|she|they)(?:'ll| will) pay)\s+(?:me\s+)?(?:on\s+|by\s+)?(.{2,30})$/iu);
  if (!m) return null;
  const date = parsePromiseDate(m[2]!, today);
  return date ? { name: m[1]!.trim(), date } : null;
}

/** "Friday 5 Dec" */
export function promiseLabel(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
