import { GoogleGenAI, type Part } from '@google/genai';
import { z } from 'zod';
import { env } from '../config/env.js';

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
  category: z.enum(['Fuel/Diesel', 'Logistics/Dispatch', 'Rent/Utilities', 'Salaries', 'Data/Airtime', 'Packaging', 'Marketing', 'Food', 'Other']).optional().describe('Expense category (expenses only).'),
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

export const QUERY_KINDS = ['profit', 'debtors', 'top_products', 'dead_stock', 'expenses_by_category', 'stock_level', 'cash_today'] as const;

export const BrainSchema = z.object({
  intent: z.enum(['LOG_TRANSACTION', 'VERIFY_BANK_ALERT', 'DRAFT_SALES_REPLY', 'CREATE_VIDEO_SCRIPT', 'QUERY_BUSINESS', 'HELP', 'OFF_TOPIC']),
  language: z.enum(['english', 'pidgin', 'yoruba', 'hausa', 'igbo']).describe('Language the user spoke/wrote in. Reply in the same register.'),
  transcript: z.string().optional().describe('Verbatim transcript if input was a voice note.'),
  transactions: z.array(TxnLineSchema).optional(),
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
      period: z.enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']).optional(),
      product_name: z.string().optional(),
    })
    .optional(),
  reply_text: z.string().optional().describe('Only for HELP or OFF_TOPIC: short friendly reply in the user\'s language.'),
});
export type BrainResult = z.infer<typeof BrainSchema>;

export const VideoScriptSchema = z.object({
  hook: z.string().describe('First 2 seconds, max 8 words, pattern-interrupt.'),
  voiceover: z.string().describe('Full 15–18 second spoken script, 38–48 words, Nigerian direct-response tone, ends with clear call to action naming the order code.'),
  captions: z.array(z.string()).describe('Exactly 3 burned-in caption lines, max 28 characters each, ALL CAPS punchy.'),
  pidgin: z.boolean().describe('True if voiceover is in Pidgin.'),
});
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
  business: { name: string; recentProducts: string[]; todayWat: string };
}

const ROUTER_SYSTEM = (b: BrainInput['business']) => `
You are Unbarmore, the WhatsApp sales, video and bookkeeping co-pilot for "${b.name}", a Nigerian small business.
Today in Lagos is ${b.todayWat}. Known products: ${b.recentProducts.slice(0, 40).join(', ') || 'none yet'}.

Classify the message into exactly one intent and fill ONLY that intent's field:
- LOG_TRANSACTION → "transactions". Split compound statements into atomic lines.
  "Sold 2 laces 50k, transfer 30k balance 20k, buy fuel 5k" →
   [{type:sale,item_name:"Lace",quantity:2,amount_ngn:50000,amount_paid_ngn:30000,payment_method:transfer},
    {type:expense,category:"Fuel/Diesel",amount_ngn:5000,amount_paid_ngn:5000,payment_method:cash}]
  Forwarded bank SMS ("Credit Alert", "Acct:**1234 Amt:NGN25,000.00 CR") is a sale/debt_repayment with payment_method transfer.
  Match item names to known products when obviously the same thing. "Collect 10k from Mama Tunde" = debt_repayment.
  If a sale has an unpaid balance but no customer name, set clarification_needed.
- VERIFY_BANK_ALERT → "bank_alert". Any screenshot of a transfer, POS slip or supplier receipt.
- DRAFT_SALES_REPLY → "sales_reply". User pastes/forwards what a customer said ("too cost", "last price?", "I go think am").
  Write 2 warm, confident Nigerian closing replies: one value-anchoring, one urgency/scarcity or bundle. Never insult. Never discount more than 10% unless the user said so.
- CREATE_VIDEO_SCRIPT → "video_request". User wants an ad/video/promo for a product. Extract any name, price, delivery info.
- QUERY_BUSINESS → "query". Questions about their own numbers: profit, who owes, best sellers, slow stock, expenses, stock left, cash today.
- HELP → greetings, "what can you do", pricing questions about Unbarmore itself. reply_text: 2 short lines.
- OFF_TOPIC → anything not about running THIS business (essays, politics, trivia, homework, relationships, general chat).
  reply_text: politely say you only help with sales, videos and bookkeeping for their business. No exceptions.

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
  orderCode: string;
  clearance?: boolean;
  pidgin?: boolean;
}): Promise<VideoScript> {
  return generateStructured({
    schema: VideoScriptSchema,
    temperature: 0.8,
    system:
      'You write 15–18 second vertical video ads for Nigerian Instagram/WhatsApp Status sellers. Hook in the first 2 seconds, one concrete benefit, social proof feel, price, scarcity, then CTA: "Send [ORDER CODE] on WhatsApp to order". Natural Lagos tone. No hashtags. No emojis in voiceover. Numbers written as words a TTS voice reads well (e.g. "fifteen thousand naira").',
    parts: [{
      text: JSON.stringify({
        business: p.businessName,
        product: p.productName,
        price_ngn: p.priceNgn,
        delivery: p.deliveryInfo,
        order_code: p.orderCode,
        style: p.clearance ? '48-HOUR CLEARANCE FLASH SALE — strong urgency, ends in 48 hours' : 'standard product ad',
        language: p.pidgin ? 'Nigerian Pidgin' : 'Nigerian English',
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
