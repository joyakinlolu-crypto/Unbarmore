'use client';
import { LogOut } from 'lucide-react';

export default function LogoutButton() {
  return (
    <button
      onClick={async () => {
        // Stop this phone getting the previous owner's evening alerts (must happen while still logged in).
        try {
          const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
          if (sub) { await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
        } catch { /* no SW / no push */ }
        await fetch('/api/auth/logout', { method: 'POST' });
        // Wipe cached pages so financial data doesn't linger on a shared phone.
        try { await Promise.all((await caches.keys()).filter((k) => k === 'pages').map((k) => caches.delete(k))); } catch { /* no SW */ }
        window.location.href = '/login';
      }}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 py-3 text-sm font-medium text-slate-600">
      <LogOut size={16} /> Log out of this device
    </button>
  );
}
