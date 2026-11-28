import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { alertAdmin, noteGeminiError } from '../lib/alerts.js';
import { recordUsage } from '../lib/usage.js';

export interface Voiceover { data: Buffer; ext: 'mp3' | 'wav'; mime: string; /** Which service made it (shown by the admin TEST VOICE command). */ provider?: 'cloud' | 'gemini' | 'azure' | 'google' }

// Speech models are only on the v1beta API surface.
const beta = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta', timeout: 45_000 } });

let gClient: TextToSpeechClient | null = null;
let cloudClient: TextToSpeechClient | null = null;
let cloudCoolUntil = 0;

/** Raw JSON or base64 of it → credentials object. null when not configured or unreadable (we then simply don't use Cloud TTS). */
export function parseCloudCredentials(raw: string | undefined): { client_email: string; private_key: string; project_id?: string } | null {
  if (!raw?.trim()) return null;
  try {
    const txt = raw.trim().startsWith('{') ? raw.trim() : Buffer.from(raw.trim(), 'base64').toString('utf8');
    const j = JSON.parse(txt) as { client_email?: string; private_key?: string; project_id?: string };
    return j.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key.replace(/\\n/g, '\n'), project_id: j.project_id } : null;
  } catch { return null; }
}

/** Plain-words status of the Cloud TTS setup, for the admin TEST VOICE command. Never throws, never reveals the credential. */
export async function cloudVoiceStatus(yoruba = false): Promise<string> {
  const raw = env.GOOGLE_TTS_CREDENTIALS_JSON;
  if (!raw?.trim()) return 'NOT SET: this server has no GOOGLE_TTS_CREDENTIALS_JSON. Check the variable name is exactly that, it is on the Unbarmore service, and Railway finished redeploying.';
  const creds = parseCloudCredentials(raw);
  if (!creds) return `UNREADABLE: the variable is set (${raw.trim().length} characters, ${raw.trim().startsWith('{') ? 'starts with {' : 'does not start with {'}) but it is not a service-account key. It must be the key file's JSON, or the base64 of that file, containing "client_email" and "private_key".`;
  try { await cloudTts('Test.', yoruba); return `WORKING (service account ${creds.client_email.replace(/^(.{3}).*(@.*)$/, '$1…$2')}).`; }
  catch (e) { return `REJECTED by Google: ${String((e as Error)?.message ?? e).replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, '[key]').replace(/\s+/g, ' ').slice(0, 320)}`; }
}

/** Google Cloud Text-to-Speech: the Gemini voice model through Cloud (or a named voice). Throws on any failure so the caller can fall back. */
async function cloudTts(text: string, yoruba: boolean): Promise<Voiceover> {
  const creds = parseCloudCredentials(env.GOOGLE_TTS_CREDENTIALS_JSON);
  if (!creds) throw new Error('Cloud TTS not configured');
  cloudClient ??= new TextToSpeechClient({ credentials: creds, projectId: creds.project_id });
  const gemini = !!env.GOOGLE_TTS_MODEL;
  const [res] = await cloudClient.synthesizeSpeech({
    input: { text },
    voice: gemini
      ? { languageCode: yoruba ? env.GOOGLE_TTS_YORUBA_LANG : env.GOOGLE_TTS_LANG, name: env.GEMINI_TTS_VOICE, modelName: env.GOOGLE_TTS_MODEL }
      : { languageCode: 'en-NG', name: env.GOOGLE_TTS_VOICE },
    audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 },
  });
  if (!res.audioContent) throw new Error('Cloud TTS returned no audio');
  const data = Buffer.from(res.audioContent as Uint8Array);
  // Cost log: Cloud bills Gemini voices per token (about 25 audio tokens a second, speech ≈ 2.6 words a second).
  const audioTokens = Math.round((text.split(/\s+/).filter(Boolean).length / 2.6) * 25);
  recordUsage('voiceover', { promptTokenCount: Math.round(text.length / 4), candidatesTokenCount: audioTokens, candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: audioTokens }] } as never);
  return { data, ext: 'mp3', mime: 'audio/mpeg', provider: 'cloud' };
}

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Wrap raw 16-bit mono PCM in a WAV header so FFmpeg (and anything else) can read it. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Send ONLY the words to be spoken. Gemini speech models read any instruction placed in the prompt out loud
 * ("Read this advert in a warm, energetic voice…" was being spoken before every ad), so style comes from the voice and the text itself.
 */
/** Retry tuning (a test sets delayMs to 0). A busy or rate-limited speech model usually recovers within seconds. */
export const ttsTuning = { rounds: 3, delayMs: 4000 };

/** A model that said "limit reached for the DAY" is skipped for a while, so every video doesn't waste seconds retrying a dead model. */
export const ttsCooldown = new Map<string, number>();
const COOLDOWN_MS = 30 * 60_000;
const isDailyCap = (e: unknown) => /free tier|per day|limit: 0\b/i.test(String((e as Error)?.message ?? e));

