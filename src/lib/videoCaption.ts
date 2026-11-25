/**
 * Reads "Cord lace, 17,500 for 5 yards, delivery Ibadan 2k, Yoruba" typed as a photo caption or a reply to "Got 3 photos!".
 * Deterministic on purpose: when text arrives WITH product photos it is video details, and the AI router (which reads
 * "Cord lace 17500" as "update my product prices") must not get to decide.
 */
export type Voice = 'english' | 'pidgin' | 'yoruba';

export interface VideoDetails { name: string; price: number; delivery: string | null; voice: Voice }

/** Words that mean this is about money moving (a transfer screenshot's caption), not a product ad. */
const MONEY_WORDS = /\b(paid|pay|sent|send|transfer(?:red)?|received|credit(?:ed)?|debit(?:ed)?|alert|bank|owe[sd]?|debt|balance|refund|deposit)\b/i;
/** A number followed by one of these is a QUANTITY ("5 yards"), not a price. */
const QUANTITY = /^\s*(?:yards?|yds?|pieces?|pcs?|sets?|metres?|meters?|inch(?:es)?|kg|units?|bundles?|dozens?|packs?|pairs?|rolls?|bags?|cartons?)\b/i;

export function detectVoice(text: string): { voice: Voice | null; rest: string } {
  let voice: Voice | null = null;
  const rest = text.replace(/\b(?:in\s+)?(yor[uù]b[aá]|pidgin|english)\b(?:\s+(?:voice|voiceover|video))?/gi, (_m, w: string) => {
    const k = w.toLowerCase();
    voice = k.startsWith('yor') ? 'yoruba' : k === 'pidgin' ? 'pidgin' : 'english';
    return ' ';
  });
  return { voice, rest };
}

export function parseVideoCaption(raw: string): VideoDetails | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 200 || MONEY_WORDS.test(text)) return null;

  const { voice, rest: noVoice } = detectVoice(text);
  let rest = noVoice;

  // Delivery: everything after "delivery"/"deliver"/"dispatch".
  let delivery: string | null = null;
  const d = rest.match(/\b(?:delivery|deliver|dispatch)\b\s*[:\-–]?\s*(.+)$/i);
  if (d) { delivery = d[1]!.trim().replace(/[.,;]+$/, '') || null; rest = rest.slice(0, d.index); }

  // Price: first amount that is not a quantity and is at least ₦100 once k/m is applied.
  const re = /(?:₦|ngn\s*|n(?=\d))?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m)?\b(?:\s*(?:naira|ngn))?/gi;
  let m: RegExpExecArray | null; let price = 0; let at: RegExpExecArray | null = null;
  while ((m = re.exec(rest))) {
    const after = rest.slice(m.index + m[0].length);
    if (QUANTITY.test(after) && !m[2]) continue;
    const n = Number(m[1]!.replace(/,/g, '')) * (m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1);
    if (n >= 100 && n <= 100_000_000) { price = Math.round(n); at = m; break; }
  }
  if (!at) return null;

  // Name: the text around the price, minus quantity phrases ("for 5 yards") and filler words.
  let name = (rest.slice(0, at.index) + ' ' + rest.slice(at.index + at[0].length))
    .replace(/\b(?:per|a|each|one)\s+(?:yards?|yds?|pieces?|pcs?|sets?|metres?|meters?|kg|units?|bundles?|packs?|pairs?)\b/gi, ' ')
    .replace(/\b(?:for|at|each|per|only|price|na|is|@)\b/gi, ' ')
    .replace(/\b\d+\s*(?:yards?|yds?|pieces?|pcs?|sets?|metres?|meters?|kg|units?|bundles?|packs?|pairs?)\b/gi, ' ')
    .replace(/[₦=@:\-–,.;!]+/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!/\p{L}{2}/u.test(name)) return null;
  name = name.slice(0, 40).trim();
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return { name, price, delivery, voice: voice ?? 'english' };
}
