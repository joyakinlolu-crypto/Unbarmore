import { env } from '../config/env.js';
import { PRICES_NGN } from '../config/plans.js';
import { foundingPrice } from '../lib/pricing.js';
import { db } from '../db/supabase.js';
import { ngn, watDayStart } from '../lib/money.js';
import { reply, type Reply } from '../services/whatsapp.js';

/** SUPPORT: the 5 core commands + a human contact link (SUPPORT_WHATSAPP_URL). */
export function supportReply(to: string): Reply {
  return reply(to).text(
    '🆘 *Quick help — 5 things to try*',
    '',
    '1️⃣ *VOICE NOTE* — say your sales & expenses: "sold 2 lace 50k, bought fuel 5k"',
    '2️⃣ *WHO DEY OWE ME* — customers who owe you',
    '3️⃣ *CLOSE* — end-of-day cash check before you leave',
    '4️⃣ *RECEIPT* — receipt for your last sale, ready to forward',
    '5️⃣ *LOGIN* — your dashboard & AI business advisor',
    '',
    env.SUPPORT_WHATSAPP_URL ? `👉 Need a person? Chat with us: ${env.SUPPORT_WHATSAPP_URL}` : 'Need a person? Just reply here and tell us what went wrong.',
  );
}

export const isAdmin = (phone: string): boolean => !!env.ADMIN_PHONE && phone === env.ADMIN_PHONE;

/** ADMIN: live platform numbers, for ADMIN_PHONE only. Counts come from the database, never from the AI. */
export async function adminStatsReply(to: string): Promise<Reply> {
  const day = watDayStart().toISOString();
  const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();
  const count = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;
  const [bizAll, active, txToday, vidAll, vidFailed, advisor, payouts] = await Promise.all([
    db.from('businesses').select('subscription_tier, billing_cycle, created_at, referral_wallet_ngn, founding_price_ngn, founding_until').limit(50000),
    count(db.from('whatsapp_sessions').select('phone_number', { count: 'exact', head: true }).gt('last_inbound_at', since24)),
    db.from('transactions').select('tx_type, total_amount_ngn').eq('status', 'confirmed').gte('transaction_date', day).limit(20000),
    count(db.from('video_jobs').select('id', { count: 'exact', head: true }).gte('created_at', day)),
    count(db.from('video_jobs').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', since24)),
    count(db.from('web_chat_messages').select('id', { count: 'exact', head: true }).eq('role', 'user').gte('created_at', day)),
    db.from('payout_requests').select('amount_ngn').eq('status', 'requested').limit(500),
  ]);
  const bs = (bizAll.data ?? []) as { subscription_tier: string; billing_cycle: string; created_at: string; referral_wallet_ngn: string; founding_price_ngn?: number | null; founding_until?: string | null }[];
  const tier = (t: string) => bs.filter((b) => b.subscription_tier === t).length;
  const mrr = bs.reduce((a, b) => {
    const p = b.subscription_tier === 'starter_5k' ? PRICES_NGN.starter_5k : b.subscription_tier === 'growth_15k' ? PRICES_NGN.growth_15k : null;
    const lock = b.subscription_tier === 'growth_15k' && b.billing_cycle !== 'annual' ? foundingPrice(b) : null;
    return a + (lock ?? (p ? (b.billing_cycle === 'annual' ? p.annual / 12 : p.monthly) : 0));
  }, 0);
  const t = (txToday.data ?? []) as { tx_type: string; total_amount_ngn: string }[];
  const salesToday = t.filter((x) => x.tx_type === 'sale').reduce((a, x) => a + Number(x.total_amount_ngn), 0);
  const pend = (payouts.data ?? []) as { amount_ngn: string }[];
  return reply(to).text(
    '📊 *Unbarmore — live stats*',
    `🏪 Businesses: *${bs.length}*  (new today ${bs.filter((b) => b.created_at >= day).length}, new 7d ${bs.filter((b) => b.created_at >= new Date(Date.now() - 7 * 864e5).toISOString()).length})`,
    `   trial ${tier('trial')} · free ${tier('free_limited')} · starter ${tier('starter_5k')} · growth ${tier('growth_15k')}`,
    `💳 Est. MRR: *${ngn(mrr)}*`,
    `💬 Active in last 24h: *${active}*`,
    `🧾 Entries today: *${t.length}*  · sales logged ${ngn(salesToday)}`,
    `🎬 Videos today: *${vidAll}*${vidFailed ? ` · ⚠️ failed (24h): ${vidFailed}` : ''}`,
    `🧠 Web advisor chats today: *${advisor}*`,
    `🎁 Referral wallets owed: ${ngn(bs.reduce((a, b) => a + Number(b.referral_wallet_ngn), 0))}`,
    pend.length ? `💸 Payout requests waiting: *${pend.length}* (${ngn(pend.reduce((a, p) => a + Number(p.amount_ngn), 0))})` : '💸 No payout requests waiting',
  );
}
