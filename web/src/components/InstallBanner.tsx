'use client';
import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';

interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
const KEY = 'unb_install_dismissed';

export default function InstallBanner() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try { if (localStorage.getItem(KEY)) return; } catch { /* storage blocked: still show */ }
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
    if (standalone) return;
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setIos(isIos);
    if (isIos) setHidden(false);
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent); setHidden(false); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const dismiss = () => { setHidden(true); try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };
  if (hidden) return null;

  return (
    <div className="mx-3 mt-3 flex items-center gap-3 rounded-2xl bg-accent p-3 text-white shadow-lg" role="region" aria-label="Install app">
      <Download size={20} className="shrink-0" />
      <p className="flex-1 text-sm leading-snug">
        {ios ? <>Tap <b>Share</b> then <b>Add to Home Screen</b> to open Unbarmore like an app.</> : <>Add Unbarmore to your Home Screen — opens instantly, even on weak network.</>}
      </p>
      {evt && <button onClick={async () => { await evt.prompt(); dismiss(); }} className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-royal">Add</button>}
      <button onClick={dismiss} aria-label="Dismiss" className="p-1"><X size={18} /></button>
    </div>
  );
}
