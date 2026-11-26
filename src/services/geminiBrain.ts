import { GoogleGenAI, type Part } from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env.js';
import { noteGeminiError } from '../lib/alerts.js';
import { MINI_VIDEO } from '../config/plans.js';

export const genai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// ═════════════════════════ SCHEMAS ═════════════════════════
// Design rule: the model NEVER produces numbers we show as facts about the business.
// It extracts what the user said (amounts in a voice note) or picks a whitelisted query;
// PostgreSQL produces every total, balance and profit figure.

const Naira = z.number().int().nonnegative().describe('Whole Naira. "50k" = 50000, "1.2m" = 1200000, "5h" / "5 hundred" = 500');

export const TxnLineSchema = z.object({
  type: z.enum(['sale', 'expense', 'restock', 'debt_repayment']).describe(
    'sale = sold goods/services; expense = running cost (fuel, rent, transport, data, salary); restock = bought inventory to resell; debt_repayment = a customer paying an old balance',
  ),
  item_name: z.string().optional().describe('Product/service in singular, title case, e.g. "Lace Fabric". Omit for expenses and debt repayments.'),
  quantity: z.number().positive().describe('Units. Default 1.'),
  unit_price_ngn: Naira.optional(),
  amount_ngn: Naira.describe('Total value of this line (quantity × unit price).'),
  amount_paid_ngn: Naira.describe('Money actually received (sale/debt_repayment) or paid out (expense/restock) now. For "transfer 30k balance 20k" on a 50k sale this is 30000.'),
  payment_method: z.enum(['cash', 'transfer', 'pos', 'credit', 'unknown']),
  customer_name: z.string().optional().describe('Who bought / who owes / who paid. Required when amount_paid_ngn < amount_ngn on a sale.'),
  category: z.enum(['Fuel/Diesel', 'Logistics/Dispatch', 'Rent/Utilities', 'Salaries', 'Data/Airtime', 'Packaging', 'Marketing', 'Food', 'Bank/POS charges', 'Repairs', 'Taxes/Levies', 'Other']).optional().describe('Expense category (expenses only).'),
});
export type TxnLine = z.infer<typeof TxnLineSchema>;

const BankAlertSchema = z.object({
  is_bank_alert: z.boolean().describe('True if the image is a bank transfer receipt/alert/screenshot.'),
  sender_name: z.string().optional(),
  bank_name: z.string().optional(),
  amount_ngn: z.number().nonnegative().optional(),
  session_id: z.string().optional().describe('NIP Session ID / Transaction reference exactly as printed, digits only if numeric.'),
  timestamp_iso: z.string().optional().describe('Transaction date-time in ISO 8601 with +01:00 offset.'),
  anomalies: z.array(z.string()).describe(
    'Visual tampering signs: mismatched fonts/weights in amount or name, misaligned baselines, inconsistent kerning, pixelation around digits, cropped/missing status bar, wrong bank logo/colour, impossible date. Empty if none.',
  ),
  is_supplier_receipt: z.boolean().describe('True if instead this is a supplier invoice/receipt for goods bought.'),
  supplier_lines: z.array(TxnLineSchema).optional().describe('If supplier receipt: restock/expense lines.'),
});
export type BankAlert = z.infer<typeof BankAlertSchema>;

export const QUERY_KINDS = ['profit', 'debtors', 'top_products', 'top_customers', 'customers', 'lapsed_customers', 'dead_stock', 'expenses_by_category', 'stock_level', 'cash_today'] as const;

/** Things people ask for that the product does not do yet. Each gets an honest, fixed reply (see flows/records.ts). */
export const NOT_SUPPORTED_KINDS = ['I_OWE_SUPPLIER', 'OPENING_CASH', 'BANK_BALANCE', 'PERSONAL_SPENDING', 'INVOICE', 'OTHER'] as const;

