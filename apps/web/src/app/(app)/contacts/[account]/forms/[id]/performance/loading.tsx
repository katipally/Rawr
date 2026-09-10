import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Three tiles, then the charts and the two breakdowns under them. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-7 w-64" />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
    <SkeletonRows rows={6} />
  </div>
)

export default Loading
