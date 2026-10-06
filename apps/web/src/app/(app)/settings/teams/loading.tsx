import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the Users and Teams tabs, then the search beside Create team over
 *  one row per team. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-48" />
    <div className="flex gap-1">
      <Skeleton className="h-10 w-20" />
      <Skeleton className="h-10 w-20" />
    </div>
    <Skeleton className="h-4 w-80 max-w-full" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-control w-full rounded-pill @lg:w-56" />
      <Skeleton className="h-8 w-28" />
    </div>
    <SkeletonRows rows={5} />
  </div>
)

export default Loading
