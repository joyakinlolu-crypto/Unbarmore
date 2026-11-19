import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { PLANS } from '../config/plans.js';
import { claimOutbound, consumeQuota, db, isInServiceWindow, ledgerSummary, type Business } from '../db/supabase.js';
import { cronQueue, QUEUE, redisConnection } from '../lib/queues.js';
import { ngn, watDateKey, watWeekKey } from '../lib/money.js';
import { createOwnerMagicLink, createOwnerMagicToken } from '../services/webLink.js';
import { reply, sendTemplate } from '../services/whatsapp.js';
import { periodRange, todayLine } from '../flows/insights.js';
import { buildWeeklyReport, reportTemplateParams, reportText } from '../flows/reports.js';

const TZ = 'Africa/Lagos';

// ═════════════════════════ SCHEDULES (BullMQ job schedulers survive restarts, dedupe across replicas) ═════════════════════════

export async function registerSchedules(): Promise<void> {
  await cronQueue.upsertJobScheduler('hourly-maintenance', { pattern: '5 * * * *', tz: TZ }, { name: 'hourly' });
  await cronQueue.upsertJobScheduler('daily-checkin', { pattern: '0 21 * * *', tz: TZ }, { name: 'daily-checkin' });
  await cronQueue.upsertJobScheduler('sunday-ceo', { pattern: '0 18 * * 0', tz: TZ }, { name: 'sunday-ceo' });
}

// ═════════════════════════ JOBS ═════════════════════════

/** Trial → free_limited (+ lapsed paid), monthly counter reset. Both RPCs are idempotent. */
async function hourly(): Promise<void> {
  const { data: downgraded } = await db.rpc('downgrade_expired');
  const ids = (downgraded ?? []) as string[];
  for (const id of ids) {
    const { data: b } = await db.from('businesses').select('owner_phone').eq('id', id).single();
    if (!b) continue;
    // Only inside the free window; otherwise they see the downgrade message on their next inbound.
    if (await isInServiceWindow(b.owner_phone as string)) {
      await reply(b.owner_phone as string)
        .text(
          '⏰ Your 7-day trial has ended — but you are *not* locked out.',
          'You keep: 1 video/month · 20 text/SMS messages · 3 PDF receipts.',
          'Starter (₦5k/mo) unlocks voice notes, fake-alert checks, 15 videos and the Sunday CEO report.',
        )
        .button('PLANS', '⭐ See plans')
        .send()
        .catch(() => undefined);
    }
  }
  await db.rpc('reset_monthly_usage');
  await db.rpc('purge_old_magic_tokens');
}

/** 9 PM WAT Cash-in-Hand Reality Check — ONLY inside the free service window ($0 Meta cost). */
async function dailyCheckin(): Promise<void> {
  const since = new Date(Date.now() - 23 * 3600_000).toISOString();
  const { data: sessions } = await db.from('whatsapp_sessions').select('phone_number, business_id').gt('last_inbound_at', since).not('business_id', 'is', null);
  const day = watDateKey();

  for (const s of sessions ?? []) {
    const { data: b } = await db.from('businesses').select('*').eq('id', s.business_id as string).single();
    const biz = b as Business | null;
    if (!biz || biz.owner_phone !== s.phone_number) continue; // owner only; staff are audited via owner
    if (!PLANS[biz.subscription_tier].dailyCheckin) continue;
    if (!(await claimOutbound(biz.id, 'daily_checkin', day))) continue;

    const { from, to } = periodRange('today');
    const t = await ledgerSummary(biz.id, from, to);
    const r = reply(biz.owner_phone);
    if (t.tx_count === 0) {
      r.text(`🌙 *${biz.name}* — nothing recorded today.`, 'Did you sell anything? Send a quick voice note and I\'ll add it.');
    } else {
      r.text(
        `🌙 *Cash-in-hand check*`,
        await todayLine(biz.id),
        `Money received today: ${ngn(t.cash_in_ngn)}`,
        '',
        '*Does the cash + transfers you are holding match this?* If not, something is missing — reply with what\'s off.',
      );
    }
    // Growth: EOD owner audit of staff activity, folded into the same message (no extra send).
    if (biz.subscription_tier === 'growth_15k') {
      const { data: staffTx } = await db.from('transactions').select('logged_by_user_id, total_amount_ngn, business_users(full_name, role)')
        .eq('business_id', biz.id).eq('status', 'confirmed').gte('transaction_date', from.toISOString()).lt('transaction_date', to.toISOString());
      const byStaff = new Map<string, number>();
      for (const x of (staffTx ?? []) as unknown as { total_amount_ngn: string; business_users: { full_name: string; role: string } | null }[]) {
        if (x.business_users?.role === 'staff') byStaff.set(x.business_users.full_name, (byStaff.get(x.business_users.full_name) ?? 0) + Number(x.total_amount_ngn));
      }
      if (byStaff.size) r.text('', '👥 *Staff today:*', ...[...byStaff].map(([n, v]) => `• ${n}: ${ngn(v)}`));
    }
    await r.send().catch(() => undefined);
  }
}

