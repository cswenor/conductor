'use client';

import { Inbox } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-4 py-12', className)}>
      {icon ?? <Inbox className="h-12 w-12 text-muted-foreground" />}
      <div className="text-center">
        <h3 className="text-lg font-semibold">{title}</h3>
        {description !== undefined && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action !== undefined && (
        <Button onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  );
}
