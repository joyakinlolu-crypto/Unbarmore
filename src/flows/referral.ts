import { db, findBusinessByReferralCode, updateBusiness, type Business } from '../db/supabase.js';
import { normalisePhone } from './records.js';

/**
 * Referral by BUSINESS NAME, not a code. A new owner is asked "who told you about Unbarmore?" and answers "Joy" or
 * "Joy Fabrics". We find the business, ask them to confirm it (so a lookalike name can't steal a reward), and only then link it.
 * A code (UNBAR-XXXX) or the referrer's phone number works too.
 */
export const REF_CODE_RE = /\bUNBAR-[A-Z2-9]{4}\b/i;

export interface Candidate { id: string; name: string }

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'of', 'my', 'is', 'by', 'from', 'a', 'shop', 'store', 'business', 'ventures', 'enterprises', 'enterprise', 'ltd', 'limited', 'nigeria']);
const tokens = (s: string) => fold(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t));

/** 3 = same name, 2 = every word they typed is in the name (or the reverse), 1 = a word in common, 0 = no match. Pure. */
export function scoreMatch(query: string, name: string): number {
  const q = fold(query), n = fold(name);
  if (!q || !n) return 0;
  if (q === n) return 3;
  const qt = tokens(query), nt = tokens(name);
  if (!qt.length || !nt.length) return 0;
  const inName = (t: string) => nt.some((x) => x === t || x.startsWith(t) || t.startsWith(x));
  if (qt.every(inName) || nt.every((t) => qt.some((x) => x === t || x.startsWith(t) || t.startsWith(x)))) return 2;
  return qt.some(inName) ? 1 : 0;
}

/** Best matches, best first, at most 3. Weak (score 1) matches only count when nothing stronger exists. Pure. */
export function rankCandidates(query: string, pool: Candidate[]): Candidate[] {
  const scored = pool.map((c) => ({ c, s: scoreMatch(query, c.name) })).filter((x) => x.s > 0);
  const best = Math.max(0, ...scored.map((x) => x.s));
  return scored.filter((x) => x.s === best).sort((a, b) => a.c.name.localeCompare(b.c.name)).slice(0, 3).map((x) => x.c);
}

const likeSafe = (s: string) => s.replace(/[%_\\,()]/g, ' ').trim();

export type ReferrerLookup =
  | { kind: 'found'; referrer: Business }               // a code: exact, no confirmation needed
  | { kind: 'confirm'; candidates: Candidate[] }        // a name or phone: ask "is it …?"
  | { kind: 'none' };

/** Turn whatever the new owner typed into a referrer. `selfId`/`selfPhone` keep people from referring themselves. */
export async function lookupReferrer(text: string, selfId: string, selfPhone: string): Promise<ReferrerLookup> {
  const code = text.match(REF_CODE_RE)?.[0]?.toUpperCase();
  if (code) {
    const b = await findBusinessByReferralCode(code);
    return b && b.id !== selfId && b.owner_phone !== selfPhone ? { kind: 'found', referrer: b } : { kind: 'none' };
  }
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 10 && text.replace(/[\d\s+()-]/g, '').length === 0) {
    const phone = normalisePhone(text);
    if (!phone || phone === selfPhone) return { kind: 'none' };
    const { data } = await db.from('businesses').select('id, name').eq('owner_phone', phone).maybeSingle();
    return data ? { kind: 'confirm', candidates: [data as Candidate] } : { kind: 'none' };
  }
  const q = text.trim().slice(0, 60);
  const words = tokens(q).sort((a, b) => b.length - a.length);
  if (!words.length) return { kind: 'none' };
  const { data } = await db.from('businesses').select('id, name, owner_phone').ilike('name', `%${likeSafe(words[0]!)}%`).neq('id', selfId).limit(25);
  const pool = ((data ?? []) as (Candidate & { owner_phone: string })[]).filter((c) => c.owner_phone !== selfPhone);
  const ranked = rankCandidates(q, pool);
  return ranked.length ? { kind: 'confirm', candidates: ranked } : { kind: 'none' };
}

/** Link `businessId` to a referrer once. Refuses self-referral, a second referral, and shops that have already paid. */
export async function linkReferrer(me: Pick<Business, 'id' | 'owner_phone' | 'referred_by_business_id' | 'referral_reward_paid'>, referrerId: string): Promise<Business | null> {
  if (referrerId === me.id || me.referred_by_business_id || me.referral_reward_paid) return null;
  const { data } = await db.from('businesses').select('*').eq('id', referrerId).maybeSingle();
  const referrer = data as Business | null;
  if (!referrer || referrer.owner_phone === me.owner_phone) return null;
  await updateBusiness(me.id, { referred_by_business_id: referrer.id });
  return referrer;
}
