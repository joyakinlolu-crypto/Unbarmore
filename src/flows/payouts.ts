import { env } from '../config/env.js';
import { REFERRAL } from '../config/plans.js';
import { db, setSession, type Actor } from '../db/supabase.js';
import { ngn } from '../lib/money.js';
import { decidePayout, listPendingPayouts, pendingPayout, PayoutsNotReadyError, requestPayout } from '../services/payouts.js';
import { reply, type Reply } from '../services/whatsapp.js';

/** How long the bot waits for bank details after WITHDRAW before it stops treating the next message as bank details. */
export const PAYOUT_DETAILS_TTL_MS = 10 * 60_000;

export const maskAccount = (acct: string | null) => (acct ? `****${acct.slice(-4)}` : '****');
export const adminTarget = (): string | null => env.ADMIN_PHONE ?? env.OPS_ALERT_PHONE ?? null;

// ───────────── bank details parsing ─────────────

export type BankParse =
  | { ok: true; bankName: string; account: string }
  | { ok: false; error: 'no_account' | 'many_accounts' | 'no_bank' };

const TEN = /(?<![0-9])[0-9]{10}(?![0-9])/g;

/**
 * "GTBank 0123456789", "0123456789 Access Bank", "Bank name: Opay, Account number: 8101234567" → { bank, 10-digit NUBAN }.
 * Strict on purpose: this decides where real money goes. An 11-digit phone number is NOT an account number.
 */
