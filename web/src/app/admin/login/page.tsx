export const metadata = { title: 'Admin login', robots: { index: false, follow: false } };

export default function AdminLogin() {
  return (
    <main className="grid min-h-dvh place-items-center bg-slate-900 p-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-xl">
        <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-slate-900 text-2xl text-white">🔐</div>
        <h1 className="text-xl font-bold">Admin console</h1>
        <p className="mt-2 text-sm text-slate-500">There is no password. Open WhatsApp on the admin phone and send this to the Unbarmore number:</p>
        <p className="mt-3 rounded-xl bg-slate-100 py-3 font-mono text-lg font-bold">ADMIN LINK</p>
        <p className="mt-3 text-xs text-slate-400">You get a single-use link that works for 10 minutes.</p>
      </div>
    </main>
  );
}
