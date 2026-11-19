import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Unbarmore Business Co-Pilot', template: '%s · Unbarmore' },
  description: 'Your sales, profit and cash — from WhatsApp, on your home screen.',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-192.png' },
  appleWebApp: { capable: true, title: 'Unbarmore', statusBarStyle: 'black-translucent' },
  robots: { index: false },
};
export const viewport: Viewport = { themeColor: '#1E3A8A', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body className="min-h-dvh antialiased">{children}</body></html>;
}