export function parseBankDetails(input: string): BankParse {
  let text = input.trim();
  let found = text.match(TEN);
  if (!found) { // "0123 456 789" / "0123-456-789"
    text = text.replace(/(?<=[0-9])[ -](?=[0-9])/g, '');
    found = text.match(TEN);
  }
  if (!found) return { ok: false, error: 'no_account' };
  const distinct = [...new Set(found)];
  if (distinct.length > 1) return { ok: false, error: 'many_accounts' };
  const account = distinct[0]!;
  const bankName = text.replace(account, ' ')
    .replace(/bank\s*name\s*[:\-]?/gi, ' ').replace(/(^|\s)bank\s*[:\-]/gi, ' ')
    .replace(/\b(account|acct|a\/c|number|no|nuban|name|my|is|the|pls|please)\b\.?/gi, ' ')
    .replace(/[:;,()\-_/\\|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}][\p{L} &.']{1,39}$/u.test(bankName)) return { ok: false, error: 'no_bank' };
  return { ok: true, bankName, account };
}

// ───────────── WITHDRAW (owner) ─────────────

export async function withdrawStart(actor: Actor): Promise<Reply> {
  const r = reply(actor.phone);
  if (actor.isStaff) return r.text('Only the business owner can withdraw referral money.');
  const wallet = Number(actor.business.referral_wallet_ngn);

  const pending = await pendingPayout(actor.business.id);
  if (pending) {
    return r.text(
      `⏳ You already have a payout waiting: *${ngn(pending.amountNgn)}* to ${pending.bankName ?? 'your bank'} ${maskAccount(pending.accountNumber)}${pending.ref ? ` (Ref ${pending.ref})` : ''}.`,
      'I\'ll message you here as soon as it is paid.',
    );
  }
  if (wallet < REFERRAL.WITHDRAW_MIN_NGN) {
    return r.text(
      `🎁 Your wallet is *${ngn(wallet)}*. Cash payout starts at *${ngn(REFERRAL.WITHDRAW_MIN_NGN)}*: that is one shop you bring who subscribes (*${ngn(REFERRAL.REWARD_BY_TIER.starter_5k)}* for Starter, *${ngn(REFERRAL.REWARD_BY_TIER.growth_15k)}* for Growth).`,
      'Type *REFER* to get your link.',
    );
  }
  await setSession(actor.phone, 'AWAITING_PAYOUT_DETAILS', { at: Date.now() });
  return r.text(
    `💸 *Cash payout: ${ngn(wallet)}* (your whole wallet)`,
    '',
    'Reply with your *bank name* and *10-digit account number*, for example:',
    '_GTBank 0123456789_',
    '',
    'The account name should match you or your business. Type *CANCEL* to stop.',
  );
}

export interface SubmitResult { reply: Reply; adminNotice: Reply | null; done: boolean }

/** Bank details received. Validates, then asks the database to do the whole thing atomically. */
export async function submitPayout(actor: Actor, text: string): Promise<SubmitResult> {
  const r = reply(actor.phone);
  const p = parseBankDetails(text);
  if (!p.ok) {
    const msg = p.error === 'no_account' ? 'I need a *10-digit account number* (not a phone number). Example: _GTBank 0123456789_'
      : p.error === 'many_accounts' ? 'I see more than one account number. Send just one, e.g. _Access Bank 0123456789_'
      : 'Which *bank* is it? Example: _GTBank 0123456789_';
    return { reply: r.text(msg, 'Or type *CANCEL*.'), adminNotice: null, done: false };
  }

  let res;
  try { res = await requestPayout(actor.business.id, p.bankName, p.account); }
  catch (e) {
    if (e instanceof PayoutsNotReadyError) {
      await setSession(actor.phone, 'IDLE', {});
      console.error('[payout] migration 003 not applied — payouts disabled');
      return { reply: r.text('💸 Cash payouts are being switched on — nothing was taken from your wallet. Please try again shortly.', env.SUPPORT_WHATSAPP_URL ? `Need it urgently? ${env.SUPPORT_WHATSAPP_URL}` : ''), adminNotice: null, done: true };
    }
    throw e;
  }

  if (res.reason === 'already_pending' || res.reason === 'below_minimum' || res.reason === 'no_business') {
    await setSession(actor.phone, 'IDLE', {});
    return { reply: r.text(res.reason === 'already_pending' ? '⏳ You already have a payout waiting — I\'ll message you when it is paid. Your wallet was not charged twice.'
      : res.reason === 'below_minimum' ? `Your wallet is ${ngn(res.amountNgn)} — cash payout starts at ${ngn(REFERRAL.WITHDRAW_MIN_NGN)}. Nothing was taken.`
      : 'I couldn\'t find your account. Nothing was taken.'), adminNotice: null, done: true };
  }
  if (!res.ok) return { reply: r.text('That account number or bank doesn\'t look right. Send them again, e.g. _GTBank 0123456789_ — or *CANCEL*.'), adminNotice: null, done: false };

  await setSession(actor.phone, 'IDLE', {});
  const target = adminTarget();
  return {
    done: true,
    reply: r.text(
      `✅ *Payout requested — ${ngn(res.amountNgn)}*`,
      `To: ${p.bankName} ${maskAccount(p.account)}`,
      `Ref: *${res.ref}*  ·  Status: ⏳ *pending*`,
      '',
      'We pay within 2 working days and I\'ll message you here. Your wallet is now ₦0 — and you can\'t request twice for the same money.',
    ),
    adminNotice: target ? reply(target).text(
      `💸 *Payout request ${res.ref}*`,
      `${ngn(res.amountNgn)} → ${p.bankName} *${p.account}*`,
      `Business: ${actor.business.name} (${actor.phone})`,
      '',
      `After you pay, reply: *PAID ${res.ref}*`,
      `To return the money to their wallet: *REJECT ${res.ref}*`,
      '(Send *PAYOUTS* to list everything pending.)',
    ) : null,
  };
}

// ───────────── ADMIN: PAYOUTS / PAID / REJECT ─────────────

export interface AdminPayoutResult { reply: Reply; userNotice: { to: string; reply: Reply } | null }

/** Only called for ADMIN_PHONE. Returns null when the text isn't a payout command (so normal handling continues). */
export async function adminPayoutCommand(adminPhone: string, text: string): Promise<AdminPayoutResult | null> {
  const t = text.trim();
  if (/^payouts$/i.test(t)) {
    const list = await listPendingPayouts(10);
    return { userNotice: null, reply: reply(adminPhone).text(
      list.length ? `💸 *${list.length} payout${list.length === 1 ? '' : 's'} pending*` : '💸 No payouts pending.',
      ...list.map((p) => `• ${p.ref} — ${ngn(p.amountNgn)} → ${p.bankName} ${p.accountNumber} · ${p.businessName} (${p.ownerPhone})`),
      list.length ? '\nReply *PAID WD-XXXXXX* after paying, or *REJECT WD-XXXXXX* to refund the wallet.' : '',
    ) };
  }
  const m = t.match(/^(paid|reject(?:ed)?)\s+(WD-[0-9A-F]{6})$/i);
  if (!m) return null;
  const paid = m[1]!.toLowerCase() === 'paid';
  const ref = m[2]!.toUpperCase();
  let d;
  try { d = await decidePayout(ref, paid ? 'paid' : 'rejected'); }
  catch (e) { if (e instanceof PayoutsNotReadyError) return { userNotice: null, reply: reply(adminPhone).text('Payouts need migration 003 in Supabase first.') }; throw e; }
  if (!d.ok) {
    return { userNotice: null, reply: reply(adminPhone).text(d.reason === 'not_found' ? `I can't find ${ref}.` : d.reason === 'already_decided' ? `${ref} was already decided — nothing changed.` : `Couldn't process ${ref} (${d.reason}).`) };
  }
  const { data: biz } = await db.from('businesses').select('name, owner_phone').eq('id', d.businessId!).maybeSingle();
  const owner = biz?.owner_phone as string | undefined;
  return {
    reply: reply(adminPhone).text(paid ? `✅ ${ref} marked *paid* — ${ngn(d.amountNgn)} to ${d.bankName} ${d.accountNumber} (${biz?.name ?? '?'}). I've told them.`
      : `↩️ ${ref} *rejected* — ${ngn(d.amountNgn)} is back in ${biz?.name ?? 'their'} wallet. I've told them.`),
    userNotice: owner ? { to: owner, reply: reply(owner).text(
      paid ? `💸 *Your referral payout has been sent!* ${ngn(d.amountNgn)} → ${d.bankName} ${maskAccount(d.accountNumber)} (Ref ${ref}). Thank you for spreading the word 🎉`
        : `Your payout request ${ref} couldn't be completed, so *${ngn(d.amountNgn)} is back in your wallet*. Check the account details and type WITHDRAW to try again${env.SUPPORT_WHATSAPP_URL ? `, or ask us: ${env.SUPPORT_WHATSAPP_URL}` : '.'}`,
    ) } : null,
  };
}

/** USE CREDIT / KEEP CASH: whether wallet money discounts the owner's own renewal (off by default: cash is the default). */
export async function setRenewalCredit(actor: Actor, on: boolean): Promise<Reply> {
  const { error } = await db.from('businesses').update({ referral_apply_to_renewal: on }).eq('id', actor.business.id);
  if (error) return reply(actor.phone).text('I could not save that choice yet. Please try again in a few minutes.');
  const wallet = Number(actor.business.referral_wallet_ngn);
  return reply(actor.phone).text(
    on ? `✅ Done. Your wallet (${ngn(wallet)} now) will come off your next renewal automatically.`
       : `✅ Done. Your wallet (${ngn(wallet)} now) stays as cash. Type *WITHDRAW* to cash out.`,
    on ? 'Changed your mind? Send *KEEP CASH*.' : 'Want it off your renewal instead? Send *USE CREDIT*.',
  );
}
