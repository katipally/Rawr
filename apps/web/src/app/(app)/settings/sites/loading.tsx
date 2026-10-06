import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the hint beside Add site, the sites table, then what the
 *  collector refused. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-64 max-w-full" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-8 w-24" />
    </div>
    <SkeletonRows rows={3} columns={5} />
    <Skeleton className="h-6 w-56" />
    <Skeleton className="h-4 w-3/4" />
  </div>
)

export default Loading
