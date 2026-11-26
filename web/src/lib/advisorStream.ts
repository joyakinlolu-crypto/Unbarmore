/**
 * Stream an answer from Gemini with a HARD time budget and automatic fallback to the next model.
 *
 *  - The whole answer is capped at `budgetMs` (25s by default). Nothing can hang the dashboard past that.
 *  - Each model gets a slice of the budget to produce its FIRST word; if it is slow or errors (503 "high demand", 500, 402…),
 *    the next model is tried straight away.
 *  - Once words have been shown we never switch models (the text would restart): a stall or the deadline ends the answer
 *    there, flagged `truncated` so the caller can say "answer cut short".
 */
export interface StreamLike { [Symbol.asyncIterator](): AsyncIterator<{ text?: string }> }
export interface AiLike {
  models: { generateContentStream(p: { model: string; contents: unknown; config?: Record<string, unknown> }): Promise<StreamLike> };
}

export interface StreamResult { text: string; model: string; truncated: boolean }

export class AdvisorTimeout extends Error {
  constructor(public readonly causes: string[]) { super(`advisor unavailable: ${causes.join(' | ')}`); }
}

export async function streamWithFallback(opts: {
  ai: AiLike; models: string[]; contents: unknown; config?: Record<string, unknown>;
  onText: (t: string) => void;
  budgetMs?: number;                 // whole answer
  firstWordMs?: number[];            // per-model time to produce the first word
  stallMs?: number;                  // max silence between words once started
}): Promise<StreamResult> {
  const budgetMs = opts.budgetMs ?? 25_000;
  const firstWordMs = opts.firstWordMs ?? [10_000, 8_000, 7_000];
  const stallMs = opts.stallMs ?? 8_000;
  const deadline = Date.now() + budgetMs;
  const causes: string[] = [];

  for (let i = 0; i < opts.models.length; i++) {
    const model = opts.models[i]!;
    const left = deadline - Date.now();
    if (left < Math.min(1_500, budgetMs / 4)) { causes.push('out of time'); break; }
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(), Math.min(firstWordMs[i] ?? 7_000, left));
    let text = '';
    try {
      const stream = await opts.ai.models.generateContentStream({ model, contents: opts.contents, config: { ...opts.config, abortSignal: ac.signal } });
      for await (const chunk of stream) {
        clearTimeout(timer);
        if (chunk.text) { text += chunk.text; opts.onText(chunk.text); }
        const remaining = deadline - Date.now();
        if (remaining <= 0) { ac.abort(); return { text, model, truncated: true }; }
        timer = setTimeout(() => ac.abort(), Math.min(stallMs, remaining));
      }
      if (!text.trim()) { causes.push(`${model}: empty answer`); continue; }
      return { text, model, truncated: false };
    } catch (e) {
      if (text.trim()) return { text, model, truncated: true }; // words already shown: keep them, never restart on another model
      causes.push(`${model}: ${ac.signal.aborted ? 'too slow' : String((e as Error)?.message ?? e).slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AdvisorTimeout(causes);
}
