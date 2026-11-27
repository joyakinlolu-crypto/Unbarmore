/**
 * Per-shop AI usage log. The business is carried in AsyncLocalStorage, set once per inbound message / video job, so the
 * low-level AI calls (router, voice, photo cleanup) don't need to know whose work they are doing.
 * Logging is fire-and-forget and never breaks the real work; if migration 008 has not been run it quietly does nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../db/supabase.js';
import { watDateKey } from './money.js';
import { summariseUsage, type UsageMetadata } from './aiCost.js';

export type UsageKind = 'message' | 'voice' | 'screenshot' | 'script' | 'voiceover' | 'photo_cleanup';
const store = new AsyncLocalStorage<{ businessId: string | null }>();

/** Everything the current async job does from here on is attributed to this business. */
export const bindUsageToBusiness = (businessId: string | null): void => { store.enterWith({ businessId }); };

let warned = false;
export function recordUsage(kind: UsageKind, md: UsageMetadata | undefined | null, extra: { images?: number } = {}): void {
  try {
    const businessId = store.getStore()?.businessId;
    if (!businessId || !md) return;
    const s = summariseUsage(md);
    void Promise.resolve(db.rpc('log_ai_usage', {
      p_business_id: businessId, p_day: watDateKey(), p_kind: kind, p_calls: 1,
      p_in: s.inTokens, p_out: s.outTokens, p_images: extra.images ?? 0, p_cost: Math.round(s.estCostNgn * 10000) / 10000,
    })).then(({ error }) => {
      if (error && !warned) { warned = true; console.warn('[usage] not logged (migration 008 not applied?):', error.message); }
    }).catch(() => undefined);
  } catch { /* logging must never break the work */ }
}
