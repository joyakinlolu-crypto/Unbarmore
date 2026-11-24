/**
 * Live smoke test against a REAL Supabase project, using the real backend modules.
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/live-smoke.mts
 * Creates throw-away tenants (phones 2349000000xxx), asserts, then deletes everything it created.
 * Secrets come from the environment only — nothing is written to disk.
 */
// Dummy values for env vars this script never uses (the backend's zod config requires them to be present).
for (const [k, v] of Object.entries({
  WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x', WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x', PAYSTACK_SECRET_KEY: 'x',
  PAYSTACK_PLAN_STARTER_MONTHLY: 'a', PAYSTACK_PLAN_STARTER_ANNUAL: 'b', PAYSTACK_PLAN_GROWTH_MONTHLY: 'c', PAYSTACK_PLAN_GROWTH_ANNUAL: 'd',
})) process.env[k] ??= v;

const S = await import('../src/db/supabase.ts');
const L = await import('../src/flows/ledger.ts');
const P = await import('../src/services/paystack.ts');
const R = await import('../src/flows/receipts.ts');
const PO = await import('../src/services/payouts.ts');
const { db } = S;

const PH = { owner: '2349000000001', ref: '2349000000002', referee: '2349000000003' };
const ids: string[] = [];
let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };
const num = (v: unknown) => Number(v ?? 0);

async function cleanup() {
  const { data: bs } = await db.from('businesses').select('id').like('owner_phone', '2349000000%');
  const all = (bs ?? []).map((b) => b.id as string);
  if (!all.length) return;
  for (const id of all) {
    const { data: files } = await db.storage.from('pdf-receipts').list(id);
    if (files?.length) await db.storage.from('pdf-receipts').remove(files.map((f) => `${id}/${f.name}`));
  }
  await db.from('payout_requests').delete().in('business_id', all);
  await db.from('billing_events').delete().in('business_id', all);
  await db.from('referral_ledger').delete().in('business_id', all);
  await db.from('businesses').delete().in('id', all);
}

