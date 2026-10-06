import { Skeleton } from '@rawr/ui'

/** The title, the Profile, Email & Calendar and Security tabs, then the
 *  headed sections of the open one. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-7 w-40" />
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-32" />
      ))}
    </div>
    {Array.from({ length: 3 }, (_, index) => (
      <div key={index} className="flex flex-col gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    ))}
  </div>
)

export default Loading
