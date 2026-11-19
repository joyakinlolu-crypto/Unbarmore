import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

const withSerwist = withSerwistInit({
  swSrc: 'src/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  additionalPrecacheEntries: [{ url: '/offline', revision: process.env.VERCEL_GIT_COMMIT_SHA ?? 'v1' }],
});

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ['pdfkit'],
  // pdfkit reads its font data from disk; make sure the bundled fonts ship with the serverless function.
  outputFileTracingIncludes: { '/api/export': ['./assets/fonts/**/*'] },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};

export default withSerwist(config);
