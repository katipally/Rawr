import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the search and Status filter beside Create automation, the rules,
 *  then the recent activity under them. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-44" />
    <Skeleton className="h-4 w-40" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex w-full items-center gap-3 @lg:w-auto">
        <Skeleton className="h-control w-full rounded-pill @lg:w-56" />
        <Skeleton className="h-5 w-16 shrink-0" />
      </div>
      <Skeleton className="h-8 w-36" />
    </div>
    <SkeletonRows rows={4} columns={5} />
    <Skeleton className="h-6 w-36" />
    <SkeletonRows rows={3} />
  </div>
)

export default Loading
