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
