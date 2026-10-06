import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the search beside Create object, then one row per object. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-36" />
    <Skeleton className="h-4 w-80 max-w-full" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-control w-full rounded-pill @lg:w-56" />
      <Skeleton className="h-8 w-28" />
    </div>
    <SkeletonRows rows={4} />
  </div>
)

export default Loading
