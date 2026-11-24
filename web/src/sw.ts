import { defaultCache } from '@serwist/next/worker';
import { CacheFirst, ExpirationPlugin, NetworkFirst, Serwist, type PrecacheEntry, type SerwistGlobalConfig } from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig { __SW_MANIFEST: (PrecacheEntry | string)[] | undefined }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Never cache anything that carries a session, a token, a file or a stream.
    { matcher: ({ url }) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'), handler: new NetworkFirst({ networkTimeoutSeconds: 10, cacheName: 'noop-net', plugins: [{ cacheWillUpdate: async () => null }] }) },
    // Immutable build assets: instant on repeat opens.
    { matcher: ({ url }) => url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/'), handler: new CacheFirst({ cacheName: 'static', plugins: [new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 30 * 86400 })] }) },
    // App pages: show the last-seen version immediately if the network is slow (3G), refresh when it answers.
    { matcher: ({ request }) => request.mode === 'navigate', handler: new NetworkFirst({ cacheName: 'pages', networkTimeoutSeconds: 3, plugins: [new ExpirationPlugin({ maxEntries: 12, maxAgeSeconds: 7 * 86400 })] }) },
    ...defaultCache.filter((r) => String((r as { matcher?: unknown }).matcher).includes('font') || String((r as { matcher?: unknown }).matcher).includes('image')),
  ],
  fallbacks: { entries: [{ url: '/offline', matcher: ({ request }) => request.destination === 'document' }] },
});

serwist.addEventListeners();

// ───────────── Push: the evening "money today" note and the Sunday report ping ─────────────
interface PushData { title?: string; body?: string; url?: string; tag?: string }

self.addEventListener('push', (event) => {
  let d: PushData = {};
  try { d = event.data?.json() ?? {}; } catch { d = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Unbarmore', {
    body: d.body ?? '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag, // a newer note of the same kind replaces the old one instead of stacking
    data: { url: d.url?.startsWith('/') ? d.url : '/dashboard' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data as { url?: string } | undefined)?.url ?? '/dashboard', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = open.find((c) => c.url.startsWith(self.location.origin));
    if (same) { await same.focus(); if ('navigate' in same) await (same as WindowClient).navigate(url); }
    else await self.clients.openWindow(url);
  })());
});
