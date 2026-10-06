import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the two subscription tabs, the search and Choice filter, then one
 *  row per recorded choice. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-44" />
    <div className="flex gap-1">
      <Skeleton className="h-10 w-36" />
      <Skeleton className="h-10 w-36" />
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <Skeleton className="h-control w-full rounded-pill @lg:w-56" />
      <Skeleton className="h-5 w-16" />
    </div>
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
