import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://x.co', SUPABASE_SERVICE_ROLE_KEY: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: 'x',
    WHATSAPP_DISPLAY_NUMBER: '2348000000000', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'verify-token-123', GEMINI_API_KEY: 'x',
  });
});

const gen = vi.hoisted(() => vi.fn());
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: gen }; } }));

import { pcmToWav, synthesizeVoiceover, ttsCooldown, ttsTuning } from '../services/ttsService.js';

const pcm = Buffer.alloc(48_000).toString('base64'); // 1 s of 24 kHz 16-bit silence
const audio = { candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/L16;rate=24000' } }] } }] };
beforeEach(() => { gen.mockReset(); ttsTuning.delayMs = 0; ttsCooldown.clear(); });

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
  it('a model that hit its DAILY cap is skipped on the next video, so the billed backup answers at once', async () => {
    const cap = new Error('Quota exceeded: generate content requests per day limit exceeded on Free Tier');
    gen.mockRejectedValueOnce(cap).mockRejectedValueOnce(cap).mockResolvedValueOnce(audio);
    await synthesizeVoiceover('One');                                   // capped, capped, backup answers
    expect(gen.mock.calls[2]![0].model).toBe('gemini-2.5-flash-preview-tts');
    gen.mockReset(); gen.mockResolvedValue(audio);
    await synthesizeVoiceover('Two');
    expect(gen).toHaveBeenCalledTimes(1);                               // went straight to the working model
    expect(gen.mock.calls[0]![0].model).toBe('gemini-2.5-flash-preview-tts');
  });
  it('an ordinary busy error (429/503) is NOT treated as a daily cap: the model is tried again next time', async () => {
    gen.mockRejectedValueOnce(new Error('503 high demand')).mockResolvedValueOnce(audio);
    await synthesizeVoiceover('One');
    gen.mockReset(); gen.mockResolvedValue(audio);
    await synthesizeVoiceover('Two');
    expect(gen.mock.calls[0]![0].model).toBe('gemini-3.8-flash-lite-tts');
  });
  it('gives up (so the video falls back) only after every round has failed', async () => {
    gen.mockRejectedValue(new Error('429 quota'));
    await expect(synthesizeVoiceover('Hello shop')).rejects.toThrow('429');
    expect(gen).toHaveBeenCalledTimes(ttsTuning.rounds * 3);
  });
  it('wraps raw PCM in a valid WAV header', () => {
    const w = pcmToWav(Buffer.alloc(100));
    expect(w.subarray(0, 4).toString()).toBe('RIFF');
    expect(w.subarray(8, 12).toString()).toBe('WAVE');
    expect(w.length).toBe(144);
  });
});

describe('Azure as the safety net when every Gemini speech model is capped', () => {
  const cap = new Error('Quota exceeded: generate content requests per day limit exceeded on Free Tier');
  it('with an Azure key, an English video still gets a voice (mp3) instead of silence', async () => {
    process.env.AZURE_SPEECH_KEY = 'k';
    vi.resetModules();
    const g = vi.fn().mockRejectedValue(cap);
    vi.doMock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: g }; } }));
    vi.doMock('../lib/alerts.js', () => ({ noteGeminiError: vi.fn(), alertAdmin: vi.fn() }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('ID3fakemp3'), { status: 200 })));
    const mod = await import('../services/ttsService.js');
    mod.ttsTuning.delayMs = 0; mod.ttsTuning.rounds = 1;
    const r = await mod.synthesizeVoiceover('Hello shop');
    expect(r.ext).toBe('mp3'); expect(r.mime).toBe('audio/mpeg');
    vi.unstubAllGlobals(); delete process.env.AZURE_SPEECH_KEY;
  });
  it('Yoruba never goes to an English voice: it fails honestly so the video is music-only', async () => {
    process.env.AZURE_SPEECH_KEY = 'k';
    vi.resetModules();
    const g = vi.fn().mockRejectedValue(cap);
    vi.doMock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: g }; } }));
    vi.doMock('../lib/alerts.js', () => ({ noteGeminiError: vi.fn(), alertAdmin: vi.fn() }));
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    const mod = await import('../services/ttsService.js');
    mod.ttsTuning.delayMs = 0; mod.ttsTuning.rounds = 1;
    await expect(mod.synthesizeVoiceover('Bawo ni', { yoruba: true })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); delete process.env.AZURE_SPEECH_KEY;
  });
  it('without an Azure key the failure is passed on, as before', async () => {
    delete process.env.AZURE_SPEECH_KEY;
    vi.resetModules();
    vi.doMock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: vi.fn().mockRejectedValue(cap) }; } }));
    vi.doMock('../lib/alerts.js', () => ({ noteGeminiError: vi.fn(), alertAdmin: vi.fn() }));
    const mod = await import('../services/ttsService.js');
    mod.ttsTuning.delayMs = 0; mod.ttsTuning.rounds = 1;
    await expect(mod.synthesizeVoiceover('Hello shop')).rejects.toThrow('Free Tier');
  });
});

