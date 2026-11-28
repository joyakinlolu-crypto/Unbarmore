import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from './supabase';
import { hashToken } from './auth';
import { ADMIN_COOKIE, ADMIN_HOURS, VIEWAS_COOKIE, VIEWAS_HOURS, signAdmin, signViewAs, verifyAdmin } from './jwt';

const cookieOpts = (hours: number) => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge: hours * 3600 });

export async function isAdmin(): Promise<boolean> { return verifyAdmin((await cookies()).get(ADMIN_COOKIE)?.value); }

/** Every admin page AND every admin server action calls this first: server actions are public endpoints. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect('/admin/login');
}

/** Single-use link from the bot ("ADMIN LINK" on WhatsApp). True exactly once, within 10 minutes. */
export async function redeemAdminToken(raw: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(raw)) return false;
  const { data, error } = await db.rpc('consume_admin_token', { p_token_hash: hashToken(raw) });
  return !error && data === true;
}

export async function startAdminSession() { (await cookies()).set(ADMIN_COOKIE, await signAdmin(), cookieOpts(ADMIN_HOURS)); }
export async function endAdminSession() { const j = await cookies(); j.delete(ADMIN_COOKIE); j.delete(VIEWAS_COOKIE); }
export async function startViewAs(businessId: string) { (await cookies()).set(VIEWAS_COOKIE, await signViewAs(businessId), cookieOpts(VIEWAS_HOURS)); }
export async function endViewAs() { (await cookies()).delete(VIEWAS_COOKIE); }

/** Who looked at / changed whose shop. Never throws: a logging hiccup must not block the action, but it is printed. */
export async function audit(action: string, shop: { id: string; name: string } | null, detail: Record<string, unknown> = {}) {
  const { error } = await db.from('admin_audit').insert({ action, business_id: shop?.id ?? null, business_name: shop?.name ?? null, detail });
  if (error) console.error('[admin_audit] not recorded:', error.message);
}
