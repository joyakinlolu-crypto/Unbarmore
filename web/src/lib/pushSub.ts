const B64URL = /^[A-Za-z0-9_-]{16,200}$/;

/** What a browser's PushSubscription.toJSON() looks like. */
export interface SubscribeBody { endpoint: string; keys: { p256dh: string; auth: string } }

/** Strict check of an untrusted subscription before it is stored: https endpoint, sane sizes, base64url keys. */
export function parseSubscription(raw: unknown): SubscribeBody | null {
  const b = raw as Partial<SubscribeBody> | null;
  if (!b || typeof b.endpoint !== 'string' || b.endpoint.length > 2048) return null;
  let url: URL;
  try { url = new URL(b.endpoint); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const k = b.keys;
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || !B64URL.test(k.p256dh) || !B64URL.test(k.auth)) return null;
  return { endpoint: b.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}
