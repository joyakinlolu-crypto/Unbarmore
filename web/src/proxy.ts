import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/jwt';

/** Fast gate: valid, unexpired JWT cookie. Pages/routes still re-check the user against the DB (getSession). */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const ok = !!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value));

  // NOTE: /login is deliberately NOT redirected here. A cookie that is cryptographically valid can still be refused by the
  // database check (deactivated user, deleted business); bouncing /login → /dashboard → /login made an infinite loop.
  // The login page itself does the DB-verified "already logged in → /dashboard" redirect.
  if (ok) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL('/login', req.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/dashboard/:path*', '/advisor/:path*', '/ledger/:path*', '/settings/:path*', '/api/chat', '/api/export', '/api/receipt/:path*', '/api/push/:path*'],
};
