import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Unbarmore Business Co-Pilot',
    short_name: 'Unbarmore',
    description: 'Your sales, profit and cash — from WhatsApp, on your home screen.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#1E3A8A',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
