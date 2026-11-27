import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { PLANS, TRIAL_DAYS, type Metric, type Tier } from '../config/plans.js';
import { randomCode } from '../lib/money.js';

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ───────────── Row types (mirror supabase/migrations/001_init_schema.sql) ─────────────

export type StudioTheme = 'clean_minimalist' | 'luxury_boutique' | 'outdoor_lifestyle';
export type TxType = 'sale' | 'expense' | 'restock' | 'debt_repayment';
export type PayMethod = 'transfer' | 'cash' | 'pos' | 'credit';
export type SourceChannel = 'whatsapp_text' | 'whatsapp_voice' | 'whatsapp_image' | 'sms_forward';

export interface Business {
  id: string;
  name: string;
  owner_phone: string;
  /** The number customers should message (shown on videos). null = owner_phone. Needs migration 006. */
  sales_phone?: string | null;
  /** Bought pay-as-you-go video credits. Needs migration 008. */
  video_credits?: number;
  business_category: string | null;
  rc_number: string | null;
  logo_url: string | null;
  studio_theme: StudioTheme;
  subscription_tier: Tier;
  billing_cycle: 'monthly' | 'annual';
  paystack_customer_code: string | null;
  paystack_subscription_code: string | null;
  trial_ends_at: string;
  subscription_expires_at: string;
  videos_used_this_month: number;
  ocr_scans_used_this_month: number;
  tx_logged_this_month: number;
  pdf_receipts_used_this_month: number;
  ceo_reports_used_this_month: number;
  referral_code: string;
  referred_by_business_id: string | null;
  referral_reward_paid: boolean;
  referral_wallet_ngn: number;
  /** The owner chose to use wallet money on their own renewal instead of cash. Needs migration 009. */
  referral_apply_to_renewal?: boolean;
  /** Evening profit split "restock/reserve/pay", e.g. 50/20/30. NULL = default. Needs migration 010. */
  setaside_split?: string | null;
  /** "GTBank 0123456789 Ada Fabrics": printed on quotes. Needs migration 011. */
  pay_details?: string | null;
  total_value_recovered_ngn: number;
  google_sheet_id: string | null;
  created_at: string;
}

export interface BusinessUser {
  id: string;
  business_id: string;
  phone_number: string;
  full_name: string;
  role: 'owner' | 'staff';
  is_active: boolean;
}

export interface TxnDraft {
  tx_type: TxType;
  description: string;
  category: string;
  quantity: number;
  unit_price_ngn: number | null;
  total_amount_ngn: number;
  amount_paid_ngn: number;
  payment_method: PayMethod | null;
  item_name: string | null;     // → products (lazy)
  customer_name: string | null; // → customers (lazy)
  bank_session_id?: string | null;
  sender_bank_name?: string | null;
  ocr_fraud_flag?: boolean;
  ocr_fraud_reason?: string | null;
}

export interface TxnRow {
  id: string;
  business_id: string;
  batch_id: string;
  logged_by_user_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  tx_type: TxType;
  category: string;
  description: string;
  quantity: number;
  unit_price_ngn: number | null;
  total_amount_ngn: number;
  amount_paid_ngn: number;
  balance_due_ngn: number;
  payment_method: PayMethod | null;
  status: 'pending_confirm' | 'confirmed' | 'undone';
  confirmed_at: string | null;
  receipt_pdf_url: string | null;
  source_channel: SourceChannel;
  transaction_date: string;
}

/** Who is talking to us. Owner and staff both live in business_users. */
export interface Actor {
  phone: string;
  business: Business;
  user: BusinessUser;
  isStaff: boolean;
}

function must<T>(res: { data: unknown; error: { message: string } | null }, ctx: string): T {
  if (res.error) throw new Error(`[db:${ctx}] ${res.error.message}`);
  return res.data as T;
}

// ───────────── Identity / onboarding ─────────────

export async function resolveActor(phone: string): Promise<Actor | null> {
  const { data } = await db
    .from('business_users')
    .select('*, businesses(*)')
    .eq('phone_number', phone)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return null;
  const { businesses: business, ...user } = data as BusinessUser & { businesses: Business };
  const isStaff = user.role === 'staff';
  // A downgraded growth business loses staff access; the owner's data stays intact.
  if (isStaff && PLANS[business.subscription_tier].maxStaff === 0) return null;
  return { phone, business, user, isStaff };
}

