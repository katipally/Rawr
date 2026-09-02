import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Shown the instant a link is clicked, while the page's reads run. The shell
 *  stays put and only the content swaps, which is what makes a tab change feel
 *  immediate rather than three seconds of nothing. */
const Loading = () => (
  <div className="flex flex-col gap-4" aria-busy="true">
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
    <div className="rounded-panel border border-line bg-surface">
      <SkeletonRows rows={8} columns={5} />
    </div>
  </div>
)

export default Loading
