import webpush from 'web-push';
import { env } from '../config/env.js';
import { db } from '../db/supabase.js';

/** What the service worker shows. `url` is where a tap lands (same-origin path). */
export interface PushPayload { title: string; body: string; url?: string; tag?: string }

export const pushEnabled = (): boolean => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

let configured = false;
function configure() {
  if (configured) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT ?? env.WEB_APP_URL, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  configured = true;
}

/** Businesses that have at least one subscribed device. Missing table (migration 004 not run yet) → none, never a crash. */
export async function businessesWithPush(): Promise<string[]> {
  if (!pushEnabled()) return [];
  const { data, error } = await db.from('push_subscriptions').select('business_id').limit(10_000);
  if (error) return [];
  return [...new Set((data ?? []).map((r) => r.business_id as string))];
}

/**
 * Send to every device of one business. Returns how many devices accepted it.
 * A device the browser reports as gone (404/410) is deleted; any other failure just counts against it, never throws.
 */
export async function sendPushToBusiness(businessId: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled()) return 0;
  configure();
  const { data, error } = await db.from('push_subscriptions').select('id, endpoint, p256dh, auth, fail_count').eq('business_id', businessId);
  if (error || !data?.length) return 0;
  const body = JSON.stringify(payload);
  let delivered = 0;
  for (const s of data) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } }, body, { TTL: 6 * 3600, urgency: 'normal' });
      delivered++;
      await db.from('push_subscriptions').update({ last_sent_at: new Date().toISOString(), fail_count: 0 }).eq('id', s.id);
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
      else if (Number(s.fail_count) + 1 >= 10) await db.from('push_subscriptions').delete().eq('id', s.id); // dead for 10 sends in a row
      else await db.from('push_subscriptions').update({ fail_count: Number(s.fail_count) + 1 }).eq('id', s.id);
    }
  }
  return delivered;
}
