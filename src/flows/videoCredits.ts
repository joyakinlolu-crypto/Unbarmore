import { PLANS, VIDEOS_PER_DAY, VIDEO_CREDIT_PACKS, type VideoPackId } from '../config/plans.js';
import type { Actor } from '../db/supabase.js';
import { alertAdmin } from '../lib/alerts.js';
import { ngn } from '../lib/money.js';
import { createVideoCreditCheckout, paymentsLive } from '../services/paystack.js';
import { reply, type Reply } from '../services/whatsapp.js';

export type LimitReason = 'daily' | 'allowance';

const packsLine = `${VIDEO_CREDIT_PACKS.BUYV1.label}  ·  ${VIDEO_CREDIT_PACKS.BUYV3.label}`;

/** Shown when a video cannot be made, and when the owner asks to buy extra videos. Never a dead end: it always offers a way forward. */
export function videoLimitReply(actor: Actor, why: LimitReason | 'ask'): Reply {
  const b = actor.business;
  const credits = Number(b.video_credits ?? 0);
  const trial = b.subscription_tier === 'trial' || b.subscription_tier === 'free_limited';
  const lines: string[] = [];
  if (why === 'daily') {
    lines.push(`🎬 You've made ${VIDEOS_PER_DAY} videos today, the daily limit for videos that come with your plan.`, 'Your other videos are safe: come back tomorrow, or get an extra video now:');
  } else if (why === 'allowance') {
    lines.push(trial ? `🎬 You've used your ${PLANS.trial.videos_used_this_month} free trial videos.` : `🎬 You've used all ${PLANS[b.subscription_tier].videos_used_this_month} videos in your plan this month.`, 'Need another? Get extra videos any time:');
  } else {
    lines.push('🎬 *Extra videos*', 'Each one is a full 15–18 second HD sales video (3 photos, your voice, your number on it).');
  }
  lines.push('', `*${packsLine}*`, credits > 0 ? `🎟️ You have ${credits} video credit${credits > 1 ? 's' : ''} left.` : '');
  if (trial && why !== 'ask') lines.push('', `Or Starter (${ngn(5000)}/mo) includes ${PLANS.starter_5k.videos_used_this_month} videos a month plus voice notes and fake-alert checks.`);
  const r = reply(actor.phone).text(...lines)
    .button('BUYV1', VIDEO_CREDIT_PACKS.BUYV1.label)
    .button('BUYV3', VIDEO_CREDIT_PACKS.BUYV3.label);
  if (trial && why !== 'ask') r.button('PLANS', '⭐ See plans');
  return r;
}

/** The owner tapped a pack. Online payment when Paystack is live; until then the request is passed to the platform owner, who adds the credits. */
export async function startCreditPurchase(actor: Actor, packId: VideoPackId): Promise<Reply> {
  const pack = VIDEO_CREDIT_PACKS[packId];
  if (!pack) return videoLimitReply(actor, 'ask');
  if (paymentsLive()) {
    try {
      const link = await createVideoCreditCheckout(actor.business, pack.qty, pack.ngn);
      return reply(actor.phone).text(`💳 *${pack.label}*`, link.url, '', 'Your credits are added the moment payment lands. ✅');
    } catch (e) {
      console.error('[credits] checkout failed', String((e as Error)?.message ?? e).slice(0, 200));
    }
  }
  void alertAdmin('system', `VIDEO CREDIT REQUEST: ${pack.label} from ${actor.business.name} (…${actor.phone.slice(-4)})`,
    `Payments are not live: collect ${ngn(pack.ngn)} by transfer, then send: GRANT VIDEOS ${actor.phone.replace(/^234/, '0')} ${pack.qty}`, { key: `${actor.phone}:${pack.qty}`, cooldownS: 3600 });
  return reply(actor.phone).text(
    `🎟️ *${pack.label}*`,
    'Online card payment is opening soon. We have your request and will contact you on WhatsApp shortly to add your credits.',
  );
}
