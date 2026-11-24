import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

const gen = vi.hoisted(() => vi.fn());
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: gen }; } }));

import { pcmToWav, synthesizeVoiceover, ttsTuning } from '../services/ttsService.js';

const pcm = Buffer.alloc(48_000).toString('base64'); // 1 s of 24 kHz 16-bit silence
const audio = { candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/L16;rate=24000' } }] } }] };
beforeEach(() => { gen.mockReset(); ttsTuning.delayMs = 0; });

describe('voiceover: only the ad is spoken', () => {
  it('sends exactly the words to speak: no instructions the voice could read out loud', async () => {
    gen.mockResolvedValue(audio);
    const ad = 'Stop scrolling. Classy ankara gown, fifteen thousand naira. Order now on WhatsApp.';
    await synthesizeVoiceover(ad);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0]![0].contents).toBe(ad);
    expect(JSON.stringify(gen.mock.calls[0]![0])).not.toMatch(/read this|do not add|accent|energetic/i);
  });
  it('same for Pidgin: the language comes from the text, not from a spoken instruction', async () => {
    gen.mockResolvedValue(audio);
    await synthesizeVoiceover('Oga, this gown sweet die! Na fifteen thousand naira.', { pidgin: true });
    expect(gen.mock.calls[0]![0].contents).toBe('Oga, this gown sweet die! Na fifteen thousand naira.');
  });
  it('falls back to the second speech model when the first is out of quota, still with the plain text', async () => {
    gen.mockRejectedValueOnce(new Error('429 quota')).mockResolvedValueOnce(audio);
    const r = await synthesizeVoiceover('Hello shop');
    expect(gen).toHaveBeenCalledTimes(2);
    expect(gen.mock.calls[0]![0].model).not.toBe(gen.mock.calls[1]![0].model);
    expect(gen.mock.calls[1]![0].contents).toBe('Hello shop');
    expect(r.ext).toBe('wav');
  });
  it('when every speech model is busy, waits and goes round again instead of giving up (no silent ads)', async () => {
    gen.mockRejectedValueOnce(new Error('429')).mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(audio);
    const r = await synthesizeVoiceover('Hello shop');
    expect(r.ext).toBe('wav');
    expect(gen).toHaveBeenCalledTimes(3); // model A fail, model B fail, round 2 model A ok
  });
  it('gives up (so the video falls back) only after every round has failed', async () => {
    gen.mockRejectedValue(new Error('429 quota'));
    await expect(synthesizeVoiceover('Hello shop')).rejects.toThrow('429');
    expect(gen).toHaveBeenCalledTimes(ttsTuning.rounds * 2);
  });
  it('wraps raw PCM in a valid WAV header', () => {
    const w = pcmToWav(Buffer.alloc(100));
    expect(w.subarray(0, 4).toString()).toBe('RIFF');
    expect(w.subarray(8, 12).toString()).toBe('WAVE');
    expect(w.length).toBe(144);
  });
});
