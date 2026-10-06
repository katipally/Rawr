import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the Users and Teams tabs, the state switch, the search, then the
 *  user table. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-48" />
    <div className="flex gap-1">
      <Skeleton className="h-10 w-20" />
      <Skeleton className="h-10 w-20" />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-4 w-72 max-w-full" />
      <Skeleton className="h-8 w-24" />
    </div>
    <Skeleton className="h-8 w-full" />
    <Skeleton className="h-control w-full rounded-pill @lg:w-80" />
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
