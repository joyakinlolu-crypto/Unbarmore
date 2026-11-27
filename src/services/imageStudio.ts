import { env } from '../config/env.js';
import { GoogleGenAI } from '@google/genai';
import { noteGeminiError } from '../lib/alerts.js';
import { recordUsage } from '../lib/usage.js';

// Image generation (responseModalities/imageConfig) is only on the v1beta API surface; the SDK default is v1.
const genai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta' } });

export type StudioTheme = 'clean_minimalist' | 'luxury_boutique' | 'outdoor_lifestyle';

const SCENES: Record<StudioTheme, string> = {
  clean_minimalist:
    'a seamless soft off-white studio backdrop with a subtle floor shadow, bright diffused softbox lighting, e-commerce catalogue style',
  luxury_boutique:
    'an upscale Lagos boutique display: warm brass accents, marble or dark wood surface, soft spotlight with gentle bokeh, premium editorial mood',
  outdoor_lifestyle:
    'a bright natural daylight lifestyle setting with soft greenery and warm golden-hour light, shallow depth of field, aspirational but realistic',
};

const PROMPT = (theme: StudioTheme) => `
Professional product photo retouch.
Remove the existing messy background (bed sheets, floors, hands, clutter, other objects) and place the product on ${SCENES[theme]}.
STRICT PRESERVATION — this is a real product for sale, the customer must receive exactly what they see:
- Do NOT change the product's shape, proportions, colour, pattern, texture, print, stitching, logo or label text.
- Do NOT add, remove or "improve" any part of the product. No extra items, props must not overlap it.
- Keep the product fully in frame, centred, filling ~70% of a vertical 9:16 composition with headroom at the top for captions.
- Realistic contact shadow. No text, no watermark.
`.trim();

/**
 * Returns the enhanced image, or the original if the model refuses/fails —
 * a video with the real photo beats no video at all.
 */
export async function enhanceProductPhoto(
  image: { data: Buffer; mimeType: string },
  theme: StudioTheme,
): Promise<{ data: Buffer; mimeType: string; enhanced: boolean }> {
  if (env.DISABLE_PHOTO_CLEANUP === 'true') return { ...image, enhanced: false };
  try {
    const res = await genai.models.generateContent({
      model: env.GEMINI_IMAGE_MODEL,
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } }, { text: PROMPT(theme) }] }],
      config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
    });
    recordUsage('photo_cleanup', res.usageMetadata as never, { images: 1 });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error('no image returned');
    return { data: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType ?? 'image/png', enhanced: true };
  } catch (err) {
    // Never block the video, but never fail silently either: a 402/429 here means every video ships with un-cleaned photos.
    void noteGeminiError('photo cleanup', err); // a 402 here would otherwise be invisible: every video would silently ship uncleaned photos
    console.error('[imageStudio] photo cleanup failed, using original:', String((err as Error)?.message ?? err).slice(0, 300));
    return { ...image, enhanced: false };
  }
}
