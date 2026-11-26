import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  WEB_APP_URL: z.string().url().default('https://app.unbarmore.com'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  PROCESS_ROLE: z.enum(['all', 'api', 'workers', 'cron']).default('all'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_DISPLAY_NUMBER: z.string().regex(/^\d{10,15}$/).describe('Bot number in E.164 without +, for wa.me links'),
  OPS_ALERT_PHONE: z.string().optional(),
  /** Owner of the platform: the only number that can use the ADMIN command (digits, e.g. 2348012345678). */
  ADMIN_PHONE: z.string().regex(/^\d{10,15}$/).optional(),
  /** Shared secret that lets the website report its own failures (e.g. the advisor) to POST /internal/alert. */
  INTERNAL_ALERT_KEY: z.string().min(16).optional(),
  /** Shown by SUPPORT and when payments aren't live yet, e.g. https://wa.me/2348012345678 */
  SUPPORT_WHATSAPP_URL: z.string().url().optional(),
  /** If the AI takes longer than this to answer, the user gets a short "Processing your entry…" note. */
  INTERIM_NOTICE_MS: z.coerce.number().int().min(1000).default(12000),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(8),
  WHATSAPP_GRAPH_VERSION: z.string().default('v23.0'),
  /** TESTING ONLY: point the WhatsApp client at a fake Meta server (scripts/live-whatsapp-flow.mts). Leave unset in production. */
  WHATSAPP_GRAPH_BASE: z.string().url().optional(),
  WHATSAPP_CEO_TEMPLATE: z.string().default('unbarmore_weekly_ceo_report'),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_TEXT_MODEL: z.string().default('gemini-3.1-flash-lite'),
  GEMINI_TEXT_FALLBACK_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_IMAGE_MODEL: z.string().default('gemini-2.5-flash-image'),

  TTS_PROVIDER: z.enum(['gemini', 'google', 'azure']).default('gemini'),
  GEMINI_TTS_MODEL: z.string().default('gemini-3.8-flash-lite-tts'),
  GEMINI_TTS_VOICE: z.string().default('Kore'),
  /** Tried when the main speech model is out of quota / overloaded (each model has its own quota). */
  GEMINI_TTS_FALLBACK_MODEL: z.string().default('gemini-3.1-flash-tts-preview'),
  GOOGLE_TTS_VOICE: z.string().default('en-NG-Chirp3-HD-Achird'),
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().default('westeurope'),
  AZURE_TTS_VOICE: z.string().default('en-NG-AbeoNeural'),

  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PLAN_STARTER_MONTHLY: z.string().optional(),
  PAYSTACK_PLAN_STARTER_ANNUAL: z.string().optional(),
  PAYSTACK_PLAN_GROWTH_MONTHLY: z.string().optional(),
  PAYSTACK_PLAN_GROWTH_ANNUAL: z.string().optional(),

  /** Web-push (free reach outside WhatsApp's 24h window). Generate once: npx web-push generate-vapid-keys. Both unset → push is simply off. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** mailto: or https: contact that push services can use. Defaults to the web app URL. */
  VAPID_SUBJECT: z.string().optional(),

  GOOGLE_SHEETS_SA_JSON_B64: z.string().optional(),

  BGM_DIR: z.string().default('./assets/bgm'),
  FONT_PATH: z.string().default('./assets/fonts/DejaVuSans-Bold.ttf'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) {
    throw new Error('Invalid environment configuration:\n  - REDIS_URL: required in production (on Railway: add a Redis service and reference its REDIS_URL)');
  }
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Fail fast: a half-configured bot that silently drops payments is worse than one that won't boot.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = load();
