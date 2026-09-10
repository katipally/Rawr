import { Skeleton, SkeletonRows } from '@rawr/ui'

/** One row per tracked site. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <SkeletonRows rows={4} />
  </div>
)

export default Loading
