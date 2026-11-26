/**
 * Instant failure alerts to the platform owner's WhatsApp (ADMIN_PHONE).
 *
 * Rules that make this safe to leave on:
 *  - The SAME problem alerts once per cooldown (default 10 min); repeats are counted, not sent.
 *  - At most MAX_PER_HOUR alerts an hour, so an outage can never turn into 500 messages.
 *  - Secrets (API keys, tokens) are scrubbed before anything is stored or sent.
 *  - Never throws: an alert that fails must not break the thing that was being reported.
 *
 * WhatsApp only lets a business message someone FIRST inside 24h of their last message to the bot (outside it needs an
 * approved template, which needs business verification). So when the owner's window is closed, alerts are queued and
 * delivered the moment the owner next messages the bot (or sends ALERTS). Message the bot once a day to keep it open.
 */
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { isInServiceWindow } from '../db/supabase.js';
import { reply } from '../services/whatsapp.js';

export type AlertKind = 'video' | 'gemini' | 'webhook' | 'worker' | 'system' | 'test';
export type AlertResult = 'sent' | 'queued' | 'suppressed' | 'no_admin';

const MAX_PER_HOUR = 30;
const LOG_KEY = 'alerts:log';
const MISSED_KEY = 'alerts:missed';
const ICON: Record<AlertKind, string> = { video: '🎬', gemini: '🤖', webhook: '📡', worker: '⚙️', system: '🖥️', test: '🧪' };

let client: Redis | null = null;
const redis = () => (client ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, commandTimeout: 4000 }));

/** Where alerts go: ADMIN_PHONE, else OPS_ALERT_PHONE. */
export const alertTarget = (): string | null => env.ADMIN_PHONE ?? env.OPS_ALERT_PHONE ?? null;

