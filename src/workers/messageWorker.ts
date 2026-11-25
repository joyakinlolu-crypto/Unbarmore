import { DelayedError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ADVICE_PER_DAY, PLANS, PRICES_NGN, TRIAL_DAYS } from '../config/plans.js';
import {
  addStaff, claimMessageId, findBusinessByReferralCode, findProductBySku, getSession, latestUndoableBatch, recentProductNames,
  resolveActor, setSession, undoBatch, updateBusiness, uploadFile, consumeQuota, createBusiness, debtors,
  type Actor, type Session,
} from '../db/supabase.js';
import { imageBatchQueue, QUEUE, redisConnection } from '../lib/queues.js';
import { ngn, watDateKey } from '../lib/money.js';
import { dailyCount } from '../lib/rateLimit.js';
import { generateStructured, readBankAlert, routeMessage, type BrainResult } from '../services/geminiBrain.js';
import { connectSheet, extractSheetId, SHEETS_SERVICE_EMAIL } from '../services/googleSheets.js';
import { createCheckoutLink, paymentsLive, PaymentsNotLiveError } from '../services/paystack.js';
import { pendingPayout } from '../services/payouts.js';
import { adminPayoutCommand, adminTarget, maskAccount, PAYOUT_DETAILS_TTL_MS, submitPayout, withdrawStart } from '../flows/payouts.js';
import { REFERRAL, WITHDRAW_MIN_REFERRALS } from '../config/plans.js';
import { downloadMedia, markReadWithTyping, reply, type Reply, type WaInboundMessage } from '../services/whatsapp.js';
import { answerQuery } from '../flows/insights.js';
import {
  acceptMarginShield, bankAlertReply, confirmAndRespond, discardPending, linesToDrafts, MAX_LINES_PER_MESSAGE, proposeBatch, quotaReply, undoAndRespond,
} from '../flows/ledger.js';
import { chaseDebtsReply, deadStockPromoReply, statementReply } from '../flows/reports.js';
import { startVideo } from '../flows/video.js';
import { createOwnerMagicLink } from '../services/webLink.js';
import { withInterimNotice } from '../lib/interim.js';
import { displayPhone } from '../lib/phone.js';
import { closeShopReply } from '../flows/close.js';
import { AWAIT_LOGO_KEY, AWAIT_LOGO_TTL_S, logoAskReply, saveLogo, useNameAsLogo } from '../flows/branding.js';
import { customerReceiptReply, latestReceiptBatch } from '../flows/receipts.js';
import {
  ACKNOWLEDGE_REPLY, cancelAction, confirmAction, CORRECT_LAST_REPLY, notSupportedReply, owingContext, proposeClients, proposeDebts, normalisePhone as normaliseNgPhone, proposeProducts, saveCustomerPhone, undoAction,
} from '../flows/records.js';
import { clientStats, customerMessagesReply, lapsedText, myClientsText } from '../flows/clients.js';
import { checklistReply } from '../flows/onboarding.js';
import { setReminders } from '../flows/reminders.js';
import { adminStatsReply, isAdmin, supportReply } from '../flows/platform.js';

export interface InboundJob { msg: WaInboundMessage; profileName: string | null }

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const IMG_KEY = (phone: string) => `img_buffer:${phone}`;
const IMG_WINDOW_MS = 8000;
const MAX_VIDEO_PHOTOS = 5;
const LOCK_KEY = (phone: string) => `lock:msg:${phone}`;

// ═════════════════════════ SAFE SEND ═════════════════════════

/**
 * Sending the reply must NEVER make BullMQ retry the whole job: by then the message has already been processed
 * (onboarding state advanced, pending ledger rows created, video quota charged), so a retry would run those side
 * effects twice — e.g. the user's "Hi" becoming their business name. We retry only the HTTP send, and only for
 * transient errors (network, 429, 5xx). Permanent errors (expired token, user not allowed, …) are logged, not thrown.
 */
export async function sendReplySafely(r: Reply, to: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await r.send();
      return true;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|WhatsApp API (429|5\d\d)\b/.test(msg);
      if (!transient || attempt === 2) {
        console.error(`[send] reply to ${to} not delivered (${transient ? 'gave up after retries' : 'permanent error'}): ${msg}`);
        return false;
      }
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1) ** 2)); // 1s, 4s
    }
  }
  return false;
}

// ═════════════════════════ ENTRY ═════════════════════════

async function processInbound(job: Job<InboundJob & { claimed?: boolean }>, token?: string): Promise<void> {
  const { msg, profileName } = job.data;
  const phone = msg.from;

  // Per-user serialisation: a "Confirm" tap must never overtake the message that created the batch.
  const locked = await redis.set(LOCK_KEY(phone), job.id ?? '1', 'PX', 60_000, 'NX');
  if (!locked) {
    await job.moveToDelayed(Date.now() + 400, token);
    throw new DelayedError();
  }
  try {
    // Idempotency for Meta re-deliveries. Claimed AFTER taking the lock and remembered on the job: a job that waited for the
    // lock is re-run with attemptsMade still 0, and re-claiming then would wrongly drop it as a "duplicate"
    // (this silently lost the 2nd/3rd photo when several arrived at once, and any message sent while another was processing).
    if (!job.data.claimed) {
      if (!(await claimMessageId(msg.id))) return;
      await job.updateData({ ...job.data, claimed: true });
    }
    void markReadWithTyping(msg.id);
    // If the AI is slow (>12s), tell the user we are on it — once. Silence on WhatsApp reads as "broken".
    const r = await withInterimNotice(() => handle(msg, profileName), env.INTERIM_NOTICE_MS, async () => { await reply(phone).text('⏳ Processing your entry...').send(); });
    if (r && !r.isEmpty) await sendReplySafely(r, phone);
  } finally {
    await redis.del(LOCK_KEY(phone));
  }
}

