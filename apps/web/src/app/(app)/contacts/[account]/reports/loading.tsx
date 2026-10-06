import { Skeleton } from '@rawr/ui'

/** The title over its date range, the report tabs, then the open report. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-44" />
      </div>
      <Skeleton className="h-5 w-36" />
    </div>
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 10 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-24" />
      ))}
    </div>
    <Skeleton className="h-80 w-full rounded-panel" />
  </div>
)

export default Loading
