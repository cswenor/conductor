'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, User, Loader2, Settings } from 'lucide-react';
import { Button } from '@/components/ui';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SessionUser {
  id: string;
  githubLogin: string;
  githubName: string | null;
  githubAvatarUrl: string | null;
}

export function UserMenu() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    async function fetchSession() {
      try {
        const response = await fetch('/api/auth/session');
        if (response.ok) {
          const data = await response.json() as { user: SessionUser | null };
          setUser(data.user);
        }
      } catch {
        // Ignore errors
      } finally {
        setLoading(false);
      }
    }

    void fetchSession();
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/session', { method: 'DELETE' });
      // Hard navigation to clear all client-side state and trigger middleware
      // (router.push does a soft navigation that preserves layout state)
      window.location.href = '/login';
    } catch {
      setLoggingOut(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-3 px-3 py-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => router.push('/login')}
      >
        <User className="h-4 w-4" />
        Sign in
      </Button>
    );
  }

  const displayName = user.githubName !== null && user.githubName !== '' ? user.githubName : user.githubLogin;
  const initials = displayName
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent transition-colors">
          <Avatar className="h-8 w-8">
            <AvatarImage src={user.githubAvatarUrl ?? undefined} alt={user.githubLogin} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 truncate">
            <div className="text-sm font-medium truncate">
              {displayName}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              @{user.githubLogin}
            </div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium">{displayName}</p>
            <p className="text-xs text-muted-foreground">@{user.githubLogin}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/settings')}>
          <Settings className="mr-2 h-4 w-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void handleLogout()}
          disabled={loggingOut}
          className="text-destructive focus:text-destructive"
        >
          {loggingOut ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="mr-2 h-4 w-4" />
          )}
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
