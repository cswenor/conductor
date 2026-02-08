import { Skeleton } from '@/components/ui';

export default function Loading() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-6 py-4">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-56 mt-2" />
      </div>
      <div className="border-b px-6">
        <div className="flex gap-4 py-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-md" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-6 space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
