/**
 * The 7 AM and 9 PM notes, for real: the actual cron jobs run against the real database; a pretend WhatsApp server records what would be sent.
 *   set -a; . ./.env; set +a; npx tsx scripts/live-morning.mts
 */
import crypto from 'node:crypto';
import http from 'node:http';

const FAKE_PORT = 3071;
const sent: { to: string; payload: any }[] = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => { try { const p = JSON.parse(b); sent.push({ to: p.to, payload: p }); } catch { /* ignore */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: 'wamid.' + crypto.randomUUID() }] })); });
}).listen(FAKE_PORT);
process.env.WHATSAPP_GRAPH_BASE = `http://127.0.0.1:${FAKE_PORT}`;
process.env.NODE_ENV = 'test';

const { db } = await import('../src/db/supabase.ts');
const cron = (await import('../src/jobs/cronJobs.ts')).__test;
const { setReminders } = await import('../src/flows/reminders.ts');
const { appUsage } = await import('../src/flows/morning.ts');

const PH = '2349000000301', PH2 = '2349000000302';
let pass = 0, fail = 0;
const ok = (n: string, c: unknown, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); };
const to = (phone: string) => sent.filter((s) => s.to === phone);
const body = (s: { payload: any }) => (s.payload.type === 'interactive' ? s.payload.interactive.body.text : s.payload.text?.body ?? '') as string;
const btns = (s: { payload: any }) => (s.payload.interactive?.action?.buttons ?? []).map((x: any) => x.reply.id) as string[];
const day = (offset: number) => new Date(Date.now() + 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);

async function cleanup() {
  for (const ph of [PH, PH2]) {
    const { data } = await db.from('businesses').select('id').eq('owner_phone', ph);
    for (const b of data ?? []) await db.from('businesses').delete().eq('id', b.id);
    await db.from('whatsapp_sessions').delete().eq('phone_number', ph);
  }
}

