import { Skeleton, SkeletonRows } from '@rawr/ui'

/** A heading, then one row per recorded choice. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-7 w-52" />
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
