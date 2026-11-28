import { NextResponse, type NextRequest } from 'next/server';
import { audit, redeemAdminToken, startAdminSession } from '@/lib/admin';

export const runtime = 'nodejs';
const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const page = (token: string, error = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0F172A;font-family:system-ui,sans-serif;padding:16px}.c{background:#fff;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center;color:#1E293B}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#64748b;font-size:15px}button,a.b{display:block;width:100%;box-sizing:border-box;padding:14px;border:0;border-radius:12px;background:#0F172A;color:#fff;font-size:16px;font-weight:600;text-decoration:none}</style></head>
<body><div class="c">${error ? '<h1>Link expired</h1><p>Admin links work once and last 10 minutes. Send ADMIN LINK to the bot again.</p><a class="b" href="/admin/login">OK</a>'
  : `<h1>🔐 Admin console</h1><p>Tap to open it.</p><form method="post" action="/admin/verify"><input type="hidden" name="token" value="${token}"><button type="submit">Open admin</button></form>`}</div></body></html>`;

/** GET only SHOWS a button and never consumes the token: WhatsApp's link preview fetches URLs and would burn a single-use link. */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new NextResponse(page('', true), { status: 400, headers });
  return new NextResponse(page(token), { headers });
}

export async function POST(req: NextRequest) {
  const token = String((await req.formData()).get('token') ?? '');
  if (!(await redeemAdminToken(token))) return new NextResponse(page('', true), { status: 400, headers });
  await startAdminSession();
  await audit('login', null, { ua: (req.headers.get('user-agent') ?? '').slice(0, 120) });
  return NextResponse.redirect(new URL('/admin', req.url), 303);
}
