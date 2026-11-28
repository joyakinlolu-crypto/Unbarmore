import 'server-only';
import { db } from './supabase';
import { watDate } from './format';
import { profitFromRow, type ProfitView } from './profit';
import { attention, mrrNgn, shopGaps, shopStatus, type Attention, type Gap, type ShopStatus } from './adminMetrics';

const DAY = 86_400_000;
const isTestPhone = (p: string) => /^2349000000\d{3}$/.test(p);   // the automated live test's accounts never count

export interface ShopRow {
  id: string; name: string; phone: string; tier: string; cycle: string; createdAt: string; ageDays: number;
  trialEndsAt: string; expiresAt: string; videoCredits: number;
  entries7: number; activeDays7: number; revenue30: number; owed: number; hasEntries: boolean; costPrices: boolean;
  lastSeen: string | null; aiCost7: number; status: ShopStatus;
}

type B = { id: string; name: string; owner_phone: string; subscription_tier: string; billing_cycle: string; created_at: string; trial_ends_at: string; subscription_expires_at: string; video_credits?: number };

/** One row per real shop, with the numbers the list and overview need. A handful of queries: fine at pilot scale (hundreds of shops). */
export async function loadShops(): Promise<ShopRow[]> {
  const since7 = new Date(Date.now() - 7 * DAY).toISOString(), since30 = new Date(Date.now() - 30 * DAY).toISOString();
  const bs = await db.from('businesses').select('*').order('created_at', { ascending: false }).limit(500);
  if (bs.error) throw new Error(`businesses: ${bs.error.message}`);
  const shops = (bs.data as B[]).filter((b) => !isTestPhone(b.owner_phone));
  if (!shops.length) return [];
  const ids = shops.map((s) => s.id);
  const [tx, debts, costed, sessions, usage, first] = await Promise.all([
    db.from('transactions').select('business_id, tx_type, transaction_date, total_amount_ngn').eq('status', 'confirmed').in('business_id', ids).gte('transaction_date', since30).limit(100000),
    db.from('customers').select('business_id, outstanding_debt_ngn').in('business_id', ids).gt('outstanding_debt_ngn', 0).limit(50000),
    db.from('products').select('business_id').in('business_id', ids).gt('cost_price_ngn', 0).limit(50000),
    db.from('whatsapp_sessions').select('business_id, last_inbound_at').in('business_id', ids).limit(10000),
    db.from('ai_usage').select('business_id, est_cost_ngn').in('business_id', ids).gte('day', since7.slice(0, 10)).limit(50000),
    db.from('transactions').select('business_id').eq('status', 'confirmed').in('business_id', ids).limit(100000),
  ]);
  const group = <T extends { business_id: string }>(rows: T[] | null) => { const m = new Map<string, T[]>(); for (const r of rows ?? []) { const a = m.get(r.business_id); if (a) a.push(r); else m.set(r.business_id, [r]); } return m; };
  const txBy = group(tx.data as { business_id: string; tx_type: string; transaction_date: string; total_amount_ngn: string }[]);
  const owedBy = group(debts.data as { business_id: string; outstanding_debt_ngn: string }[]);
  const aiBy = group(usage.data as { business_id: string; est_cost_ngn: string }[]);
  const costedSet = new Set((costed.data ?? []).map((r) => r.business_id as string));
  const everSet = new Set((first.data ?? []).map((r) => r.business_id as string));
  const seen = new Map<string, string>();
  for (const x of sessions.data ?? []) { const id = x.business_id as string, t = x.last_inbound_at as string | null; if (t && (!seen.get(id) || t > seen.get(id)!)) seen.set(id, t); }

  return shops.map((b) => {
    const rows = txBy.get(b.id) ?? [];
    const last7 = rows.filter((r) => r.transaction_date >= since7);
    const activeDays7 = new Set(last7.map((r) => watDate(r.transaction_date))).size;
    const ageDays = Math.floor((Date.now() - new Date(b.created_at).getTime()) / DAY);
    const hasEntries = everSet.has(b.id);
    return {
      id: b.id, name: b.name, phone: b.owner_phone, tier: b.subscription_tier, cycle: b.billing_cycle, createdAt: b.created_at, ageDays,
      trialEndsAt: b.trial_ends_at, expiresAt: b.subscription_expires_at, videoCredits: Number(b.video_credits ?? 0),
      entries7: last7.length, activeDays7, revenue30: rows.filter((r) => r.tx_type === 'sale').reduce((a, r) => a + Number(r.total_amount_ngn), 0),
      owed: (owedBy.get(b.id) ?? []).reduce((a, r) => a + Number(r.outstanding_debt_ngn), 0), hasEntries, costPrices: costedSet.has(b.id),
      lastSeen: seen.get(b.id) ?? null, aiCost7: Math.round((aiBy.get(b.id) ?? []).reduce((a, r) => a + Number(r.est_cost_ngn), 0)),
      status: shopStatus({ ageDays, hasEntries, activeDays7 }),
    };
  });
}

