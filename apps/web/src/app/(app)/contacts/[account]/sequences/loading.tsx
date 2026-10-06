import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The state tabs, the search, then the table. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-4 w-64 max-w-full" />
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-8 w-24" />
      ))}
    </div>
    <Skeleton className="h-8 w-60" />
    <SkeletonRows rows={6} />
  </div>
)

export default Loading
