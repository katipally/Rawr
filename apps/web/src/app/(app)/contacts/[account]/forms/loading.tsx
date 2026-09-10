import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The forms table, with its header above it. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-9 w-full" />
    <SkeletonRows rows={10} />
  </div>
)

export default Loading
