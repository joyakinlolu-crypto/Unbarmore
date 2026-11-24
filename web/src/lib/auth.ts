import 'server-only';
import crypto from 'node:crypto';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from './supabase';
import { SESSION_COOKIE, SESSION_DAYS, signSession, verifySession, type SessionClaims } from './jwt';

export const hashToken = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');
export const newRawToken = () => crypto.randomBytes(32).toString('hex');

export interface Business {
  id: string; name: string; owner_phone: string; rc_number: string | null; studio_theme: string;
  subscription_tier: 'trial' | 'free_limited' | 'starter_5k' | 'growth_15k';
  billing_cycle: 'monthly' | 'annual'; subscription_expires_at: string; trial_ends_at: string;
  referral_code: string; referral_wallet_ngn: number; total_value_recovered_ngn: number;
  google_sheet_id: string | null; business_category: string | null;
  logo_url: string | null; created_at: string; videos_used_this_month: number;
}
export interface Session extends SessionClaims { business: Business }

export async function redeemToken(raw: string): Promise<SessionClaims | null> {
  if (!/^[a-f0-9]{64}$/.test(raw)) return null;
  const { data, error } = await db.rpc('consume_magic_token', { p_token_hash: hashToken(raw) });
  const row = (data as { user_id: string; business_id: string; role: string }[] | null)?.[0];
  if (error || !row) return null;
  return { sub: row.user_id, business_id: row.business_id, role: 'owner' };
}

export async function startSession(claims: SessionClaims) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await signSession(claims), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400,
  });
}

export async function endSession() { (await cookies()).delete(SESSION_COOKIE); }

/**
 * Cookie → JWT → live DB check. The JWT alone is not enough: a deactivated user or a deleted business
 * must lose access immediately, not in 30 days.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const claims = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!claims) return null;
  const lookup = () => db.from('business_users').select('id, role, is_active, businesses(*)')
    .eq('id', claims.sub).eq('business_id', claims.business_id).maybeSingle();
  let { data, error } = await lookup();
  if (error) ({ data, error } = await lookup()); // one retry for a network blip
  // A failed lookup is NOT "logged out": throw so the user sees an error page and can retry, instead of being bounced to /login.
  if (error) throw new Error(`session lookup failed: ${error.message}`);
  const row = data as unknown as { is_active: boolean; role: 'owner' | 'staff'; businesses: Business } | null;
  if (!row || !row.is_active || row.role !== 'owner') return null;
  return { ...claims, business: row.businesses };
});

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}
