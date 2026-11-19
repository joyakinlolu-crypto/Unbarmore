import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { env } from '../config/env.js';

let gClient: TextToSpeechClient | null = null;

const escapeXml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Nigerian-accented voiceover as MP3. Slightly fast delivery = more energy for 15s ads. */
export async function synthesizeVoiceover(text: string, opts: { pidgin?: boolean } = {}): Promise<Buffer> {
  if (env.TTS_PROVIDER === 'azure') return azureTts(text);

  gClient ??= new TextToSpeechClient();
  const [res] = await gClient.synthesizeSpeech({
    input: { text },
    // Chirp 3 HD voices don't support SSML/rate tweaks reliably; Pidgin is read best by en-NG voices as plain text.
    voice: { languageCode: 'en-NG', name: env.GOOGLE_TTS_VOICE },
    audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000, speakingRate: opts.pidgin ? 1.0 : 1.08 },
  });
  if (!res.audioContent) throw new Error('Google TTS returned no audio');
  return Buffer.from(res.audioContent as Uint8Array);
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
