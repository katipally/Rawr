import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Tabs, a filter row, then submissions. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <div className="flex gap-2">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-8 w-24" />
    </div>
    <Skeleton className="h-9 w-full" />
    <SkeletonRows rows={12} />
  </div>
)

export default Loading
