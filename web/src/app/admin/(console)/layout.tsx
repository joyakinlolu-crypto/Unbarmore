import Link from 'next/link';
import { requireAdmin } from '@/lib/admin';
import { endSessionAction } from './actions';

export const metadata = { title: { default: 'Admin', template: '%s · Admin' }, robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const tabs = [['/admin', 'Overview'], ['/admin/shops', 'Shops'], ['/admin/payouts', 'Payouts'], ['/admin/audit', 'Activity log']] as const;
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="sticky top-0 z-10 bg-slate-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3">
          <span className="font-bold">🔐 Unbarmore admin</span>
          <nav className="flex flex-1 gap-4 text-sm">{tabs.map(([h, l]) => <Link key={h} href={h} className="text-slate-300 hover:text-white">{l}</Link>)}</nav>
          <form action={endSessionAction}><button className="text-sm text-slate-400 hover:text-white">Log out</button></form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4">{children}</main>
    </div>
  );
}
