// Edge/proxy-safe: only `jose`, no Node crypto, no DB.
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'unbarmore_session';
export const SESSION_DAYS = 30;

export interface SessionClaims { sub: string; business_id: string; role: 'owner' | 'staff' }

const key = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (32+ chars)');
  return new TextEncoder().encode(s);
};

export async function signSession(c: SessionClaims): Promise<string> {
  return new SignJWT({ business_id: c.business_id, role: c.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setIssuer('unbarmore')
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(key());
}

export async function verifySession(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'], issuer: 'unbarmore' });
    if (typeof payload.sub !== 'string' || typeof payload.business_id !== 'string') return null;
    return { sub: payload.sub, business_id: payload.business_id, role: payload.role === 'staff' ? 'staff' : 'owner' };
  } catch {
    return null;
  }
}

// ───────────── Admin console ─────────────
// Separate cookies and separate JWT issuers: a shop-owner session can never be accepted as an admin session, nor the reverse.
export const ADMIN_COOKIE = 'unbarmore_admin';
export const VIEWAS_COOKIE = 'unbarmore_viewas';
export const ADMIN_HOURS = 8;
export const VIEWAS_HOURS = 2;

export async function signAdmin(): Promise<string> {
  return new SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).setSubject('admin').setIssuedAt().setIssuer('unbarmore-admin').setExpirationTime(`${ADMIN_HOURS}h`).sign(key());
}
export async function verifyAdmin(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try { const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'], issuer: 'unbarmore-admin' }); return payload.sub === 'admin' && payload.role === 'admin'; }
  catch { return false; }
}

/** "Look at this shop as its owner would": which shop, for how long. Only honoured together with a valid admin cookie. */
export async function signViewAs(businessId: string): Promise<string> {
  return new SignJWT({ business_id: businessId }).setProtectedHeader({ alg: 'HS256' }).setSubject('admin').setIssuedAt().setIssuer('unbarmore-viewas').setExpirationTime(`${VIEWAS_HOURS}h`).sign(key());
}
export async function verifyViewAs(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try { const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'], issuer: 'unbarmore-viewas' }); return typeof payload.business_id === 'string' ? payload.business_id : null; }
  catch { return null; }
}
