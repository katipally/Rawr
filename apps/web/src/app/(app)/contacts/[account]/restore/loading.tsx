import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The breadcrumb and title, the object tabs, the search, then one row per
 *  deleted record. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-40" />
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-4 w-80 max-w-full" />
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-24" />
      ))}
    </div>
    <Skeleton className="h-control w-full rounded-pill @lg:w-56" />
    <SkeletonRows rows={8} columns={3} />
  </div>
)

export default Loading
