import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the search beside the count and Create pipeline, then one row per
 *  pipeline. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-36" />
    <Skeleton className="h-4 w-80 max-w-full" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-control w-full rounded-pill sm:w-56" />
      <Skeleton className="h-8 w-44" />
    </div>
    <SkeletonRows rows={3} columns={3} />
  </div>
)

export default Loading
