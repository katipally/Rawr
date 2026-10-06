import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The title, the Subscription Types and Consent Records tabs, the hint beside
 *  Create subscription type, then one row per type. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-44" />
    <div className="flex gap-1">
      <Skeleton className="h-10 w-36" />
      <Skeleton className="h-10 w-36" />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-8 w-44" />
    </div>
    <SkeletonRows rows={5} columns={5} />
  </div>
)

export default Loading
