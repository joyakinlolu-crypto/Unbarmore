import { db } from '../db/supabase.js';

export type PayoutReason = 'ok' | 'bad_account' | 'bad_bank' | 'no_business' | 'already_pending' | 'below_minimum';
export interface PayoutResult { ok: boolean; reason: PayoutReason; ref: string | null; amountNgn: number }
export interface PendingPayout { ref: string | null; amountNgn: number; bankName: string | null; accountNumber: string | null; businessId: string }

/** Migration 003 hasn't been applied to this database yet. The bot must say so plainly, not crash or lie. */
export class PayoutsNotReadyError extends Error {
  constructor() { super('referral payouts need migration 003_referral_payouts.sql'); this.name = 'PayoutsNotReadyError'; }
}
const missingFn = (e: { code?: string; message?: string }) => e.code === 'PGRST202' || /Could not find the function|does not exist/i.test(e.message ?? '');

/** One atomic database step: locks the wallet, validates, zeroes it, writes the pending ledger + payout rows. */
export async function requestPayout(businessId: string, bankName: string, accountNumber: string): Promise<PayoutResult> {
  const { data, error } = await db.rpc('request_payout', { p_business_id: businessId, p_bank_name: bankName, p_account_number: accountNumber });
  if (error) { if (missingFn(error)) throw new PayoutsNotReadyError(); throw new Error(`[payout] ${error.message}`); }
  const r = (data as { ok: boolean; reason: PayoutReason; ref: string | null; amount_ngn: string }[])[0]!;
  return { ok: r.ok, reason: r.reason, ref: r.ref, amountNgn: Number(r.amount_ngn) };
}

export async function decidePayout(ref: string, decision: 'paid' | 'rejected') {
  const { data, error } = await db.rpc('decide_payout', { p_ref: ref, p_decision: decision });
  if (error) { if (missingFn(error)) throw new PayoutsNotReadyError(); throw new Error(`[payout] ${error.message}`); }
  const r = (data as { ok: boolean; reason: string; business_id: string | null; amount_ngn: string; bank_name: string | null; account_number: string | null }[])[0]!;
  return { ok: r.ok, reason: r.reason, businessId: r.business_id, amountNgn: Number(r.amount_ngn), bankName: r.bank_name, accountNumber: r.account_number };
}

const toPending = (r: Record<string, unknown>): PendingPayout => ({
  ref: (r.ref as string | null) ?? null, amountNgn: Number(r.amount_ngn), bankName: (r.bank_name as string | null) ?? null,
  accountNumber: (r.account_number as string | null) ?? null, businessId: r.business_id as string,
});

/** The business's pending payout, if any. Returns null (not an error) on a database without migration 003. */
export async function pendingPayout(businessId: string): Promise<PendingPayout | null> {
  const { data, error } = await db.from('payout_requests').select('*').eq('business_id', businessId).eq('status', 'requested').limit(1).maybeSingle();
  return error || !data ? null : toPending(data);
}

export async function listPendingPayouts(limit = 10): Promise<(PendingPayout & { businessName: string; ownerPhone: string })[]> {
  const { data } = await db.from('payout_requests').select('*, businesses(name, owner_phone)').eq('status', 'requested').order('created_at', { ascending: true }).limit(limit);
  return ((data ?? []) as (Record<string, unknown> & { businesses: { name: string; owner_phone: string } | null })[]).map((r) => ({
    ...toPending(r), businessName: r.businesses?.name ?? '?', ownerPhone: r.businesses?.owner_phone ?? '',
  }));
}
