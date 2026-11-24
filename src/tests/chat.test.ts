import { describe, expect, it } from 'vitest';
import { dailyCount, type Counter } from '../lib/rateLimit.js';

vi_env();
function vi_env() {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
}

const fake = () => {
  const counts = new Map<string, number>(); const ttl = new Map<string, number>();
  const c: Counter = { incr: async (k) => { counts.set(k, (counts.get(k) ?? 0) + 1); return counts.get(k)!; }, expire: async (k, s) => { ttl.set(k, s); } };
  return { c, ttl };
};

describe('WhatsApp advice chat: daily cap', () => {
  it('allows up to the cap, then refuses, and starts the 24h clock only on the first use', async () => {
    const { c, ttl } = fake();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await dailyCount(c, 'advice:234:2026-11-24', 3));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.n)).toEqual([1, 2, 3, 4]);
    expect(ttl.get('advice:234:2026-11-24')).toBe(86_400);
  });
  it('counts each owner separately', async () => {
    const { c } = fake();
    await dailyCount(c, 'advice:a', 1);
    expect((await dailyCount(c, 'advice:a', 1)).ok).toBe(false);
    expect((await dailyCount(c, 'advice:b', 1)).ok).toBe(true);
  });
});

describe('router knows the advice intent', () => {
  it('BUSINESS_ADVICE is a valid routed intent and carries its answer in reply_text', async () => {
    const { BrainSchema } = await import('../services/geminiBrain.js');
    const r = BrainSchema.parse({ intent: 'BUSINESS_ADVICE', language: 'english', reply_text: 'Price at cost plus 30%.' });
    expect(r.intent).toBe('BUSINESS_ADVICE');
    expect(r.reply_text).toContain('30%');
    expect(() => BrainSchema.parse({ intent: 'CHIT_CHAT', language: 'english' })).toThrow();
  });
});
