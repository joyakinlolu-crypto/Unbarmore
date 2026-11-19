'use client';
import { LogOut } from 'lucide-react';

export default function LogoutButton() {
  return (
    <button
      onClick={async () => {
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
