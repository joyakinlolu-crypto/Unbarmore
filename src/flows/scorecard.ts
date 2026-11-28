import { videoResultsLine } from './videoResults.js';
import { db } from '../db/supabase.js';
import { watDateKey } from '../lib/money.js';
import { buildScorecard, scorecardText, type ShopFacts } from '../lib/scorecard.js';
import { reply, type Reply } from '../services/whatsapp.js';

/** Test accounts (the automated live test uses 2349000000xxx) must never pollute real pilot numbers. */
const isTestPhone = (p: string) => /^2349000000\d{3}$/.test(p);
const DAY = 86_400_000;
const MAX_SHOPS = 60;

/** Everything the scorecard needs, for every real shop. A handful of small queries, fine at pilot scale. */
export async function gatherScorecard(days = 7): Promise<ShopFacts[]> {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const sinceDate = since.slice(0, 10);
  const { data: bs } = await db.from('businesses').select('id, name, owner_phone, subscription_tier, created_at').order('created_at', { ascending: false }).limit(MAX_SHOPS + 20);
  const shops = ((bs ?? []) as { id: string; name: string; owner_phone: string; subscription_tier: string; created_at: string }[]).filter((b) => !isTestPhone(b.owner_phone)).slice(0, MAX_SHOPS);
  if (!shops.length) return [];
  const ids = shops.map((s) => s.id);

  const [tx, firsts, debts, costed, jobs, quotes, counts, sessions, usage, apps, push] = await Promise.all([
    db.from('transactions').select('business_id, tx_type, transaction_date, total_amount_ngn, amount_paid_ngn, receipt_pdf_url').eq('status', 'confirmed').in('business_id', ids).gte('transaction_date', since).limit(50000),
    Promise.all(shops.map(async (s) => {
      const r = await db.from('transactions').select('created_at').eq('business_id', s.id).eq('status', 'confirmed').order('created_at', { ascending: true }).limit(1).maybeSingle();
      return [s.id, (r.data?.created_at as string | undefined) ?? null] as const;
    })),
    db.from('customers').select('business_id, outstanding_debt_ngn').in('business_id', ids).gt('outstanding_debt_ngn', 0).limit(20000),
    db.from('products').select('business_id').in('business_id', ids).gt('cost_price_ngn', 0).limit(20000),
    db.from('video_jobs').select('business_id').in('business_id', ids).eq('status', 'completed').gte('created_at', since).limit(20000),
    db.from('quotes').select('business_id').in('business_id', ids).gte('created_at', since).limit(20000),
    db.from('cash_counts').select('business_id').in('business_id', ids).gte('counted_at', since).limit(20000),
    db.from('whatsapp_sessions').select('business_id, last_inbound_at').in('business_id', ids).limit(5000),
    db.from('ai_usage').select('business_id, est_cost_ngn').in('business_id', ids).gte('day', sinceDate).limit(50000),
    db.from('web_magic_tokens').select('business_id').in('business_id', ids).not('used_at', 'is', null).limit(20000),
    db.from('push_subscriptions').select('business_id').in('business_id', ids).limit(20000),
  ]);

  const by = <T extends { business_id: string }>(rows: T[] | null | undefined) => {
    const m = new Map<string, T[]>(); for (const r of rows ?? []) (m.get(r.business_id) ?? m.set(r.business_id, []).get(r.business_id)!).push(r); return m;
  };
  const txBy = by(tx.data as { business_id: string; tx_type: string; transaction_date: string; total_amount_ngn: string; amount_paid_ngn: string; receipt_pdf_url: string | null }[]);
  const debtBy = by(debts.data as { business_id: string; outstanding_debt_ngn: string }[]);
  const set = (rows: { business_id: string }[] | null) => new Set((rows ?? []).map((r) => r.business_id));
  const costedSet = set(costed.data), appSet = new Set([...set(apps.data), ...set(push.data)]);
  const count = (rows: { business_id: string }[] | null) => { const m = new Map<string, number>(); for (const r of rows ?? []) m.set(r.business_id, (m.get(r.business_id) ?? 0) + 1); return m; };
  const jobsN = count(jobs.data), quotesN = count(quotes.data), countsN = count(counts.data);
  const seen = new Map<string, string | null>();   // owner and staff share a shop: keep the most recent message
  for (const x of sessions.data ?? []) { const id = x.business_id as string, t = x.last_inbound_at as string | null; if (t && (!seen.get(id) || t > seen.get(id)!)) seen.set(id, t); }
  const aiBy = by(usage.data as { business_id: string; est_cost_ngn: string }[]);
  const firstBy = new Map(firsts);

  return shops.map((s) => {
    const rows = txBy.get(s.id) ?? [];
    return {
      name: s.name, tier: s.subscription_tier, createdAt: s.created_at,
      ageDays: Math.floor((Date.now() - new Date(s.created_at).getTime()) / DAY),
      firstEntryAt: firstBy.get(s.id) ?? null, lastInboundAt: seen.get(s.id) ?? null,
      activeDates: [...new Set(rows.map((r) => watDateKey(new Date(r.transaction_date))))],
      entries: rows.length,
      revenueNgn: rows.filter((r) => r.tx_type === 'sale').reduce((a, r) => a + Number(r.total_amount_ngn), 0),
      debtOpenNgn: (debtBy.get(s.id) ?? []).reduce((a, r) => a + Number(r.outstanding_debt_ngn), 0),
      debtCollectedNgn: rows.filter((r) => r.tx_type === 'debt_repayment').reduce((a, r) => a + Number(r.amount_paid_ngn), 0),
      costPricesSet: costedSet.has(s.id), receipts: rows.filter((r) => r.receipt_pdf_url).length,
      videos: jobsN.get(s.id) ?? 0, quotes: quotesN.get(s.id) ?? 0, counts: countsN.get(s.id) ?? 0,
      openedApp: appSet.has(s.id), aiCostNgn: Math.round((aiBy.get(s.id) ?? []).reduce((a, r) => a + Number(r.est_cost_ngn), 0)),
    };
  });
}

/** Admin: SCORECARD or SCORECARD 14 (days, 1 to 30). */
export async function scorecardReply(phone: string, days = 7): Promise<Reply> {
  const d = Math.min(30, Math.max(1, Math.round(days)));
  try {
    const facts = await gatherScorecard(d);
    if (!facts.length) return reply(phone).text('📋 No real shops yet. Share your WhatsApp number with your first testers.');
    const vr = await videoResultsLine();
    return reply(phone).text(...scorecardText(buildScorecard(facts), d), ...(vr ? ['', vr] : []));
  } catch (e) {
    return reply(phone).text(`Could not build the scorecard: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
  }
}
