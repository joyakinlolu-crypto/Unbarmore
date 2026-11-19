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
