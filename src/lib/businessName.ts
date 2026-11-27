/**
 * When onboarding asks "What is your business name?", people often answer with a greeting or a word like "ok".
 * (Real accounts were created named "Hi" and "Sent".) A name like that would then show on every receipt, so ask again.
 */
const NOT_A_NAME = /^(hi+|hello+|hey+|hiya|hola|yo|sup|good\s*(morning|afternoon|evening|day)|gm|ok(ay)?|yes|yeah|no|nope|test(ing)?|sent|done|start|menu|help|stop|skip|thanks?|thank\s*you|please|abeg|oga|boss|sir|madam)[\s.!?]*$/i;

export function looksLikeBusinessName(raw: string): boolean {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 80) return false;
  if (NOT_A_NAME.test(t)) return false;
  if (!/\p{L}{2}/u.test(t)) return false; // needs at least two letters in a row ("12345" or "??" is not a name)
  return true;
}

/**
 * People answer "What is your business name?" with a sentence ("My business Name is TeweTegbo. We deal with herbal remedies…").
 * Pull out just the name. Returns null when it cannot be sure (the bot then asks again for a SHORT name).
 */
export function extractBusinessName(raw: string): string | null {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^(hi+|hello+|hey+|good\s*(morning|afternoon|evening))[,.!\s]+/i, '');
  // "my business name is X", "business name: X", "our shop is X"
  const m = t.match(/(?:^|\b)(?:my|our|the)?\s*(?:business|shop|company|brand|store|firm)(?:\s*name)?\s*(?:is|na|:|=|-|–)?\s+(.+)$/i);
  if (m) t = m[1]!;
  t = t.replace(/^(it'?s|it is|i am|i'm|we are|we're|call me|na|they call it|called)\s+/i, '');
  // a description, not a name: "We deal in lace and ankara"
  if (/^(we|i)\s+(deal|sell|make|do|offer|specialize|specialise|run|buy)\b/i.test(t)) return null;
  // cut at the end of the name: first full stop/!/?/;, a dash, a comma before a description, or "we deal…"
  t = t.split(/[.!?;\n]|\s[-–—]\s|,\s*(?:we|and we|i|which|that|a |an |the )|\s+(?:we|which|that|where|and we)\s+(?:deal|sell|make|do|are|offer|specialize|specialise|run)\b/i)[0]!;
  t = t.replace(/^["'“‘]+|["'”’]+$/g, '').replace(/\s+(and|&)$/i, '').trim();
  if (t.length > 50) return null;
  return looksLikeBusinessName(t) ? t : null;
}
