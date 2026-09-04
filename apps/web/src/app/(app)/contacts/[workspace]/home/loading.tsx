import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The Monday screen's tiles and its two panels, in outline. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-8 w-40" />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <SkeletonRows rows={8} />
      <SkeletonRows rows={5} />
    </div>
  </div>
)

export default Loading
