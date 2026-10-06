import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The heading, the search and owner filter, then the table. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <div className="flex gap-3">
      <Skeleton className="h-8 w-60" />
      <Skeleton className="h-8 w-28" />
    </div>
    <SkeletonRows rows={6} />
  </div>
)

export default Loading