/** Remove anything that looks like a credential, and keep it short. */
export function scrub(s: string, max = 280): string {
  return s
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]')
    .replace(/\b(sk|pk|rk)_(live|test)_[0-9A-Za-z]{10,}/g, '[key]')
    .replace(/(Bearer|apikey|api_key|token|secret|password)["':= ]+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const watClock = () => new Date(Date.now() + 3600_000).toISOString().slice(11, 16); // WAT = UTC+1, no DST

/** The one entry point. `key` makes "same problem" specific (e.g. a video id); cooldown is seconds. */
export async function alertAdmin(kind: AlertKind, title: string, detail = '', opts: { key?: string; cooldownS?: number } = {}): Promise<AlertResult> {
  try {
    const to = alertTarget();
    const line = `${ICON[kind]} ${title}${detail ? ` — ${scrub(detail)}` : ''}`;
    if (!to) { console.error('[alert:no-admin-phone]', line); return 'no_admin'; }

    const r = redis();
    const id = createHash('sha1').update(`${kind}|${title}|${opts.key ?? ''}`).digest('hex').slice(0, 16);
    const fresh = await r.set(`alert:d:${id}`, '1', 'EX', opts.cooldownS ?? 600, 'NX');
    if (!fresh) { await r.incr(`alert:sup:${id}`); return 'suppressed'; }

    const bucket = Math.floor(Date.now() / 3600_000);
    const n = await r.incr(`alert:hour:${bucket}`);
    if (n === 1) await r.expire(`alert:hour:${bucket}`, 7200);
    if (n > MAX_PER_HOUR) return 'suppressed';
    const storm = n === MAX_PER_HOUR ? '\n⚠️ Alert limit reached for this hour. Further alerts are held back; check Railway logs.' : '';

    const text = `🚨 *Unbarmore alert* ${watClock()} WAT\n${line}${storm}`;
    await r.lpush(LOG_KEY, JSON.stringify({ t: Date.now(), kind, text: line })).then(() => r.ltrim(LOG_KEY, 0, 49)).then(() => r.expire(LOG_KEY, 7 * 86400));

    if (await isInServiceWindow(to)) {
      try { await reply(to).text(text).send(); return 'sent'; } catch (e) { console.error('[alert] send failed, queued', String((e as Error)?.message ?? e).slice(0, 160)); }
    }
    await r.lpush(MISSED_KEY, text).then(() => r.ltrim(MISSED_KEY, 0, 49)).then(() => r.expire(MISSED_KEY, 3 * 86400));
    return 'queued';
  } catch (e) {
    console.error('[alert] could not raise alert:', String((e as Error)?.message ?? e).slice(0, 160));
    return 'suppressed';
  }
}

/** Alerts that could not be sent because the 24h window was closed. Returns them oldest-first and clears the queue. */
export async function takeMissedAlerts(): Promise<string[]> {
  try {
    const r = redis();
    const items = await r.lrange(MISSED_KEY, 0, -1);
    if (items.length) await r.del(MISSED_KEY);
    return items.reverse();
  } catch { return []; }
}

/** Last N alerts (any status), newest first: for the ALERTS command. */
export async function recentAlerts(n = 10): Promise<{ t: number; kind: AlertKind; text: string }[]> {
  try { return (await redis().lrange(LOG_KEY, 0, n - 1)).map((s) => JSON.parse(s)); } catch { return []; }
}

// ───────────── Gemini errors ─────────────

export type GeminiErrorClass = '402' | '401' | '403' | '429' | '500' | '503' | 'other';

export function classifyGeminiError(err: unknown): GeminiErrorClass {
  const m = String((err as { message?: string })?.message ?? err);
  const status = Number((err as { status?: number })?.status);
  if (status === 402 || /prepayment credits are depleted|\b402\b/i.test(m)) return '402';
  if (status === 401 || /\b401\b|API key not valid|API_KEY_INVALID/i.test(m)) return '401';
  if (status === 403 || /\b403\b|PERMISSION_DENIED|has been suspended|disabled/i.test(m)) return '403';
  if (status === 429 || /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(m)) return '429';
  if (status === 500 || /\b500\b|INTERNAL/i.test(m)) return '500';
  if (status === 503 || /\b503\b|UNAVAILABLE|high demand/i.test(m)) return '503';
  return 'other';
}

/**
 * Call from any place a Gemini call finally failed. Critical errors (402 credits gone, 401/403 key bad, 500) alert at once;
 * the noisy ones (429 quota, 503 "high demand") only when they keep happening, so one Google blip never pages you.
 */
export async function noteGeminiError(where: string, err: unknown): Promise<void> {
  try {
    const cls = classifyGeminiError(err);
    const detail = `${where}: ${String((err as { message?: string })?.message ?? err)}`;
    switch (cls) {
      case '402':
        await alertAdmin('gemini', 'Gemini credits are used up (402). Voice, photos, videos and replies are failing', `Top up at ai.studio/projects. ${where}`, { key: '402', cooldownS: 1800 });
        break;
      case '401': case '403':
        await alertAdmin('gemini', `Gemini key rejected (${cls}). Everything AI is failing`, detail, { key: cls, cooldownS: 1800 });
        break;
      case '500':
        await alertAdmin('gemini', 'Gemini returned a server error (500)', detail, { key: `500:${where}`, cooldownS: 600 });
        break;
      case '429': case '503': {
        const r = redis();
        const k = `alert:gem:${cls}`;
        const n = await r.incr(k);
        if (n === 1) await r.expire(k, 600);
        const threshold = cls === '429' ? 3 : 8;
        if (n === threshold) {
          await alertAdmin('gemini', cls === '429' ? `Gemini quota/rate limit hit ${n} times in 10 min` : `Google's AI is overloaded: ${n} failures in 10 min`, detail, { key: cls, cooldownS: 1800 });
        }
        break;
      }
      default: break; // 400s and schema mistakes are bugs, not outages
    }
  } catch { /* alerting never breaks the caller */ }
}
