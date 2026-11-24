/** The two Redis calls we need, so tests can use a tiny fake instead of a server. */
export interface Counter { incr(key: string): Promise<number>; expire(key: string, seconds: number): Promise<unknown> }

/** Count one use against a per-key daily cap. `n` is how many uses so far today (including this one). */
export async function dailyCount(c: Counter, key: string, cap: number): Promise<{ ok: boolean; n: number }> {
  const n = await c.incr(key);
  if (n === 1) await c.expire(key, 86_400);
  return { ok: n <= cap, n };
}
