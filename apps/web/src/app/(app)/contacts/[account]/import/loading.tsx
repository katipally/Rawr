import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The import list, with the upload card above it. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-9 w-full" />
    <SkeletonRows rows={6} />
  </div>
)

export default Loading
