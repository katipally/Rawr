import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the two ways in side by side, then the imports table in its card. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-56" />
    <div className="grid gap-4 md:grid-cols-2">
      <Skeleton className="h-28 w-full rounded-panel" />
      <Skeleton className="h-28 w-full rounded-panel" />
    </div>
    <div className="flex flex-col gap-3 rounded-panel border border-line p-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-control w-full rounded-pill sm:w-56" />
      <SkeletonRows rows={6} />
    </div>
  </div>
)

export default Loading
