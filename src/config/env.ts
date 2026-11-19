import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  PROCESS_ROLE: z.enum(['all', 'api', 'workers', 'cron']).default('all'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_DISPLAY_NUMBER: z.string().regex(/^\d{10,15}$/).describe('Bot number in E.164 without +, for wa.me links'),
  OPS_ALERT_PHONE: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(8),
  WHATSAPP_GRAPH_VERSION: z.string().default('v23.0'),
  WHATSAPP_CEO_TEMPLATE: z.string().default('unbarmore_weekly_ceo_report'),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_TEXT_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_TEXT_FALLBACK_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_IMAGE_MODEL: z.string().default('gemini-2.5-flash-image'),

  TTS_PROVIDER: z.enum(['google', 'azure']).default('google'),
  GOOGLE_TTS_VOICE: z.string().default('en-NG-Chirp3-HD-Achird'),
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().default('westeurope'),
  AZURE_TTS_VOICE: z.string().default('en-NG-AbeoNeural'),

  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_PLAN_STARTER_MONTHLY: z.string().min(1),
  PAYSTACK_PLAN_STARTER_ANNUAL: z.string().min(1),
  PAYSTACK_PLAN_GROWTH_MONTHLY: z.string().min(1),
  PAYSTACK_PLAN_GROWTH_ANNUAL: z.string().min(1),

  GOOGLE_SHEETS_SA_JSON_B64: z.string().optional(),

  BGM_DIR: z.string().default('./assets/bgm'),
  FONT_PATH: z.string().default('./assets/fonts/DejaVuSans-Bold.ttf'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Fail fast: a half-configured bot that silently drops payments is worse than one that won't boot.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = load();