async function geminiTts(text: string, yoruba = false): Promise<Voiceover> {
  // The preview model understood Yoruba better in listening checks, so it goes first for Yoruba and second otherwise.
  // The backup is a billed model with no daily cap: it carries the load once the two capped ones are used up.
  const order = yoruba ? [env.GEMINI_TTS_FALLBACK_MODEL, env.GEMINI_TTS_MODEL, env.GEMINI_TTS_BACKUP_MODEL] : [env.GEMINI_TTS_MODEL, env.GEMINI_TTS_FALLBACK_MODEL, env.GEMINI_TTS_BACKUP_MODEL];
  const all = order.filter((m, i, a) => m && a.indexOf(m) === i);
  const live = all.filter((m) => (ttsCooldown.get(m) ?? 0) < Date.now());
  const models = live.length ? live : all;                    // everything cooling down: try anyway rather than fail
  let lastErr: unknown;
  // Try every speech model, and if all are busy/out of quota, wait a moment and go round again: a silent ad is worse than a slow one.
  for (let round = 0; round < ttsTuning.rounds; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, ttsTuning.delayMs * round));
    for (const model of models) {
      try {
        const res = await beta.models.generateContent({
          model,
          contents: text,
          config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_TTS_VOICE } } } },
        });
        recordUsage('voiceover', res.usageMetadata as never);
        const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
        if (!part?.data) throw new Error('Gemini TTS returned no audio');
        const raw = Buffer.from(part.data, 'base64');
        return /wav/i.test(part.mimeType ?? '') ? { data: raw, ext: 'wav', mime: 'audio/wav', provider: 'gemini' } : { data: pcmToWav(raw), ext: 'wav', mime: 'audio/wav', provider: 'gemini' };
      } catch (e) {
        lastErr = e; // out of quota / overloaded → next model, then next round
        if (isDailyCap(e)) ttsCooldown.set(model, Date.now() + COOLDOWN_MS);
      }
    }
  }
  void noteGeminiError('voice', lastErr);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Nigerian-accented voiceover. Default provider "gemini" needs no extra account (uses GEMINI_API_KEY). */
export async function synthesizeVoiceover(text: string, opts: { pidgin?: boolean; yoruba?: boolean } = {}): Promise<Voiceover> {
  if (env.TTS_PROVIDER === 'gemini') {
    // 1) Google Cloud TTS first when a service account is configured: real quotas (per minute, not 10 a day).
    if (parseCloudCredentials(env.GOOGLE_TTS_CREDENTIALS_JSON) && Date.now() >= cloudCoolUntil) {
      try { return await cloudTts(text, !!opts.yoruba); }
      catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (/quota|resource_exhausted|\b429\b/i.test(msg)) cloudCoolUntil = Date.now() + 2 * 60_000;   // rate limited: use the others for a moment
        void alertAdmin('gemini', 'Google Cloud voice failed: falling back to the Gemini API voice', msg.slice(0, 200), { key: `cloud-tts:${msg.slice(0, 40)}`, cooldownS: 1800 });
      }
    }
    // 2) Gemini API speech models (capped at ~10 requests a day each on a free-tier quota), 3) Azure for English/Pidgin.
    try { return await geminiTts(text, opts.yoruba); }
    catch (e) {
      // Google caps every Gemini speech model at ~10 requests a day per model on a free-tier quota (our prepaid credits do not lift it).
      // If an Azure Speech key is configured, use Nigerian-English Azure instead of shipping a silent video. Yoruba stays Gemini-only:
      // an English voice reading Yoruba would be worse than music.
      if (!env.AZURE_SPEECH_KEY || opts.yoruba) throw e;
      void alertAdmin('gemini', 'Gemini voice is at its daily cap: using the Azure voice instead', String((e as Error)?.message ?? e).slice(0, 160), { key: 'tts-azure-fallback', cooldownS: 3600 });
      return { data: await azureTts(text), ext: 'mp3', mime: 'audio/mpeg', provider: 'azure' };
    }
  }
  if (env.TTS_PROVIDER === 'azure') return { data: await azureTts(text), ext: 'mp3', mime: 'audio/mpeg' };

  gClient ??= new TextToSpeechClient();
  const [res] = await gClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'en-NG', name: env.GOOGLE_TTS_VOICE },
    audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000, speakingRate: opts.pidgin ? 1.0 : 1.08 },
  });
  if (!res.audioContent) throw new Error('Google TTS returned no audio');
  return { data: Buffer.from(res.audioContent as Uint8Array), ext: 'mp3', mime: 'audio/mpeg' };
}

async function azureTts(text: string): Promise<Buffer> {
  if (!env.AZURE_SPEECH_KEY) throw new Error('AZURE_SPEECH_KEY not set');
  const ssml = `<speak version="1.0" xml:lang="en-NG"><voice name="${env.AZURE_TTS_VOICE}"><prosody rate="+8%">${escapeXml(text)}</prosody></voice></speak>`;
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      'User-Agent': 'unbarmore-tts',
    },
    body: ssml,
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
