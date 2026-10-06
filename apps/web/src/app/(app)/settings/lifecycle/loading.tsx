import { Skeleton } from '@rawr/ui'

/** The title and its hint, then one draggable row per stage with its name in
 *  an input. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-48" />
    <Skeleton className="h-4 w-64 max-w-full" />
    <Skeleton className="h-4 w-3/4" />
    {Array.from({ length: 8 }, (_, index) => (
      <div key={index} className="flex items-center gap-3 border-b border-line py-2">
        <Skeleton className="size-4" />
        <Skeleton className="h-control w-full max-w-xl" />
      </div>
    ))}
  </div>
)

export default Loading