export const BrainSchema = z.object({
  intent: z.enum([
    'LOG_TRANSACTION', 'RECORD_DEBTS', 'SET_PRODUCTS', 'UPDATE_CUSTOMER', 'RECORD_CLIENTS', 'CUSTOMER_OUTREACH', 'VERIFY_BANK_ALERT', 'DRAFT_SALES_REPLY', 'CREATE_VIDEO_SCRIPT',
    'QUERY_BUSINESS', 'CHASE_DEBTS', 'UNDO_LAST', 'CORRECT_LAST', 'NOT_SUPPORTED', 'BUSINESS_ADVICE', 'ACKNOWLEDGE', 'HELP', 'OFF_TOPIC',
  ]),
  language: z.enum(['english', 'pidgin', 'yoruba', 'hausa', 'igbo']).describe('Language the user spoke/wrote in. Reply in the same register.'),
  transcript: z.string().optional().describe('Verbatim transcript if input was a voice note.'),
  transactions: z.array(TxnLineSchema).optional(),
  debts: z.array(z.object({
    customer_name: z.string(),
    amount_ngn: Naira,
    due_date: z.string().optional().describe('YYYY-MM-DD, only if the owner said when it will be paid ("next week", "month end"). Work it out from today\'s date.'),
    owing_since: z.string().optional().describe('YYYY-MM-DD, only if the owner said how long ago ("last month", "since October").'),
  })).optional().describe('RECORD_DEBTS: money customers owed the owner BEFORE today, or outside a sale being logged now.'),
  products: z.array(z.object({
    name: z.string(),
    quantity: z.number().nonnegative().optional().describe('Units the owner HAS in stock right now ("I have 50 lace"). Omit for a price-only change.'),
    cost_price_ngn: Naira.optional().describe('What one unit costs the owner.'),
    selling_price_ngn: Naira.optional().describe('What one unit sells for.'),
  })).optional().describe('SET_PRODUCTS: opening stock counts and price/cost changes. Nothing here is a sale or a purchase.'),
  customer_update: z.object({ name: z.string(), phone: z.string() }).optional().describe('UPDATE_CUSTOMER: a customer\'s phone number.'),
  clients: z.array(z.object({ name: z.string(), phone: z.string().optional() })).optional().describe('RECORD_CLIENTS: customers to add to the owner\'s client list, with a phone number if given.'),
  outreach: z.enum(['winback', 'thank_top']).optional().describe('CUSTOMER_OUTREACH: winback = customers who stopped buying; thank_top = best customers.'),
  not_supported: z.enum(NOT_SUPPORTED_KINDS).optional().describe('NOT_SUPPORTED: which unsupported thing was asked.'),
  clarification_needed: z.string().optional().describe('One short question if something critical is missing (e.g. who owes a balance). Omit otherwise.'),
  bank_alert: BankAlertSchema.optional(),
  sales_reply: z
    .object({
      customer_objection: z.string(),
      scripts: z.array(z.string()).describe('Exactly 2 ready-to-paste WhatsApp replies, max 60 words each.'),
    })
    .optional(),
  video_request: z
    .object({ product_name: z.string().optional(), price_ngn: Naira.optional(), delivery_info: z.string().optional() })
    .optional(),
  query: z
    .object({
      kind: z.enum(QUERY_KINDS),
      customer_name: z.string().optional().describe('For "how much does NAME owe me" / one named customer.'),
      period: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']).optional(),
      product_name: z.string().optional(),
    })
    .optional(),
  reply_text: z.string().optional().describe('Only for HELP, BUSINESS_ADVICE or OFF_TOPIC: the reply text in the user\'s language.'),
});
export type BrainResult = z.infer<typeof BrainSchema>;

const videoScriptSchema = (mini: boolean) => z.object({
  hook: z.string().describe(mini ? 'First 2 seconds, max 6 words, pattern-interrupt.' : 'First 2 seconds, max 8 words, pattern-interrupt.'),
  voiceover: z.string().describe(mini
    ? `Short 8–10 second spoken script, ${MINI_VIDEO.words} words, Nigerian direct-response tone: hook, price, closing call to action "Message us on WhatsApp to order" (no phone number, no code).`
    : 'Full 15–18 second spoken script, 28–32 words (the voice speaks about two words a second), Nigerian direct-response tone, ends with the call to action "Message us on WhatsApp to order" (no phone number, no code, no invented claims).'),
  captions: z.array(z.string()).describe('Exactly 3 burned-in caption lines, max 28 characters each, ALL CAPS punchy.'),
  pidgin: z.boolean().describe('True if voiceover is in Pidgin.'),
});
export const VideoScriptSchema = videoScriptSchema(false);
export type VideoScript = z.infer<typeof VideoScriptSchema>;

