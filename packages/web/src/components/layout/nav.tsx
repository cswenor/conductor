'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Rocket,
  Play,
  CheckCircle,
  FolderKanban,
  BarChart3,
  Settings,
  Activity,
} from 'lucide-react';
import { UserMenu } from './user-menu';
import { Badge, Separator } from '@/components/ui';
import { useApprovalsCount } from '@/hooks/use-approvals-count';

const mainNavigation = [
  { name: 'Dashboard', href: '/dashboard' as Route, icon: LayoutDashboard },
  { name: 'Start Work', href: '/start' as Route, icon: Rocket },
  { name: 'Work', href: '/work' as Route, icon: Play },
  { name: 'Approvals', href: '/approvals' as Route, icon: CheckCircle },
  { name: 'Projects', href: '/projects' as Route, icon: FolderKanban },
  { name: 'Analytics', href: '/analytics' as Route, icon: BarChart3 },
];

const settingsNavigation = [
  { name: 'Settings', href: '/settings' as Route, icon: Settings },
];

export function Nav() {
  const pathname = usePathname();
  const approvalsCount = useApprovalsCount();

  return (
    <nav className="flex flex-col gap-1">
      {mainNavigation.map((item) => {
        const isActive =
          item.href === '/dashboard'
            ? pathname === '/dashboard' || pathname === '/'
            : pathname.startsWith(item.href);
        const showBadge = item.name === 'Approvals' && approvalsCount > 0;
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
            {showBadge && (
              <Badge variant="destructive" className="ml-auto h-5 min-w-5 justify-center text-xs px-1">
                {approvalsCount}
              </Badge>
            )}
          </Link>
        );
      })}

      <Separator className="my-2" />

      {settingsNavigation.map((item) => {
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
      href={'/dashboard' as Route}
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
