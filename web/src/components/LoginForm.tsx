'use client';
import { useState } from 'react';
import { MessageCircle } from 'lucide-react';

export default function LoginForm({ bot, expired }: { bot: string; expired: boolean }) {
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('busy');
    try {
      const r = await fetch('/api/auth/request-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone }) });
      setState(r.ok ? 'sent' : 'error');
    } catch { setState('error'); }
  }

  const loginHref = `https://wa.me/${bot}?text=${encodeURIComponent('LOGIN')}`;
  return (
    <div className="space-y-4">
      {expired && <p className="rounded-xl bg-rose-50 p-3 text-sm text-alert">That link expired or was already used. Get a fresh one below.</p>}
      <a href={loginHref} className="flex items-center justify-center gap-2 rounded-xl bg-[#25D366] py-3.5 font-semibold text-white">
        <MessageCircle size={20} /> Get my login link on WhatsApp
      </a>
      <p className="text-center text-xs text-slate-400">Opens WhatsApp with “LOGIN” ready to send. The link arrives in seconds.</p>
      <div className="flex items-center gap-3 text-xs text-slate-300"><hr className="flex-1" />or<hr className="flex-1" /></div>
      <form onSubmit={submit} className="space-y-3">
        <label htmlFor="phone" className="block text-sm font-medium">Enter your registered WhatsApp number</label>
        <input id="phone" inputMode="tel" autoComplete="tel" placeholder="0801 234 5678" value={phone} onChange={(e) => setPhone(e.target.value)}
          className="w-full rounded-xl border border-slate-200 px-4 py-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" />
        <button disabled={state === 'busy' || phone.replace(/\D/g, '').length < 10}
          className="w-full rounded-xl bg-royal py-3.5 font-semibold text-white disabled:opacity-40">{state === 'busy' ? 'Sending…' : 'Send me a login link'}</button>
      </form>
      {state === 'sent' && (
        <p className="rounded-xl bg-blue-50 p-3 text-sm text-royal" role="status">
          If that number is registered, a link is on its way on WhatsApp. <b>No message?</b> Tap the green button above — it opens the free chat window and I’ll send it instantly.
        </p>
      )}
      {state === 'error' && <p className="text-sm text-alert" role="alert">Couldn’t send. Check the number and try again.</p>}
    </div>
  );
}
