import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { db } from '../db/supabase.js';

/**
 * Single-use login link for the web companion (app.unbarmore.com). Only the SHA-256 of the token is stored,
 * so a database leak cannot be replayed. Owner only: the dashboard shows profit and debts, which staff must not see.
 * Returns null when throttled (3 per 10 minutes per user).
 */
export async function createOwnerMagicLink(businessId: string): Promise<string | null> {
  const { data: owner } = await db.from('business_users').select('id').eq('business_id', businessId).eq('role', 'owner').eq('is_active', true).maybeSingle();
  if (!owner) return null;
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const { data, error } = await db.rpc('issue_magic_token', { p_token_hash: hash, p_business_id: businessId, p_user_id: owner.id });
  if (error) throw new Error(`issue_magic_token: ${error.message}`);
  return data === true ? `${env.WEB_APP_URL.replace(/\/$/, '')}/auth/verify?token=${raw}` : null;
}
