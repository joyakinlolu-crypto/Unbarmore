/**
 * Estimated AI cost in naira from Google's token counts. ESTIMATES: the prices below are Google's published list prices
 * for the 2.5-generation models; the newer 3.x models may be priced differently. Check the real number in Google AI Studio
 * (the Spend page) and adjust USD_NGN / the table if they differ.
 */
export const PRICE_USD_PER_M = { textIn: 0.10, audioIn: 0.30, imageIn: 0.30, textOut: 0.40, ttsOut: 10, imageOut: 30 } as const;
export const usdNgn = (): number => Number(process.env.USD_NGN) || 1500;

interface TokenDetail { modality?: string; tokenCount?: number }
export interface UsageMetadata {
  promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number;
  promptTokensDetails?: TokenDetail[]; candidatesTokensDetails?: TokenDetail[];
}
export interface UsageSummary { inTokens: number; outTokens: number; estCostNgn: number }

const sumBy = (d: TokenDetail[] | undefined, modality: string) => (d ?? []).filter((x) => x.modality === modality).reduce((a, x) => a + (x.tokenCount ?? 0), 0);

export function summariseUsage(md: UsageMetadata | undefined | null): UsageSummary {
  if (!md) return { inTokens: 0, outTokens: 0, estCostNgn: 0 };
  const inTotal = md.promptTokenCount ?? 0;
  const audioIn = sumBy(md.promptTokensDetails, 'AUDIO'), imageIn = sumBy(md.promptTokensDetails, 'IMAGE');
  const textIn = Math.max(0, inTotal - audioIn - imageIn);
  const outAudio = sumBy(md.candidatesTokensDetails, 'AUDIO'), outImage = sumBy(md.candidatesTokensDetails, 'IMAGE');
  const outTotal = (md.candidatesTokenCount ?? 0) + (md.thoughtsTokenCount ?? 0);
  const outText = Math.max(0, outTotal - outAudio - outImage);
  const usd = (textIn * PRICE_USD_PER_M.textIn + audioIn * PRICE_USD_PER_M.audioIn + imageIn * PRICE_USD_PER_M.imageIn
    + outText * PRICE_USD_PER_M.textOut + outAudio * PRICE_USD_PER_M.ttsOut + outImage * PRICE_USD_PER_M.imageOut) / 1e6;
  return { inTokens: inTotal, outTokens: outTotal, estCostNgn: usd * usdNgn() };
}
