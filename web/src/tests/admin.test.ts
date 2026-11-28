import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.JWT_SECRET = 'x'.repeat(40); process.env.SUPABASE_URL = 'http://x.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'; process.env.GEMINI_API_KEY = 'x'; });
vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  admin: { current: true },
  audits: [] as unknown[][],
  dbCalls: [] as string[],
  rpc: { data: true as unknown, error: null as unknown },
  businesses: { current: { id: 'b'.repeat(8) + '-0000-0000-0000-000000000001', name: 'Ada Fabrics', subscription_tier: 'trial', trial_ends_at: '2026-12-01T00:00:00Z', subscription_expires_at: '2026-12-01T00:00:00Z' } as Record<string, unknown> | null },
  updates: [] as Record<string, unknown>[],
  session: { current: null as unknown },
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: (k: string) => (h.jar.has(k) ? { value: h.jar.get(k) } : undefined), set: (k: string, v: string) => { h.jar.set(k, v); }, delete: (k: string) => { h.jar.delete(k); } }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(f: T) => f }));   // no per-request caching in tests
vi.mock('@/lib/supabase', () => {
  const chain = (table: string): any => {
    let upd: Record<string, unknown> | null = null;
    const api: any = new Proxy({}, { get: (_t, prop: string) => {
      if (prop === 'then') return (res: (v: unknown) => void) => { if (upd) h.updates.push({ table, ...upd }); h.dbCalls.push(table); res({ data: table === 'businesses' ? h.businesses.current : null, error: null }); };
      return (...a: unknown[]) => { if (prop === 'update') upd = a[0] as Record<string, unknown>; if (prop === 'insert' && table === 'admin_audit') h.audits.push([a[0]]); return api; };
    } });
    return api;
  };
  return { db: { from: (t: string) => chain(t), rpc: async (fn: string, args: unknown) => { h.dbCalls.push(`rpc:${fn}`); h.audits.push([fn, args]); return { data: h.rpc.data, error: h.rpc.error }; } } };
});

import { ADMIN_COOKIE, SESSION_COOKIE, VIEWAS_COOKIE, signAdmin, signSession, signViewAs, verifyAdmin, verifySession, verifyViewAs } from '@/lib/jwt';
import { boundedInt, extendedTrialEnd, GRANT_MAX, attention, mrrNgn, shopGaps, shopStatus, type GapInput } from '@/lib/adminMetrics';

const BID = 'b'.repeat(8) + '-0000-0000-0000-000000000001';
const key = new TextEncoder().encode('x'.repeat(40));
beforeEach(() => { h.jar.clear(); h.audits.length = 0; h.dbCalls.length = 0; h.updates.length = 0; h.rpc.data = true; h.rpc.error = null; h.businesses.current = { id: BID, name: 'Ada Fabrics', subscription_tier: 'trial', trial_ends_at: '2026-12-01T00:00:00Z', subscription_expires_at: '2026-12-01T00:00:00Z' }; });

describe('admin tokens cannot be confused with shop sessions', () => {
  it('a shop owner session is NOT an admin; an admin cookie is NOT a shop session', async () => {
    const shop = await signSession({ sub: 'u1', business_id: BID, role: 'owner' });
    expect(await verifyAdmin(shop)).toBe(false); expect(await verifyViewAs(shop)).toBeNull();
    const admin = await signAdmin();
    expect(await verifyAdmin(admin)).toBe(true); expect(await verifySession(admin)).toBeNull(); expect(await verifyViewAs(admin)).toBeNull();
    const view = await signViewAs(BID);
    expect(await verifyViewAs(view)).toBe(BID); expect(await verifyAdmin(view)).toBe(false); expect(await verifySession(view)).toBeNull();
  });
  it('forged tokens are refused: wrong secret, no expiry check bypass, tampered payload, garbage', async () => {
    const forged = await new SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).setSubject('admin').setIssuer('unbarmore-admin').setExpirationTime('1h').sign(new TextEncoder().encode('y'.repeat(40)));
    expect(await verifyAdmin(forged)).toBe(false);
    const expired = await new SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256' }).setSubject('admin').setIssuer('unbarmore-admin').setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(key);
    expect(await verifyAdmin(expired)).toBe(false);
    const wrongRole = await new SignJWT({ role: 'owner' }).setProtectedHeader({ alg: 'HS256' }).setSubject('admin').setIssuer('unbarmore-admin').setExpirationTime('1h').sign(key);
    expect(await verifyAdmin(wrongRole)).toBe(false);
    for (const bad of [undefined, '', 'abc', 'a.b.c']) { expect(await verifyAdmin(bad)).toBe(false); expect(await verifyViewAs(bad)).toBeNull(); }
  });
});

