import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder shown while a signed-in page's data streams in. */
export function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-5 w-96 max-w-full" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
