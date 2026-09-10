import { Skeleton, SkeletonRows } from '@rawr/ui'

/** A pipeline and its stages. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