// ═════════════════════════ CORE CALL ═════════════════════════

function toGeminiSchema(schema: z.ZodType): unknown {
  const js = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === '$schema' || k === 'additionalProperties') continue;
        out[k] = strip(v);
      }
      return out;
    }
    return node;
  };
  return strip(js);
}

const schemaCache = new WeakMap<z.ZodType, unknown>();

export async function generateStructured<T>(opts: {
  schema: z.ZodType<T>;
  system: string;
  parts: Part[];
  temperature?: number;
}): Promise<T> {
  let jsonSchema = schemaCache.get(opts.schema);
  if (!jsonSchema) {
    jsonSchema = toGeminiSchema(opts.schema);
    schemaCache.set(opts.schema, jsonSchema);
  }
  const models = [env.GEMINI_TEXT_MODEL, env.GEMINI_TEXT_FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr: unknown;
  for (const model of models) {
    // Two tries per model: Gemini returns 503 "high demand" in spikes. Keep total worst-case latency bounded
    // (≈15s timeout × 2 tries × 2 models) — a WhatsApp user is waiting on the other end.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await genai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: opts.parts }],
          config: {
            systemInstruction: opts.system,
            responseMimeType: 'application/json',
            responseJsonSchema: jsonSchema,
            temperature: opts.temperature ?? 0.2,
            // No thinkingConfig on purpose: thinkingBudget:0 is rejected (400) by some newer models, and the
            // configured model is meant to be swappable via env without code changes.
            httpOptions: { timeout: 15_000 },
          },
        });
        const text = res.text;
        if (!text) throw new Error('empty model response');
        const parsed = opts.schema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`schema validation failed: ${parsed.error.message}`);
        return parsed.data;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) break; // 400/404/validation → retrying the same model won't help, go to fallback
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  void noteGeminiError('text', lastErr);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 429 / 5xx / deadline / "high demand" — worth one more try. */
export function isTransient(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? err);
  return /\b(429|500|502|503|504)\b|high demand|DEADLINE|UNAVAILABLE|RESOURCE_EXHAUSTED|timed? ?out|fetch failed/i.test(m);
}

// ═════════════════════════ ROUTER ═════════════════════════

export interface BrainInput {
  text?: string;
  audio?: { data: Buffer; mimeType: string };
  image?: { data: Buffer; mimeType: string; caption?: string };
  /** owing: customers who currently owe the business, as "Femi ₦14,000". Lets the router tell a debt payment from a fresh sale. */
  business: { name: string; recentProducts: string[]; todayWat: string; owing?: string[] };
}

