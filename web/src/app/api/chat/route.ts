import { GoogleGenAI } from '@google/genai';
import { NextResponse, type NextRequest } from 'next/server';
import { buildAdvisorSystemPrompt, buildBusinessSnapshot, isFinalFreeMessage } from '@/lib/advisorContext';
import { getSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const ERR = '\u0000ERR:';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const businessId = session.business_id; // ← only ever from the verified session

  const message = String(((await req.json().catch(() => ({}))) as { message?: unknown }).message ?? '').trim();
  if (!message || message.length > 2000) return NextResponse.json({ error: 'Message must be 1–2000 characters' }, { status: 400 });

  // Tier gate (spec §5.B.2): unlimited on paid tiers, 10/month on trial & free_limited.
  const tier = session.business.subscription_tier;
  let finalFreeMessage = false;
  if (tier === 'trial' || tier === 'free_limited') {
    // The limit (3/month) lives in SQL — advisor_usage() — so the route and the UI read the same number.
    const { data: u } = await db.rpc('advisor_usage', { p_business_id: businessId });
    const { used, free_limit } = ((u as { used: number; free_limit: number }[] | null)?.[0]) ?? { used: 0, free_limit: 3 };
    if (used >= free_limit) return NextResponse.json({ error: 'limit', limit: free_limit }, { status: 402 });
    finalFreeMessage = isFinalFreeMessage(tier, used, free_limit); // this is message 3 of 3 → lead with their biggest ₦ leak
  }
  // Burst guard: even "unlimited" shouldn't let a loop burn the Gemini bill.
  const { count: recent } = await db.from('web_chat_messages').select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).eq('role', 'user').gte('created_at', new Date(Date.now() - 60_000).toISOString());
  if ((recent ?? 0) >= 6) return NextResponse.json({ error: 'slow_down' }, { status: 429 });

  // History is server-owned: the client sends only the new message, so it can't forge "assistant" turns.
  const { data: hist } = await db.from('web_chat_messages').select('role, content').eq('business_id', businessId)
    .order('created_at', { ascending: false }).limit(20);
  const chatHistory = (hist ?? []).reverse().map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));
  while (chatHistory[0]?.role === 'model') chatHistory.shift();

  const { data: userRow, error: insErr } = await db.from('web_chat_messages')
    .insert({ business_id: businessId, user_id: session.sub, role: 'user', content: message }).select('id').single();
  if (insErr || !userRow) return NextResponse.json({ error: 'save_failed' }, { status: 500 });

  const snapshot = await buildBusinessSnapshot(businessId);
  const systemInstruction = buildAdvisorSystemPrompt(snapshot, { finalFreeMessage });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = '';
      let open = true;
      const push = (t: string) => { if (!open) return; try { controller.enqueue(encoder.encode(t)); } catch { open = false; } };
      try {
        const models = [process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite', process.env.GEMINI_TEXT_FALLBACK_MODEL || 'gemini-3.5-flash-lite']
          .filter((m, i, a) => a.indexOf(m) === i);
        let stream: Awaited<ReturnType<typeof ai.models.generateContentStream>> | null = null;
        let lastErr: unknown;
        const startedAt = Date.now(); // hard budget: maxDuration is 60s, so stop starting new attempts after 35s
        // Try the primary model, then the fallback, BEFORE the first byte is streamed (503 "high demand" happens at stream start).
        for (const model of models) {
          // Gemini answers 503 "high demand" in short spikes: one quick retry per model before falling back.
          for (let attempt = 0; attempt < 2 && !stream && Date.now() - startedAt < 35_000; attempt++) {
            try {
              stream = await ai.models.generateContentStream({
                model,
                contents: [...chatHistory, { role: 'user', parts: [{ text: message }] }],
                config: { systemInstruction, temperature: 0.5, maxOutputTokens: 1200, httpOptions: { timeout: 25_000 } }, // a hung attempt is abandoned, not waited on
              });
            } catch (e) {
              lastErr = e;
              // retry only fast transient errors (503 etc.); a timeout/abort means the model is hung → go straight to the fallback
              if (!/\b(429|500|503)\b|high demand|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(String((e as Error)?.message ?? e))) break;
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            }
          }
          if (stream) break;
        }
        if (!stream) throw lastErr;
        for await (const chunk of stream) {
          const t = chunk.text;
          if (t) { full += t; push(t); }
        }
        if (!full.trim()) throw new Error('empty response');
        await db.from('web_chat_messages').insert({ business_id: businessId, user_id: session.sub, role: 'assistant', content: full });
      } catch (e) {
        console.error('[chat]', e);
        // Don't charge a free-tier message for a failed answer.
        await db.from('web_chat_messages').delete().eq('id', userRow.id);
        push(`${ERR}failed`);
      }
      if (open) try { controller.close(); } catch { /* already closed */ }
    },
  });

  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