export async function findBusinessByReferralCode(code: string): Promise<Business | null> {
  const { data } = await db.from('businesses').select('*').eq('referral_code', code.trim().toUpperCase()).maybeSingle();
  return (data as Business | null) ?? null;
}

/** Step 1 of onboarding: the business only exists once it has a name (name is NOT NULL). */
export async function createBusiness(phone: string, name: string, ownerName: string | null): Promise<Business> {
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString(); // overrides the column's 7-day default
  const biz = must<Business>(await db.from('businesses').insert({ owner_phone: phone, name, trial_ends_at: trialEnds }).select('*').single(), 'createBusiness');
  must(await db.from('business_users').insert({
    business_id: biz.id, phone_number: phone, full_name: ownerName ?? 'Owner', role: 'owner',
  }), 'createOwnerUser');
  return biz;
}

export async function getBusiness(id: string): Promise<Business> {
  return must<Business>(await db.from('businesses').select('*').eq('id', id).single(), 'getBusiness');
}

export async function updateBusiness(id: string, patch: Partial<Business>): Promise<void> {
  must(await db.from('businesses').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id), 'updateBusiness');
}

export async function addStaff(businessId: string, phone: string, fullName: string): Promise<'ok' | 'limit' | 'taken'> {
  const biz = await getBusiness(businessId);
  const { count } = await db.from('business_users').select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).eq('role', 'staff').eq('is_active', true);
  if ((count ?? 0) >= PLANS[biz.subscription_tier].maxStaff) return 'limit';
  const { error } = await db.from('business_users').insert({ business_id: businessId, phone_number: phone, full_name: fullName, role: 'staff' });
  if (error?.code === '23505') return 'taken';
  if (error) throw new Error(`[db:addStaff] ${error.message}`);
  return 'ok';
}

// ───────────── Sessions & 24h window ─────────────

export type SessionState =
  | 'IDLE' | 'ONBOARDING_NAME' | 'ONBOARDING_REFERRAL' | 'AWAITING_VIDEO_DETAILS'
  | 'AWAITING_TX_CONFIRM' | 'AWAITING_TX_EDIT' | 'AWAITING_PAYOUT_DETAILS' | 'AWAITING_SHEET_LINK';

export interface Session {
  phone_number: string;
  business_id: string | null;
  current_state: SessionState;
  pending_payload: Record<string, unknown>;
  last_inbound_at: string;
}

/** Called from the webhook (fast path): records inbound time for the free 24h window. */
export async function touchInbound(phone: string): Promise<void> {
  const now = new Date().toISOString();
  must(await db.from('whatsapp_sessions').upsert(
    { phone_number: phone, last_inbound_at: now, last_message_at: now },
    { onConflict: 'phone_number', ignoreDuplicates: false },
  ), 'touchInbound');
}

export async function getSession(phone: string): Promise<Session> {
  const { data } = await db.from('whatsapp_sessions').select('*').eq('phone_number', phone).maybeSingle();
  return (data as Session | null) ?? {
    phone_number: phone, business_id: null, current_state: 'IDLE', pending_payload: {}, last_inbound_at: new Date().toISOString(),
  };
}

export async function setSession(phone: string, state: SessionState, payload: Record<string, unknown> = {}, businessId?: string): Promise<void> {
  must(await db.from('whatsapp_sessions').upsert({
    phone_number: phone, current_state: state, pending_payload: payload,
    ...(businessId ? { business_id: businessId } : {}),
  }, { onConflict: 'phone_number' }), 'setSession');
}

export async function isInServiceWindow(phone: string): Promise<boolean> {
  const { data } = await db.from('whatsapp_sessions').select('last_inbound_at').eq('phone_number', phone).maybeSingle();
  if (!data) return false;
  // 23h, not 24h: headroom so a slow queue never tips us into a paid send.
  return Date.now() - new Date(data.last_inbound_at as string).getTime() < 23 * 3600_000;
}

