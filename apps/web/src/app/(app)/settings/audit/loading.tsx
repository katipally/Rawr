import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the Category and Modified by filters, then the history. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-4 w-64 max-w-full" />
    <div className="flex gap-3">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-5 w-24" />
    </div>
    <SkeletonRows rows={12} />
  </div>
)

export default Loading
