'use client';
import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';

const KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
type State = 'loading' | 'hidden' | 'idle' | 'on' | 'denied' | 'busy';

/** base64url public key → bytes, the format pushManager.subscribe wants */
function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

class Friendly extends Error {}
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const ready = () => withTimeout(navigator.serviceWorker.ready, 5000);

/**
 * "Turn on the evening money alert." The app's own way to reach the owner every day, free,
 * even after they stop chatting on WhatsApp. Renders nothing where push can't work.
 */
export default function PushPrompt({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<State>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      if (!KEY || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setState('hidden');
      if (Notification.permission === 'denied') return setState('denied');
      try {
        const sub = await (await ready()).pushManager.getSubscription();
        setState(sub && Notification.permission === 'granted' ? 'on' : 'idle');
      } catch { setState('hidden'); }
    })();
  }, []);

  async function turnOn() {
    setErr(''); setState('busy');
    try {
      if ((await Notification.requestPermission()) !== 'granted') return setState(Notification.permission === 'denied' ? 'denied' : 'idle');
      const reg = await ready();
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(KEY!) }));
      const res = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
      if (!res.ok) { await sub.unsubscribe().catch(() => false); throw new Friendly(res.status === 503 ? 'Alerts are being set up. Try again tomorrow.' : 'Could not save. Check your network and try again.'); }
      setState('on');
    } catch (e) { setErr(e instanceof Friendly ? e.message : 'Could not turn on alerts on this phone. Check your network and try again.'); setState('idle'); }
  }

  async function turnOff() {
    setState('busy');
    try {
      const sub = await (await ready()).pushManager.getSubscription();
      if (sub) { await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
    } catch { /* fall through: worst case the next send cleans the dead device */ }
    setState('idle');
  }

  if (state === 'loading' || state === 'hidden') return null;

  if (state === 'on') return compact ? (
    <div className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2"><Bell size={16} className="text-profit" /> Evening money alert is on</span>
      <button onClick={turnOff} className="text-xs text-slate-500 underline">Turn off</button></div>
  ) : null;

  if (state === 'denied') return compact ? (
    <p className="flex items-center gap-2 text-sm text-slate-500"><BellOff size={16} /> Alerts are blocked. Allow notifications for this site in your browser settings.</p>
  ) : null;

  return (
    <section className={compact ? '' : 'rounded-3xl border border-royal/20 bg-blue-50 p-4'} aria-label="Evening money alert">
      {!compact && <p className="font-semibold text-royal">Never lose track of your money</p>}
      <p className="mt-1 text-sm text-slate-600">Get one note every evening: what came in, what you spent, and who still owes you. Works even when you forget to open WhatsApp.</p>
      <button onClick={turnOn} disabled={state === 'busy'} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-royal py-3 font-semibold text-white disabled:opacity-60">
        <Bell size={16} /> {state === 'busy' ? 'Turning on…' : 'Turn on my evening alert'}
      </button>
      {err && <p role="alert" className="mt-2 text-sm text-alert">{err}</p>}
    </section>
  );
}
