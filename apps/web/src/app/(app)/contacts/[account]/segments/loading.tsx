import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title and count, the type and object filters, the search, then the
 *  segments table. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-44" />
    <Skeleton className="h-4 w-24" />
    <div className="flex gap-3">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-5 w-24" />
    </div>
    <Skeleton className="h-control w-full rounded-pill @lg:w-56" />
    <SkeletonRows rows={8} columns={5} />
  </div>
)

export default Loading
