import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});
const m = vi.hoisted(() => ({ synth: vi.fn(), upload: vi.fn(), cloud: { current: 'WORKING: Nigerian Gemini voice WORKING; regular Google voice WORKING.' } }));
vi.mock('../services/ttsService.js', () => ({ synthesizeVoiceover: m.synth, cloudVoiceStatus: async () => m.cloud.current }));
vi.mock('../db/supabase.js', () => ({
  db: {}, addVideoCredits: vi.fn(), isInServiceWindow: vi.fn(),
  uploadFile: (...a: unknown[]) => m.upload(...a), signedUrl: async (_b: string, p: string) => `https://files.test/${p}`,
}));
vi.mock('../lib/alerts.js', () => ({ alertAdmin: vi.fn(), recentAlerts: vi.fn(), takeMissedAlerts: vi.fn() }));
vi.mock('./scorecard.js', () => ({ scorecardReply: vi.fn() }));

import { adminAlertCommand } from '../flows/adminAlerts.js';
const payload = async (t: string) => (await adminAlertCommand('2348100000001', t))!.toPayload() as any;
beforeEach(() => { m.synth.mockReset(); m.upload.mockReset(); m.upload.mockImplementation(async (_b: string, p: string) => p); });

describe('admin TEST VOICE', () => {
  it('says which service answered, how long it took, and sends the audio file so it can be listened to', async () => {
    m.synth.mockResolvedValue({ data: Buffer.from('x'), ext: 'mp3', mime: 'audio/mpeg', provider: 'cloud' });
    const p = await payload('TEST VOICE');
    expect(p.document.caption).toContain('Google Cloud voice:* WORKING');
    expect(p.document.filename).toBe('voice-test-english.mp3'); expect(p.document.caption).toContain('Google Cloud Text-to-Speech'); expect(p.document.caption).toContain('worked');
    expect(m.upload.mock.calls[0]![0]).toBe('videos'); expect(m.upload.mock.calls[0]![1]).toMatch(/^admin-tests\/voice-\d+\.mp3$/);
  });
  it('TEST VOICE YORUBA asks for the Yoruba voice with Yoruba words', async () => {
    m.synth.mockResolvedValue({ data: Buffer.from('x'), ext: 'wav', mime: 'audio/wav', provider: 'gemini' });
    const p = await payload('test voice yoruba');
    expect(m.synth.mock.calls[0]![1]).toMatchObject({ yoruba: true }); expect(m.synth.mock.calls[0]![0]).toMatch(/[ẹọṣ]/i); expect(p.document.caption).toContain('capped');
  });
  it('a failure is reported plainly with the reason and what to check (never crashes)', async () => {
    m.synth.mockRejectedValue(new Error('429 Free Tier per day'));
    const t = (await payload('TEST VOICE')).text.body as string;
    expect(t).toContain('FAILED'); expect(t).toContain('429'); expect(t).toContain('music only'); expect(t).toContain('GOOGLE_TTS_CREDENTIALS_JSON');
  });
  it('when Cloud is not being used, the message says exactly why (so nobody has to guess)', async () => {
    m.synth.mockResolvedValue({ data: Buffer.from('x'), ext: 'wav', mime: 'audio/wav', provider: 'gemini' });
    m.cloud.current = 'WORKING: Nigerian Gemini voice REJECTED (403 Agent Platform API has not been used); regular Google voice WORKING.';
    expect((await payload('TEST VOICE')).document.caption).toContain('Nigerian Gemini voice REJECTED (403 Agent Platform API');
    m.cloud.current = 'NOT SET: this server has no GOOGLE_TTS_CREDENTIALS_JSON.';
    expect((await payload('TEST VOICE')).document.caption).toContain('NOT SET');
  });
  it('only exact commands match', async () => {
    expect(await adminAlertCommand('2348100000001', 'test voices please')).toBeNull();
  });
});
