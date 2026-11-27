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
