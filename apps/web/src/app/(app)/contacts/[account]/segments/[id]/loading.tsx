import { Skeleton } from '@rawr/ui'

/** Back to segments, the name and its badges, then the filters card beside the
 *  figures and members. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-32" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-7 w-72 max-w-full" />
      <Skeleton className="h-9 w-40" />
    </div>
    <Skeleton className="h-4 w-48" />
    <div className="grid gap-4 @4xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
      <Skeleton className="h-40 w-full rounded-panel" />
      <Skeleton className="h-64 w-full rounded-panel" />
    </div>
  </div>
)

export default Loading
