import { NextResponse, type NextRequest } from 'next/server';
import { redeemToken, startSession } from '@/lib/auth';

export const runtime = 'nodejs';

const page = (token: string, error = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Open Unbarmore</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1E3A8A;font-family:system-ui,sans-serif;padding:16px}
.c{background:#fff;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center;color:#1E293B}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#64748b;font-size:15px}
button,a.b{display:block;width:100%;box-sizing:border-box;padding:14px;border:0;border-radius:12px;background:#2563EB;color:#fff;font-size:16px;font-weight:600;text-decoration:none}</style></head>
<body><div class="c">${error
  ? `<h1>Link expired</h1><p>Login links work once and last 15 minutes.</p><a class="b" href="/login">Get a new link</a>`
  : `<h1>Welcome back 👋</h1><p>Tap below to open your Unbarmore dashboard.</p>
<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${token}"><button type="submit">Open my dashboard</button></form>`}
</div></body></html>`;

const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/**
 * GET only RENDERS a confirm button — it never consumes the token.
 * WhatsApp (and many link scanners) fetch URLs server-side to build previews; if GET logged you in, the preview
 * bot would burn the single-use token before you ever tapped it.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new NextResponse(page('', true), { status: 400, headers });
  return new NextResponse(page(token), { headers });
}

export async function POST(req: NextRequest) {
  const token = String((await req.formData()).get('token') ?? '');
  const claims = await redeemToken(token);
  if (!claims) return NextResponse.redirect(new URL('/login?error=expired', req.url), 303);
  await startSession(claims);
  return NextResponse.redirect(new URL('/dashboard', req.url), 303);
}
