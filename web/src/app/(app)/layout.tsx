import InstallBanner from '@/components/InstallBanner';
import Nav from '@/components/Nav';
import { requireSession } from '@/lib/auth';

const TIER: Record<string, { label: string; cls: string }> = {
  trial: { label: 'Free trial', cls: 'bg-amber-100 text-amber-800' },
  free_limited: { label: 'Free plan', cls: 'bg-slate-100 text-slate-600' },
  starter_5k: { label: 'Starter', cls: 'bg-blue-100 text-royal' },
  growth_15k: { label: 'Growth', cls: 'bg-emerald-100 text-profit' },
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { business } = await requireSession();
  const t = TIER[business.subscription_tier]!;
  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-20">
      <header className="sticky top-0 z-10 flex items-center justify-between bg-royal px-4 py-3 pt-[max(env(safe-area-inset-top),0.75rem)] text-white">
        <span className="truncate font-semibold">{business.name}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${t.cls}`}>{t.label}</span>
      </header>
      <InstallBanner />
      {children}
      <Nav />
    </div>
  );
}
