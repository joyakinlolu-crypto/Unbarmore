import { redirect } from 'next/navigation';
import LoginForm from '@/components/LoginForm';
import { getSession } from '@/lib/auth';
import { botNumber } from '@/lib/whatsapp';

export const metadata = { title: 'Log in' };

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSession()) redirect('/dashboard'); // truly logged in (DB-verified), not just a well-formed cookie
  const { error } = await searchParams;
  return (
    <main className="grid min-h-dvh place-items-center bg-royal p-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-royal text-2xl font-bold text-white">U</div>
          <h1 className="text-xl font-bold">Unbarmore</h1>
          <p className="text-sm text-slate-500">Your business co-pilot — no password needed</p>
        </div>
        <LoginForm bot={botNumber()} expired={error === 'expired'} />
        <p className="mt-5 text-center text-xs text-slate-400">
          By continuing you agree to our <a href="/terms" className="underline">Terms</a> and <a href="/privacy" className="underline">Privacy Policy</a>.
        </p>
      </div>
    </main>
  );
}
