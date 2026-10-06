import { Skeleton } from '@rawr/ui'

/** Back to imports, the file's name and object, who ran it, then its summary. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-28" />
    <Skeleton className="h-7 w-80 max-w-full" />
    <Skeleton className="h-4 w-24" />
    <Skeleton className="h-4 w-48" />
    <Skeleton className="h-32 w-full rounded-panel" />
  </div>
)

export default Loading
