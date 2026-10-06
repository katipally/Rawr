import { Skeleton } from '@rawr/ui'

/** The title, the three app tabs, then the outgoing webhooks and the unclaimed
 *  events, each in its own card. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-80 max-w-full" />
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-32" />
      ))}
    </div>
    <Skeleton className="h-44 w-full rounded-panel" />
    <Skeleton className="h-44 w-full rounded-panel" />
  </div>
)

export default Loading
