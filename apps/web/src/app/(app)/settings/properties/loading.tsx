import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the object picker, the Properties, Groups and Archived tabs, the
 *  filters, the search beside Create property, then the properties. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-96 max-w-full" />
    <Skeleton className="h-14 w-full rounded-panel" />
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-28" />
      ))}
    </div>
    <div className="flex gap-3">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-5 w-24" />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-control w-full rounded-pill sm:w-80" />
      <Skeleton className="h-8 w-32" />
    </div>
    <SkeletonRows rows={10} />
  </div>
)

export default Loading
