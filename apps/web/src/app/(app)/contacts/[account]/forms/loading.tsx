import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title and its counts, the folder pills, then the forms table. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-4 w-64 max-w-full" />
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-pill w-24 rounded-pill" />
      ))}
    </div>
    <SkeletonRows rows={10} />
  </div>
)

export default Loading
