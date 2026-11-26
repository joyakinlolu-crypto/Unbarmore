import { describe, expect, it } from 'vitest';
import { AdvisorTimeout, streamWithFallback, type AiLike } from '@/lib/advisorStream';

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
});

/** A fake Gemini: per model, a script of steps (wait ms then yield text) or an error at start. */
type Step = { wait: number; text?: string } | { fail: string };
const fake = (scripts: Record<string, Step[]>, started: string[] = []): AiLike => ({
  models: {
    async generateContentStream({ model, config }) {
      started.push(model);
      const signal = config?.abortSignal as AbortSignal | undefined;
      const steps = scripts[model] ?? [{ fail: 'no script' }];
      const first = steps[0]!;
      if ('fail' in first) throw new Error(first.fail);
      return {
        async *[Symbol.asyncIterator]() {
          for (const s of steps) { if ('fail' in s) throw new Error(s.fail); await sleep(s.wait, signal); yield { text: s.text }; }
        },
      };
    },
  },
});

const opts = { budgetMs: 600, firstWordMs: [200, 160, 140], stallMs: 150 };

describe('streamWithFallback: a hard time budget and model fallback', () => {
  it('fast primary model: streams its answer, no fallback used', async () => {
    const started: string[] = []; const got: string[] = [];
    const r = await streamWithFallback({ ai: fake({ A: [{ wait: 10, text: 'Hello ' }, { wait: 10, text: 'world' }] }, started), models: ['A', 'B', 'C'], contents: [], onText: (t) => got.push(t), ...opts });
    expect(r).toMatchObject({ text: 'Hello world', model: 'A', truncated: false });
    expect(started).toEqual(['A']);
    expect(got.join('')).toBe('Hello world');
  });

  it('503 "high demand" at the start → the next model answers straight away', async () => {
    const started: string[] = [];
    const r = await streamWithFallback({ ai: fake({ A: [{ fail: '503 UNAVAILABLE high demand' }], B: [{ wait: 10, text: 'from B' }] }, started), models: ['A', 'B', 'C'], contents: [], onText: () => {}, ...opts });
    expect(r).toMatchObject({ text: 'from B', model: 'B' });
    expect(started).toEqual(['A', 'B']);
  });

  it('a HUNG primary model is abandoned after its slice, and the fallback answers within the budget', async () => {
    const t0 = Date.now();
    const r = await streamWithFallback({ ai: fake({ A: [{ wait: 5_000, text: 'too late' }], B: [{ wait: 10, text: 'rescued' }] }), models: ['A', 'B', 'C'], contents: [], onText: () => {}, ...opts });
    expect(r).toMatchObject({ text: 'rescued', model: 'B' });
    expect(Date.now() - t0).toBeLessThan(600);
  });

  it('every model hung or failing → gives up inside the budget (never hangs) with the reasons', async () => {
    const t0 = Date.now();
    const p = streamWithFallback({ ai: fake({ A: [{ wait: 5_000, text: 'x' }], B: [{ fail: '402 prepayment credits are depleted' }], C: [{ wait: 5_000, text: 'y' }] }), models: ['A', 'B', 'C'], contents: [], onText: () => {}, ...opts });
    await expect(p).rejects.toBeInstanceOf(AdvisorTimeout);
    await p.catch((e: AdvisorTimeout) => { expect(e.causes.join(' ')).toMatch(/A: too slow.*B: 402.*C: too slow/); });
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('words already shown then a stall → keeps what was said, flagged truncated (never restarts on another model)', async () => {
    const started: string[] = [];
    const r = await streamWithFallback({ ai: fake({ A: [{ wait: 10, text: 'Your sales are up. ' }, { wait: 5_000, text: 'never' }], B: [{ wait: 10, text: 'SHOULD NOT RUN' }] }, started), models: ['A', 'B'], contents: [], onText: () => {}, ...opts });
    expect(r).toMatchObject({ text: 'Your sales are up. ', model: 'A', truncated: true });
    expect(started).toEqual(['A']);
  });

  it('a slow-but-steady answer is cut at the overall deadline, truncated', async () => {
    const steps: Step[] = Array.from({ length: 30 }, () => ({ wait: 40, text: 'word ' }));
    const t0 = Date.now();
    const r = await streamWithFallback({ ai: fake({ A: steps }), models: ['A'], contents: [], onText: () => {}, ...opts });
    expect(r.truncated).toBe(true);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(r.text.length).toBeGreaterThan(10);
  });

  it('an empty answer counts as a failure and moves on', async () => {
    const r = await streamWithFallback({ ai: fake({ A: [{ wait: 5, text: '' }], B: [{ wait: 5, text: 'real answer' }] }), models: ['A', 'B'], contents: [], onText: () => {}, ...opts });
    expect(r).toMatchObject({ text: 'real answer', model: 'B' });
  });
});
