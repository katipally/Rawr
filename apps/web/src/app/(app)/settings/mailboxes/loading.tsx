import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, Connected emails with its connect buttons over the mailboxes,
 *  then the senders never read. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-72 max-w-full" />
    <Skeleton className="h-6 w-44" />
    <div className="flex flex-wrap gap-2">
      <Skeleton className="h-8 w-32 rounded-pill" />
      <Skeleton className="h-8 w-48 rounded-pill" />
    </div>
    <Skeleton className="h-32 w-full rounded-panel" />
    <Skeleton className="h-6 w-44" />
    <Skeleton className="h-4 w-3/4" />
    <SkeletonRows rows={3} columns={2} />
  </div>
)

export default Loading