export interface Overview {
  shops: ShopRow[]; byTier: Record<string, number>; statusCounts: Record<ShopStatus, number>;
  signups7: number; signups30: number; paying: number; mrr: number; active7: number; sales30: number; owed: number;
  aiCost7: number; aiCost30: number; failedVideos7: number; payoutsPending: { n: number; ngn: number }; walletsOwed: number; attention: Attention;
}

export async function loadOverview(): Promise<Overview> {
  const shops = await loadShops();
  const since30 = new Date(Date.now() - 30 * DAY).toISOString(), since7 = new Date(Date.now() - 7 * DAY).toISOString();
  const [ai30, vids, pay, wallets] = await Promise.all([
    db.from('ai_usage').select('est_cost_ngn').gte('day', since30.slice(0, 10)).limit(100000),
    db.from('video_jobs').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', since7),
    db.from('payout_requests').select('amount_ngn').eq('status', 'requested').limit(500),
    db.from('businesses').select('referral_wallet_ngn').gt('referral_wallet_ngn', 0).limit(5000),
  ]);
  const byTier: Record<string, number> = {};
  const statusCounts: Record<ShopStatus, number> = { habit: 0, trying: 0, stalled: 0, never_started: 0, new: 0 };
  shops.forEach((s) => { byTier[s.tier] = (byTier[s.tier] ?? 0) + 1; statusCounts[s.status] += 1; });
  const paid = shops.filter((s) => (s.tier === 'starter_5k' || s.tier === 'growth_15k') && new Date(s.expiresAt).getTime() > Date.now());
  return {
    shops, byTier, statusCounts,
    signups7: shops.filter((s) => s.createdAt >= since7).length, signups30: shops.filter((s) => s.createdAt >= since30).length,
    paying: paid.length, mrr: mrrNgn(shops.map((s) => ({ tier: s.tier, cycle: s.cycle, expiresAt: s.expiresAt }))),
    active7: shops.filter((s) => s.activeDays7 > 0).length, sales30: shops.reduce((a, s) => a + s.revenue30, 0), owed: shops.reduce((a, s) => a + s.owed, 0),
    aiCost7: shops.reduce((a, s) => a + s.aiCost7, 0), aiCost30: Math.round((ai30.data ?? []).reduce((a, r) => a + Number(r.est_cost_ngn), 0)),
    failedVideos7: vids.count ?? 0,
    payoutsPending: { n: (pay.data ?? []).length, ngn: (pay.data ?? []).reduce((a, r) => a + Number(r.amount_ngn), 0) },
    walletsOwed: (wallets.data ?? []).reduce((a, r) => a + Number(r.referral_wallet_ngn), 0),
    attention: attention(shops.map((s) => ({ id: s.id, name: s.name, tier: s.tier, status: s.status, ageDays: s.ageDays, trialEndsAt: s.trialEndsAt, expiresAt: s.expiresAt, activeDays7: s.activeDays7 }))),
  };
}

