import { Skeleton } from '@/components/ui';

export default function Loading() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-6 py-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72 mt-2" />
      </div>
      <div className="border-b px-6">
        <div className="flex gap-4 py-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28 rounded-md" />
          ))}
        </div>
      </div>
      <div className="flex-1 p-6 space-y-6">
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    </div>
  );
}
