'use server';
import { revalidatePath } from 'next/cache';
import { audit, requireAdmin } from '@/lib/admin';
import { COMP_MAX_DAYS, COMP_TIERS, GRANT_MAX, TRIAL_EXTEND_MAX, boundedInt, extendedTrialEnd } from '@/lib/adminMetrics';
import { db } from '@/lib/supabase';

export type ActionResult = { ok: boolean; message: string };
const UUID = /^[0-9a-f-]{36}$/;

async function shopOf(id: string) {
  if (!UUID.test(id)) return null;
  const { data } = await db.from('businesses').select('id, name, subscription_tier, trial_ends_at, subscription_expires_at').eq('id', id).maybeSingle();
  return data as { id: string; name: string; subscription_tier: string; trial_ends_at: string; subscription_expires_at: string } | null;
}

/** Give a shop extra videos (e.g. after a bank transfer, or as a thank-you). */
export async function grantVideos(id: string, _prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  await requireAdmin();                                                    // server actions are public endpoints: always re-check
  const shop = await shopOf(id); if (!shop) return { ok: false, message: 'Shop not found.' };
  const qty = boundedInt(form.get('qty'), 1, GRANT_MAX);
  if (qty === null) return { ok: false, message: `Enter a whole number from 1 to ${GRANT_MAX}.` };
  const { data, error } = await db.rpc('add_video_credits', { p_business_id: id, p_qty: qty });
  if (error) return { ok: false, message: 'Could not add credits (has migration 008 been run?).' };
  await audit('grant_videos', shop, { qty, balance: data });
  revalidatePath(`/admin/shops/${id}`);
  return { ok: true, message: `Added ${qty} video credit${qty > 1 ? 's' : ''}. Balance: ${String(data)}.` };
}

/** Give a trial more days. Extends from whichever is later, today or the current end. A shop already on the free plan goes back to trial. */
export async function extendTrial(id: string, _prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  const shop = await shopOf(id); if (!shop) return { ok: false, message: 'Shop not found.' };
  const days = boundedInt(form.get('days'), 1, TRIAL_EXTEND_MAX);
  if (days === null) return { ok: false, message: `Enter a whole number of days from 1 to ${TRIAL_EXTEND_MAX}.` };
  if (shop.subscription_tier === 'starter_5k' || shop.subscription_tier === 'growth_15k') return { ok: false, message: 'This shop is on a paid plan. Use "Give a plan" instead.' };
  const end = extendedTrialEnd(shop.trial_ends_at, days);
  const { error } = await db.from('businesses').update({ subscription_tier: 'trial', trial_ends_at: end, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { ok: false, message: 'Could not save.' };
  await audit('extend_trial', shop, { days, from: shop.trial_ends_at, to: end, tier_before: shop.subscription_tier });
  revalidatePath(`/admin/shops/${id}`);
  return { ok: true, message: `Trial now runs to ${end.slice(0, 10)}.` };
}

/** Give a plan free for a number of days (a pilot partner, a goodwill gesture). It lapses by itself: the hourly job downgrades it after the end date. */
export async function compPlan(id: string, _prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  await requireAdmin();
  const shop = await shopOf(id); if (!shop) return { ok: false, message: 'Shop not found.' };
  const tier = String(form.get('tier') ?? '');
  if (!(COMP_TIERS as readonly string[]).includes(tier)) return { ok: false, message: 'Pick Starter or Growth.' };
  const days = boundedInt(form.get('days'), 1, COMP_MAX_DAYS);
  if (days === null) return { ok: false, message: `Enter a whole number of days from 1 to ${COMP_MAX_DAYS}.` };
  const end = new Date(Date.now() + days * 86_400_000).toISOString();
  const { error } = await db.from('businesses').update({ subscription_tier: tier, billing_cycle: 'monthly', subscription_expires_at: end, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return { ok: false, message: 'Could not save.' };
  await audit('comp_plan', shop, { tier, days, until: end, tier_before: shop.subscription_tier });
  revalidatePath(`/admin/shops/${id}`);
  return { ok: true, message: `${tier === 'growth_15k' ? 'Growth' : 'Starter'} until ${end.slice(0, 10)}, then it drops back by itself.` };
}
