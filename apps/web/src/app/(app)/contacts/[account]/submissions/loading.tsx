import { Skeleton } from '@rawr/ui'

/** The title and count, the four review tabs, then one card per submission. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-4 w-28" />
    <div className="flex flex-wrap gap-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-9 w-28" />
      ))}
    </div>
    {Array.from({ length: 3 }, (_, index) => (
      <Skeleton key={index} className="h-36 w-full rounded-panel" />
    ))}
  </div>
)

export default Loading