const ROUTER_SYSTEM = (b: BrainInput['business']) => `
You are Unbarmore, the WhatsApp sales, video and bookkeeping co-pilot for "${b.name}", a Nigerian small business.
Today in Lagos is ${b.todayWat}. Known products: ${b.recentProducts.slice(0, 40).join(', ') || 'none yet'}.
Customers who currently owe this business: ${b.owing?.length ? b.owing.slice(0, 30).join('; ') : 'none recorded yet'}.

Classify the message into exactly one intent and fill ONLY that intent's field:
- LOG_TRANSACTION → "transactions". Something that HAPPENED now: a sale, expense, restock or a debt payment. Split compound statements into atomic lines.
  "Sold 2 laces 50k, transfer 30k balance 20k, buy fuel 5k" →
   [{type:sale,item_name:"Lace",quantity:2,amount_ngn:50000,amount_paid_ngn:30000,payment_method:transfer},
    {type:expense,category:"Fuel/Diesel",amount_ngn:5000,amount_paid_ngn:5000,payment_method:cash}]
  Forwarded bank SMS ("Credit Alert", "Acct:**1234 Amt:NGN25,000.00 CR") is a sale/debt_repayment with payment_method transfer.
  Match item names to known products when obviously the same thing.
  debt_repayment ONLY when the person is in the "currently owe" list above, or the owner clearly says an old debt/balance was paid ("Femi don pay his balance", "Mama Tunde cleared her debt").
  "Collected/received 12k from Chika for the gele", or any payment for goods, is a SALE paid in full. If the payer is not in the owing list and it is unclear whether it is a debt or a sale, set clarification_needed.
  "Balance 20k" / "remaining 20k" / "she owe 20k" means 20k is still UNPAID: amount_paid_ngn = amount_ngn − 20000. "Paid 30k" / "collected 30k" is what was received.
  BUYING GOODS to resell is a RESTOCK (money OUT), never a sale and never SET_PRODUCTS: "I bought 5 lace 15,550", "the goods cost me 15,550", "cost of buying the goods 15,550", "I stocked lace for 15k", "bought goods 40k" → {type:restock, amount_ngn: the TOTAL paid, amount_paid_ngn: same, quantity if stated, item_name only if a product is named}. A single total for goods is a restock even when no product or quantity is named. Never read a total as the price of ONE item.
  Running costs are EXPENSES (money out), never income: transport/transportation/fare/okada/bus/dispatch, feeding/food/lunch, fuel, data/airtime, rent, salary, light bill, packaging. "Paid 2k for transport" and "transportation 800 feeding 800" are two expenses of 800, not a sale. Only money coming IN from a customer is a sale.
  NEVER invent an item name. If the message names no item (only a person and amounts), omit item_name and set clarification_needed to ask what was sold.
  If a sale has an unpaid balance but no customer name, set clarification_needed.
- RECORD_DEBTS → "debts". The owner TELLS you money customers owed them BEFORE today or outside any sale now: "3 people owe me money", "Femi owe me 14k from last month", a typed or spoken list of names with amounts, "Mama Tunde dey owe me 20k". These are statements to RECORD, not questions. Include due_date / owing_since only if said.
  If they say people owe them but give no names or amounts ("3 persons own me money before now"), still use RECORD_DEBTS with an empty debts list: the system will ask for the names and amounts.
- SET_PRODUCTS → "products". The owner states stock they already HAVE ("I have 50 lace, I bought at 15k") or changes the price or cost of ONE item/yard/piece ("update price of lace to 20k", "lace now costs me 17k each", "lace cost price is 3k per yard"). Only when it is clearly per item or names the product with a per-item cost. A lump sum for goods ("the goods cost me 15,550") is a RESTOCK under LOG_TRANSACTION, not this. Never a sale, never an expense.
- UPDATE_CUSTOMER → "customer_update". A customer's phone number to save ("Femi's number is 08031234567").
- RECORD_CLIENTS → "clients". The owner gives a list of CUSTOMERS to remember, with or without phone numbers ("add my customers: Femi 08031234567, Kalu", "save these clients"). Not debts, not sales.
- CUSTOMER_OUTREACH → "outreach". They want messages to bring customers back or thank them: "customers wey don stop to buy, write message for them" (winback), "message customers who haven't bought", "thank my best customers" (thank_top).
- VERIFY_BANK_ALERT → "bank_alert". Any screenshot of a transfer, POS slip or supplier receipt.
- DRAFT_SALES_REPLY → "sales_reply". User pastes/forwards what a customer said ("too cost", "last price?", "I go think am").
  Write 2 warm, confident Nigerian closing replies: one value-anchoring, one urgency/scarcity or bundle. Never insult. Never discount more than 10% unless the user said so.
- CREATE_VIDEO_SCRIPT → "video_request". User wants an ad/video/promo for a product. Extract any name, price, delivery info.
- QUERY_BUSINESS → "query". QUESTIONS about their own recorded numbers: profit, who owes (all, or one named customer via customer_name), best sellers, best customers, slow stock, expenses, stock left, cash today, "my customers / my client list" (kind customers), "who has stopped buying / my inactive customers" (kind lapsed_customers). A question has a question form ("who owes me?", "how much does Femi owe?"); a statement of debts is RECORD_DEBTS.
- CHASE_DEBTS → no field. They want reminder messages for people who OWE THEM money ("remind everyone owing me", "chase my debtors"). Messaging all customers in general ("message all my customers", promotions, broadcasts) is NOT_SUPPORTED with not_supported=OTHER, never CHASE_DEBTS.
- UNDO_LAST → no field. They want the last entry removed ("delete the last entry", "cancel that").
- CORRECT_LAST → no field. They say the last entry had a wrong amount or detail ("that last one was 25k not 35k").
- NOT_SUPPORTED → "not_supported": I_OWE_SUPPLIER (ONLY a bare statement that the owner owes a supplier, with no goods bought now; if they describe buying goods with a quantity or price, even part-paid, it is LOG_TRANSACTION restock with the amount actually paid), OPENING_CASH, BANK_BALANCE (their bank/cash balance), PERSONAL_SPENDING (owner took money for personal/household use), INVOICE (asks you to send an invoice), OTHER (a business request you cannot do).
- BUSINESS_ADVICE → practical questions about running or growing THEIR business that are not about their own recorded numbers: pricing, marketing, getting and keeping customers, handling debtors or suppliers, stock, cash flow, hiring, record keeping, how to use Unbarmore.
  reply_text: a direct, practical answer in the user's language and register, max 90 words, Nigerian market context, ending with one concrete next step. Use plain text (no markdown headings). Never invent their numbers: if they want their own figures that is QUERY_BUSINESS.
- ACKNOWLEDGE → "thank you", "ok", "👍", "alright", "noted" with nothing else.
- HELP → greetings, "what can you do", pricing questions about Unbarmore itself, and "how do I use Unbarmore" questions. reply_text: 2 short lines. Facts: staff numbers (Growth plan) are added by the owner sending ADD STAFF <phone number> <name>; PLANS shows prices; DASHBOARD gives the web link; WHO DEY OWE ME lists debts; CLOSE closes the shop's day; RECEIPT makes a customer receipt.
- OFF_TOPIC → anything not about running a business at all (essays, politics, trivia, homework, relationships, general chat).
  reply_text: politely say you only help with sales, videos and bookkeeping for their business. No exceptions.

HONESTY RULE: reply_text must NEVER say you saved, noted, recorded, updated, changed or deleted anything. Only the system performs actions, and it will tell the owner itself. Never claim a price, stock level or contact was changed.

Voice notes may be English, Nigerian Pidgin, Yoruba, Hausa or Igbo — transcribe into "transcript" and set "language".
Nigerian money slang: k=thousand, m=million, "half"=500 in context of small items, "ten-ten" = 10,000 each.
Never invent amounts. If an amount is truly unclear, use clarification_needed.
`.trim();

