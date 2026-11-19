import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/jwt';

/** Fast gate: valid, unexpired JWT cookie. Pages/routes still re-check the user against the DB (getSession). */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const ok = !!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value));

  if (pathname === '/login') return ok ? NextResponse.redirect(new URL('/dashboard', req.url)) : NextResponse.next();
  if (ok) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL('/login', req.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/login', '/dashboard/:path*', '/advisor/:path*', '/ledger/:path*', '/settings/:path*', '/api/chat', '/api/export', '/api/receipt/:path*'],
};
