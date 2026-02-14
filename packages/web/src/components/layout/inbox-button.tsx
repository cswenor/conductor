'use client';

import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Bell } from 'lucide-react';
import { Button, Badge } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useInbox, categorizeItem, isUnread, type InboxItem } from '@/hooks/use-inbox';
import { timeAgo } from '@/lib/phase-config';
import { cn } from '@/lib/utils';

function EventList({
  items,
  cursor,
  onItemClick,
}: {
  items: InboxItem[];
  cursor: { lastSeenId: number; lastSeenTsMs: number };
  onItemClick: (item: InboxItem) => void;
}) {
  if (items.length === 0) {
    return (
      <DropdownMenuLabel className="text-sm font-normal text-muted-foreground">
        No recent activity
      </DropdownMenuLabel>
    );
  }

  return (
    <div className="max-h-72 overflow-y-auto">
      {items.map((item) => {
        const unread = isUnread(item, cursor);
        const hasNavTarget = item.event.runId !== undefined;
        return (
          <DropdownMenuItem
            key={item.dedupId}
            className="flex flex-col items-start gap-0.5 py-2"
            disabled={!hasNavTarget}
            onSelect={() => onItemClick(item)}
          >
            <span className={cn(
              'text-sm',
              unread ? 'font-medium' : 'text-muted-foreground',
            )}>
              {item.summary}
            </span>
            {item.taskTitle !== undefined && (
              <span className="text-xs text-muted-foreground truncate max-w-full">
                {item.taskTitle}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {item.projectName !== undefined
                ? `${item.projectName} · ${timeAgo(item.event.timestamp)}`
                : timeAgo(item.event.timestamp)}
            </span>
          </DropdownMenuItem>
        );
      })}
    </div>
  );
}

export function InboxButton() {
  const router = useRouter();
  const { items, unreadCount, loading, cursor, markAllRead, markRead } = useInbox();

  const messageItems = items.filter(i => categorizeItem(i) === 'messages').slice(0, 20);
  const toastItems = items.filter(i => categorizeItem(i) === 'toasts').slice(0, 20);

  function handleItemClick(item: InboxItem) {
    markRead(item);
    const e = item.event;
    if (e.runId !== undefined) {
      router.push(`/runs/${e.runId}` as Route);
    } else if (e.kind === 'project.updated') {
      router.push(`/projects/${e.projectId}` as Route);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80" side="right" align="start">
        <div className="flex items-center justify-between">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          {unreadCount > 0 && (
            <button
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={markAllRead}
            >
              Mark all as read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {loading && items.length === 0 ? (
          <DropdownMenuLabel className="text-sm font-normal text-muted-foreground">
            Loading...
          </DropdownMenuLabel>
        ) : (
          <Tabs defaultValue="messages" className="px-1 pb-1">
            <TabsList className="w-full">
              <TabsTrigger value="messages" className="flex-1 text-xs">
                Messages
                {messageItems.filter(i => isUnread(i, cursor)).length > 0 && (
                  <Badge variant="destructive" className="ml-1 h-4 min-w-4 justify-center px-1 text-[10px] leading-none">
                    {messageItems.filter(i => isUnread(i, cursor)).length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="toasts" className="flex-1 text-xs">
                Alerts
                {toastItems.filter(i => isUnread(i, cursor)).length > 0 && (
                  <Badge variant="destructive" className="ml-1 h-4 min-w-4 justify-center px-1 text-[10px] leading-none">
                    {toastItems.filter(i => isUnread(i, cursor)).length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="messages">
              <EventList items={messageItems} cursor={cursor} onItemClick={handleItemClick} />
            </TabsContent>
            <TabsContent value="toasts">
              <EventList items={toastItems} cursor={cursor} onItemClick={handleItemClick} />
            </TabsContent>
          </Tabs>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
