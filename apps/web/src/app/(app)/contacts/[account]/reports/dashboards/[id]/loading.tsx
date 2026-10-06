import { Skeleton } from '@rawr/ui'

/** The dashboard's name beside its buttons, the date range, then its cards. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-8 w-56" />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
    <Skeleton className="h-5 w-36" />
    <div className="grid min-w-0 gap-2.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-56 w-full rounded-panel" />
      ))}
    </div>
  </div>
)

export default Loading