/** Returns false if Meta already delivered this message id (webhook retries). */
export async function claimMessageId(waMessageId: string): Promise<boolean> {
  const { error } = await db.from('processed_messages').insert({ wa_message_id: waMessageId });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(`[db:claimMessageId] ${error.message}`);
}

// ───────────── Quotas ─────────────

export async function consumeQuota(b: Business, metric: Metric, amount = 1): Promise<boolean> {
  const { data, error } = await db.rpc('consume_quota', {
    p_business_id: b.id, p_metric: metric, p_cap: PLANS[b.subscription_tier][metric], p_amount: amount,
  });
  if (error) throw new Error(`[db:consumeQuota] ${error.message}`);
  return data === true;
}

export async function refundQuota(businessId: string, metric: Metric, amount = 1): Promise<void> {
  await db.rpc('refund_quota', { p_business_id: businessId, p_metric: metric, p_amount: amount });
}

/** Video credits (migration 008). Reads fail closed: if the migration is missing there are simply no credits. */
export async function consumeVideoCredit(businessId: string): Promise<boolean> {
  try { const { data, error } = await db.rpc('consume_video_credit', { p_business_id: businessId }); return !error && data === true; } catch { return false; }
}
export async function addVideoCredits(businessId: string, qty: number): Promise<number> {
  const { data, error } = await db.rpc('add_video_credits', { p_business_id: businessId, p_qty: qty });
  if (error) throw new Error(`[db:addVideoCredits] ${error.message}`);
  return Number(data);
}
export async function refundVideoCredit(businessId: string): Promise<void> {
  await db.rpc('refund_video_credit', { p_business_id: businessId });
}

// ───────────── Lazy products & customers ─────────────

