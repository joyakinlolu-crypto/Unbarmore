import InstallBanner from '@/components/InstallBanner';
import Nav from '@/components/Nav';
import { requireSession } from '@/lib/auth';
import { botNumber } from '@/lib/whatsapp';
import { exitViewAs } from '@/app/admin/(console)/actions';

const TIER: Record<string, { label: string; cls: string }> = {
  trial: { label: 'Free trial', cls: 'bg-amber-100 text-amber-800' },
  free_limited: { label: 'Free plan', cls: 'bg-slate-100 text-slate-600' },
  starter_5k: { label: 'Starter', cls: 'bg-blue-100 text-royal' },
  growth_15k: { label: 'Growth', cls: 'bg-emerald-100 text-profit' },
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const { business } = session;
  const t = TIER[business.subscription_tier]!;
  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-20">
      {session.viewingAs && (
        <form action={exitViewAs.bind(null, business.id)} className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950">
          <span>👁 Admin view: this is {business.name} as its owner sees it. Read-only.</span>
          <button className="rounded-lg bg-amber-950 px-3 py-1 text-xs text-white">Exit</button>
        </form>
      )}
      <header className="sticky top-0 z-10 flex items-center justify-between bg-royal px-4 py-3 pt-[max(env(safe-area-inset-top),0.75rem)] text-white">
        <span className="truncate font-semibold">{business.name}</span>
        <span className="flex shrink-0 items-center gap-2">
          <a href={`https://wa.me/${botNumber()}?text=${encodeURIComponent('HELP')}`} target="_blank" rel="noopener"
            className="rounded-full bg-white/15 px-3 py-0.5 text-xs font-semibold text-white" aria-label="Get help on WhatsApp">Help</a>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${t.cls}`}>{t.label}</span>
        </span>
      </header>
      <InstallBanner />
      {children}
      <Nav />
    </div>
  );
}
