import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The record page's own three columns, so nothing jumps sideways when the real
 *  panels arrive. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-10 w-72" />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_minmax(0,18rem)]">
      <SkeletonRows rows={8} />
      <SkeletonRows rows={10} />
      <SkeletonRows rows={6} />
    </div>
  </div>
)

export default Loading