export interface ProductRow {
  id: string; sku_code: string; name: string; cost_price_ngn: number; previous_cost_price_ngn: number | null;
  selling_price_ngn: number; stock_qty: number; last_sold_at: string | null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export async function upsertProduct(businessId: string, name: string, attempt = 0): Promise<ProductRow> {
  const existing = await db.from('products').select('*').eq('business_id', businessId).eq('name_key', norm(name)).maybeSingle();
  if (existing.data) return existing.data as ProductRow;
  // Smart Order Code: UNB-XXX, short enough to say in a 15s video and type on a phone.
  const ins = await db.from('products')
    .insert({ business_id: businessId, name: name.trim(), sku_code: `UNB-${randomCode(3, '23456789ABCDEFGHJKMNPQRSTUVWXYZ')}` })
    .select('*').single();
  if (ins.error?.code === '23505' && attempt < 5) return upsertProduct(businessId, name, attempt + 1); // name race or sku clash
  return must<ProductRow>(ins, 'upsertProduct');
}

export async function getProduct(id: string): Promise<ProductRow> {
  return must<ProductRow>(await db.from('products').select('*').eq('id', id).single(), 'getProduct');
}

export async function findProductBySku(businessId: string, sku: string): Promise<ProductRow | null> {
  const { data } = await db.from('products').select('*').eq('business_id', businessId).eq('sku_code', sku.toUpperCase()).maybeSingle();
  return (data as ProductRow | null) ?? null;
}

export async function recentProductNames(businessId: string, limit = 40): Promise<string[]> {
  const { data } = await db.from('products').select('name').eq('business_id', businessId).order('updated_at', { ascending: false }).limit(limit);
  return (data ?? []).map((r) => r.name as string);
}

export async function upsertCustomer(businessId: string, name: string, attempt = 0): Promise<string> {
  const existing = await db.from('customers').select('id').eq('business_id', businessId).eq('name_key', norm(name)).maybeSingle();
  if (existing.data) return existing.data.id as string;
  const ins = await db.from('customers').insert({ business_id: businessId, name: name.trim() }).select('id').single();
  if (ins.error?.code === '23505' && attempt < 3) return upsertCustomer(businessId, name, attempt + 1);
  return must<{ id: string }>(ins, 'upsertCustomer').id;
}

// ───────────── Ledger ─────────────

export async function createPendingBatch(
  actor: Actor, source: SourceChannel, drafts: TxnDraft[], occurredAt?: string,
): Promise<{ batchId: string; rows: TxnRow[] }> {
  const batchId = crypto.randomUUID();
  const rows = [];
  for (const d of drafts) {
    const product = d.item_name && (d.tx_type === 'sale' || d.tx_type === 'restock') ? await upsertProduct(actor.business.id, d.item_name) : null;
    const customerId = d.customer_name ? await upsertCustomer(actor.business.id, d.customer_name) : null;
    rows.push({
      business_id: actor.business.id,
      batch_id: batchId,
      logged_by_user_id: actor.user.id,
      customer_id: customerId,
      product_id: product?.id ?? null,
      tx_type: d.tx_type,
      category: d.category,
      description: d.description,
      quantity: d.quantity,
      unit_price_ngn: d.unit_price_ngn,
      total_amount_ngn: d.total_amount_ngn,
      amount_paid_ngn: d.amount_paid_ngn,
      payment_method: d.payment_method,
      source_channel: source,
      bank_session_id: d.bank_session_id ?? null,
      sender_bank_name: d.sender_bank_name ?? null,
      ocr_fraud_flag: d.ocr_fraud_flag ?? false,
      ocr_fraud_reason: d.ocr_fraud_reason ?? null,
      status: 'pending_confirm',
      ...(occurredAt ? { transaction_date: occurredAt } : {}),
    });
  }
  const inserted = must<TxnRow[]>(await db.from('transactions').insert(rows).select('*'), 'insertTxns');
  return { batchId, rows: inserted };
}

export async function getBatchRows(batchId: string): Promise<(TxnRow & { customers: { name: string } | null })[]> {
  return must(await db.from('transactions').select('*, customers(name)').eq('batch_id', batchId).order('created_at'), 'getBatchRows');
}

export async function confirmBatch(batchId: string): Promise<number> {
  const { data, error } = await db.rpc('confirm_batch', { p_batch_id: batchId });
  if (error) throw new Error(`[db:confirmBatch] ${error.message}`);
  return Number(data ?? 0);
}

export async function undoBatch(batchId: string): Promise<boolean> {
  const { data, error } = await db.rpc('undo_batch', { p_batch_id: batchId });
  if (error) throw new Error(`[db:undoBatch] ${error.message}`);
  return data === true;
}

export async function setReceiptUrl(batchId: string, path: string): Promise<void> {
  await db.from('transactions').update({ receipt_pdf_url: path }).eq('batch_id', batchId);
}

/** Latest batch by this person that UNDO can still reverse. */
export async function latestUndoableBatch(businessId: string, userId: string): Promise<string | null> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data } = await db.from('transactions')
    .select('batch_id, status, confirmed_at')
    .eq('business_id', businessId).eq('logged_by_user_id', userId)
    .in('status', ['pending_confirm', 'confirmed'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  if (data.status === 'pending_confirm') return data.batch_id as string;
  return (data.confirmed_at as string) >= fiveMinAgo ? (data.batch_id as string) : null;
}

/** Same NIP session id seen before (any business) = recycled/forged screenshot. */
export async function findBankSessionReuse(sessionId: string): Promise<{ business_id: string; transaction_date: string } | null> {
  const { data } = await db.from('transactions').select('business_id, transaction_date')
    .eq('bank_session_id', sessionId).neq('status', 'undone').limit(1).maybeSingle();
  return (data as { business_id: string; transaction_date: string } | null) ?? null;
}

// ───────────── Analytics (numbers come from SQL, never from the LLM) ─────────────

export interface LedgerSummary {
  revenue_ngn: number; cash_in_ngn: number; expenses_ngn: number; restock_ngn: number;
  debt_collected_ngn: number; net_profit_ngn: number; tx_count: number;
  /** Present once the database has migration 005 (true profit); absent before, and then net_profit_ngn is only "cash left". */
  cogs_ngn?: number; gross_profit_ngn?: number; unpriced_revenue_ngn?: number;
}

export async function ledgerSummary(businessId: string, from: Date, to: Date): Promise<LedgerSummary> {
  const { data, error } = await db.rpc('ledger_summary', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw new Error(`[db:ledgerSummary] ${error.message}`);
  const r = ((data as Record<string, string | number>[])[0] ?? {}) as Record<string, string | number>;
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    revenue_ngn: n('revenue_ngn'), cash_in_ngn: n('cash_in_ngn'), expenses_ngn: n('expenses_ngn'), restock_ngn: n('restock_ngn'),
    debt_collected_ngn: n('debt_collected_ngn'), net_profit_ngn: n('net_profit_ngn'), tx_count: n('tx_count'),
    ...('cogs_ngn' in r ? { cogs_ngn: n('cogs_ngn'), gross_profit_ngn: n('gross_profit_ngn'), unpriced_revenue_ngn: n('unpriced_revenue_ngn') } : {}),
  };
}

export async function expensesByCategory(businessId: string, from: Date, to: Date): Promise<{ category: string; amount: number }[]> {
  const { data } = await db.rpc('expenses_by_category', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString() });
  return ((data ?? []) as { category: string; amount_ngn: string }[]).map((r) => ({ category: r.category, amount: Number(r.amount_ngn) }));
}

