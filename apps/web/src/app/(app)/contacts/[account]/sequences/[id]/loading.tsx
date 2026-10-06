import { Skeleton } from '@rawr/ui'

/** Back to sequences, the name and its state, the Steps, Enrollments and
 *  Emails sent tabs, then the tab's own content. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-32" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-9 w-40" />
    </div>
    <Skeleton className="h-4 w-24" />
    <div className="flex gap-1 border-b border-line">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-28" />
      ))}
    </div>
    <Skeleton className="h-64 w-full rounded-panel" />
  </div>
)

export default Loading
