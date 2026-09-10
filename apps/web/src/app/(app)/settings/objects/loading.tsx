import { Skeleton, SkeletonRows } from '@rawr/ui'

/** One row per object in the account. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <SkeletonRows rows={6} />
  </div>
)

export default Loading
