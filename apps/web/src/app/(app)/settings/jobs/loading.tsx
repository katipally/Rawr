import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the search over job and error, then the jobs that could not be
 *  delivered. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-96 max-w-full" />
    <Skeleton className="h-control w-full rounded-pill @lg:w-56" />
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
