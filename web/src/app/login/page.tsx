import LoginForm from '@/components/LoginForm';
import { botNumber } from '@/lib/whatsapp';

export const metadata = { title: 'Log in' };

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
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
      </div>
    </main>
  );
}
