import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { noteGeminiError } from '../lib/alerts.js';

export interface Voiceover { data: Buffer; ext: 'mp3' | 'wav'; mime: string }

// Speech models are only on the v1beta API surface.
const beta = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta', timeout: 45_000 } });

let gClient: TextToSpeechClient | null = null;

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

async function geminiTts(text: string, yoruba = false): Promise<Voiceover> {
  // The preview model understood Yoruba better in listening checks, so it goes first for Yoruba and second otherwise.
  const order = yoruba ? [env.GEMINI_TTS_FALLBACK_MODEL, env.GEMINI_TTS_MODEL] : [env.GEMINI_TTS_MODEL, env.GEMINI_TTS_FALLBACK_MODEL];
  const models = order.filter((m, i, a) => m && a.indexOf(m) === i);
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
        const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
        if (!part?.data) throw new Error('Gemini TTS returned no audio');
        const raw = Buffer.from(part.data, 'base64');
        return /wav/i.test(part.mimeType ?? '') ? { data: raw, ext: 'wav', mime: 'audio/wav' } : { data: pcmToWav(raw), ext: 'wav', mime: 'audio/wav' };
      } catch (e) { lastErr = e; } // out of quota / overloaded → next model, then next round
    }
  }
  void noteGeminiError('voice', lastErr);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Nigerian-accented voiceover. Default provider "gemini" needs no extra account (uses GEMINI_API_KEY). */
export async function synthesizeVoiceover(text: string, opts: { pidgin?: boolean; yoruba?: boolean } = {}): Promise<Voiceover> {
  if (env.TTS_PROVIDER === 'gemini') return geminiTts(text, opts.yoruba);
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
