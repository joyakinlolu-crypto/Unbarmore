/** How many INCLUDED videos a shop has made today (WAT). Redis, 2-day expiry. Fails open: a Redis hiccup must never stop a customer. */
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { watDateKey } from './money.js';

let client: Redis | null = null;
const redis = () => (client ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, commandTimeout: 3000 }));
const key = (businessId: string) => `vid_today:${businessId}:${watDateKey()}`;

export async function videosToday(businessId: string): Promise<number> {
  try { return Number((await redis().get(key(businessId))) ?? 0); } catch { return 0; }
}
export async function countVideoToday(businessId: string): Promise<void> {
  try { const n = await redis().incr(key(businessId)); if (n === 1) await redis().expire(key(businessId), 172_800); } catch { /* fail open */ }
}
export async function uncountVideoToday(businessId: string): Promise<void> {
  try { const v = Number((await redis().get(key(businessId))) ?? 0); if (v > 0) await redis().decr(key(businessId)); } catch { /* fail open */ }
}
