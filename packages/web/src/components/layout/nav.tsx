'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { cn } from '@/lib/utils';
import {
  FolderKanban,
  Play,
  CheckCircle,
  Settings,
  Activity,
} from 'lucide-react';

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
    <div className="flex items-center gap-2 px-3 py-4">
      <Activity className="h-6 w-6 text-primary" />
      <span className="text-lg font-semibold">Conductor</span>
    </div>
  );
}

export function NavFooter() {
  return (
    <div className="mt-auto border-t pt-4">
      <Link
        href={'/settings' as Route}
        className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Settings className="h-4 w-4" />
        Settings
      </Link>
    </div>
  );
}
