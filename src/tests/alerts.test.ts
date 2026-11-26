import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
    ADMIN_PHONE: '2348100000001', REDIS_URL: 'redis://127.0.0.1:6379',
  });
});

const m = vi.hoisted(() => ({ inWindow: true, sent: [] as string[], failSend: false }));
vi.mock('../db/supabase.js', () => ({ isInServiceWindow: async () => m.inWindow }));
vi.mock('../services/whatsapp.js', () => ({
  reply: () => ({ text: (...l: string[]) => ({ send: async () => { if (m.failSend) throw new Error('boom'); m.sent.push(l.join('\n')); } }) }),
}));

const A = await import('../lib/alerts.js');
const { Redis } = await import('ioredis');
const r = new Redis('redis://127.0.0.1:6379');
const reset = async () => { for (const k of await r.keys('alert*')) await r.del(k); await r.del('alerts:log', 'alerts:missed'); m.sent.length = 0; m.inWindow = true; m.failSend = false; };

describe('classifyGeminiError', () => {
  it.each([
    ['{"error":{"code":402,"message":"Your prepayment credits are depleted."}}', '402'],
    ['got status: UNAVAILABLE. {"error":{"code":503,"message":"high demand"}}', '503'],
    ['API key not valid. Please pass a valid API key.', '401'],
    ['{"error":{"code":403,"status":"PERMISSION_DENIED"}}', '403'],
    ['{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', '429'],
    ['{"error":{"code":500,"status":"INTERNAL"}}', '500'],
    ['schema validation failed', 'other'],
  ])('%s → %s', (msg, cls) => expect(A.classifyGeminiError(new Error(msg))).toBe(cls));
});

describe('scrub', () => {
  it('removes API keys and tokens, and shortens long text', () => {
    const s = A.scrub('failed with key AIzaSyA1234567890abcdefghijklmnop and Bearer abcdefghijklmnop1234 and ' + 'x'.repeat(500));
    expect(s).not.toMatch(/AIza|abcdefghijklmnop1234/);
    expect(s.length).toBeLessThanOrEqual(280);
  });
});

describe('alertAdmin', () => {
  beforeEach(reset);

  it('sends a WhatsApp message to ADMIN_PHONE when the 24h window is open', async () => {
    expect(await A.alertAdmin('video', 'Video FAILED: Cord lace', 'ffmpeg killed')).toBe('sent');
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toContain('🚨 *Unbarmore alert*');
    expect(m.sent[0]).toContain('Video FAILED: Cord lace — ffmpeg killed');
  });

  it('the SAME problem alerts once per cooldown; repeats are counted, not sent', async () => {
    expect(await A.alertAdmin('gemini', 'Credits used up')).toBe('sent');
    expect(await A.alertAdmin('gemini', 'Credits used up')).toBe('suppressed');
    expect(await A.alertAdmin('gemini', 'Credits used up')).toBe('suppressed');
    expect(m.sent).toHaveLength(1);
    expect(await A.alertAdmin('gemini', 'A different problem')).toBe('sent');
  });

  it('a hailstorm is capped: at most 30 an hour, with a notice on the last one', async () => {
    const results = [];
    for (let i = 0; i < 35; i++) results.push(await A.alertAdmin('worker', `problem ${i}`));
    expect(results.filter((x) => x === 'sent')).toHaveLength(30);
    expect(results.slice(30).every((x) => x === 'suppressed')).toBe(true);
    expect(m.sent[29]).toContain('Alert limit reached');
  });

  it('window closed → queued (never lost), then handed over by takeMissedAlerts, oldest first', async () => {
    m.inWindow = false;
    expect(await A.alertAdmin('video', 'first problem')).toBe('queued');
    expect(await A.alertAdmin('video', 'second problem')).toBe('queued');
    expect(m.sent).toHaveLength(0);
    const missed = await A.takeMissedAlerts();
    expect(missed).toHaveLength(2);
    expect(missed[0]).toContain('first problem');
    expect(missed[1]).toContain('second problem');
    expect(await A.takeMissedAlerts()).toHaveLength(0);
  });

  it('a send that fails is queued instead of lost', async () => {
    m.failSend = true;
    expect(await A.alertAdmin('webhook', 'could not queue')).toBe('queued');
    expect(await A.takeMissedAlerts()).toHaveLength(1);
  });

  it('keeps a log for the ALERTS command, newest first', async () => {
    await A.alertAdmin('video', 'one'); await A.alertAdmin('video', 'two');
    const log = await A.recentAlerts();
    expect(log.map((x) => x.text)).toEqual(['🎬 two', '🎬 one']);
  });
});

describe('noteGeminiError: critical errors alert at once, noisy ones only when repeated', () => {
  beforeEach(reset);

  it('402 (credits used up) → immediate alert saying how to fix it', async () => {
    await A.noteGeminiError('voice', new Error('{"error":{"code":402,"message":"Your prepayment credits are depleted."}}'));
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toContain('Gemini credits are used up (402)');
    expect(m.sent[0]).toContain('ai.studio/projects');
  });

  it('500 → immediate alert', async () => {
    await A.noteGeminiError('text', new Error('got status: INTERNAL. {"error":{"code":500}}'));
    expect(m.sent[0]).toContain('server error (500)');
  });

  it('a single 503 "high demand" blip does NOT page the owner; the 8th in 10 minutes does', async () => {
    for (let i = 0; i < 7; i++) await A.noteGeminiError('text', new Error('503 UNAVAILABLE high demand'));
    expect(m.sent).toHaveLength(0);
    await A.noteGeminiError('text', new Error('503 UNAVAILABLE high demand'));
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toContain('overloaded');
  });

  it('a validation/schema error is a bug, not an outage: no alert', async () => {
    await A.noteGeminiError('text', new Error('schema validation failed'));
    expect(m.sent).toHaveLength(0);
  });

  it('the alert never contains the API key', async () => {
    await A.noteGeminiError('text', new Error('API key not valid: AIzaSyA1234567890abcdefghijklmnop'));
    expect(m.sent.join('')).not.toMatch(/AIza/);
  });
});