export async function routeMessage(input: BrainInput): Promise<BrainResult> {
  const parts: Part[] = [];
  if (input.audio) parts.push({ inlineData: { mimeType: input.audio.mimeType, data: input.audio.data.toString('base64') } });
  if (input.image) parts.push({ inlineData: { mimeType: input.image.mimeType, data: input.image.data.toString('base64') } });
  const text = [input.text, input.image?.caption].filter(Boolean).join('\n');
  parts.push({ text: text || (input.audio ? '(voice note)' : '(image)') });

  return generateStructured({ schema: BrainSchema, system: ROUTER_SYSTEM(input.business), parts });
}

/** Image-only path when user is mid-flow and we already know it's a bank alert / receipt. */
export async function readBankAlert(image: { data: Buffer; mimeType: string }, todayWat: string = new Date(Date.now() + 3600_000).toISOString().slice(0, 10)): Promise<BankAlert> {
  return generateStructured({
    schema: BankAlertSchema,
    system:
      `You are a forensic reader of Nigerian bank transfer screenshots (Opay, Moniepoint, Palmpay, Kuda, GTBank, Access, Zenith, UBA, First Bank, etc.) and supplier receipts. Extract fields exactly as printed. Scrutinise the amount and name regions for edit artifacts. Be conservative: list an anomaly only if you can point to it in the image itself. Today's date in Lagos is ${todayWat}: a date on or before today is NORMAL and must never be listed as an anomaly. Do not flag the session ID merely for its length or digits.`,
    parts: [{ inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } }, { text: 'Read this.' }],
    temperature: 0,
  });
}

// ═════════════════════════ COPYWRITING ═════════════════════════

