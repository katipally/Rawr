import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The filter row, then the history. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-9 w-full" />
    <SkeletonRows rows={12} />
  </div>
)

export default Loading
