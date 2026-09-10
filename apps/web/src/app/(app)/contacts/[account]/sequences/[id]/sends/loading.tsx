import { Skeleton, SkeletonRows } from '@rawr/ui'

/** A crumb, a heading, the state filters, then one row per send. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-64" />
    <Skeleton className="h-7 w-72" />
    <div className="flex flex-wrap gap-2">
      <Skeleton className="h-8 w-28" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-8 w-24" />
    </div>
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
