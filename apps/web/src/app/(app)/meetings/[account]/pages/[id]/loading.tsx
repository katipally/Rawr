import { Skeleton } from '@rawr/ui'

/** Back to meetings, the link's name and actions, its three tabs, then the
 *  settings beside the preview. */
const Loading = () => (
  <div className="mx-auto flex w-full max-w-[80rem] min-w-0 flex-col gap-6">
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-32" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="flex gap-1 border-b border-line">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-32" />
        ))}
      </div>
    </div>
    <div className="grid min-w-0 gap-10 @4xl:grid-cols-[minmax(0,35rem)_minmax(0,1fr)]">
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-panel" />
    </div>
  </div>
)

export default Loading