/**
 * Sunday 6 PM WAT CEO Report.
 *  - Eligible: trial (once — first Sunday), starter_5k, growth_15k. NEVER free_limited / expired.
 *  - Inside 24h window → free session message with 3 buttons. Outside → approved utility template with 3 quick-reply buttons.
 */
async function sundayCeo(): Promise<void> {
  const week = watWeekKey();
  const { data } = await db.from('businesses').select('*').in('subscription_tier', ['trial', 'starter_5k', 'growth_15k']);

  for (const biz of (data ?? []) as Business[]) {
    try {
      const plan = PLANS[biz.subscription_tier];
      if (!plan.outboundCeoTemplate) continue;
      // Trial: 1 report total — consumes the trial quota; paid tiers are unlimited so this just counts.
      if (!(await consumeQuota(biz, 'ceo_reports_used_this_month'))) continue;
      if (!(await claimOutbound(biz.id, 'ceo_report', week))) continue;

      const rep = await buildWeeklyReport(biz);
      const inWindow = await isInServiceWindow(biz.owner_phone);
      if (inWindow) {
        const r = reply(biz.owner_phone).text(...reportText(biz, rep));
        if (rep.debtors.length) r.button('BTN_CHASE_DEBT', '💬 Chase debts');
        if (rep.deadStock.length) r.button('BTN_DEADSTOCK_PROMO', '🎬 Clear dead stock');
        // Free-window version carries a 1-tap login link to the full dashboard (templates can't carry a per-user token).
        const link = await createOwnerMagicLink(biz.id).catch(() => null);
        if (link) r.text('', `📊 Full charts & AI advisor: ${link}`);
        r.button('BTN_EXPORT_PDF', '📄 Export PDF');
        await r.send();
      } else {
        // The approved template has ONE button: a dynamic URL button "Open Full Dashboard" (index 0) →
        // …/auth/verify?token={{1}}. No quick replies: mixing URL + quick-reply buttons is what breaks on WhatsApp Desktop.
        // (CHASE / PROMO / STATEMENT stay available as text commands and as buttons in the free in-window version.)
        // If token issuing is throttled we still must supply a value; a non-hex placeholder lands on the harmless
        // "link expired → text LOGIN" page.
        const token = (await createOwnerMagicToken(biz.id).catch(() => null)) ?? 'expired';
        await sendTemplate(biz.owner_phone, env.WHATSAPP_CEO_TEMPLATE, reportTemplateParams(biz, rep), [], token);
      }
    } catch (err) {
      console.error('[cron:sunday-ceo]', biz.id, err);
    }
  }
}

export function startCronWorker() {
  return new Worker(
    QUEUE.cron,
    async (job) => {
      switch (job.name) {
        case 'hourly': return hourly();
        case 'daily-checkin': return dailyCheckin();
        case 'sunday-ceo': return sundayCeo();
      }
    },
    { connection: redisConnection, concurrency: 1 },
  );
}

export const __test = { hourly, dailyCheckin, sundayCeo };
