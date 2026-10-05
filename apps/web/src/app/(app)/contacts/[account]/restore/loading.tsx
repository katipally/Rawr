import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Tabs, the search, then one row per deleted record. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-8 w-full" />
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
