import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Back to tasks, the title, the search beside Create task queue, then the queues. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-16" />
    <Skeleton className="h-8 w-40" />
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
      <Skeleton className="h-control w-full rounded-pill sm:w-56" />
      <Skeleton className="h-9 w-36" />
    </div>
    <SkeletonRows rows={4} columns={2} />
  </div>
)

export default Loading