async function handle(msg: WaInboundMessage, profileName: string | null): Promise<Reply | null> {
  const phone = msg.from;
  if (msg.type === 'text' && /^admin$/i.test(msg.text?.body?.trim() ?? '') && isAdmin(phone)) return adminStatsReply(phone);
  if (msg.type === 'text' && isAdmin(phone)) {
    const cmd = await adminPayoutCommand(phone, msg.text?.body ?? ''); // PAYOUTS · PAID WD-XXXXXX · REJECT WD-XXXXXX
    if (cmd) { if (cmd.userNotice) await sendReplySafely(cmd.userNotice.reply, cmd.userNotice.to); return cmd.reply; }
  }
  const actor = await resolveActor(phone);
  let session = await getSession(phone);

  if (!actor) return onboarding(msg, session, profileName);

  // The owner asked to set a logo and is now sending it: this photo is the logo, not a product shot.
  const photoId = msg.type === 'image' ? msg.image?.id : msg.type === 'document' && msg.document?.mime_type?.startsWith('image/') ? msg.document.id : null;
  if (photoId && !actor.isStaff) {
    const waiting = await redis.getdel(AWAIT_LOGO_KEY(phone));
    if (waiting !== null) {
      try { await saveLogo(actor, (await downloadMedia(photoId)).data); }
      catch { await redis.set(AWAIT_LOGO_KEY(phone), waiting, 'EX', AWAIT_LOGO_TTL_S); return reply(phone).text('I couldn\'t read that picture. Please send your logo again as a normal photo.'); }
      return waiting !== '-' ? customerReceiptReply(actor, waiting) : reply(phone).text('✅ Logo saved. It now appears at the top of your receipts and statements.');
    }
  }

  // Images are debounced (3–5 product photos arrive as separate webhooks within milliseconds).
  if (msg.type === 'image' && msg.image) {
    await redis.multi()
      .rpush(IMG_KEY(phone), JSON.stringify({ mediaId: msg.image.id, caption: msg.image.caption ?? '', mime: msg.image.mime_type }))
      .pexpire(IMG_KEY(phone), 120_000)
      .exec();
    await imageBatchQueue.add('flush', { phone }, {
      delay: IMG_WINDOW_MS,
      // Sliding window: every new photo replaces the pending flush and restarts the timer. 8s, not 4s: photos forwarded
      // from a gallery over a slow phone connection can arrive more than 4s apart and used to split into two batches.
      deduplication: { id: `img:${phone}`, ttl: IMG_WINDOW_MS, extend: true, replace: true },
    });
    return null;
  }

  const buttonId = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? msg.button?.payload ?? null;
  if (buttonId) return onButton(actor, buttonId, session);

  // Edit flow: whatever comes next (text OR voice) replaces the pending batch. Nothing was charged for the pending
  // batch (metering happens at confirmation), so there is nothing to refund. A voice note the plan can't take
  // must NOT discard the pending entry — the user would lose it for nothing.
  const voiceBlocked = msg.type === 'audio' && !PLANS[actor.business.subscription_tier].voiceNotes;
  if (session.current_state === 'AWAITING_TX_EDIT' && (msg.type === 'text' || msg.type === 'audio') && !voiceBlocked) {
    await undoBatch(session.pending_payload.batch_id as string);
    await setSession(phone, 'IDLE', {});
    session = { ...session, current_state: 'IDLE', pending_payload: {} };
  }

  const text = msg.text?.body?.trim() ?? '';
  if (text) {
    const cmd = await onCommand(actor, text, session);
    if (cmd) return cmd;
    const stateful = await onState(actor, text, session);
    if (stateful) return stateful;
  }

  if (msg.type === 'audio' && msg.audio) {
    if (!PLANS[actor.business.subscription_tier].voiceNotes) {
      return reply(phone)
        .text('🎙️ *Speak a full day\'s sales & expenses in one voice note* — that\'s Starter (₦5k/mo).', 'On the free plan, just type it: _"sold 2 lace 50k transfer"_')
        .button('PLANS', '⭐ See plans');
    }
    const audio = await downloadMedia(msg.audio.id);
    return runBrain(actor, { audio }, session);
  }
  if (msg.type === 'document' && msg.document?.mime_type?.startsWith('image/')) {
    const image = await downloadMedia(msg.document.id);
    return runBrain(actor, { image: { ...image, caption: msg.document.caption } }, session);
  }
  if (text) return runBrain(actor, { text }, session);

  // A reaction (👍 on a message) is not a request: replying would spam the owner and cost a WhatsApp conversation.
  if (msg.type === 'reaction') return null;
  console.warn('[inbound] unsupported message type from', phone.slice(-4), '→', msg.type);
  if (msg.type === 'video' || msg.type === 'document' || msg.type === 'sticker') {
    return reply(phone).text('I can\'t open that kind of file yet. Send product *photos*, a voice note, or type it: _"sold 3 Ankara 45k cash"_');
  }
  return reply(phone).text('I can read text, voice notes and photos. Try: _"sold 3 Ankara 45k cash"_');
}

// ═════════════════════════ ONBOARDING (2 steps, zero catalogue) ═════════════════════════

const REF_RE = /\bUNBAR-[A-Z2-9]{4}\b/i;

