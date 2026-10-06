import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title with its buttons, the view tabs, the search and filters, then tasks. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-8 w-32" />
      <div className="flex gap-2">
        <Skeleton className="size-9" />
        <Skeleton className="h-9 w-28" />
      </div>
    </div>
    <div className="flex flex-wrap gap-1 border-b border-line pb-1">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-pill w-24" />
      ))}
    </div>
    <div className="flex flex-wrap gap-2">
      <Skeleton className="h-control w-full rounded-pill sm:w-[13.375rem]" />
      <Skeleton className="h-control w-24 rounded-pill" />
    </div>
    <SkeletonRows rows={12} />
  </div>
)

export default Loading