describe('Google Cloud Text-to-Speech (the path around the Gemini API\'s 10-a-day cap)', () => {
  const sa = { client_email: 'tts@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n', project_id: 'proj' };
  const synth = vi.fn();
  const setup = async (creds: string | undefined, geminiResult: 'ok' | 'fail' = 'fail') => {
    vi.resetModules(); synth.mockReset();
    if (creds === undefined) delete process.env.GOOGLE_TTS_CREDENTIALS_JSON; else process.env.GOOGLE_TTS_CREDENTIALS_JSON = creds;
    const g = geminiResult === 'ok' ? vi.fn().mockResolvedValue(audio) : vi.fn().mockRejectedValue(new Error('Quota exceeded: Free Tier per day'));
    vi.doMock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: g }; } }));
    vi.doMock('@google-cloud/text-to-speech', () => ({ TextToSpeechClient: class { constructor(public opts: unknown) {} synthesizeSpeech = synth; } }));
    vi.doMock('../lib/alerts.js', () => ({ noteGeminiError: vi.fn(), alertAdmin: vi.fn() }));
    const mod = await import('../services/ttsService.js'); mod.ttsTuning.delayMs = 0; mod.ttsTuning.rounds = 1;
    return { mod, g };
  };

  it('credentials: raw JSON or base64 are accepted, \\n in the key is repaired, junk is ignored', async () => {
    const { mod } = await setup(undefined);
    expect(mod.parseCloudCredentials(JSON.stringify(sa))?.client_email).toBe(sa.client_email);
    expect(mod.parseCloudCredentials(Buffer.from(JSON.stringify(sa)).toString('base64'))?.project_id).toBe('proj');
    expect(mod.parseCloudCredentials(JSON.stringify(sa))?.private_key).toContain('\n');
    for (const bad of [undefined, '', '   ', 'not json', '{"a":1}', Buffer.from('{"x":1}').toString('base64')]) expect(mod.parseCloudCredentials(bad)).toBeNull();
  });
  it('with credentials, Cloud TTS answers FIRST using the Gemini voice model, and the Gemini API is never called', async () => {
    const { mod, g } = await setup(JSON.stringify(sa), 'ok');
    synth.mockResolvedValue([{ audioContent: Buffer.from('ID3mp3bytes') }]);
    const r = await mod.synthesizeVoiceover('Order now on WhatsApp');
    expect(r.ext).toBe('mp3'); expect(r.mime).toBe('audio/mpeg'); expect(g).not.toHaveBeenCalled();
    expect(synth.mock.calls[0]![0]).toMatchObject({ input: { text: 'Order now on WhatsApp' }, voice: { languageCode: 'en-US', name: 'Kore', modelName: 'gemini-2.5-flash-tts' } });
  });
  it('Yoruba asks Cloud for the Yoruba language code', async () => {
    const { mod } = await setup(JSON.stringify(sa));
    synth.mockResolvedValue([{ audioContent: Buffer.from('ID3') }]);
    await mod.synthesizeVoiceover('Ẹ káàbọ̀', { yoruba: true });
    expect(synth.mock.calls[0]![0].voice.languageCode).toBe('yo-NG');
  });
  it('if Cloud fails (e.g. the language is not supported) the Gemini API voice is tried next, so a video still gets a voice', async () => {
    const { mod, g } = await setup(JSON.stringify(sa), 'ok');
    synth.mockRejectedValue(new Error('3 INVALID_ARGUMENT: language yo-NG is not supported'));
    const r = await mod.synthesizeVoiceover('Bawo ni', { yoruba: true });
    expect(r.ext).toBe('wav'); expect(g).toHaveBeenCalled();
  });
  it('Cloud rate-limited → the next few seconds go to the others instead of hammering it', async () => {
    const { mod, g } = await setup(JSON.stringify(sa), 'ok');
    synth.mockRejectedValue(new Error('8 RESOURCE_EXHAUSTED: quota'));
    await mod.synthesizeVoiceover('One'); await mod.synthesizeVoiceover('Two');
    expect(synth).toHaveBeenCalledTimes(1);                             // the second video skipped Cloud during the cool-off
    expect(g).toHaveBeenCalledTimes(2);
  });
  it('without credentials nothing changes: Cloud is never touched', async () => {
    const { mod, g } = await setup(undefined, 'ok');
    await mod.synthesizeVoiceover('Hello'); expect(synth).not.toHaveBeenCalled(); expect(g).toHaveBeenCalled();
  });
  it('an unreadable credential is treated as "not configured" (no crash)', async () => {
    const { mod, g } = await setup('garbage', 'ok');
    await mod.synthesizeVoiceover('Hello'); expect(synth).not.toHaveBeenCalled(); expect(g).toHaveBeenCalled();
    delete process.env.GOOGLE_TTS_CREDENTIALS_JSON;
  });
  it('cloudVoiceStatus says NOT SET / UNREADABLE / WORKING / REJECTED, never leaking the key', async () => {
    let { mod } = await setup(undefined);
    expect(await mod.cloudVoiceStatus()).toMatch(/^NOT SET/);
    ({ mod } = await setup('{"hello": "world"}'));
    const bad = await mod.cloudVoiceStatus(); expect(bad).toMatch(/^UNREADABLE/); expect(bad).toContain('18 characters'); expect(bad).toContain('starts with {');
    ({ mod } = await setup(JSON.stringify(sa)));
    synth.mockResolvedValue([{ audioContent: Buffer.from('ID3') }]);
    const ok = await mod.cloudVoiceStatus(); expect(ok).toMatch(/^WORKING/); expect(ok).not.toContain('PRIVATE KEY'); expect(ok).not.toContain(sa.client_email);
    synth.mockRejectedValue(new Error(`7 PERMISSION_DENIED: Cloud Text-to-Speech API has not been used in project 1 before or it is disabled. ${sa.private_key}`));
    const rej = await mod.cloudVoiceStatus(); expect(rej).toMatch(/^REJECTED by Google: 7 PERMISSION_DENIED/); expect(rej).not.toContain('ABC');
    delete process.env.GOOGLE_TTS_CREDENTIALS_JSON;
  });
});
