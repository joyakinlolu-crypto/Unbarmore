import Link from 'next/link';
import type { ReactNode } from 'react';
import { LEGAL, REG_ID } from '@/lib/legal';

export function LegalPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 text-[15px] leading-relaxed text-ink">
      <nav className="mb-6 flex items-center justify-between text-sm">
        <Link href="/login" className="flex items-center gap-2 font-bold text-royal">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-royal text-white">U</span> {LEGAL.product}
        </Link>
        <span className="flex gap-4 text-slate-500">
          <Link href="/privacy" className="underline">Privacy</Link>
          <Link href="/terms" className="underline">Terms</Link>
        </span>
      </nav>
      <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-slate-500">Effective {LEGAL.effective}</p>
      <p className="mt-4 rounded-2xl bg-mist p-4 text-sm">{intro}</p>
      <div className="mt-6 space-y-6">{children}</div>
      <footer className="mt-10 border-t border-slate-100 pt-4 text-xs text-slate-500">
        {LEGAL.company}{REG_ID ? ` · ${REG_ID}` : ''}{LEGAL.address ? ` · ${LEGAL.address}` : ''} · <a className="underline" href={`mailto:${LEGAL.email}`}>{LEGAL.email}</a>
      </footer>
    </main>
  );
}

export const H = ({ n, children }: { n: number; children: ReactNode }) => <h2 id={`s${n}`} className="mt-2 text-lg font-bold text-royal">{n}. {children}</h2>;
export const P = ({ children }: { children: ReactNode }) => <p className="mt-2">{children}</p>;
export const UL = ({ children }: { children: ReactNode }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>;