describe('"view as shop" session', () => {
  it('admin cookie + view-as cookie → the shop\'s session, READ-ONLY, not a real user', async () => {
    h.jar.set(ADMIN_COOKIE, await signAdmin()); h.jar.set(VIEWAS_COOKIE, await signViewAs(BID));
    const { getSession } = await import('@/lib/auth');
    const s = await getSession();
    expect(s).toMatchObject({ business_id: BID, readOnly: true, viewingAs: true, sub: 'admin', role: 'owner' });
    expect(s!.business.name).toBe('Ada Fabrics');
  });
  it('a view-as cookie WITHOUT the admin cookie opens nothing (nobody can fake it from a shop login)', async () => {
    h.jar.set(VIEWAS_COOKIE, await signViewAs(BID));
    const { getSession } = await import('@/lib/auth');
    expect(await getSession()).toBeNull();
  });
  it('the admin cookie alone is not a shop session either', async () => {
    h.jar.set(ADMIN_COOKIE, await signAdmin());
    const { getSession } = await import('@/lib/auth');
    expect(await getSession()).toBeNull();
  });
  it('a shop that no longer exists gives no session', async () => {
    h.businesses.current = null; h.jar.set(ADMIN_COOKIE, await signAdmin()); h.jar.set(VIEWAS_COOKIE, await signViewAs(BID));
    const { getSession } = await import('@/lib/auth');
    expect(await getSession()).toBeNull();
  });
});

describe('every write path refuses a read-only admin view', () => {
  const ro = () => ({ sub: 'admin', business_id: BID, role: 'owner', readOnly: true, viewingAs: true, business: { id: BID, name: 'Ada', subscription_tier: 'trial', studio_theme: 'clean_minimalist' } });
  it('saving the shop profile', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({ requireSession: async () => ro(), READ_ONLY_MESSAGE: 'Read-only admin view: nothing can be changed here.' }));
    const { saveProfile } = await import('@/app/(app)/settings/actions');
    const fd = new FormData(); fd.set('name', 'Hacked Name');
    const r = await saveProfile(null, fd);
    expect(r.ok).toBe(false); expect(r.message).toContain('Read-only'); expect(h.updates).toHaveLength(0);
  });
  it('the advisor chat (it would spend the shop\'s allowance and write its chat history)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({ getSession: async () => ro() }));
    const { POST } = await import('@/app/api/chat/route');
    const res = await POST(new Request('http://x/api/chat', { method: 'POST', body: JSON.stringify({ message: 'hello' }) }) as never);
    expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: 'read_only' }); expect(h.dbCalls).toEqual([]);
  });
  it('turning push alerts on or off', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth', () => ({ getSession: async () => ro() }));
    const mod = await import('@/app/api/push/subscribe/route');
    const mk = (m: string) => new Request('http://x/api/push/subscribe', { method: m, body: JSON.stringify({ endpoint: 'https://push.example/1' }) }) as never;
    expect((await mod.POST(mk('POST'))).status).toBe(403); expect((await mod.DELETE(mk('DELETE'))).status).toBe(403);
    expect(h.dbCalls).toEqual([]);
  });
});

