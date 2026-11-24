/**
 * Live end-to-end test of the web app against REAL Supabase + Gemini.
 *   1. start the web app:   cd web && NODE_USE_ENV_PROXY=1 npx next start -p 3333
 *   2. run this:            set -a; . web/.env.local; set +a; NODE_USE_ENV_PROXY=1 npx tsx scripts/live-web-e2e.mts
 * Seeds a throw-away business (phone 2349000000101), mints REAL magic links through the backend's own function,
 * drives login → dashboard → ledger → advisor chat (in a real browser), then deletes everything it created.
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
for (const [k, v] of Object.entries({
  WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x', WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 'x', WHATSAPP_VERIFY_TOKEN: 'verify-token-123',
  PAYSTACK_SECRET_KEY: 'x', PAYSTACK_PLAN_STARTER_MONTHLY: 'a', PAYSTACK_PLAN_STARTER_ANNUAL: 'b', PAYSTACK_PLAN_GROWTH_MONTHLY: 'c', PAYSTACK_PLAN_GROWTH_ANNUAL: 'd',
  WEB_APP_URL: 'http://localhost:3333',
})) process.env[k] = process.env[k] && k !== 'WEB_APP_URL' && !process.env[k]!.startsWith('unused') ? process.env[k]! : v;

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { db } = await import('../src/db/supabase.ts');
const { createOwnerMagicLink } = await import('../src/services/webLink.ts');

const BASE = 'http://localhost:3333';
const PHONE = '2349000000101';
let pass = 0, fail = 0;
const ok = (name: string, cond: unknown, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

async function cleanup() {
  const { data } = await db.from('businesses').select('id').eq('owner_phone', PHONE);
  for (const b of data ?? []) await db.from('businesses').delete().eq('id', b.id); // cascades users, txns, customers, tokens, chat
}

let browser: any;
try {
  await cleanup();

  // ───────── seed: known figures ─────────
  const { data: biz } = await db.from('businesses').insert({ name: 'E2E Test Fabrics', owner_phone: PHONE }).select('id, referral_code').single();
  const bid = biz!.id as string;
  await db.from('business_users').insert({ business_id: bid, phone_number: PHONE, full_name: 'Ada Test', role: 'owner' });
  const day = 864e5, batch = crypto.randomUUID();
  const { data: cust } = await db.from('customers').insert({ business_id: bid, name: 'Mama Tunde', outstanding_debt_ngn: 95000, debt_since: new Date(Date.now() - 23 * day).toISOString() }).select('id').single();
  // every row needs the same keys: a bulk insert sends explicit NULLs for missing ones, which violates NOT NULL (quantity)
  const row = (o: Record<string, unknown>) => ({ business_id: bid, batch_id: batch, quantity: 1, unit_price_ngn: null, customer_id: null, category: 'General', status: 'confirmed', confirmed_at: new Date().toISOString(), transaction_date: new Date().toISOString(), ...o });
  const { error: txErr } = await db.from('transactions').insert([
    row({ tx_type: 'sale', description: '10 × Swiss Lace', category: 'Sales', quantity: 10, unit_price_ngn: 20000, total_amount_ngn: 200000, amount_paid_ngn: 105000, payment_method: 'transfer', customer_id: cust!.id }),
    row({ tx_type: 'expense', description: 'Fuel/Diesel', category: 'Fuel/Diesel', total_amount_ngn: 60000, amount_paid_ngn: 60000, payment_method: 'cash' }),
    row({ tx_type: 'expense', description: 'Rent/Utilities', category: 'Rent/Utilities', total_amount_ngn: 20000, amount_paid_ngn: 20000, payment_method: 'cash' }),
  ]);
  ok('seeded business: sales ₦200k, fuel ₦60k, rent ₦20k, Mama Tunde owes ₦95k', !txErr, txErr?.message);

  // ───────── 1. magic link: minted by the BACKEND's own function ─────────
  const linkA = await createOwnerMagicLink(bid);
  ok('backend mints a login link for the owner', !!linkA && /\/auth\/verify\?token=[a-f0-9]{64}$/.test(linkA!), linkA?.replace(/token=.*/, 'token=<64 hex>'));
  const tokA = tokenOf(linkA!);
  const { data: stored } = await db.from('web_magic_tokens').select('token_hash').eq('business_id', bid);
  ok('only the SHA-256 hash is stored, never the raw token', stored?.length === 1 && stored[0]!.token_hash === crypto.createHash('sha256').update(tokA).digest('hex') && stored[0]!.token_hash !== tokA);

  // ───────── 2. verify route ─────────
  const g = await fetch(linkA!);
  const gHtml = await g.text();
  ok('GET /auth/verify shows an "Open my dashboard" button (link-preview safe)', g.status === 200 && gHtml.includes('Open my dashboard'));
  const stillValid = await db.from('web_magic_tokens').select('used_at').eq('business_id', bid).single();
  ok('…and did NOT consume the token', stillValid.data?.used_at === null);

  const post = await fetch(`${BASE}/auth/verify`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${tokA}` });
  const setCookie = post.headers.get('set-cookie') ?? '';
  ok('POST /auth/verify → 303 to /dashboard', post.status === 303 && new URL(post.headers.get('location')!).pathname === '/dashboard');
  ok('session cookie is httpOnly + SameSite=Lax + 30 days', /unbarmore_session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=lax/i.test(setCookie) && /Max-Age=2592000/.test(setCookie), setCookie.replace(/unbarmore_session=[^;]+/, 'unbarmore_session=<jwt>').slice(0, 120));
  const cookie = setCookie.split(';')[0]!;
  const replay = await fetch(`${BASE}/auth/verify`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${tokA}` });
  ok('replaying the same token is rejected', replay.status === 303 && (replay.headers.get('location') ?? '').includes('/login?error=expired'));

  // ───────── 3. dashboard shows REAL figures ─────────
  const noAuth = await fetch(`${BASE}/dashboard`, { redirect: 'manual' });
  ok('/dashboard without cookie → redirected to /login', noAuth.status === 307 && (noAuth.headers.get('location') ?? '').endsWith('/login'));
  const d = await fetch(`${BASE}/dashboard`, { headers: { cookie } });
  const dTxt = text(await d.text());
  ok('/dashboard → 200 with the business name', d.status === 200 && dTxt.includes('E2E Test Fabrics'));
  ok('Sales this month ₦200,000', /Sales this month ₦200,000/.test(dTxt));
  ok('Expenses + stock ₦80,000', /Expenses \+ stock ₦80,000/.test(dTxt));
  ok('Net profit ₦120,000 at 60% margin', /Net profit ₦120,000 60% margin/.test(dTxt));
  ok('Customers owe you ₦95,000 (1 customer)', /Customers owe you ₦95,000 1 customer/.test(dTxt));
  ok('expense breakdown lists Fuel/Diesel ₦60,000 and Rent ₦20,000', dTxt.includes('Fuel/Diesel') && dTxt.includes('₦60,000') && dTxt.includes('Rent/Utilities') && dTxt.includes('₦20,000'));
  ok('plan badge shows Free trial', dTxt.includes('Free trial'));
  ok('dashboard has a "Today" card: money in / spent / profit for today, top debtor, and a WhatsApp chase button',
    /Today Money in ₦105,000 Spent ₦80,000 Profit ₦120,000/.test(dTxt) && /Still owing you Mama Tunde ₦95,000/.test(dTxt) && /Chase them on WhatsApp/.test(dTxt) && /Log a sale on WhatsApp/.test(dTxt),
    (dTxt.match(/Today .{0,140}/) ?? [''])[0]);
  ok('dashboard headline: nothing collected yet → invites the first chase (no fake number)', /Chase your first debt/.test(dTxt) && !/Money Unbarmore got back for you ₦/.test(dTxt));
  await db.from('transactions').insert(row({ tx_type: 'debt_repayment', description: 'Debt repayment — Mama Tunde', category: 'Debt Repayment', total_amount_ngn: 30000, amount_paid_ngn: 30000, payment_method: 'transfer', customer_id: cust!.id }));
  await db.from('businesses').update({ total_value_recovered_ngn: 16000 }).eq('id', bid);
  const dTxt2 = text(await (await fetch(`${BASE}/dashboard`, { headers: { cookie } })).text());
  ok('after ₦30,000 collected + ₦16,000 margin protected: headline shows ₦46,000 with both parts', /Money Unbarmore got back for you ₦46,000 ₦30,000 collected from customers \+ ₦16,000 margin protected/.test(dTxt2), (dTxt2.match(/Money Unbarmore got back.{0,120}/) ?? [''])[0]);
  await db.from('businesses').update({ total_value_recovered_ngn: 0 }).eq('id', bid);

  // ───────── evening alerts (web push) ─────────
  const subBody = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-test-device', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };
  const pushPost = (body: unknown, headers: Record<string, string> = {}) => fetch(`${BASE}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  ok('/api/push/subscribe without a login → 401', (await pushPost(subBody)).status === 401);
  ok('with a login but a junk subscription → 400', (await pushPost({ endpoint: 'http://insecure.example', keys: subBody.keys }, { cookie })).status === 400);
  ok('a request from another website is refused (403)', (await pushPost(subBody, { cookie, origin: 'https://evil.example' })).status === 403);
  const sv = await pushPost(subBody, { cookie });
  const svJson = await sv.json().catch(() => ({}));
  if (sv.status === 200) {
    const { data: rows } = await db.from('push_subscriptions').select('business_id').eq('endpoint', subBody.endpoint);
    ok('valid subscription is saved against THIS business', rows?.length === 1 && rows[0]!.business_id === bid);
    await pushPost(subBody, { cookie }); // same device again
    const { data: again } = await db.from('push_subscriptions').select('id').eq('endpoint', subBody.endpoint);
    ok('subscribing the same phone twice keeps one row', again?.length === 1);
    const del = await fetch(`${BASE}/api/push/subscribe`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: subBody.endpoint }) });
    const { data: gone } = await db.from('push_subscriptions').select('id').eq('endpoint', subBody.endpoint);
    ok('turning alerts off removes the device', del.status === 200 && gone?.length === 0);
  } else {
    ok('valid subscription → 503 "not_ready" (run migration 004 to turn alerts on; nothing crashes before then)', sv.status === 503 && svJson.error === 'not_ready', `status ${sv.status}`);
  }
  const swJs = await (await fetch(`${BASE}/sw.js`)).text();
  ok('service worker handles push + notification taps', swJs.includes('"push"') && swJs.includes('notificationclick') && swJs.includes('showNotification'));

  // ───────── 4. other pages + isolation ─────────
  const l = text(await (await fetch(`${BASE}/ledger`, { headers: { cookie } })).text());
  ok('/ledger lists the sale (₦200,000) and both expenses', l.includes('10 × Swiss Lace') && l.includes('₦200,000') && l.includes('Fuel/Diesel') && l.includes('Owes ₦95,000'));
  const dl = await (await fetch(`${BASE}/ledger?tab=debtors`, { headers: { cookie } })).text();
  ok('/ledger?tab=debtors shows Mama Tunde ₦95,000 with a wa.me reminder link', dl.includes('Mama Tunde') && text(dl).includes('₦95,000') && /https:\/\/wa\.me\/\?text=Hello%20Mama/.test(dl));
  const st = text(await (await fetch(`${BASE}/settings`, { headers: { cookie } })).text());
  ok('/settings shows this business\'s referral code', st.includes(biz!.referral_code as string));
  // referral wallet card on /settings: locked → unlocked → pending
  const settingsHtml = async () => (await (await fetch(`${BASE}/settings`, { headers: { cookie } })).text()).replace(/<!--.*?-->/g, '');
  await db.from('businesses').update({ referral_wallet_ngn: 3000 }).eq('id', bid);
  let sh = await settingsHtml();
  ok('wallet ₦3,000: shows progress "2 more to go" + renewal-discount note, NO payout button', /2 more to go/.test(sh) && /takes money off your next renewal/.test(sh) && !/Request Cash Payout/.test(sh));
  await db.from('businesses').update({ referral_wallet_ngn: 5000 }).eq('id', bid);
  sh = await settingsHtml();
  ok('wallet ₦5,000: "💸 Request Cash Payout" button appears, opening WhatsApp with WITHDRAW', /Request Cash Payout/.test(sh) && /wa\.me\/2348000000000\?text=WITHDRAW/.test(sh));
  await db.from('payout_requests').insert({ business_id: bid, amount_ngn: 5000, bank_details: 'GTBank · 0123456789', status: 'requested' });
  await db.from('payout_requests').update({ bank_name: 'GTBank', account_number: '0123456789', ref: 'WD-E2E001' }).eq('business_id', bid); // only works once migration 003 is applied
  sh = await settingsHtml();
  ok('payout pending: button replaced by a "Payout pending" note (no double request from the web either)', /Payout pending/.test(sh) && !/Request Cash Payout/.test(sh));
  await db.from('payout_requests').delete().eq('business_id', bid);
  await db.from('businesses').update({ referral_wallet_ngn: 0 }).eq('id', bid);
  const pdf = await fetch(`${BASE}/api/export`, { headers: { cookie } });
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  ok('/api/export returns a real PDF statement', pdf.status === 200 && pdfBuf.subarray(0, 4).toString() === '%PDF' && pdfBuf.length > 3000, `${pdfBuf.length} bytes`);
  // a deactivated user holding a still-valid cookie must NOT cause a redirect loop
  await db.from('business_users').update({ is_active: false }).eq('business_id', bid).eq('role', 'owner');
  const deact = await fetch(`${BASE}/dashboard`, { headers: { cookie }, redirect: 'manual' });
  const loginPage = await fetch(`${BASE}/login`, { headers: { cookie }, redirect: 'manual' });
  ok('deactivated user + valid cookie: /dashboard → /login, and /login renders (no redirect loop)', deact.status === 307 && (deact.headers.get('location') ?? '').endsWith('/login') && loginPage.status === 200, `dashboard ${deact.status}, login ${loginPage.status}`);
  await db.from('business_users').update({ is_active: true }).eq('business_id', bid).eq('role', 'owner');
  const loggedInLogin = await fetch(`${BASE}/login`, { headers: { cookie }, redirect: 'manual' });
  ok('logged-in user opening /login is sent to /dashboard', loggedInLogin.status === 307 && (loggedInLogin.headers.get('location') ?? '').endsWith('/dashboard'));
  const forged = await fetch(`${BASE}/dashboard`, { redirect: 'manual', headers: { cookie: 'unbarmore_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad' } });
  ok('forged session cookie is rejected', forged.status === 307);

  // ───────── 5. advisor chat in a real browser: 3 free messages ─────────
  const linkB = await createOwnerMagicLink(bid);
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  await ctx.grantPermissions(['notifications'], { origin: BASE }); // a headless browser starts with notifications blocked; a real user taps Allow
  const page = await ctx.newPage();
  await page.goto(linkB!);
  await page.getByRole('button', { name: 'Open my dashboard' }).click();
  await page.waitForURL('**/dashboard');
  ok('browser login: tap "Open my dashboard" → lands on /dashboard', true);

  // evening alerts in a real browser. Headless Chromium has notifications BLOCKED and no reachable push service, so we check the honest paths:
  await page.waitForTimeout(3000);
  ok('the service worker is registered (offline page, fast reopen and alerts all depend on it)', await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));
  await page.goto(`${BASE}/settings`);
  await page.getByText(/Alerts are blocked/).waitFor({ timeout: 10000 }).catch(() => undefined);
  ok('notifications blocked in the browser → Settings says how to unblock (no broken button)', (await page.getByText(/Alerts are blocked/).count()) === 1);
  // now as a user who tapped "Allow", on a phone whose push service we cannot reach: must fail politely, never hang
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(`Object.defineProperty(Notification, 'permission', { get: () => 'granted' }); Notification.requestPermission = async () => 'granted';`);
  const page2 = await ctx2.newPage();
  await page2.goto(await createOwnerMagicLink(bid) as string); await page2.getByRole('button', { name: 'Open my dashboard' }).click(); await page2.waitForURL('**/dashboard');
  const alertBtn = page2.getByRole('button', { name: /Turn on my evening alert/ });
  await alertBtn.waitFor({ timeout: 20000 }).catch(() => undefined);
  ok('allowed + not yet subscribed → dashboard shows the "Turn on my evening alert" card', (await alertBtn.count()) === 1);
  await alertBtn.click().catch(() => undefined);
  const outcome = await Promise.race([
    page2.getByText(/Evening money alert is on/).waitFor({ timeout: 25000 }).then(() => 'on'),
    page2.locator('section[aria-label="Evening money alert"] [role=alert]').waitFor({ timeout: 25000 }).then(() => 'error'),
  ]).catch(() => 'stuck');
  ok('tapping it ends clearly: on, or a readable error with the button usable again (never stuck on "Turning on…")', outcome !== 'stuck' && (await page2.getByRole('button', { name: /Turning on/ }).count()) === 0, `outcome: ${outcome}: ${await page2.locator('section[aria-label="Evening money alert"] [role=alert]').textContent().catch(() => '')}`);
  await ctx2.close();
  await page.goto(`${BASE}/dashboard`);
  await page.goto(`${BASE}/advisor`);
  ok('advisor starts with the 4 quick-prompt chips', (await page.locator('button:has-text("Where am I leaking money")').count()) === 1);

  const questions = ['Where am I leaking money this month?', 'How should I re-price my top products against inflation?', 'Draft a polite payment reminder for my biggest debtor'];
  const replies: string[] = [];
  for (const [i, q] of questions.entries()) {
    const t = Date.now();
    // A real user retries when Gemini is overloaded ("Couldn't get an answer — your message wasn't counted"); so does this test.
    let tries = 0;
    for (;;) {
      tries++;
      await page.locator('textarea').fill(q);
      await page.locator('textarea').press('Enter');
      const done = page.locator('div.bg-mist button:has-text("Copy")').nth(i);
      const failed = page.locator('text=/Couldn.t get an answer/');
      // The route now bounds itself to <60s, so within 150s we must see either an answer or the graceful failure notice.
      const winner = await Promise.race([done.waitFor({ timeout: 150_000 }).then(() => 'ok'), failed.waitFor({ timeout: 150_000 }).then(() => 'fail')]).catch(() => 'timeout');
      if (winner === 'timeout') throw new Error(`message ${i + 1}: neither an answer nor a graceful failure within 150s (route is not bounded)`);
      if (winner === 'ok') break;
      console.log(`   ⚠️  message ${i + 1}: Gemini overloaded, graceful failure shown — retrying (${tries}/4)`);
      const { data: leftover } = await db.from('web_chat_messages').select('id').eq('business_id', bid).eq('role', 'user');
      if (leftover!.length !== i) { fail++; console.log(`❌ failed attempt left a saved/charged message (${leftover!.length} stored, expected ${i})`); }
      if (tries >= 4) throw new Error('Gemini unavailable after 4 attempts');
      await page.waitForTimeout(3000);
    }
    const bubble = page.locator('div.bg-mist').filter({ has: page.locator('button:has-text("Copy")') }).nth(i);
    const txt: string = (await bubble.innerText()).replace(/\s*Copy\s*Send on WhatsApp\s*$/i, '').trim();
    replies.push(txt);
    console.log(`   ↳ reply ${i + 1} [${((Date.now() - t) / 1000).toFixed(1)}s]: ${txt.replace(/\s+/g, ' ').slice(0, 230)}…`);
    if (i === 0) ok('free-chat counter appears after message 1 ("2 free chats left")', (await page.locator('text=/2 free chats left/').count()) === 1);
    if (i === 1) ok('counter after message 2 ("1 free chat left")', (await page.locator('text=/1 free chat left/').count()) === 1);
  }

  const first = replies[2]!.replace(/\s+/g, ' ');
  const fact = 'Mama Tunde owes you ₦95,000 and it has been 23 days.';
  ok('reply #3 OPENS with the exact leak fact', first.startsWith(fact) || first.slice(0, fact.length + 40).includes(fact), `first 110 chars: "${first.slice(0, 110)}"`);
  ok('reply #3 quotes ₦95,000 exactly (no rounding)', first.slice(0, 160).includes('₦95,000'));
  ok('replies #1 and #2 are normal answers (no forced opener)', !replies[0]!.replace(/\s+/g, ' ').startsWith(fact) && !replies[1]!.replace(/\s+/g, ' ').startsWith(fact));
  ok('reply #3 does not pitch the upgrade itself (UI does)', !/upgrade|starter|₦5,000\/mo/i.test(replies[2]!));

  // the lock + CTA
  const cta = page.locator('a:has-text("Upgrade to Starter (₦5,000/mo) for Unlimited CFO Chat")');
  await cta.waitFor({ timeout: 10_000 });
  const href = await cta.getAttribute('href');
  ok('inline CTA button appears under message 3', (await cta.count()) === 1);
  ok('CTA opens WhatsApp with STARTER prefilled', /^https:\/\/wa\.me\/2348000000000\?text=STARTER$/.test(href ?? ''), href ?? '');
  ok('input is LOCKED (textarea disabled, "Upgrade to keep chatting")', (await page.locator('textarea').isDisabled()) && (await page.locator('textarea').getAttribute('placeholder')) === 'Upgrade to keep chatting');
  ok('send button is disabled', await page.locator('button[aria-label="Send"]').isDisabled());
  await page.screenshot({ path: 'tmp/e2e-advisor-locked.png' });

  // server-side enforcement (not just UI): a 4th message must be refused
  const status4 = await page.evaluate(async () => (await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'one more please' }) })).status);
  ok('server refuses message #4 with 402 (limit enforced, not just hidden)', status4 === 402, `HTTP ${status4}`);
  const { data: msgs } = await db.from('web_chat_messages').select('role').eq('business_id', bid);
  ok('DB has exactly 3 user + 3 assistant messages (the refused one was not saved)', msgs?.filter((m) => m.role === 'user').length === 3 && msgs?.filter((m) => m.role === 'assistant').length === 3, JSON.stringify(msgs?.map((m) => m.role[0])));
  const { data: usage } = await db.rpc('advisor_usage', { p_business_id: bid });
  ok('advisor_usage = 3 of 3', usage?.[0]?.used === 3 && usage?.[0]?.free_limit === 3);

  // reload: state persists from the DB
  await page.reload();
  await page.locator('a:has-text("Unlimited CFO Chat")').waitFor({ timeout: 10_000 });
  ok('after reload the lock + CTA persist (state comes from the DB, not memory)', await page.locator('textarea').isDisabled());
  await page.screenshot({ path: 'tmp/e2e-advisor-reload.png' });
  await page.goto(`${BASE}/dashboard`); await page.waitForLoadState('networkidle'); await page.screenshot({ path: 'tmp/e2e-dashboard.png' });
} catch (e) {
  fail++; console.error('💥 unexpected error:', e);
} finally {
  await browser?.close().catch(() => undefined);
  await cleanup();
  const { count } = await db.from('businesses').select('id', { count: 'exact', head: true }).eq('owner_phone', PHONE);
  console.log(`\n🧹 cleanup: ${count === 0 ? 'test business and all its data removed' : 'TEST DATA REMAINS'}`);
  console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