async function onboarding(msg: WaInboundMessage, session: Session, profileName: string | null): Promise<Reply> {
  const phone = msg.from;
  const text = msg.text?.body?.trim() ?? '';
  const button = msg.interactive?.button_reply?.id;

  // Staff number not yet added, or an ex-staff of a downgraded business.
  if (session.current_state === 'IDLE' || !['ONBOARDING_NAME', 'ONBOARDING_REFERRAL'].includes(session.current_state)) {
    // Referral deep link: wa.me/<bot>?text=Hi%20UNBAR-XXXX — capture it so step 2 is skipped.
    const code = text.match(REF_RE)?.[0]?.toUpperCase() ?? null;
    await setSession(phone, 'ONBOARDING_NAME', { referral_code: code });
    return reply(phone).text(
      `👋 Welcome to *Unbarmore*${profileName ? `, ${profileName.split(' ')[0]}` : ''}! I'm your pocket business manager on WhatsApp:`,
      '💰 Track sales, expenses and who owes you. Just talk or send a voice note.',
      '🎬 Turn product photos into sales videos.',
      '🛡️ Check transfer alerts for fakes.',
      '💬 Answer your business questions.',
      '',
      code ? `🎁 Referral code ${code} saved — you both get ₦1,000 when you subscribe.` : '',
      '*What is your business name?*',
    );
  }

  if (session.current_state === 'ONBOARDING_NAME') {
    const name = text.replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 2) return reply(phone).text('Please type your business name (e.g. _Ada Fabrics_).');
    const biz = await createBusiness(phone, name, profileName);
    const savedCode = (session.pending_payload.referral_code as string | null) ?? null;
    if (savedCode) {
      const ok = await applyReferral(biz.id, savedCode);
      await setSession(phone, 'IDLE', {}, biz.id);
      return welcomeDone(phone, name, biz.referral_code, ok ? savedCode : null, biz.id);
    }
    await setSession(phone, 'ONBOARDING_REFERRAL', {}, biz.id);
    return reply(phone)
      .text(`✅ *${name}* is set up. Your ${TRIAL_DAYS}-day free trial has started.`, '', 'Did someone refer you? Type their code (e.g. UNBAR-7K2P) or tap Skip.')
      .button('ONB_SKIP', 'Skip');
  }

  // ONBOARDING_REFERRAL — the business exists but resolveActor found it only after createBusiness;
  // this path is reached only if the owner row is missing, which createBusiness guarantees it isn't.
  void button;
  return reply(phone).text('Type your business name to start.');
}

async function applyReferral(businessId: string, code: string): Promise<boolean> {
  const referrer = await findBusinessByReferralCode(code);
  if (!referrer || referrer.id === businessId) return false;
  await updateBusiness(businessId, { referred_by_business_id: referrer.id });
  return true;
}

/** The message that turns a signup into a habit: what to do right now, where the dashboard is, and how to get the evening alert. */
async function welcomeDone(phone: string, name: string, myCode: string, usedCode: string | null, businessId: string): Promise<Reply> {
  const link = await createOwnerMagicLink(businessId).catch(() => null); // never let a link problem block a welcome
  return reply(phone).text(
    `🎉 You're in, *${name}*! Your ${TRIAL_DAYS}-day free trial has started: ${PLANS.trial.videos_used_this_month} short videos · ${PLANS.trial.tx_logged_this_month} logged messages · ${PLANS.trial.ocr_scans_used_this_month} alert checks.`,
    usedCode ? `🎁 Referral ${usedCode} applied.` : '',
    '',
    '*Start with these 3 steps:*',
    '1️⃣ *Tell me a sale.* Send a voice note or type: _"Sold 2 lace 50k, transfer 30k, balance 20k Mama Tunde"_',
    '2️⃣ *Tell me who owes you.* Type: _"Femi owes me 14k, Kalu 28k"_',
    '3️⃣ *Make a customer receipt* with the 🧾 button after a sale.',
    '',
    'Also: 📸 send photos for a sales video · 🧾 send a transfer screenshot and I check if it\'s fake · 💬 ask me anything about your business.',
    '',
    link ? `📲 *Your dashboard:* ${link}` : '📲 Type *DASHBOARD* any time for your charts and AI advisor.',
    link ? '_Open it, add it to your Home Screen, and tap "Turn on my evening alert". Every evening I\'ll show you what you made and who still owes you._' : '',
    '',
    '⏰ I\'ll message you at *7 AM* (who to follow up today) and *9 PM* (how your day went). Reply *REMINDERS OFF* to pause.',
    `Type *START* any time to see your progress. Your referral code: *${myCode}*, share it and you both get ₦1,000.`,
  );
}

// ═════════════════════════ STATEFUL REPLIES ═════════════════════════

const VideoDetailsSchema = z.object({
  product_name: z.string().optional(),
  price_ngn: z.number().int().nonnegative().optional(),
  delivery_info: z.string().optional(),
  pidgin: z.boolean(),
});

async function onState(actor: Actor, text: string, session: Session): Promise<Reply | null> {
  const p = session.pending_payload;
  switch (session.current_state) {
    case 'ONBOARDING_REFERRAL': {
      await setSession(actor.phone, 'IDLE', {});
      const code = text.match(REF_RE)?.[0]?.toUpperCase();
      const ok = code ? await applyReferral(actor.business.id, code) : false;
      if (code && !ok) return reply(actor.phone).text(`Hmm, ${code} isn't valid — no wahala, you're set up anyway.`).text('', 'Send a voice note or product photos to start.');
      return welcomeDone(actor.phone, actor.business.name, actor.business.referral_code, ok ? code! : null, actor.business.id);
    }
    case 'AWAITING_VIDEO_DETAILS': {
      const d = await generateStructured({
        schema: VideoDetailsSchema,
        system: 'Extract product name, selling price in whole Naira ("15k"=15000) and delivery info from a Nigerian seller\'s message. pidgin=true if written in Pidgin.',
        parts: [{ text }],
      });
      if (!d.product_name || !d.price_ngn) {
        return reply(actor.phone).text('I need the *product name* and *price*. E.g. _"Ankara gown, 15k, delivery Lagos 2k"_');
      }
      await setSession(actor.phone, 'IDLE', {});
      return startVideo(actor, {
        productName: d.product_name, priceNgn: d.price_ngn, deliveryInfo: d.delivery_info ?? null,
        rawPaths: (p.image_paths as string[]) ?? [], pidgin: d.pidgin,
      });
    }
    case 'AWAITING_PAYOUT_DETAILS': {
      // Don't let a forgotten WITHDRAW swallow tomorrow's "sold 2 lace…": the state expires.
      if (Date.now() - Number(p.at ?? 0) > PAYOUT_DETAILS_TTL_MS) { await setSession(actor.phone, 'IDLE', {}); return null; }
      if (/^(cancel|stop|no)$/i.test(text.trim())) { await setSession(actor.phone, 'IDLE', {}); return reply(actor.phone).text('Okay, cancelled. Your wallet is unchanged.'); }
      const res = await submitPayout(actor, text);
      const target = adminTarget();
      if (res.adminNotice && target) await sendReplySafely(res.adminNotice, target); // ADMIN_PHONE must have messaged the bot in the last 24h (Meta rule); PAYOUTS always lists pending ones
      return res.reply;
    }
    case 'AWAITING_SHEET_LINK': {
      const id = extractSheetId(text);
      if (!id) return reply(actor.phone).text('Paste the full Google Sheet link (starts with https://docs.google.com/spreadsheets/…).');
      await setSession(actor.phone, 'IDLE', {});
      if (!(await connectSheet(id))) {
        return reply(actor.phone).text(`I can't write to that sheet yet. Share it with *${SHEETS_SERVICE_EMAIL}* as Editor, then paste the link again.`);
      }
      await updateBusiness(actor.business.id, { google_sheet_id: id });
      return reply(actor.phone).text('✅ Google Sheet connected. Every confirmed record now appears there live.');
    }
    default:
      return null;
  }
}

