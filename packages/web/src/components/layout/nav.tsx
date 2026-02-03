'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { cn } from '@/lib/utils';
import {
  FolderKanban,
  Play,
  CheckCircle,
  Activity,
} from 'lucide-react';
import { UserMenu } from './user-menu';

const navigation = [
  { name: 'Projects', href: '/projects' as Route, icon: FolderKanban },
  { name: 'Runs', href: '/runs' as Route, icon: Play },
  { name: 'Approvals', href: '/approvals' as Route, icon: CheckCircle },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {navigation.map((item) => {
        const isActive = pathname.startsWith(item.href);
        return (
          <Link
            key={item.name}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.name}
          </Link>
        );
      })}
    </nav>
  );
}

export function NavHeader() {
  return (
    <Link
      href={'/' as Route}
      className="flex items-center gap-2 px-3 py-4 hover:opacity-80 transition-opacity"
    >
      <Activity className="h-6 w-6 text-primary" />
      <span className="text-lg font-semibold">Conductor Core</span>
    </Link>
  );
}

export function NavFooter() {
  return (
    <div className="mt-auto border-t pt-4">
      <UserMenu />
    </div>
  );
}