export interface ShopDetail {
  shop: ShopRow; b: Record<string, unknown>; month: ProfitView; today: ProfitView; allTime: ProfitView; cashInMonth: number; debtCollectedMonth: number;
  recent: { id: string; tx_type: string; description: string; total_amount_ngn: string; amount_paid_ngn: string; payment_method: string | null; transaction_date: string; status: string; customers: { name: string } | null }[];
  debtors: { name: string; phone_number: string | null; outstanding_debt_ngn: string; debt_since: string | null }[];
  products: { total: number; noCost: { name: string; stock_qty: string }[]; low: { name: string; stock_qty: string }[] };
  videos: { status: string; created_at: string }[]; aiByKind: { kind: string; cost: number }[]; quotesOpen: number; counts: { counted_at: string; counted_ngn: string; variance_ngn: string | null }[];
  referredBy: string | null; referralsMade: number; audit: { at: string; action: string; detail: Record<string, unknown> }[]; gaps: Gap[];
}

export async function loadShopDetail(id: string): Promise<ShopDetail | null> {
  const shops = await loadShops();
  const shop = shops.find((s) => s.id === id);
  if (!shop) return null;
  const now = new Date(); const to = new Date(now.getTime() + DAY).toISOString();
  const monthFrom = new Date(Date.now() - 30 * DAY).toISOString();
  const dayFrom = new Date(new Date(now.getTime() + 3600_000).setUTCHours(0, 0, 0, 0) - 3600_000).toISOString();
  const since7 = new Date(Date.now() - 7 * DAY).toISOString();
  const rpc = (from: string) => db.rpc('ledger_summary', { p_business_id: id, p_from: from, p_to: to });
  const [bRow, month, today, all, recent, debtors, prods, videos, ai, quotes, counts, unconf, ref, refs, aud, oldDebts] = await Promise.all([
    db.from('businesses').select('*').eq('id', id).maybeSingle(), rpc(monthFrom), rpc(dayFrom), rpc('2000-01-01T00:00:00Z'),
    db.from('transactions').select('id, tx_type, description, total_amount_ngn, amount_paid_ngn, payment_method, transaction_date, status, customers(name)').eq('business_id', id).neq('status', 'undone').order('created_at', { ascending: false }).limit(25),
    db.from('customers').select('name, phone_number, outstanding_debt_ngn, debt_since').eq('business_id', id).gt('outstanding_debt_ngn', 0).order('outstanding_debt_ngn', { ascending: false }).limit(10),
    db.from('products').select('name, stock_qty, cost_price_ngn').eq('business_id', id).limit(2000),
    db.from('video_jobs').select('status, created_at').eq('business_id', id).order('created_at', { ascending: false }).limit(10),
    db.from('ai_usage').select('kind, est_cost_ngn').eq('business_id', id).gte('day', monthFrom.slice(0, 10)).limit(5000),
    db.from('quotes').select('id', { count: 'exact', head: true }).eq('business_id', id).eq('status', 'open'),
    db.from('cash_counts').select('counted_at, counted_ngn, variance_ngn').eq('business_id', id).order('counted_at', { ascending: false }).limit(5),
    db.from('transactions').select('batch_id').eq('business_id', id).eq('status', 'pending_confirm').lt('created_at', new Date(Date.now() - DAY).toISOString()).limit(500),
    db.from('businesses').select('name, referred_by_business_id').eq('id', id).maybeSingle(),
    db.from('businesses').select('id', { count: 'exact', head: true }).eq('referred_by_business_id', id),
    db.from('admin_audit').select('at, action, detail').eq('business_id', id).order('at', { ascending: false }).limit(10),
    db.from('customers').select('phone_number, outstanding_debt_ngn, debt_since').eq('business_id', id).gt('outstanding_debt_ngn', 0).limit(2000),
  ]);
  if (!bRow.data) return null;
  const row = (r: { data: unknown }) => ((r.data as Record<string, string>[] | null)?.[0]) ?? {};
  const mv = profitFromRow(row(month)), tv = profitFromRow(row(today)), av = profitFromRow(row(all));
  const productList = (prods.data ?? []) as { name: string; stock_qty: string; cost_price_ngn: string }[];
  const aiMap = new Map<string, number>(); for (const r of ai.data ?? []) aiMap.set(r.kind as string, (aiMap.get(r.kind as string) ?? 0) + Number(r.est_cost_ngn));
  const dts = (oldDebts.data ?? []) as { phone_number: string | null; outstanding_debt_ngn: string; debt_since: string | null }[];
  const countsList = (counts.data ?? []) as { counted_at: string; counted_ngn: string; variance_ngn: string | null }[];
  let referredBy: string | null = null;
  const refId = (ref.data as { referred_by_business_id: string | null } | null)?.referred_by_business_id;
  if (refId) referredBy = ((await db.from('businesses').select('name').eq('id', refId).maybeSingle()).data as { name: string } | null)?.name ?? null;
  const failed7 = ((videos.data ?? []) as { status: string; created_at: string }[]).filter((v) => v.status === 'failed' && v.created_at >= since7).length;
  const gaps = shopGaps({
    tier: shop.tier, trialEndsAt: shop.trialEndsAt, ageDays: shop.ageDays, activeDays7: shop.activeDays7, everActive: shop.hasEntries,
    unpricedRevenue: mv.unpriced, debtOverdue30: dts.filter((d) => d.debt_since && Date.now() - new Date(d.debt_since).getTime() > 30 * DAY).reduce((a, d) => a + Number(d.outstanding_debt_ngn), 0),
    debtorsWithoutPhone: dts.filter((d) => !d.phone_number).length, unconfirmedOld: new Set((unconf.data ?? []).map((r) => r.batch_id as string)).size,
    lastCountVariance: countsList[0]?.variance_ngn != null ? Number(countsList[0]!.variance_ngn) : null, failedVideos7d: failed7,
    revenue30: mv.revenue, cogs30: mv.cogs, negativeStock: productList.filter((p) => Number(p.stock_qty) < 0).length,
  });
  return {
    shop, b: bRow.data as Record<string, unknown>, month: mv, today: tv, allTime: av, cashInMonth: Number(row(month).cash_in_ngn ?? 0), debtCollectedMonth: Number(row(month).debt_collected_ngn ?? 0),
    recent: (recent.data ?? []) as unknown as ShopDetail['recent'], debtors: (debtors.data ?? []) as ShopDetail['debtors'],
    products: { total: productList.length, noCost: productList.filter((p) => !(Number(p.cost_price_ngn) > 0)).slice(0, 8), low: productList.filter((p) => Number(p.cost_price_ngn) > 0 && Number(p.stock_qty) <= 2).slice(0, 8) },
    videos: (videos.data ?? []) as ShopDetail['videos'], aiByKind: [...aiMap].map(([kind, cost]) => ({ kind, cost: Math.round(cost) })).sort((a, b) => b.cost - a.cost),
    quotesOpen: quotes.count ?? 0, counts: countsList, referredBy, referralsMade: refs.count ?? 0, audit: (aud.data ?? []) as ShopDetail['audit'], gaps,
  };
}

export async function loadAudit(limit = 100) {
  const { data } = await db.from('admin_audit').select('at, action, business_name, detail').order('at', { ascending: false }).limit(limit);
  return (data ?? []) as { at: string; action: string; business_name: string | null; detail: Record<string, unknown> }[];
}

export async function loadPayouts() {
  const { data } = await db.from('payout_requests').select('ref, amount_ngn, bank_name, account_number, status, created_at, businesses(name, owner_phone)').order('created_at', { ascending: false }).limit(50);
  return (data ?? []) as unknown as { ref: string; amount_ngn: string; bank_name: string | null; account_number: string | null; status: string; created_at: string; businesses: { name: string; owner_phone: string } | null }[];
}
