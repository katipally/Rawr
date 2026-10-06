import { Skeleton } from '@rawr/ui'

/** Every Meetings tab opens the same way: the title over its counts, the five
 *  tabs, then the tab's own content. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-48" />
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-28" />
      ))}
    </div>
    <Skeleton className="h-10 w-full" />
    <Skeleton className="h-80 w-full rounded-panel" />
  </div>
)

export default Loading
