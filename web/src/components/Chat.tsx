'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Send } from 'lucide-react';
import { Md } from './Md';

export interface Msg { id: string; role: 'user' | 'assistant'; content: string }
const CHIPS = [
  'Where am I leaking money this month?',
  'How should I re-price my top products against inflation?',
  'Give me a 7-day WhatsApp Status promo plan to clear slow stock',
  'Draft a polite payment reminder for my biggest debtor',
];

export default function Chat({ initial, tier, bot, freeLeft }: { initial: Msg[]; tier: string; bot: string; freeLeft: number | null }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'limit' | 'slow' | 'fail' | null>(null);
  const [left, setLeft] = useState(freeLeft);
  const [copied, setCopied] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setNotice(null); setBusy(true); setInput('');
    const uid = crypto.randomUUID(), aid = crypto.randomUUID();
    setMsgs((m) => [...m, { id: uid, role: 'user', content: message }, { id: aid, role: 'assistant', content: '' }]);
    const rollback = () => setMsgs((m) => m.filter((x) => x.id !== uid && x.id !== aid));
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      if (res.status === 402) { rollback(); setNotice('limit'); setLeft(0); return; }
      if (res.status === 429) { rollback(); setInput(message); setNotice('slow'); return; }
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok || !res.body) { rollback(); setInput(message); setNotice('fail'); return; }

      const reader = res.body.getReader(); const dec = new TextDecoder(); let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        const bad = acc.indexOf('\u0000ERR:');
        const shown = bad >= 0 ? acc.slice(0, bad) : acc;
        setMsgs((m) => m.map((x) => (x.id === aid ? { ...x, content: shown } : x)));
        if (bad >= 0) { rollback(); setInput(message); setNotice('fail'); return; }
      }
      if (left !== null) setLeft(Math.max(0, left - 1));
    } catch { rollback(); setInput(message); setNotice('fail'); }
    finally { setBusy(false); }
  }

  const copy = async (id: string, t: string) => {
    try { await navigator.clipboard.writeText(t); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch { /* blocked */ }
  };

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {msgs.length === 0 && (
          <div className="space-y-3 pt-2">
            <p className="text-center text-sm text-slate-500">Ask me anything about your money. I can see your last 30 days.</p>
            <div className="flex flex-col gap-2">
              {CHIPS.map((c) => (
                <button key={c} onClick={() => send(c)} className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-left text-sm font-medium text-royal active:bg-blue-100">{c}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${m.role === 'user' ? 'bg-royal text-white' : 'bg-mist text-ink'}`}>
              {m.role === 'user' ? m.content : m.content ? <Md text={m.content} /> : <span className="animate-pulse text-slate-400">Checking your numbers…</span>}
              {m.role === 'assistant' && m.content && !busy && (
                <div className="mt-2 flex gap-3 border-t border-slate-200 pt-2 text-xs text-slate-500">
                  <button onClick={() => copy(m.id, m.content)} className="flex items-center gap-1">{copied === m.id ? <Check size={14} /> : <Copy size={14} />}{copied === m.id ? 'Copied' : 'Copy'}</button>
                  <a href={`https://wa.me/?text=${encodeURIComponent(m.content.replace(/\*\*/g, '*'))}`} className="flex items-center gap-1" target="_blank" rel="noopener">Send on WhatsApp</a>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>

      {notice === 'limit' && (
        <div className="mx-3 mb-2 rounded-2xl bg-royal p-4 text-white">
          <p className="font-semibold">You’ve used your 10 free advisor chats this month.</p>
          <p className="mt-1 text-sm text-blue-100">Starter (₦5,000/mo) gives you unlimited coaching — one saved debt pays for it.</p>
          <a href={`https://wa.me/${bot}?text=${encodeURIComponent('PLANS')}`} className="mt-3 block rounded-xl bg-white py-2.5 text-center font-semibold text-royal">See plans on WhatsApp</a>
        </div>
      )}
      {notice === 'slow' && <p className="px-4 pb-1 text-xs text-alert">Slow down a little — try again in a minute.</p>}
      {notice === 'fail' && <p className="px-4 pb-1 text-xs text-alert" role="alert">Couldn’t get an answer. Your message wasn’t counted — please retry.</p>}
      {left !== null && left > 0 && left <= 5 && <p className="px-4 pb-1 text-xs text-slate-400">{left} free {left === 1 ? 'chat' : 'chats'} left this month ({tier === 'trial' ? 'trial' : 'free plan'})</p>}

      <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex items-end gap-2 border-t border-slate-100 bg-white px-3 py-2">
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} maxLength={2000} placeholder="Ask your advisor…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
          className="max-h-28 min-h-11 flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-2.5 text-base outline-none focus:border-accent" />
        <button disabled={busy || !input.trim()} aria-label="Send" className="grid h-11 w-11 place-items-center rounded-full bg-accent text-white disabled:opacity-40"><Send size={18} /></button>
      </form>
    </div>
  );
}
