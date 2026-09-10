import { Skeleton, SkeletonRows } from '@rawr/ui'

/** A filter row, then one card per sequence. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <div className="flex gap-2">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-8 w-24" />
    </div>
    <SkeletonRows rows={6} />
  </div>
)

export default Loading
