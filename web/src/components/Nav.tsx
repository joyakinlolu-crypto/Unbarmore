'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, BookOpen, LayoutDashboard, MessageCircle, Settings } from 'lucide-react';

const TABS = [
  { href: '/dashboard', label: 'Overview', Icon: LayoutDashboard },
  { href: '/charts', label: 'Charts', Icon: BarChart3 },
  { href: '/advisor', label: 'Advisor', Icon: MessageCircle },
  { href: '/ledger', label: 'Money', Icon: BookOpen },
  { href: '/settings', label: 'Settings', Icon: Settings },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur" aria-label="Main">
      <ul className="mx-auto grid max-w-2xl grid-cols-5">
        {TABS.map(({ href, label, Icon }) => {
          const on = path.startsWith(href);
          return (
            <li key={href}>
              <Link href={href} prefetch aria-current={on ? 'page' : undefined}
                className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${on ? 'text-royal' : 'text-slate-400'}`}>
                <Icon size={22} strokeWidth={on ? 2.5 : 2} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
