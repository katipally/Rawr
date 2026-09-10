import { Skeleton } from '@rawr/ui'

/** One card per template. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <div className="grid gap-3 lg:grid-cols-2">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-28 w-full" />
      ))}
    </div>
  </div>
)

export default Loading