try {
  await cleanup(); // leftovers from an aborted earlier run

  // ── 1. Onboarding ──
  const biz = await S.createBusiness(PH.owner, 'Smoke Test Fabrics', 'Ada');
  ids.push(biz.id);
  ok('createBusiness → referral code UNBAR-XXXX', /^UNBAR-[A-Z2-9]{4}$/.test(biz.referral_code), biz.referral_code);
  ok('new business starts on trial', biz.subscription_tier === 'trial');
  const actor = (await S.resolveActor(PH.owner))!;
  actor.business.logo_url = 'none'; // the first receipt asks "Do you have a logo?" (covered in the conversation test); here the owner already chose to use the business name
  ok('resolveActor finds the owner', actor?.business.id === biz.id && !actor.isStaff);

  // ── 2. Ledger: 3 lines from ONE message, human-in-the-loop ──
  const drafts = L.linesToDrafts([
    { type: 'sale', item_name: 'Swiss Lace', quantity: 2, amount_ngn: 50000, amount_paid_ngn: 30000, payment_method: 'transfer', customer_name: 'Mama Tunde' },
    { type: 'expense', quantity: 1, amount_ngn: 5000, amount_paid_ngn: 5000, payment_method: 'cash', category: 'Fuel/Diesel' },
    { type: 'restock', item_name: 'Gele', quantity: 10, unit_price_ngn: 4000, amount_ngn: 40000, amount_paid_ngn: 40000, payment_method: 'cash' },
  ] as never);
  const proposal = await L.proposeBatch(actor, 'whatsapp_voice', drafts);
  const { data: pend } = await db.from('transactions').select('id, status, batch_id').eq('business_id', biz.id);
  ok('proposal creates 3 PENDING rows (nothing committed silently)', pend?.length === 3 && pend.every((t) => t.status === 'pending_confirm'));
  ok('proposal offers Confirm / Edit buttons', JSON.stringify(proposal.toPayload()).includes('Confirm') && JSON.stringify(proposal.toPayload()).includes('Edit'));
  ok('proposing does NOT charge the message quota yet', num((await S.getBusiness(biz.id)).tx_logged_this_month) === 0);
  const batchId = pend![0]!.batch_id as string;

  const confirmed = await L.confirmAndRespond(actor, batchId);
  const after = await S.getBusiness(biz.id);
  ok('confirming a 3-line message charges exactly 1 message', num(after.tx_logged_this_month) === 1, `tx_logged_this_month=${after.tx_logged_this_month}`);
  ok('all 3 rows are now confirmed', ((await db.from('transactions').select('status').eq('batch_id', batchId)).data ?? []).every((t) => t.status === 'confirmed'));
  const { data: cust } = await db.from('customers').select('outstanding_debt_ngn, debt_since').eq('business_id', biz.id).single();
  ok('unpaid balance became customer debt (₦20,000)', num(cust?.outstanding_debt_ngn) === 20000 && !!cust?.debt_since);
  const { data: prods } = await db.from('products').select('name, stock_qty, cost_price_ngn, sku_code').eq('business_id', biz.id);
  const lace = prods?.find((p) => p.name === 'Swiss Lace'), gele = prods?.find((p) => p.name === 'Gele');
  ok('products auto-created lazily with UNB-XXX codes', /^UNB-[A-Z0-9]{3}$/.test(lace?.sku_code ?? '') && /^UNB-/.test(gele?.sku_code ?? ''));
  ok('stock moved (lace −2, gele +10) and restock cost recorded', num(lace?.stock_qty) === -2 && num(gele?.stock_qty) === 10 && num(gele?.cost_price_ngn) === 4000);
  const cp = confirmed.toPayload() as { interactive?: { header?: unknown; action?: { buttons: { reply: { id: string } }[] } } };
  ok('confirmation is light: a 🧾 Customer Receipt button, no PDF forced on every sale', !cp.interactive?.header && !!cp.interactive?.action?.buttons.some((x) => x.reply.id === `RCPT:${batchId}`));
  ok('PDF quota untouched until a receipt is asked for', num(after.pdf_receipts_used_this_month) === 0);
  const rcpt = (await R.customerReceiptReply(actor, batchId)).toPayload() as { type: string; document?: { link: string; caption: string } };
  ok('tapping the receipt button → one document message (Storage upload + signed URL work)', rcpt.type === 'document' && !!rcpt.document?.link.startsWith('https://'));
  ok('receipt caption carries the remaining debt (Mama Tunde ₦20,000)', /Mama Tunde/.test(rcpt.document?.caption ?? '') && /Balance remaining: ₦20,000/.test(rcpt.document?.caption ?? ''));
  await R.customerReceiptReply(actor, batchId);
  ok('receipt counted once, even if re-sent', num((await S.getBusiness(biz.id)).pdf_receipts_used_this_month) === 1);
  const again = await L.confirmAndRespond(actor, batchId);
  ok('double-confirm is idempotent and not charged twice', num((await S.getBusiness(biz.id)).tx_logged_this_month) === 1 && JSON.stringify(again.toPayload()).includes('Already saved'));

  // ── 3. Analytics come from SQL ──
  const now = new Date(), from = new Date(now.getTime() - 864e5), to = new Date(now.getTime() + 864e5);
  const sum = await S.ledgerSummary(biz.id, from, to);
  ok('ledger_summary: revenue 50,000 · costs 45,000 · profit 5,000', sum.revenue_ngn === 50000 && sum.expenses_ngn === 5000 && sum.restock_ngn === 40000 && sum.net_profit_ngn === 5000, JSON.stringify(sum));
  const series = await db.rpc('ledger_series', { p_business_id: biz.id, p_from: from.toISOString(), p_to: to.toISOString(), p_bucket: 'day' });
  ok('ledger_series (web chart) returns rows', !series.error && (series.data as unknown[]).length >= 1, series.error?.message ?? '');
  const top = await S.topProducts(biz.id, from, to);
  ok('top_products ranks Swiss Lace', top[0]?.name === 'Swiss Lace');

  // ── 4. UNDO within 5 min reverses everything and returns the message unit ──
  const undone = await L.undoAndRespond(actor, batchId);
  const afterUndo = await S.getBusiness(biz.id);
  ok('UNDO reverses debt, stock and refunds the message unit',
    JSON.stringify(undone.toPayload()).includes('Reversed') && num(afterUndo.tx_logged_this_month) === 0
    && num((await db.from('customers').select('outstanding_debt_ngn').eq('business_id', biz.id).single()).data?.outstanding_debt_ngn) === 0);

  // ── 5. Caps ──
  await db.from('businesses').update({ subscription_tier: 'free_limited', tx_logged_this_month: 20 }).eq('id', biz.id);
  const capped = await L.proposeBatch((await S.resolveActor(PH.owner))!, 'whatsapp_text', drafts);
  const { count: n1 } = await db.from('transactions').select('id', { count: 'exact', head: true }).eq('business_id', biz.id).eq('status', 'pending_confirm');
  ok('free_limited at 20/20: blocked with upsell, no new pending rows', JSON.stringify(capped.toPayload()).includes('logged messages') && (n1 ?? 0) === 0);
  await db.from('businesses').update({ tx_logged_this_month: 19 }).eq('id', biz.id);
  ok('consume_quota: 20th message allowed, 21st refused (atomic)',
    (await S.consumeQuota({ ...(await S.getBusiness(biz.id)) }, 'tx_logged_this_month')) === true &&
    (await S.consumeQuota({ ...(await S.getBusiness(biz.id)) }, 'tx_logged_this_month')) === false);

  // ── 6. Magic links ──
  const owner = (await db.from('business_users').select('id').eq('business_id', biz.id).eq('role', 'owner').single()).data!;
  const hashes = ['t1', 't2', 't3', 't4'].map((x) => x.padEnd(64, '0'));
  const issued = [];
  for (const h of hashes) issued.push((await db.rpc('issue_magic_token', { p_token_hash: h, p_business_id: biz.id, p_user_id: owner.id })).data);
  ok('issue_magic_token: 3 allowed, 4th throttled', JSON.stringify(issued) === '[true,true,true,false]', JSON.stringify(issued));
  const r1 = await db.rpc('consume_magic_token', { p_token_hash: hashes[0] });
  const r2 = await db.rpc('consume_magic_token', { p_token_hash: hashes[0] });
  ok('token redeems once, replay fails', (r1.data as unknown[]).length === 1 && (r2.data as unknown[]).length === 0);
  await db.from('business_users').insert({ business_id: biz.id, phone_number: '2349000000099', full_name: 'Staff', role: 'staff' });
  const staffU = (await db.from('business_users').select('id').eq('phone_number', '2349000000099').single()).data!;
  await db.from('web_magic_tokens').insert({ token_hash: 's'.padEnd(64, '0'), business_id: biz.id, user_id: staffU.id });
  ok('a staff token cannot log in to the dashboard', ((await db.rpc('consume_magic_token', { p_token_hash: 's'.padEnd(64, '0') })).data as unknown[]).length === 0);

  // ── 7. Advisor limit (3) ──
  const u0 = (await db.rpc('advisor_usage', { p_business_id: biz.id })).data as { used: number; free_limit: number }[];
  await db.from('web_chat_messages').insert([1, 2, 3].map((i) => ({ business_id: biz.id, user_id: owner.id, role: 'user', content: `q${i}` })));
  const u1 = (await db.rpc('advisor_usage', { p_business_id: biz.id })).data as { used: number; free_limit: number }[];
  ok('advisor_usage: limit is 3; counts user messages', u0[0]?.free_limit === 3 && u0[0]?.used === 0 && u1[0]?.used === 3);

  // ── 8. Paystack → upgrade + ₦1,000 give-to-get (idempotent) ──
  const referrer = await S.createBusiness(PH.ref, 'Referrer Ltd', 'Bola'); ids.push(referrer.id);
  const referee = await S.createBusiness(PH.referee, 'Referee Ltd', 'Chidi'); ids.push(referee.id);
  await S.updateBusiness(referee.id, { referred_by_business_id: referrer.id });
  const evt = { event: 'charge.success', data: { reference: 'live-smoke-1', amount: 500000, status: 'success', customer: { customer_code: 'CUS_smoke', email: `${PH.referee}@wa.unbarmore.com` },
    metadata: { business_id: referee.id, tier: 'starter_5k' as const, interval: 'monthly' as const, wallet_applied: 0 } } };
  const o1 = await P.handlePaystackEvent(evt);
  const o2 = await P.handlePaystackEvent(evt);
  const [rr, re] = [await S.getBusiness(referrer.id), await S.getBusiness(referee.id)];
  ok('charge.success upgrades the subscriber to starter_5k (+30 days)', o1?.tier === 'starter_5k' && re.subscription_tier === 'starter_5k' && new Date(re.subscription_expires_at).getTime() > Date.now() + 29 * 864e5);
  ok('₦1,000 credited to BOTH wallets, reward flag set', num(rr.referral_wallet_ngn) === 1000 && num(re.referral_wallet_ngn) === 1000 && re.referral_reward_paid === true && o1?.referralCredited === true);
  ok('replayed webhook is ignored (no double credit)', o2 === null && num((await S.getBusiness(referrer.id)).referral_wallet_ngn) === 1000);
  const { count: ledgerRows } = await db.from('referral_ledger').select('id', { count: 'exact', head: true }).in('business_id', [referrer.id, referee.id]);
  ok('referral_ledger has the 2 audit rows', ledgerRows === 2);

  // ── 8b. referral cash payouts (migration 003) ──
  const probe = await db.from('payout_requests').select('ref').limit(1);
  if (probe.error) console.log('⏭️  payout database checks skipped: run supabase/migrations/003_referral_payouts.sql in Supabase, then re-run');
  else {
    const wal = async () => num((await S.getBusiness(referrer.id)).referral_wallet_ngn);
    const setW = (v: number) => db.from('businesses').update({ referral_wallet_ngn: v }).eq('id', referrer.id);
    await setW(4000);
    const low = await PO.requestPayout(referrer.id, 'GTBank', '0123456789');
    ok('payout below ₦5,000 refused, wallet untouched', low.reason === 'below_minimum' && (await wal()) === 4000);
    await setW(5000);
    ok('bad account numbers refused by the database (9, 11 digits, letters)', (await Promise.all(['123456789', '01234567890', '01234abc89'].map((a) => PO.requestPayout(referrer.id, 'GTBank', a)))).every((x) => x.reason === 'bad_account') && (await wal()) === 5000);
    // the real race: two requests for the same wallet, sent at the same instant over the network
    const [x, y] = await Promise.all([PO.requestPayout(referrer.id, 'GTBank', '0123456789'), PO.requestPayout(referrer.id, 'Access Bank', '0987654321')]);
    ok('two simultaneous withdrawals → exactly ONE succeeds', [x, y].filter((z) => z.ok).length === 1 && [x, y].some((z) => z.reason === 'already_pending'), `${x.reason} / ${y.reason}`);
    const winner = x.ok ? x : y;
    const { data: led } = await db.from('referral_ledger').select('status, amount_ngn').eq('business_id', referrer.id).eq('entry_type', 'cash_payout');
    ok('wallet ₦0, ONE pending ledger row (−₦5,000), ONE payout row', (await wal()) === 0 && led?.length === 1 && led[0]!.status === 'pending' && num(led[0]!.amount_ngn) === -5000 && (await PO.pendingPayout(referrer.id))?.ref === winner.ref);
    ok('PAID is recorded once; a second decision is refused', (await PO.decidePayout(winner.ref!, 'paid')).ok && (await PO.decidePayout(winner.ref!, 'rejected')).reason === 'already_decided');
    await setW(7000);
    const again = await PO.requestPayout(referrer.id, 'Opay', '8101234567');
    const rej = await PO.decidePayout(again.ref!, 'rejected');
    ok('after PAID a new payout works; REJECT puts ₦7,000 back in the wallet', again.ok && rej.ok && (await wal()) === 7000);
  }

  // ── 9. RLS: the public/anon key must NOT read data ──
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (anonKey) {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/businesses?select=id&limit=1`, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
    const body = await res.json();
    ok('anon/publishable key cannot read businesses (RLS on)', Array.isArray(body) && body.length === 0, `HTTP ${res.status}`);
  } else console.log('⏭️  RLS check skipped (set SUPABASE_ANON_KEY to the publishable key to run it)');
} catch (e) {
  fail++; console.error('💥 unexpected error:', e);
} finally {
  await cleanup();
  const { count } = await db.from('businesses').select('id', { count: 'exact', head: true }).like('owner_phone', '2349000000%');
  console.log(`\n🧹 cleanup: ${count === 0 ? 'all test data removed' : `${count} test businesses remain!`}`);
  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
