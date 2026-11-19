export default function Offline() {
  return (
    <main className="grid min-h-screen place-items-center bg-royal p-4 text-center">
      <div className="max-w-sm rounded-3xl bg-white p-8">
        <h1 className="text-xl font-bold text-ink">You're offline</h1>
        <p className="mt-2 text-slate-500">Your records are safe on WhatsApp. Reconnect and this page will refresh.</p>
      </div>
    </main>
  );
}
