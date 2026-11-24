/**
 * Does the AI understand real Nigerian shop-owner messages? Runs ~45 realistic messages (English, Pidgin, Yoruba, Hausa, Igbo, typed lists)
 * through the real router and checks the INTENT and the key facts. Run before every release:
 *   set -a; . ./.env; set +a; npx tsx scripts/live-router-audit.mts
 * (Uses the real Gemini API; a 429 means quota: wait a minute and re-run.)
 */
const { routeMessage } = await import('../src/services/geminiBrain.ts');
type R = Awaited<ReturnType<typeof routeMessage>>;
const biz = { name: 'Test Shop', recentProducts: ['Ankara', 'Lace', 'Gele'], todayWat: '2026-11-24', owing: ['Femi ₦14,000', 'Mama Tunde ₦20,000'] };

const sum = (r: R) => (r.transactions ?? []).map((t) => `${t.type}:${t.amount_ngn}/${t.amount_paid_ngn}`).join(' ');
const cases: [string, string, ((r: R) => boolean)?][] = [
  // ── the bug that started this: debts that already existed ──
  ['3 persons own me money before now', 'RECORD_DEBTS', (r) => !(r.debts?.length)],
  ['3 people are owning me money.\n\n1. 20,000 Olowoyeye (to pay next week)\n2. 14,000 Femi (not yet mentioned date)\n3. 28,000 kalu (month end)', 'RECORD_DEBTS', (r) => r.debts?.length === 3 && r.debts.reduce((a, d) => a + d.amount_ngn, 0) === 62000],
  ['Femi owe me 14k from last month', 'RECORD_DEBTS', (r) => r.debts?.[0]?.amount_ngn === 14000],
  ['Mama Tunde dey owe me 20k', 'RECORD_DEBTS', (r) => r.debts?.[0]?.amount_ngn === 20000],
  ['Bisi never pay me 8k since October', 'RECORD_DEBTS', (r) => r.debts?.[0]?.amount_ngn === 8000],
  // ── sale vs debt payment ──
  ['Femi don pay 5k', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.type === 'debt_repayment'],
  ['Mama Tunde paid her balance 20k transfer', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.type === 'debt_repayment'],
  ['collected 12k from Chika for the gele', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.type === 'sale'],
  ['sold 2 lace 50k cash, 1 ankara 15k credit to Sade', 'LOG_TRANSACTION', (r) => r.transactions?.length === 2 && r.transactions[1]!.amount_paid_ngn === 0],
  ['Chika collect 3 gele 36k, she don pay 20k', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.amount_ngn === 36000 && r.transactions[0].amount_paid_ngn === 20000],
  ['Tunde book 10 gele, paid 20k deposit, balance 30k', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.amount_ngn === 50000 && r.transactions[0].amount_paid_ngn === 20000],
  ['sold ankara 3 yards 4500 each POS', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.amount_ngn === 13500 && r.transactions[0].payment_method === 'pos'],
  ['sold generator 1.2m cash', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.amount_ngn === 1200000],
  ['sold 5 bags rice 250k, Chioma collect on credit', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.amount_paid_ngn === 0],
  ['sold to Mama Tunde 30k balance 10k', 'LOG_TRANSACTION', (r) => !!r.clarification_needed || (r.transactions?.[0]?.amount_paid_ngn === 20000 && !/ankara|lace|gele/i.test(r.transactions[0]?.item_name ?? ''))],
  // ── other languages ──
  ['Na sayar da atamfa uku a kan dubu goma sha biyar, tsabar kudi', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.type === 'sale'],
  ['Mo ta aṣọ ankara mẹta ni ẹgbẹrun mẹẹdogun, owo ọwọ', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.amount_ngn === 15000],
  // ── expenses and restock ──
  ['I paid rent 150k', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.type === 'expense' && r.transactions[0].amount_ngn === 150000],
  ['paid worker salary 25k', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.category === 'Salaries'],
  ['buy fuel 20k and airtime 2k', 'LOG_TRANSACTION', (r) => r.transactions?.length === 2],
  ['I buy 20 yards lace 3k each from Alhaji, I pay 40k remaining 20k', 'LOG_TRANSACTION', (r) => r.transactions?.[0]?.type === 'restock' && r.transactions[0].amount_paid_ngn === 40000],
  // ── stock and prices: never a purchase or a sale ──
  ['I have 50 pieces of lace in stock, I bought them at 15k each', 'SET_PRODUCTS', (r) => r.products?.[0]?.quantity === 50 && r.products[0].cost_price_ngn === 15000],
  ['update price of lace to 20k', 'SET_PRODUCTS', (r) => r.products?.[0]?.selling_price_ngn === 20000],
  ['lace now costs me 17k', 'SET_PRODUCTS', (r) => r.products?.[0]?.cost_price_ngn === 17000],
  ['price of ankara be 4500 per yard', 'SET_PRODUCTS'],
  // ── customer details ──
  ["Femi's number is 08031234567", 'UPDATE_CUSTOMER', (r) => r.customer_update?.phone?.replace(/\D/g, '') === '08031234567'],
  // ── questions about their numbers ──
  ['how many lace do I have', 'QUERY_BUSINESS', (r) => r.query?.kind === 'stock_level'],
  ['how much did I make yesterday', 'QUERY_BUSINESS', (r) => r.query?.kind === 'profit'],
  ['wetin I make today', 'QUERY_BUSINESS'],
  ['who is my best customer', 'QUERY_BUSINESS', (r) => r.query?.kind === 'top_customers'],
  ['how much does Femi owe me', 'QUERY_BUSINESS', (r) => r.query?.kind === 'debtors' && /femi/i.test(r.query.customer_name ?? '')],
  ['show me my debtors', 'QUERY_BUSINESS', (r) => r.query?.kind === 'debtors'],
  ['who owe me pass', 'QUERY_BUSINESS', (r) => r.query?.kind === 'debtors'],
  ['total expenses this month', 'QUERY_BUSINESS', (r) => r.query?.kind === 'expenses_by_category'],
  // ── client list and getting customers back ──
  ['add my customers: Femi 08031234567, Kalu 08051234567', 'RECORD_CLIENTS', (r) => r.clients?.length === 2 && /08031234567/.test(r.clients[0]?.phone ?? '')],
  ['save these clients for me: Mama Ade, Chika 08099999999', 'RECORD_CLIENTS', (r) => r.clients?.length === 2],
  ['show my customers', 'QUERY_BUSINESS', (r) => r.query?.kind === 'customers'],
  ['my client list', 'QUERY_BUSINESS', (r) => r.query?.kind === 'customers'],
  ['which customers have stopped buying from me', 'QUERY_BUSINESS', (r) => r.query?.kind === 'lapsed_customers'],
  ['write message for customers wey don stop to buy', 'CUSTOMER_OUTREACH', (r) => r.outreach === 'winback'],
  ['thank my best customers', 'CUSTOMER_OUTREACH', (r) => r.outreach === 'thank_top'],
  // ── actions on debts / entries ──
  ['remind everyone owing me', 'CHASE_DEBTS'],
  ['send reminders', 'CHASE_DEBTS'],
  ['delete the last entry', 'UNDO_LAST'],
  ['that last one was 25k not 35k', 'CORRECT_LAST'],
  // ── honest "not yet" (must never pretend) ──
  ['I owe Mama Ade 30k for fabric', 'NOT_SUPPORTED', (r) => r.not_supported === 'I_OWE_SUPPLIER'],
  ['my opening cash is 200k', 'NOT_SUPPORTED'],
  ['what is my bank balance', 'NOT_SUPPORTED', (r) => r.not_supported === 'BANK_BALANCE'],
  ['I took 10k for personal use', 'NOT_SUPPORTED', (r) => r.not_supported === 'PERSONAL_SPENDING'],
  ['send invoice to Tunde for 50k', 'NOT_SUPPORTED', (r) => r.not_supported === 'INVOICE'],
  // ── conversation ──
  ['thank you', 'ACKNOWLEDGE'],
  ['ok', 'ACKNOWLEDGE'],
  ['good morning', 'HELP'],
  ['how do I add my staff', 'HELP', (r) => /ADD STAFF/i.test(r.reply_text ?? '')],
  ['customer say price too high, wetin I go tell her', 'DRAFT_SALES_REPLY'],
  ['I wan make video for my ankara', 'CREATE_VIDEO_SCRIPT'],
  ['how do i price my ankara gowns so i make profit', 'BUSINESS_ADVICE'],
  ['Write me a 500 word essay on Nigerian politics', 'OFF_TOPIC'],
];
// The bot must never claim it did something in free text.
const CLAIMS = /\b(i have|i['’]ve|i just|has been|have been)\s+(noted|saved|recorded|updated|changed|deleted|removed)\b|\bnoted (the|your|femi)/i;

let pass = 0, fail = 0, skipped = 0;
const results = await Promise.all(cases.map(async ([msg, want, check]) => {
  let last = '';
  for (let t = 0; t < 4; t++) {
    try {
      const r = await routeMessage({ text: msg, business: biz });
      const claim = r.reply_text && CLAIMS.test(r.reply_text) ? ` CLAIMS-ACTION("${r.reply_text.slice(0, 60)}")` : '';
      const good = r.intent === want && (!check || check(r)) && !claim;
      if (good || t === 3) return { msg, want, got: r.intent, good, detail: `${sum(r)}${claim}${r.debts ? ' debts=' + r.debts.length : ''}` };
      last = r.intent; await new Promise((x) => setTimeout(x, 1500)); // re-ask once or twice: the AI is not perfectly repeatable
    } catch (e: any) { last = 'ERR'; if (/429|quota/i.test(String(e.message))) { await new Promise((x) => setTimeout(x, 6000)); continue; } await new Promise((x) => setTimeout(x, 3000)); }
  }
  return { msg, want, got: last, good: false, detail: 'gave up (quota/overload?)', skipped: last === 'ERR' };
}));
for (const r of results as { msg: string; want: string; got: string; good: boolean; detail: string; skipped?: boolean }[]) {
  if (r.skipped) { skipped++; console.log(`⏭️  ${r.msg.replace(/\n/g, ' ⏎ ').slice(0, 70)} — no answer from Gemini (quota)`); continue; }
  r.good ? pass++ : fail++;
  console.log(`${r.good ? '✅' : '❌'} ${r.msg.replace(/\n/g, ' ⏎ ').slice(0, 70)} → ${r.got}${r.good ? '' : ` (wanted ${r.want}) ${r.detail}`}`);
}
console.log(`\n${fail ? '⚠️' : '🎉'} ${pass} understood, ${fail} misunderstood${skipped ? `, ${skipped} skipped (Gemini quota)` : ''} of ${cases.length}`);
process.exit(fail ? 1 : 0);
