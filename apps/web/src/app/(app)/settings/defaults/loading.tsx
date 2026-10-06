import { Skeleton } from '@rawr/ui'

/** The title, the General, User Defaults and Currency tabs, then the open
 *  tab's labelled fields. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-7 w-48" />
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-28" />
      ))}
    </div>
    <Skeleton className="h-4 w-64 max-w-full" />
    {Array.from({ length: 4 }, (_, index) => (
      <div key={index} className="flex max-w-md flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-control w-full" />
      </div>
    ))}
  </div>
)

export default Loading
