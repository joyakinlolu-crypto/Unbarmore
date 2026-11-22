import { Gift, Share2 } from 'lucide-react';
import LogoutButton from '@/components/LogoutButton';
import { requireSession } from '@/lib/auth';
import { ngn, waLink } from '@/lib/format';
import { db } from '@/lib/supabase';
import { REFERRAL, walletState, WITHDRAW_MIN_REFERRALS } from '@/lib/referral';
import { botNumber } from '@/lib/whatsapp';
import ProfileForm from './ProfileForm';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const PLAN_NAME = { trial: 'Free trial', free_limited: 'Free plan', starter_5k: 'Starter', growth_15k: 'Growth' } as const;

export default async function Settings() {
  const { business: b } = await requireSession();
  const bot = botNumber();
  // A payout the admin hasn't paid yet (select * so this also works on a database that hasn't had migration 003).
  const { data: pend } = await db.from('payout_requests').select('*').eq('business_id', b.id).eq('status', 'requested').limit(1).maybeSingle();
  const wallet = Number(b.referral_wallet_ngn);
  const ws = walletState(wallet, !!pend);
  const paid = b.subscription_tier === 'starter_5k' || b.subscription_tier === 'growth_15k';
  const share = waLink(bot, `Hi Unbarmore ${b.referral_code}`);
  const shareMsg = `I use Unbarmore to make sales videos, track my profit and catch fake transfer alerts — all on WhatsApp. Use my code ${b.referral_code} and we both get ₦1,000 when you subscribe: ${share}`;
  const expires = new Date(paid ? b.subscription_expires_at : b.trial_ends_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const upgrade = (t: string) => waLink(bot, t);
  const card = 'rounded-3xl border border-slate-100 p-5 shadow-sm';

  return (
    <main className="space-y-4 p-3">
      <section className={card}><h2 className="mb-4 font-semibold">Business profile</h2>
        <ProfileForm name={b.name} rc={b.rc_number ?? ''} theme={b.studio_theme} themesLocked={b.subscription_tier === 'free_limited'} />
        <p className="mt-3 text-xs text-slate-400">Logo on receipts is coming soon.</p>
      </section>

      <section className="rounded-3xl bg-gradient-to-br from-royal to-accent p-5 text-white">
        <h2 className="flex items-center gap-2 font-semibold"><Gift size={18} /> Give ₦1,000, get ₦1,000</h2>
        <p className="mt-1 text-sm text-blue-100">When someone you refer subscribes, you both get ₦1,000 credit.</p>
        <div className="mt-3 flex items-end justify-between">
          <div><p className="text-xs text-blue-200">Your code</p><p className="text-2xl font-extrabold tracking-wider">{b.referral_code}</p></div>
          <div className="text-right"><p className="text-xs text-blue-200">Wallet</p><p className="text-2xl font-extrabold">{ngn(b.referral_wallet_ngn)}</p></div>
        </div>
        <a href={`https://wa.me/?text=${encodeURIComponent(shareMsg)}`} target="_blank" rel="noopener" className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-white py-3 font-semibold text-royal"><Share2 size={16} /> Share on WhatsApp</a>
        {ws.kind === 'unlocked' && (
          <a href={upgrade('WITHDRAW')} className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-emerald-400 py-3 font-semibold text-emerald-950">💸 Request Cash Payout</a>
        )}
        {ws.kind === 'pending' && (
          <p className="mt-3 rounded-xl bg-white/15 p-3 text-sm">⏳ Payout pending — {ngn(Number(pend?.amount_ngn ?? 0))} to {String(pend?.bank_name ?? 'your bank')} ····{String(pend?.account_number ?? '').slice(-4)}{pend?.ref ? ` · Ref ${String(pend.ref)}` : ''}. We’ll message you on WhatsApp when it’s paid.</p>
        )}
        {ws.kind === 'locked' && (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded-full bg-white/20" role="progressbar" aria-valuenow={ws.progressPct} aria-valuemin={0} aria-valuemax={100}><div className="h-2 rounded-full bg-emerald-300" style={{ width: `${Math.max(4, ws.progressPct)}%` }} /></div>
            <p className="mt-1.5 text-xs text-blue-100">Cash payout unlocks at {ngn(REFERRAL.WITHDRAW_MIN_NGN)} ({WITHDRAW_MIN_REFERRALS} referrals) — {ws.referralsToGo} more to go.</p>
            {ws.canDiscount && <p className="mt-1 text-xs text-blue-100">Meanwhile your {ngn(wallet)} already takes money off your next renewal.</p>}
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-1 font-semibold">Subscription</h2>
        <p className="text-sm text-slate-500"><b className="text-ink">{PLAN_NAME[b.subscription_tier]}</b>{paid ? ` · ${b.billing_cycle === 'annual' ? 'yearly' : 'monthly'} · renews/ends ${expires}` : b.subscription_tier === 'trial' ? ` · ends ${expires}` : ''}</p>
        {Number(b.referral_wallet_ngn) > 0 && <p className="mt-1 text-sm text-profit">Your {ngn(b.referral_wallet_ngn)} wallet is applied automatically at checkout.</p>}
        <div className="mt-4 grid gap-2">
          {b.subscription_tier !== 'growth_15k' && <a href={upgrade('PLANS')} className="rounded-xl bg-accent py-3 text-center font-semibold text-white">{paid ? 'Upgrade to Growth' : 'Choose a plan'}</a>}
          <p className="text-center text-xs text-slate-400">Starter ₦5,000/mo or ₦50,000/yr (2 months free) · Growth ₦15,000/mo or ₦150,000/yr. Checkout opens in WhatsApp.</p>
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-1 font-semibold">Google Sheets live sync</h2>
        {b.subscription_tier === 'growth_15k'
          ? b.google_sheet_id ? <p className="text-sm text-profit">Connected ✅ Every confirmed record is added to your sheet.</p>
            : <p className="text-sm text-slate-500">Not connected. Send <b>SHEET</b> on WhatsApp and follow the 3 steps.</p>
          : <p className="text-sm text-slate-500">Available on the Growth plan.</p>}
      </section>

      <LogoutButton />
    </main>
  );
}
