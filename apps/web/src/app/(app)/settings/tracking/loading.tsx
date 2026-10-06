import { Skeleton } from '@rawr/ui'

/** The title, the Domain, Events and Campaigns tabs, then the open tab's
 *  headed sections split by a rule. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-7 w-36" />
    <Skeleton className="h-4 w-64 max-w-full" />
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-28" />
      ))}
    </div>
    {Array.from({ length: 3 }, (_, index) => (
      <div key={index} className="flex flex-col gap-2 border-b border-line pb-4 last:border-b-0">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-control w-full max-w-md" />
      </div>
    ))}
  </div>
)

export default Loading
