import { describe, expect, it } from 'vitest';
import { parseSubscription } from '@/lib/pushSub';

const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const ok = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys };

describe('push subscription validation', () => {
  it('accepts a real browser subscription', () => { expect(parseSubscription(ok)).toEqual(ok); });
  it('rejects non-https endpoints (no plain http, no javascript:/data: tricks)', () => {
    for (const endpoint of ['http://push.example/x', 'javascript:alert(1)', 'data:text/plain,hi', 'not a url', '']) expect(parseSubscription({ ...ok, endpoint })).toBeNull();
  });
  it('rejects missing, oversized or non-base64url keys', () => {
    expect(parseSubscription({ endpoint: ok.endpoint })).toBeNull();
    expect(parseSubscription({ ...ok, keys: { p256dh: 'short', auth: keys.auth } })).toBeNull();
    expect(parseSubscription({ ...ok, keys: { p256dh: keys.p256dh, auth: 'has spaces and <tags>!!' } })).toBeNull();
    expect(parseSubscription({ ...ok, keys: { p256dh: 'A'.repeat(500), auth: keys.auth } })).toBeNull();
  });
  it('rejects junk and absurdly long endpoints', () => {
    for (const v of [null, undefined, 42, 'x', [], {}]) expect(parseSubscription(v)).toBeNull();
    expect(parseSubscription({ ...ok, endpoint: 'https://push.example/' + 'a'.repeat(3000) })).toBeNull();
  });
  it('drops extra fields so only the three we need are stored', () => {
    expect(Object.keys(parseSubscription({ ...ok, evil: 'x', expirationTime: null })!)).toEqual(['endpoint', 'keys']);
  });
});
