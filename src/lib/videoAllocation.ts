/**
 * Which "wallet" pays for a new video?
 *   1. An INCLUDED video from the plan, if the monthly allowance is not used up AND the shop has made fewer than the daily limit today.
 *   2. Otherwise a bought VIDEO CREDIT (never blocked by the daily limit: someone who paid should get their video).
 *   3. Otherwise nothing: the caller shows why (daily limit vs. allowance used up) and offers to buy credits.
 */
export interface VideoDeps {
  dailyLimit: number;
  usedToday(): Promise<number>;
  consumeIncluded(): Promise<boolean>;   // atomic monthly-allowance check in the database
  countToday(): Promise<void>;
  consumeCredit(): Promise<boolean>;     // atomic credit decrement in the database
}
export type Allocation = { source: 'included' } | { source: 'credit' } | { source: 'none'; reason: 'daily' | 'allowance' };

export async function allocateVideo(d: VideoDeps, hasIncludedLeft: boolean): Promise<Allocation> {
  const dailyFull = (await d.usedToday()) >= d.dailyLimit;
  if (!dailyFull && (await d.consumeIncluded())) { await d.countToday(); return { source: 'included' }; }
  if (await d.consumeCredit()) return { source: 'credit' };
  return { source: 'none', reason: dailyFull && hasIncludedLeft ? 'daily' : 'allowance' };
}
