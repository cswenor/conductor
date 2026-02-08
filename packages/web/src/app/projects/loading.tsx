import { Skeleton } from '@/components/ui';

export default function Loading() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-6 py-4">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-52 mt-2" />
      </div>
      <div className="flex-1 p-6">
        <div className="grid grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
