/**
 * Photos already cleaned for an earlier video can be reused (saving ~₦60 each) ONLY when it is certain they are the same photos:
 * the earlier video was made from exactly the same uploaded files, and each cleaned file sits at the position of its own photo
 * (cleaned files are named "<business>/<video>-<index>.<ext>").
 */
export function reusableCleaned(rawNow: string[], candidates: { raw: string[]; cleaned: string[] }[]): string[] {
  for (const c of candidates) {
    const sameFiles = c.raw.length === rawNow.length && c.raw.every((x, i) => x === rawNow[i]);
    const aligned = c.cleaned.every((p, i) => !p || new RegExp(`-${i}\\.[a-z]+$`).test(p));
    if (sameFiles && aligned && c.cleaned.some(Boolean)) return c.cleaned;
  }
  return [];
}