export async function topProducts(businessId: string, from: Date, to: Date, limit = 5): Promise<{ name: string; qty: number; revenue: number }[]> {
  const { data } = await db.rpc('top_products', { p_business_id: businessId, p_from: from.toISOString(), p_to: to.toISOString(), p_limit: limit });
  return ((data ?? []) as { name: string; qty: string; revenue_ngn: string }[]).map((r) => ({ name: r.name, qty: Number(r.qty), revenue: Number(r.revenue_ngn) }));
}

export interface Debtor { id: string; name: string; phone_number: string | null; outstanding_debt_ngn: number; debt_since: string | null; debt_due_date: string | null; last_reminder_sent_at: string | null }

export async function debtors(businessId: string, limit = 20): Promise<Debtor[]> {
  const { data } = await db.from('customers').select('id, name, phone_number, outstanding_debt_ngn, debt_since, debt_due_date, last_reminder_sent_at')
    .eq('business_id', businessId).gt('outstanding_debt_ngn', 0)
    .order('outstanding_debt_ngn', { ascending: false }).limit(limit);
  return ((data ?? []) as Debtor[]).map((d) => ({ ...d, outstanding_debt_ngn: Number(d.outstanding_debt_ngn) }));
}

export async function deadStock(businessId: string, days = 21): Promise<ProductRow[]> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const { data } = await db.from('products').select('*')
    .eq('business_id', businessId).gt('stock_qty', 0).lt('last_sold_at', cutoff)
    .order('last_sold_at', { ascending: true }).limit(10);
  return (data ?? []) as ProductRow[];
}

export async function lowStock(businessId: string, productName?: string): Promise<ProductRow[]> {
  let q = db.from('products').select('*').eq('business_id', businessId);
  if (productName) q = q.eq('name_key', norm(productName));
  const { data } = await q.order('stock_qty', { ascending: true }).limit(10);
  return (data ?? []) as ProductRow[];
}

/** Dedupe for scheduled sends. Returns false if already sent for this period. */
export async function claimOutbound(businessId: string, kind: string, periodKey: string): Promise<boolean> {
  const { error } = await db.from('outbound_log').insert({ business_id: businessId, kind, period_key: periodKey });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(`[db:claimOutbound] ${error.message}`);
}

// ───────────── Storage ─────────────

export async function uploadFile(bucket: string, path: string, body: Buffer, contentType: string): Promise<string> {
  const { error } = await db.storage.from(bucket).upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(`[storage:${bucket}] ${error.message}`);
  return path;
}

/** Meta fetches media from this URL once; keep TTL short. */
export async function signedUrl(bucket: string, path: string, ttlSeconds = 3600): Promise<string> {
  const { data, error } = await db.storage.from(bucket).createSignedUrl(path, ttlSeconds);
  if (error || !data) throw new Error(`[storage:sign] ${error?.message}`);
  return data.signedUrl;
}

export async function downloadFile(bucket: string, path: string): Promise<Buffer> {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`[storage:download] ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}