// ═════════════════════════ COMMANDS (deterministic, no LLM cost) ═════════════════════════

/** One-tap sign-in link to the web app (also behind the 📲 Open my app button on the morning note). */
async function dashboardReply(actor: Actor): Promise<Reply> {
  if (actor.isStaff) return reply(actor.phone).text('The dashboard shows the whole business\'s money, so it is for the owner only.');
  const link = await createOwnerMagicLink(actor.business.id);
  if (!link) return reply(actor.phone).text('You asked for several links just now. Please wait a few minutes and try again.');
  return reply(actor.phone).text(
    '📊 *Your dashboard, advisor chat and ledger:*', link, '',
    'One tap, no password. Link works once and expires in 15 minutes. Add it to your Home Screen to open it like an app.',
  );
}

async function onCommand(actor: Actor, raw: string, session: Session): Promise<Reply | null> {
  const t = raw.trim();
  const upper = t.toUpperCase();
  const b = actor.business;

  if (upper === 'UNDO') return undoAndRespond(actor, await latestUndoableBatch(b.id, actor.user.id));
  if (['PLANS', 'UPGRADE', 'PAY', 'SUBSCRIBE'].includes(upper)) return plansMenu(actor);
  if (['DASHBOARD', 'WEB', 'CHAT', 'LOGIN'].includes(upper)) return dashboardReply(actor);
  if (upper === 'STARTER') {
    if (!paymentsLive()) return paymentsSoonReply(actor.phone);
    const link = await createCheckoutLink(b, 'starter_5k', 'monthly').catch((e) => { if (e instanceof PaymentsNotLiveError) return null; throw e; });
    if (!link) return paymentsSoonReply(actor.phone);
    return reply(actor.phone).text(
      `Tap to pay *${ngn(link.amountNgn)}*${link.walletApplied ? ` (${ngn(link.walletApplied)} wallet applied)` : ''} for Starter — card, transfer or USSD:`,
      link.url, '', 'Unlimited CFO chat + 15 videos + voice notes + fake-alert checks. Activates the moment payment lands. ✅',
    );
  }
  if (upper === 'SUPPORT') return supportReply(actor.phone);
  if (/^close( the)?( shop)?$|^closing$/i.test(t)) return closeShopReply(actor);
  if (/^who dey owe me\??$/i.test(t)) return reply(actor.phone).text(await answerQuery(b, { kind: 'debtors' }));
  const rcpt = t.match(/^receipt(?:\s+(.{2,40}))?$/i);
  if (rcpt) { const who = rcpt[1]?.trim(); return customerReceiptReply(actor, await latestReceiptBatch(actor, who), who); }
  const num = t.match(/^(?:my|sales|shop|video) (?:whatsapp )?number(?:\s+(.+))?$/i);
  if (num && !actor.isStaff) return setSalesNumber(actor, num[1]?.trim());
  if (upper === 'LOGO' && !actor.isStaff) { await redis.set(AWAIT_LOGO_KEY(actor.phone), '-', 'EX', AWAIT_LOGO_TTL_S); return logoAskReply(actor.phone); }
  if (['LOGO REMOVE', 'NO LOGO', 'REMOVE LOGO'].includes(upper) && !actor.isStaff) { await useNameAsLogo(actor); return reply(actor.phone).text('✅ Done. Your business name is now your logo on receipts.'); }
  if (['MY CLIENTS', 'MY CUSTOMERS', 'CLIENTS', 'CUSTOMERS'].includes(upper)) return reply(actor.phone).text(myClientsText(await clientStats(b.id)));
  if (['WIN BACK', 'WINBACK', 'WIN-BACK'].includes(upper)) return customerMessagesReply(actor, 'winback');
  if (['THANK', 'THANK CUSTOMERS', 'THANK BEST CUSTOMERS', 'VIP'].includes(upper)) return customerMessagesReply(actor, 'thank_top');
  if (['START', 'GETTING STARTED', 'GUIDE', 'HOW IT WORKS', 'HOW DOES THIS WORK', 'HOW DOES IT WORK'].includes(upper)) return checklistReply(actor);
  if (['REMINDERS OFF', 'STOP', 'UNSUBSCRIBE', 'STOP REMINDERS', 'MORNING OFF'].includes(upper) && !actor.isStaff) {
    await setReminders(b.id, false);
    return reply(actor.phone).text('✅ Done. I\'ll stop the 7 AM and 9 PM notes. Everything else still works. Type *REMINDERS ON* any time to turn them back on.');
  }
  if (['REMINDERS ON', 'START REMINDERS', 'MORNING ON'].includes(upper) && !actor.isStaff) {
    await setReminders(b.id, true);
    return reply(actor.phone).text('✅ Back on. You\'ll hear from me at 7 AM (who to follow up) and 9 PM (how your day went).');
  }
  if (upper === 'CHASE') return chaseDebtsReply(actor);
  if (upper === 'PROMO') return deadStockPromoReply(actor);
  if (upper === 'STATEMENT') return statementReply(actor);
  if (['MENU', 'HELP', '?'].includes(upper)) return helpMenu(actor);
  if (upper === 'I HAVE PAID') return reply(actor.phone).text(`Thanks! Your plan: *${b.subscription_tier}*. If you just paid, it updates within a minute.`);

  if (['WITHDRAW', 'CASH OUT', 'CASHOUT', 'PAYOUT'].includes(upper)) return withdrawStart(actor);
  if (['REFER', 'WALLET', 'REFERRAL'].includes(upper)) {
    const link = `https://wa.me/${env.WHATSAPP_DISPLAY_NUMBER}?text=${encodeURIComponent(`Hi Unbarmore ${b.referral_code}`)}`;
    const wallet = Number(b.referral_wallet_ngn);
    const pend = await pendingPayout(b.id);
    const r = reply(actor.phone).text(
      `🎁 Wallet: *${ngn(wallet)}*  ·  Your code: *${b.referral_code}*`,
      '',
      `• Each referral who subscribes = *${ngn(REFERRAL.REWARD_NGN)}* for you AND for them.`,
      `• Any balance from ${ngn(REFERRAL.DISCOUNT_MIN_NGN)} takes money off your own renewal — automatically.`,
      `• Cash payout unlocks at *${ngn(REFERRAL.WITHDRAW_MIN_NGN)}* (${WITHDRAW_MIN_REFERRALS} referrals): type *WITHDRAW*.`,
      pend ? `\n⏳ Payout pending: ${ngn(pend.amountNgn)} → ${pend.bankName ?? 'bank'} ${maskAccount(pend.accountNumber)}${pend.ref ? ` (${pend.ref})` : ''}` : '',
      '', 'Forward this to other sellers 👇', link,
    );
    if (wallet >= REFERRAL.WITHDRAW_MIN_NGN && !pend) r.button('WITHDRAW', '💸 Withdraw cash');
    return r;
  }

  if (upper === 'THEME') {
    if (!PLANS[b.subscription_tier].themes) return reply(actor.phone).text('Studio themes are on paid plans.').button('PLANS', '⭐ See plans');
    return reply(actor.phone).text(`Current video studio: *${b.studio_theme.replace('_', ' ')}*. Pick one:`)
      .listMenu('Choose theme', [
        { id: 'THEME:clean_minimalist', title: 'Clean minimalist', description: 'White studio, catalogue look' },
        { id: 'THEME:luxury_boutique', title: 'Luxury boutique', description: 'Marble, brass, spotlight' },
        { id: 'THEME:outdoor_lifestyle', title: 'Outdoor lifestyle', description: 'Golden-hour, greenery' },
      ]);
  }

  const rc = t.match(/^RC\s*[:#]?\s*(\d{4,8})$/i);
  if (rc && !actor.isStaff) {
    await updateBusiness(b.id, { rc_number: rc[1]! });
    return reply(actor.phone).text(`✅ RC ${rc[1]} will now appear on your receipts.`);
  }

  const staff = t.match(/^ADD STAFF\s+\+?(\d{10,15})\s+(.{2,60})$/i);
  if (staff && !actor.isStaff) {
    if (!PLANS[b.subscription_tier].maxStaff) return reply(actor.phone).text('Staff numbers are on Growth (₦15k/mo): up to 10 staff, each sale audited to you.').button('PLANS', '⭐ See plans');
    const res = await addStaff(b.id, normalisePhone(staff[1]!), staff[2]!.trim());
    return reply(actor.phone).text(
      res === 'ok' ? `✅ ${staff[2]} can now log sales from ${staff[1]}. You'll get an audit of everything they log.`
        : res === 'limit' ? 'You have reached 10 staff numbers.' : 'That number is already linked to a business.',
    );
  }

  if (upper === 'SHEET' && !actor.isStaff) {
    if (!PLANS[b.subscription_tier].sheetsSync) return reply(actor.phone).text('Live Google Sheets sync is on Growth (₦15k/mo).').button('PLANS', '⭐ See plans');
    await setSession(actor.phone, 'AWAITING_SHEET_LINK', {});
    return reply(actor.phone).text('1. Create a Google Sheet', `2. Share it with *${SHEETS_SERVICE_EMAIL ?? '(not configured)'}* as Editor`, '3. Paste the link here');
  }

  // Smart Order Code typed alone ("UNB-7K2") → show product card.
  const sku = upper.match(/^UNB-[A-Z0-9]{3}$/)?.[0];
  if (sku) {
    const p = await findProductBySku(b.id, sku);
    if (p) return reply(actor.phone).text(`*${p.name}* (${p.sku_code})`, `Price: ${ngn(p.selling_price_ngn)} · Stock: ${Math.max(0, Number(p.stock_qty))}`, '', `To log a sale: _"sold 1 ${sku} cash"_`);
  }
  void session;
  return null;
}

const normalisePhone = (p: string) => (p.startsWith('0') ? `234${p.slice(1)}` : p);

/** Shown instead of a payment link while PAYSTACK_SECRET_KEY isn't live: honest, and gives a human route. */
function paymentsSoonReply(to: string): Reply {
  return reply(to).text(
    '💳 Online payment is being switched on — it opens very soon.',
    env.SUPPORT_WHATSAPP_URL ? `Want your plan today? Message us and we'll activate it by hand: ${env.SUPPORT_WHATSAPP_URL}` : 'Please check back shortly — nothing is charged.',
  );
}

function helpMenu(actor: Actor): Reply {
  const b = actor.business;
  return reply(actor.phone).text(
    `*${b.name}* · plan: ${b.subscription_tier}`,
    '',
    '🎙️ Voice/text a sale, expense or restock',
    '📸 3–5 product photos → sales video',
    '🧾 Transfer screenshot → fake-alert check',
    '❓ Ask: "who owes me?", "profit this week"',
    '💬 Paste a customer\'s "too cost" → closing replies',
    '👥 MY CLIENTS · WIN BACK (customers who stopped buying) · LOGO (your receipt logo) · MY NUMBER (the number shown on your videos)',
    '🧠 Ask me about your business: pricing, customers, stock, cash flow',
    '',
    '📊 DASHBOARD — charts + unlimited AI advisor on the web',
    '🧾 RECEIPT — receipt for your last sale · 🏪 CLOSE — end-of-day cash check · 🆘 SUPPORT',
    'Commands: UNDO · CHASE · PROMO · STATEMENT · THEME · REFER · PLANS · RC 1234567',
  );
}

function plansMenu(actor: Actor): Reply {
  const b = actor.business;
  return reply(actor.phone)
    .text(
      '*Unbarmore plans*',
      `⭐ Starter — ${ngn(PRICES_NGN.starter_5k.monthly)}/mo or ${ngn(PRICES_NGN.starter_5k.annual)}/yr (2 months free)`,
      '🎙️ *Speak a full day\'s sales & expenses in one voice note* — I split it into every sale, expense and debt. One voice note = 1 of your 250 messages.',
      '15 HD videos · 150 alert checks · Inflation Shield · Sunday CEO report · unlimited AI advisor',
      '',
      `🚀 Growth — ${ngn(PRICES_NGN.growth_15k.monthly)}/mo or ${ngn(PRICES_NGN.growth_15k.annual)}/yr`,
      '50 videos, no watermark · unlimited logging · 10 staff numbers with audit · live Google Sheet',
      Number(b.referral_wallet_ngn) > 0 ? `\n🎁 Your ${ngn(b.referral_wallet_ngn)} wallet is applied automatically.` : '',
      !paymentsLive() ? '\n_Online payment opens very soon — pick a plan and we\'ll sort it with you._' : '',
    )
    .listMenu('Choose plan', [
      { id: 'PAY:starter_5k:monthly', title: 'Starter monthly', description: '₦5,000 / month' },
      { id: 'PAY:starter_5k:annual', title: 'Starter yearly', description: '₦50,000 / year — 2 months free' },
      { id: 'PAY:growth_15k:monthly', title: 'Growth monthly', description: '₦15,000 / month' },
      { id: 'PAY:growth_15k:annual', title: 'Growth yearly', description: '₦150,000 / year — 2 months free' },
    ]);
}

// ═════════════════════════ BUTTONS ═════════════════════════

async function onButton(actor: Actor, id: string, session: Session): Promise<Reply | null> {
  const [kind, a, b2] = id.split(':');
  switch (kind) {
    case 'TXC': return confirmAndRespond(actor, a!, async (pid) => (await redis.set(`costask:${pid}`, '1', 'EX', 3 * 86_400, 'NX')) === 'OK');
    case 'TXE':
      await setSession(actor.phone, 'AWAITING_TX_EDIT', { batch_id: a });
      return reply(actor.phone).text('✏️ Send the correct version (text or voice note) and I\'ll replace it.');
    case 'TXX': return discardPending(actor, a!);
    case 'TXU': return undoAndRespond(actor, a!);
    case 'ACTOK': return confirmAction(actor, redis, a!);
    case 'ACTNO': return cancelAction(actor, redis, a!);
    case 'ACTUNDO': return undoAction(actor, redis, a!);
    case 'RCPT': return customerReceiptReply(actor, a!, undefined, b2);
    case 'LOGO': {
      if (actor.isStaff) return reply(actor.phone).text('Only the owner can change the logo.');
      const batch = b2 && b2 !== '-' ? b2 : null;
      if (a === 'ask') { await redis.set(AWAIT_LOGO_KEY(actor.phone), batch ?? '-', 'EX', AWAIT_LOGO_TTL_S); return logoAskReply(actor.phone); }
      await useNameAsLogo(actor);
      return batch ? customerReceiptReply(actor, batch) : reply(actor.phone).text('✅ Done. Your business name is your logo on receipts.');
    }
    case 'MSA': return acceptMarginShield(actor, a!, Number(b2));
    case 'MSK': return reply(actor.phone).text('👍 Price unchanged. I\'ll keep watching your costs.');
    case 'PLANS': return plansMenu(actor);
    case 'PAY': {
      const tier = a as 'starter_5k' | 'growth_15k';
      const cycle = b2 as 'monthly' | 'annual';
      if (!(tier in PRICES_NGN) || !['monthly', 'annual'].includes(cycle)) return null;
      const link = await createCheckoutLink(actor.business, tier, cycle).catch((e) => { if (e instanceof PaymentsNotLiveError) return null; throw e; });
      if (!link) return paymentsSoonReply(actor.phone);
      return reply(actor.phone).text(
        `Tap to pay *${ngn(link.amountNgn)}*${link.walletApplied ? ` (${ngn(link.walletApplied)} wallet applied)` : ''} — card, transfer or USSD:`,
        link.url,
        '',
        'Your plan activates the moment payment lands. ✅',
      );
    }
    case 'PAYOUT':
    case 'WITHDRAW': return withdrawStart(actor);
    case 'THEME': {
      const theme = a as Actor['business']['studio_theme'];
      if (!['clean_minimalist', 'luxury_boutique', 'outdoor_lifestyle'].includes(theme)) return null;
      await updateBusiness(actor.business.id, { studio_theme: theme });
      return reply(actor.phone).text(`✅ New videos will use *${theme.replace('_', ' ')}*.`);
    }
    case 'ONB_SKIP':
      await setSession(actor.phone, 'IDLE', {});
      return welcomeDone(actor.phone, actor.business.name, actor.business.referral_code, null, actor.business.id);
    case 'BTN_CHASE_DEBT': return chaseDebtsReply(actor);
    case 'WINBACK': return customerMessagesReply(actor, 'winback');
    case 'DASHLINK': return dashboardReply(actor);
    case 'LOGHOW': return reply(actor.phone).text('📝 Send a voice note or type it, like: _sold 2 lace 50k cash_ or _paid rent 150k_. I\'ll show it back for you to confirm.');
    case 'BTN_DEADSTOCK_PROMO': return deadStockPromoReply(actor);
    case 'BTN_EXPORT_PDF': return statementReply(actor);
    default:
      void session;
      return reply(actor.phone).text('That button has expired. Type MENU to see options.');
  }
}

// ═════════════════════════ GEMINI ROUTING ═════════════════════════

async function runBrain(
  actor: Actor,
  input: { text?: string; audio?: { data: Buffer; mimeType: string }; image?: { data: Buffer; mimeType: string; caption?: string } },
  session: Session,
): Promise<Reply> {
  // Resolve Smart Order Codes to product names so "sold 2 UNB-7K2" logs against the right product.
  let text = input.text;
  if (text && /UNB-[A-Z0-9]{3}/i.test(text)) {
    for (const m of text.match(/UNB-[A-Z0-9]{3}/gi) ?? []) {
      const p = await findProductBySku(actor.business.id, m);
      if (p) text = text.replace(m, p.name);
    }
  }

  const brain: BrainResult = await routeMessage({
    ...input, text,
    business: {
      name: actor.business.name, recentProducts: await recentProductNames(actor.business.id), todayWat: watDateKey(),
      owing: owingContext(await debtors(actor.business.id, 30).catch(() => [])),
    },
  });
  const source = input.audio ? 'whatsapp_voice' : input.image ? 'whatsapp_image'
    : /\b(credit|cr|acct|amt|ngn)\b.*\d/i.test(text ?? '') ? 'sms_forward' : 'whatsapp_text';
  void session;

  switch (brain.intent) {
    case 'LOG_TRANSACTION': {
      if (!brain.transactions?.length) return reply(actor.phone).text(brain.clarification_needed ?? 'I couldn\'t find an amount. Try: _"sold 2 lace 50k cash"_');
      if (brain.transactions.length > MAX_LINES_PER_MESSAGE) {
        return reply(actor.phone).text(`That's ${brain.transactions.length} items in one message — please send them in batches of ${MAX_LINES_PER_MESSAGE} or fewer so I can check each one.`);
      }
      return proposeBatch(actor, source, linesToDrafts(brain.transactions), {
        clarification: brain.clarification_needed,
        prefix: brain.transcript ? `🎙️ _"${brain.transcript.slice(0, 200)}"_\n` : undefined,
      });
    }
    case 'RECORD_DEBTS': return proposeDebts(actor, redis, brain.debts);
    case 'SET_PRODUCTS': return proposeProducts(actor, redis, brain.products);
    case 'UPDATE_CUSTOMER': return saveCustomerPhone(actor, brain.customer_update?.name ?? '', brain.customer_update?.phone ?? '');
    case 'RECORD_CLIENTS': return proposeClients(actor, redis, brain.clients);
    case 'CUSTOMER_OUTREACH': return customerMessagesReply(actor, brain.outreach ?? 'winback');
    case 'CHASE_DEBTS': return chaseDebtsReply(actor);
    case 'UNDO_LAST': return undoAndRespond(actor, await latestUndoableBatch(actor.business.id, actor.user.id));
    case 'CORRECT_LAST': return reply(actor.phone).text(CORRECT_LAST_REPLY);
    case 'NOT_SUPPORTED': return notSupportedReply(actor.phone, brain.not_supported);
    case 'ACKNOWLEDGE': return reply(actor.phone).text(ACKNOWLEDGE_REPLY);
    case 'VERIFY_BANK_ALERT': {
      if (!input.image) return reply(actor.phone).text('Send the transfer screenshot and I\'ll check it.');
      if (!(await consumeQuota(actor.business, 'ocr_scans_used_this_month'))) return quotaReply(actor, 'ocr_scans_used_this_month');
      const alert = brain.bank_alert?.is_bank_alert || brain.bank_alert?.is_supplier_receipt ? brain.bank_alert : await readBankAlert(input.image);
      if (alert.is_supplier_receipt && alert.supplier_lines?.length) {
        return proposeBatch(actor, 'whatsapp_image', linesToDrafts(alert.supplier_lines), { prefix: '🧾 Supplier receipt read:' });
      }
      if (!alert.is_bank_alert) return reply(actor.phone).text('That doesn\'t look like a transfer receipt. For a product video, send 2–5 photos together.');
      const path = await uploadFile('raw-images', `${actor.business.id}/alerts/${Date.now()}.jpg`, input.image.data, input.image.mimeType);
      return bankAlertReply(actor, alert, path);
    }
    case 'DRAFT_SALES_REPLY': {
      const s = brain.sales_reply;
      if (!s?.scripts?.length) return reply(actor.phone).text('Paste exactly what the customer said and I\'ll write replies that close.');
      return reply(actor.phone).text('💬 *Copy one and send:*', ...s.scripts.slice(0, 2).flatMap((x, i) => ['', `*Option ${i + 1}*`, x]));
    }
    case 'CREATE_VIDEO_SCRIPT': {
      const v = brain.video_request;
      if (input.image) {
        // Single photo with a caption like "make video, Ankara 15k" — treat as a 1-photo batch.
        return askOrStartVideo(actor, [input.image], v?.product_name, v?.price_ngn, v?.delivery_info);
      }
      return reply(actor.phone).text(
        `📸 Send 2–5 photos of ${v?.product_name ?? 'the product'} together (select them all, then send).`,
        'Clear daylight photos work best — I\'ll clean up the background.',
      );
    }
    case 'QUERY_BUSINESS': {
      const q = brain.query ?? { kind: 'profit' as const };
      if (q.kind === 'customers') return reply(actor.phone).text(myClientsText(await clientStats(actor.business.id)));
      if (q.kind === 'lapsed_customers') return reply(actor.phone).text(lapsedText(await clientStats(actor.business.id)));
      return reply(actor.phone).text(await answerQuery(actor.business, q));
    }
    case 'BUSINESS_ADVICE': {
      const advisor = `${env.WEB_APP_URL.replace(/\/$/, '')}/advisor`;
      const { ok, n } = await dailyCount(redis, `advice:${actor.phone}:${watDateKey()}`, ADVICE_PER_DAY);
      if (!ok) return reply(actor.phone).text(`💬 That's my ${ADVICE_PER_DAY} chat answers for today on WhatsApp. For deeper help any time, open your advisor: ${advisor}`);
      const r = reply(actor.phone).text(brain.reply_text ?? 'Tell me a little more about your business and what you want to improve.');
      // The link on the first answer of the day and every 5th: useful, never nagging.
      if (n === 1 || n % 5 === 0) r.text('', `📲 Charts + a deeper advisor that knows your numbers: ${advisor}`);
      return r;
    }
    case 'HELP':
      return reply(actor.phone).text(brain.reply_text ?? '', '', 'Type MENU to see everything I can do.');
    case 'OFF_TOPIC':
    default:
      return reply(actor.phone).text(
        brain.reply_text ?? 'I only help with your business — sales videos, bookkeeping, receipts and closing customers. 🙏',
      );
  }
}

// ═════════════════════════ IMAGE BATCH (after 4s debounce) ═════════════════════════

async function askOrStartVideo(
  actor: Actor, images: { data: Buffer; mimeType: string }[], name?: string, price?: number, delivery?: string,
): Promise<Reply> {
  const paths: string[] = [];
  for (const [i, img] of images.entries()) {
    const ext = img.mimeType.split('/')[1] ?? 'jpg';
    paths.push(await uploadFile('raw-images', `${actor.business.id}/${Date.now()}-${i}.${ext}`, img.data, img.mimeType));
  }
  if (name && price) return startVideo(actor, { productName: name, priceNgn: price, deliveryInfo: delivery ?? null, rawPaths: paths });

  // Late photos of the SAME set (a slow album arriving in pieces): add them to the pending photos instead of replacing them.
  const session = await getSession(actor.phone);
  const earlier = session.current_state === 'AWAITING_VIDEO_DETAILS' ? ((session.pending_payload.image_paths as string[] | undefined) ?? []) : [];
  if (earlier.length) {
    const all = [...earlier, ...paths].slice(0, MAX_VIDEO_PHOTOS);
    await setSession(actor.phone, 'AWAITING_VIDEO_DETAILS', { image_paths: all });
    return reply(actor.phone).text(
      `➕ Added — you now have ${all.length} photo${all.length > 1 ? 's' : ''}${earlier.length + paths.length > MAX_VIDEO_PHOTOS ? ` (${MAX_VIDEO_PHOTOS} is the most for one video)` : ''}.`,
      'Reply with the product name, price (₦) and delivery info (optional) to start your video.',
    );
  }
  await setSession(actor.phone, 'AWAITING_VIDEO_DETAILS', { image_paths: paths });
  return reply(actor.phone).text(
    `📸 Got ${paths.length} photo${paths.length > 1 ? 's' : ''}! For your sales video, reply in one message:`,
    '1️⃣ Product name',
    '2️⃣ Price (₦)',
    '3️⃣ Delivery info (optional)',
    '',
    '_e.g. "Ankara gown, 15k, delivery Lagos 2k"_',
  );
}

/** MY NUMBER → show it · MY NUMBER 0803… → change it · MY NUMBER RESET → back to the number you chat with. Shown on videos made from now on. */
async function setSalesNumber(actor: Actor, arg?: string): Promise<Reply> {
  const r = reply(actor.phone);
  const current = displayPhone(actor.business.sales_phone ?? actor.business.owner_phone);
  if (!arg) return r.text(`📞 Customers see *${current ?? 'no number'}* on your videos.`, 'To change it: _MY NUMBER 0803 123 4567_', 'To go back to the number you chat with me from: _MY NUMBER RESET_');
  const reset = /^(reset|default|remove|same)$/i.test(arg);
  const phone = reset ? null : normaliseNgPhone(arg);
  if (!reset && !phone) return r.text(`That number doesn't look right (${arg.slice(0, 20)}). Send the 11 digits, like _MY NUMBER 08031234567_.`);
  try { await updateBusiness(actor.business.id, { sales_phone: phone }); }
  catch (e) {
    console.error('[sales_phone] update failed (migration 006 not applied?)', String((e as Error)?.message ?? e).slice(0, 200));
    return r.text('I couldn\'t save that just now. Please try again later.');
  }
  return r.text(`✅ Your next videos will show *${displayPhone(phone ?? actor.business.owner_phone)}*.`, '_Videos you already made keep the old number._');
}

export async function flushImageBatch(phone: string): Promise<void> {
  const res = await redis.multi().lrange(IMG_KEY(phone), 0, -1).del(IMG_KEY(phone)).exec();
  const items = ((res?.[0]?.[1] as string[] | undefined) ?? []).map((s) => JSON.parse(s) as { mediaId: string; caption: string; mime: string });
  if (!items.length) return;

  const actor = await resolveActor(phone);
  if (!actor) return;
  const caption = items.map((i) => i.caption).filter(Boolean).join(' ');
  const images = await Promise.all(items.slice(0, 5).map((i) => downloadMedia(i.mediaId)));

  let r: Reply;
  if (images.length === 1) {
    // One image is ambiguous: transfer screenshot, supplier receipt, or a single product photo. Let Gemini decide.
    r = await runBrain(actor, { image: { ...images[0]!, caption } }, await getSession(phone));
  } else {
    // Several images at once = product photos for a video.
    const brain = caption
      ? await routeMessage({ text: caption, business: { name: actor.business.name, recentProducts: [], todayWat: watDateKey() } }).catch(() => null)
      : null;
    const v = brain?.video_request;
    r = await askOrStartVideo(actor, images, v?.product_name, v?.price_ngn, v?.delivery_info);
  }
  await sendReplySafely(r, phone);
}

// ═════════════════════════ WORKERS ═════════════════════════

export function startMessageWorkers() {
  const inbound = new Worker<InboundJob>(QUEUE.inbound, processInbound, { connection: redisConnection, concurrency: 20 });
  const images = new Worker<{ phone: string }>(QUEUE.imageBatch, async (job) => flushImageBatch(job.data.phone), { connection: redisConnection, concurrency: 10 });

  // Final failure → one apology, so the user is never left on "typing…".
  inbound.on('failed', (job, err) => {
    if (!job || err instanceof DelayedError || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    console.error('[inbound] failed', job.data.msg.id, err);
    void reply(job.data.msg.from).text('😓 Sorry, I couldn\'t process that. Please try again in a minute.').send().catch(() => undefined);
  });
  images.on('failed', (job, err) => {
    console.error('[images] failed', job?.data.phone, err);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void reply(job.data.phone).text('😓 I couldn\'t read those photos. Please send them again.').send().catch(() => undefined);
    }
  });
  return [inbound, images];
}
