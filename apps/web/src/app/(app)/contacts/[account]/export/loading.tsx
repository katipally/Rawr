import { Skeleton } from '@rawr/ui'

/** The export form and what it will write. */
const Loading = () => (
  <div className="flex max-w-2xl flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-4 w-3/4" />
    {Array.from({ length: 2 }, (_, index) => (
      <Skeleton key={index} className="h-24 w-full" />
    ))}
  </div>
)

export default Loading