try {
  await cleanup();
  const mk = async (name: string, phone: string, lastInboundHoursAgo: number) => {
    const { data: biz } = await db.from('businesses').insert({ name, owner_phone: phone }).select('id').single();
    await db.from('business_users').insert({ business_id: biz!.id, phone_number: phone, full_name: 'Owner', role: 'owner' });
    await db.from('whatsapp_sessions').upsert({ phone_number: phone, business_id: biz!.id, current_state: 'IDLE', pending_payload: {}, last_inbound_at: new Date(Date.now() - lastInboundHoursAgo * 3600_000).toISOString() });
    return biz!.id as string;
  };
  const bid = await mk('Morning Test Shop', PH, 2);       // messaged 2 hours ago: inside the free window
  const idle = await mk('Quiet Owner Shop', PH2, 30);     // last message 30 hours ago: OUTSIDE the window

  const d = async (n: string, amt: number, due: string | null, since: number) => (await db.from('customers').insert({ business_id: bid, name: n, outstanding_debt_ngn: amt, debt_due_date: due, debt_since: new Date(Date.now() - since * 86_400_000).toISOString() }).select('id').single()).data!.id as string;
  await d('Kalu', 28000, day(-3), 20);          // 3 days overdue
  await d('Olowoyeye', 20000, day(0), 9);       // due today
  await d('Femi', 14000, day(2), 5);            // due in 2 days
  const bisi = (await db.from('customers').insert({ business_id: bid, name: 'Bisi', total_spent_ngn: 30000 }).select('id').single()).data!.id as string;
  await db.from('transactions').insert({ business_id: bid, batch_id: crypto.randomUUID(), tx_type: 'sale', description: '1 × Lace', category: 'Sales', quantity: 1, unit_price_ngn: 30000, total_amount_ngn: 30000, amount_paid_ngn: 30000, payment_method: 'cash', customer_id: bisi, status: 'confirmed', confirmed_at: new Date().toISOString(), transaction_date: new Date(Date.now() - 45 * 86_400_000).toISOString() });
  await db.from('products').insert({ business_id: bid, sku_code: 'UNB-MRN', name: 'Lace', cost_price_ngn: 15000, selling_price_ngn: 30000, stock_qty: 1 });
  ok('seeded: 3 debts (overdue / due today / due soon), a customer quiet for 45 days, a product with 1 left', true);

  // ───── 7 AM ─────
  await cron.dailyMorning();
  const m1 = to(PH);
  ok('7 AM: the owner inside the free window gets exactly ONE message', m1.length === 1, `${m1.length} message(s)`);
  const t = m1[0] ? body(m1[0]) : '';
  ok('it greets by business name and gives yesterday\'s result line', /Good morning, Morning Test Shop!/.test(t) && /Nothing was recorded yesterday|Yesterday: Sales/.test(t));
  ok('it names who to follow up: Kalu (3 days overdue), Olowoyeye (due today), Femi (due in 2 days) with amounts', /Kalu owes you ₦28,000: 3 days overdue/.test(t) && /Olowoyeye owes you ₦20,000: due today/.test(t) && /Femi owes you ₦14,000: due in 2 days/.test(t), t.replace(/\n/g, ' | ').slice(0, 330));
  ok('…plus the customer who went quiet (Bisi, 45 days) and the item running out (Lace, 1 left)', /Bisi hasn't bought in 45 days/.test(t) && /Lace: only 1 left/.test(t));
  ok('one clear action: "Start with Kalu: ₦28,000"', /Start with Kalu: ₦28,000/.test(t));
  ok('buttons: Chase debts · Win back · Log a sale (a tap keeps tomorrow\'s free window open)', btns(m1[0]!).join() === 'BTN_CHASE_DEBT,WINBACK,LOGHOW', btns(m1[0]!).join());

  await cron.dailyMorning();
  ok('running it again the same morning sends nothing more (no double messages)', to(PH).length === 1);
  ok('an owner whose last message was 30 hours ago is NOT messaged (that would be a paid template)', to(PH2).length === 0);

  // ───── pause / resume ─────
  await db.from('outbound_log').delete().eq('business_id', bid).eq('kind', 'daily_morning');
  await setReminders(bid, false);
  await cron.dailyMorning();
  ok('REMINDERS OFF → no morning message', to(PH).length === 1);
  await setReminders(bid, true);
  await cron.dailyMorning();
  ok('REMINDERS ON → the morning message comes back', to(PH).length === 2);

  // ───── is the owner in the app yet? (decides whether to invite them) ─────
  ok('app usage: a new owner has never opened the app → "none"', (await appUsage(bid)) === 'none');
  const { data: user } = await db.from('business_users').select('id').eq('business_id', bid).single();
  await db.from('web_magic_tokens').insert({ token_hash: crypto.randomBytes(16).toString('hex'), business_id: bid, user_id: user!.id, used_at: new Date().toISOString() });
  ok('…after redeeming a login link → "opened"', (await appUsage(bid)) === 'opened');
  const sub = await db.from('push_subscriptions').insert({ business_id: bid, endpoint: 'https://fcm.googleapis.com/fcm/send/morning-test', p256dh: 'k'.repeat(20), auth: 'a'.repeat(16) });
  ok('…after turning the evening alert on → "alerts" (no more invitations)', sub.error ? true : (await appUsage(bid)) === 'alerts', sub.error ? 'push table not available: skipped' : '');

  // ───── 9 PM ─────
  await cron.dailyCheckin();
  const ev = to(PH).slice(2);
  ok('9 PM: one evening message', ev.length === 1, `${ev.length}`);
  const et = ev[0] ? body(ev[0]) : '';
  ok('it also says what to follow up soon (Olowoyeye is due today)', /Follow up/.test(et) && /Olowoyeye ₦20,000/.test(et), et.replace(/\n/g, ' | ').slice(0, 300));
  await db.from('outbound_log').delete().eq('business_id', bid).eq('kind', 'daily_checkin');
  await setReminders(bid, false);
  await cron.dailyCheckin();
  ok('REMINDERS OFF also silences the evening note', to(PH).length === 3);
} catch (e) {
  fail++; console.error('💥', e);
} finally {
  await cleanup().catch(() => undefined);
  fake.close();
  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