export async function writeVideoScript(p: {
  businessName: string;
  productName: string;
  priceNgn: number | null;
  deliveryInfo: string | null;
  /** @deprecated not used any more: customers order by messaging the shop's WhatsApp number. */
  orderCode?: string;
  clearance?: boolean;
  pidgin?: boolean;
  /** Voice language. 'yoruba' = Yoruba with the product name and price said in English words (Yoruba number words are unreliable). */
  voice?: 'english' | 'pidgin' | 'yoruba';
  /** ~10-second preview (trial / free plan). */
  mini?: boolean;
}): Promise<VideoScript> {
  const mini = !!p.mini;
  const voice = p.voice ?? (p.pidgin ? 'pidgin' : 'english');
  return generateStructured({
    schema: videoScriptSchema(mini),
    temperature: 0.8,
    system:
      (mini
        ? `You write 8–10 second vertical video ads for Nigerian Instagram/WhatsApp Status sellers. The voiceover is ${MINI_VIDEO.words} words, no more: a 2-second hook, the product and price, then a closing call to action: "Message us on WhatsApp to order" (the phone number is shown on screen; never say any phone number, code or digits aloud). `
        : 'You write 15–18 second vertical video ads for Nigerian Instagram/WhatsApp Status sellers. The voiceover is 28–32 words, no more (the voice speaks about two words a second). Hook in the first 2 seconds, one concrete benefit, price, a nudge to act now, then a closing call to action: "Message us on WhatsApp to order" (the phone number is shown on screen; never say any phone number, code or digits aloud). ') +
      (voice === 'yoruba'
        ? 'LANGUAGE: write the voiceover AND the 3 captions in Yoruba with correct tone marks and diacritics (ẹ, ọ, ṣ, à, á…), Lagos market-seller tone. Yoruba number words are easy to get wrong, so say the product name and the price in ENGLISH words inside the Yoruba sentence (e.g. "seventeen thousand five hundred naira"), never as digits and never in Yoruba number words. The call to action is the Yoruba for "Message us on WhatsApp to order". Set pidgin=false. '
        : '') +
      'Never invent facts the owner did not give you: no customer counts ("500 happy customers"), no ratings, no "limited stock" or "few pieces left", no discounts, no delivery promises beyond the given delivery text. Natural Lagos tone. No hashtags. No emojis in voiceover. Numbers written as words a TTS voice reads well (e.g. "fifteen thousand naira").',
    parts: [{
      text: JSON.stringify({
        business: p.businessName,
        product: p.productName,
        price_ngn: p.priceNgn,
        delivery: p.deliveryInfo,
        style: p.clearance ? '48-HOUR CLEARANCE FLASH SALE — strong urgency, ends in 48 hours' : 'standard product ad',
        language: voice === 'yoruba' ? 'Yoruba' : voice === 'pidgin' ? 'Nigerian Pidgin' : 'Nigerian English',
      }),
    }],
  });
}

const DebtReminderSchema = z.object({ messages: z.array(z.object({ customer: z.string(), message: z.string() })) });

export async function writeDebtReminders(businessName: string, debtors: { name: string; amount: string; days: number }[]) {
  const out = await generateStructured({
    schema: DebtReminderSchema,
    temperature: 0.6,
    system:
      'Write polite, warm, respectful Nigerian payment reminders a shop owner can forward on WhatsApp. Max 45 words each. Greet by name, mention exact amount, give an easy next step (transfer details "as before"), never threaten, preserve the relationship. Vary the wording.',
    parts: [{ text: JSON.stringify({ business: businessName, debtors }) }],
  });
  return out.messages;
}

/** Warm, short messages an owner forwards to customers: "we miss you" (win-back) or "thank you" (best customers). */
export async function writeCustomerMessages(
  businessName: string, kind: 'winback' | 'thank_top', customers: { name: string; daysSinceLastBuy: number | null; totalSpent: string }[],
): Promise<{ customer: string; message: string }[]> {
  const out = await generateStructured({
    schema: DebtReminderSchema,
    temperature: 0.7,
    system: kind === 'winback'
      ? 'Write short, warm Nigerian WhatsApp messages a shop owner sends to a past customer who has not bought for a while. Max 40 words each. Greet by first name, say they are missed, mention something new or an easy reason to come back (no fake discounts, no invented products), end with a simple invitation to reply. Never pushy. Vary the wording.'
      : 'Write short, warm Nigerian WhatsApp messages a shop owner sends to one of their best customers to say thank you. Max 35 words each. Greet by first name, appreciate their loyalty, invite them to tell a friend (no invented discounts). Vary the wording.',
    parts: [{ text: JSON.stringify({ business: businessName, customers }) }],
  });
  return out.messages;
}
