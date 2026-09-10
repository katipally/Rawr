import { Skeleton, SkeletonRows } from '@rawr/ui'

/** One card per team. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <SkeletonRows rows={5} />
  </div>
)

export default Loading
