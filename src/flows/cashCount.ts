import { db, updateBusiness, type Actor } from '../db/supabase.js';
import { countText } from '../lib/cashCount.js';
import { parseSplitCommand, splitFromString, splitToString, type Split } from '../lib/setAside.js';
import { reply, type Reply } from '../services/whatsapp.js';
import { summariseDay, type DayRow } from './close.js';

const NOT_READY = 'Cash counting needs a quick update on my side. Please try again in a little while.';

/**
 * "COUNT 85000": the owner counted the drawer. Expected cash = what they counted last time + every cash movement we've recorded since.
 * The gap is the leak. The first count has nothing to compare against, so it only sets the starting cash.
 */
export async function cashCountReply(actor: Actor, counted: number): Promise<Reply> {
  if (actor.isStaff) return reply(actor.phone).text('COUNT is for the shop owner: it checks the whole shop\'s cash.');
  const id = actor.business.id;
  const last = await db.from('cash_counts').select('counted_at, counted_ngn').eq('business_id', id).order('counted_at', { ascending: false }).limit(1).maybeSingle();
  if (last.error) return reply(actor.phone).text(NOT_READY);

  const now = new Date().toISOString();
  let expected: number | null = null, variance: number | null = null, unspecified = 0;
  if (last.data) {
    const since = last.data.counted_at as string;
    const { data } = await db.from('transactions').select('tx_type, payment_method, total_amount_ngn, amount_paid_ngn')
      .eq('business_id', id).eq('status', 'confirmed').gt('transaction_date', since).lte('transaction_date', now).limit(5000);
    const s = summariseDay((data ?? []) as DayRow[]);
    expected = Number(last.data.counted_ngn) + s.expectedCash;
    variance = counted - expected;
    unspecified = s.unspecifiedCount;
  }
  const ins = await db.from('cash_counts').insert({ business_id: id, counted_at: now, counted_ngn: counted, expected_ngn: expected, variance_ngn: variance });
  if (ins.error) return reply(actor.phone).text(NOT_READY);

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const wk = await db.from('cash_counts').select('variance_ngn').eq('business_id', id).gte('counted_at', weekAgo).not('variance_ngn', 'is', null).limit(50);
  const vs = ((wk.data ?? []) as { variance_ngn: string }[]).map((r) => Number(r.variance_ngn));
  const weekShort = -vs.filter((v) => v < 0).reduce((a, v) => a + v, 0);
  return reply(actor.phone).text(...countText({ counted, expected, variance, unspecified, weekShort, weekCounts: vs.length }));
}

/** SET ASIDE / SET ASIDE 50 20 30 / MY SPLIT */
export async function splitCommandReply(actor: Actor, text: string): Promise<Reply | null> {
  const cmd = parseSplitCommand(text);
  if (cmd === null) return null;
  const r = reply(actor.phone);
  if (actor.isStaff) return r.text('Only the shop owner can set the profit split.');
  const cur = splitFromString(actor.business.setaside_split);
  if (cmd === 'show') {
    return r.text(
      `💼 *Your evening split:* Restock ${cur.restock}% · Rent & tax reserve ${cur.reserve}% · Pay yourself ${cur.pay}%`,
      `Every evening I'll tell you the exact naira to move. Change it: *SET ASIDE ${splitToString(cur)}* (three numbers adding to 100).`,
    );
  }
  if (cmd === 'bad') return r.text('The three numbers must add up to 100, in this order: restock, rent & tax reserve, pay yourself. Example: *SET ASIDE 50 20 30*');
  const next: Split = cmd;
  try { await updateBusiness(actor.business.id, { setaside_split: splitToString(next) }); } catch { return r.text('I could not save that yet. Please try again in a little while.'); }
  return r.text(`✅ Done. From tonight: Restock ${next.restock}% · Rent & tax reserve ${next.reserve}% · Pay yourself ${next.pay}%.`);
}