describe('admin actions: hard limits, re-authentication, and an audit trail', () => {
  const setup = async (isAdmin = true) => {
    vi.resetModules();
    vi.doMock('@/lib/admin', () => ({ requireAdmin: async () => { if (!isAdmin) throw new Error('REDIRECT:/admin/login'); }, audit: async (...a: unknown[]) => { h.audits.push(['AUDIT', ...a]); } }));
    return import('@/app/admin/(console)/shops/[id]/actions');
  };
  const fd = (o: Record<string, string>) => { const f = new FormData(); Object.entries(o).forEach(([k, v]) => f.set(k, v)); return f; };

  it('server actions re-check the admin cookie themselves: a non-admin changes nothing', async () => {
    const a = await setup(false);
    await expect(a.grantVideos(BID, null, fd({ qty: '5' }))).rejects.toThrow('REDIRECT:/admin/login');
    await expect(a.extendTrial(BID, null, fd({ days: '5' }))).rejects.toThrow('REDIRECT');
    await expect(a.compPlan(BID, null, fd({ tier: 'growth_15k', days: '5' }))).rejects.toThrow('REDIRECT');
    expect(h.updates).toHaveLength(0); expect(h.dbCalls.filter((c) => c.startsWith('rpc:'))).toHaveLength(0);
  });
  it('grant videos: 1 to 50 whole numbers only; adds credits and writes an audit row', async () => {
    const a = await setup(); h.rpc.data = 7;
    expect((await a.grantVideos(BID, null, fd({ qty: '3' }))).message).toContain('Balance: 7');
    expect(h.audits.some((x) => x[0] === 'add_video_credits' && (x[1] as { p_qty: number }).p_qty === 3)).toBe(true);
    expect(h.audits.some((x) => x[0] === 'AUDIT' && x[1] === 'grant_videos')).toBe(true);
    h.audits.length = 0;
    for (const bad of ['0', '-1', '51', '1.5', 'abc', '', '1e3']) expect((await a.grantVideos(BID, null, fd({ qty: bad }))).ok).toBe(false);
    expect(h.audits).toEqual([]);                                                         // no credit, no audit for refused input
  });
  it('a malformed shop id never reaches the database', async () => {
    const a = await setup();
    expect((await a.grantVideos("x'; drop table businesses;--", null, fd({ qty: '1' }))).message).toBe('Shop not found.');
    expect(h.dbCalls).toEqual([]);
  });
  it('extend trial: moves the end date forward and puts a free-plan shop back on trial; refuses paid shops', async () => {
    const a = await setup();
    h.businesses.current = { ...h.businesses.current!, subscription_tier: 'free_limited', trial_ends_at: '2026-01-01T00:00:00Z' };
    expect((await a.extendTrial(BID, null, fd({ days: '7' }))).ok).toBe(true);
    const u = h.updates.find((x) => x.table === 'businesses')!; expect(u.subscription_tier).toBe('trial'); expect(new Date(u.trial_ends_at as string).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    h.updates.length = 0; h.businesses.current = { ...h.businesses.current!, subscription_tier: 'starter_5k' };
    expect((await a.extendTrial(BID, null, fd({ days: '7' }))).message).toContain('paid plan'); expect(h.updates).toHaveLength(0);
    expect((await a.extendTrial(BID, null, fd({ days: '31' }))).ok).toBe(false);
  });
  it('give a plan: Starter or Growth only, 1 to 90 days, expires by itself; audit records who got what', async () => {
    const a = await setup();
    expect((await a.compPlan(BID, null, fd({ tier: 'growth_15k', days: '30' }))).ok).toBe(true);
    const u = h.updates.find((x) => x.table === 'businesses')!; expect(u.subscription_tier).toBe('growth_15k'); expect(new Date(u.subscription_expires_at as string).getTime()).toBeLessThan(Date.now() + 31 * 86_400_000);
    expect(h.audits.some((x) => x[0] === 'AUDIT' && x[1] === 'comp_plan' && (x[3] as { tier: string }).tier === 'growth_15k')).toBe(true);
    h.updates.length = 0;
    for (const bad of [{ tier: 'admin', days: '5' }, { tier: 'trial', days: '5' }, { tier: 'starter_5k', days: '91' }, { tier: 'starter_5k', days: '0' }, { tier: '', days: '5' }]) expect((await a.compPlan(BID, null, fd(bad))).ok).toBe(false);
    expect(h.updates).toHaveLength(0);
  });
});

describe('redeeming the admin link', () => {
  it('only a 64-hex token is even looked up; the database call gets a HASH, never the raw token', async () => {
    vi.resetModules(); vi.doUnmock('@/lib/admin'); vi.doUnmock('@/lib/auth');
    const { redeemAdminToken } = await import('@/lib/admin');
    expect(await redeemAdminToken('not-a-token')).toBe(false); expect(h.dbCalls).toEqual([]);
    const raw = 'ab'.repeat(32);
    expect(await redeemAdminToken(raw)).toBe(true);
    const call = h.audits.find((x) => x[0] === 'consume_admin_token')!; expect((call[1] as { p_token_hash: string }).p_token_hash).toMatch(/^[a-f0-9]{64}$/); expect((call[1] as { p_token_hash: string }).p_token_hash).not.toBe(raw);
    h.rpc.data = false; expect(await redeemAdminToken(raw)).toBe(false);                    // replay or expired
    h.rpc.data = true; h.rpc.error = { message: 'boom' }; expect(await redeemAdminToken(raw)).toBe(false);
  });
});

describe('metrics', () => {
  it('statuses', () => {
    expect(shopStatus({ ageDays: 9, hasEntries: true, activeDays7: 5 })).toBe('habit'); expect(shopStatus({ ageDays: 9, hasEntries: true, activeDays7: 2 })).toBe('trying');
    expect(shopStatus({ ageDays: 9, hasEntries: true, activeDays7: 0 })).toBe('stalled'); expect(shopStatus({ ageDays: 3, hasEntries: false, activeDays7: 0 })).toBe('never_started');
    expect(shopStatus({ ageDays: 0, hasEntries: false, activeDays7: 0 })).toBe('new');
  });
  it('MRR counts only paid plans that have not lapsed; annual is spread over 12 months', () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString(), past = new Date(Date.now() - 86_400_000).toISOString();
    expect(mrrNgn([{ tier: 'starter_5k', cycle: 'monthly', expiresAt: future }, { tier: 'growth_15k', cycle: 'annual', expiresAt: future }, { tier: 'starter_5k', cycle: 'monthly', expiresAt: past }, { tier: 'trial', cycle: 'monthly', expiresAt: future }])).toBe(5000 + 12500);
  });
  it('bounded numbers and trial extension never land in the past', () => {
    expect([boundedInt('5', 1, 50), boundedInt('50', 1, 50), boundedInt('51', 1, 50), boundedInt('0', 1, 50), boundedInt(' 7 ', 1, 50), boundedInt('7.5', 1, 50), boundedInt(null, 1, 50)]).toEqual([5, 50, null, null, 7, null, null]);
    expect(GRANT_MAX).toBe(50);
    const e = new Date(extendedTrialEnd('2020-01-01T00:00:00Z', 3)).getTime(); expect(e).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
    expect(extendedTrialEnd('2099-01-01T00:00:00.000Z', 2)).toBe('2099-01-03T00:00:00.000Z');
  });
  const gap = (o: Partial<GapInput> = {}): GapInput => ({ tier: 'trial', trialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), ageDays: 10, activeDays7: 3, everActive: true, unpricedRevenue: 0, debtOverdue30: 0, debtorsWithoutPhone: 0, unconfirmedOld: 0, lastCountVariance: null, failedVideos7d: 0, ...o });
  it('"what is this shop missing": each reason appears, with naira, and a healthy shop has none', () => {
    expect(shopGaps(gap())).toEqual([]);
    const t = shopGaps(gap({ unpricedRevenue: 120_000, debtOverdue30: 45_000, debtorsWithoutPhone: 2, unconfirmedOld: 1, lastCountVariance: -5_000, failedVideos7d: 2 })).map((g) => g.text).join('\n');
    for (const s of ['₦120,000 of sales have no cost price', '₦45,000 has been owed', '2 customers who owe money have no phone', '1 entry was never confirmed', '₦5,000 short', '2 videos failed']) expect(t).toContain(s);
  });
  it('selling below cost and negative stock are called out (a real finding in the pilot data)', () => {
    const t = shopGaps(gap({ revenue30: 174_000, cogs30: 186_600, negativeStock: 2 })).map((g) => g.text).join('\n');
    expect(t).toContain('Selling at a loss'); expect(t).toContain('₦186,600'); expect(t).toContain('₦174,000'); expect(t).toContain('-7%'); expect(t).toContain('2 products show negative stock');
    expect(shopGaps(gap({ revenue30: 174_000, cogs30: 100_000 })).some((g) => g.text.includes('Selling at a loss'))).toBe(false);
    expect(shopGaps(gap({ revenue30: 174_000, cogs30: 186_600, unpricedRevenue: 10_000 })).some((g) => g.text.includes('Selling at a loss'))).toBe(false);   // cost is incomplete: do not accuse
  });
  it('quiet shops and never-started shops are flagged; a trial about to end is a chance (and says why or why not to ask)', () => {
    expect(shopGaps(gap({ activeDays7: 0, ageDays: 9 })).some((g) => g.text.includes('nothing recorded in the last 7 days'))).toBe(true);
    expect(shopGaps(gap({ everActive: false, activeDays7: 0, ageDays: 2 })).some((g) => g.text.includes('never recorded a single entry'))).toBe(true);
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(shopGaps(gap({ trialEndsAt: soon, activeDays7: 4 })).find((g) => g.level === 'chance')!.text).toContain('good moment to ask them to subscribe');
    expect(shopGaps(gap({ trialEndsAt: soon, activeDays7: 0 })).find((g) => g.level === 'chance')!.text).toContain('find out why first');
  });
  it('the attention lists: trials ending, paid plans ending, never started, went quiet', () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    const base = { id: 'x', name: 'S', ageDays: 5, activeDays7: 0 };
    const a = attention([
      { ...base, id: '1', tier: 'trial', status: 'trying', trialEndsAt: day(2), expiresAt: day(2) }, { ...base, id: '2', tier: 'trial', status: 'trying', trialEndsAt: day(9), expiresAt: day(9) },
      { ...base, id: '3', tier: 'starter_5k', status: 'habit', trialEndsAt: day(-9), expiresAt: day(1) }, { ...base, id: '4', tier: 'trial', status: 'never_started', trialEndsAt: day(10), expiresAt: day(10) },
      { ...base, id: '5', tier: 'trial', status: 'stalled', trialEndsAt: day(10), expiresAt: day(10) },
    ]);
    expect([a.trialsEnding.map((s) => s.id), a.paidExpiring.map((s) => s.id), a.neverStarted.map((s) => s.id), a.wentQuiet.map((s) => s.id)]).toEqual([['1'], ['3'], ['4'], ['5']]);
  });
});
