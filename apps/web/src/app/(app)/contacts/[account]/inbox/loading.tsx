import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The thread list beside the conversation. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <SkeletonRows rows={10} columns={2} />
      <SkeletonRows rows={6} columns={1} />
    </div>
  </div>
)

export default Loading
