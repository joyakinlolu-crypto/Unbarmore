import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_COOKIE, SESSION_COOKIE, VIEWAS_COOKIE, verifyAdmin, verifySession, verifyViewAs } from '@/lib/jwt';

/** Fast gate: valid, unexpired JWT cookie. Pages/routes still re-check the user against the DB (getSession / requireAdmin). */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const admin = await verifyAdmin(req.cookies.get(ADMIN_COOKIE)?.value);

  // Admin console: everything except the login page and the single-use link redemption needs the admin cookie.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (pathname === '/admin/login' || pathname === '/admin/verify') return NextResponse.next();
    if (admin) return NextResponse.next();
    return NextResponse.redirect(new URL('/admin/login', req.url));
  }

  // The owner app: a real owner session, or an admin who is currently viewing a shop.
  const ok = !!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) || (admin && !!(await verifyViewAs(req.cookies.get(VIEWAS_COOKIE)?.value)));

  // NOTE: /login is deliberately NOT redirected here. A cookie that is cryptographically valid can still be refused by the
  // database check (deactivated user, deleted business); bouncing /login → /dashboard → /login made an infinite loop.
  // The login page itself does the DB-verified "already logged in → /dashboard" redirect.
  if (ok) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL('/login', req.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/dashboard/:path*', '/advisor/:path*', '/charts/:path*', '/ledger/:path*', '/settings/:path*', '/admin', '/admin/:path*', '/api/chat', '/api/export', '/api/receipt/:path*', '/api/push/:path*'],
};
