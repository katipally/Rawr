import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Back to Automations, the rule's name, the Status filter, then one row per
 *  record it ran on. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-36" />
    <Skeleton className="h-7 w-72 max-w-full" />
    <Skeleton className="h-4 w-56" />
    <Skeleton className="h-5 w-16" />
    <SkeletonRows rows={8} />
  </div>
)

export default Loading
