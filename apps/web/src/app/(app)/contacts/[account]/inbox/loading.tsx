import { Skeleton, SkeletonRows } from '@rawr/ui'

/** The three panes: views and search, the thread list, the conversation. */
const Loading = () => (
  <div className="flex h-full min-h-0 flex-1">
    <div className="hidden w-inbox-nav shrink-0 flex-col gap-3 border-r border-line bg-surface p-4 md:flex">
      <Skeleton className="h-5 w-16" />
      <Skeleton className="h-control w-full rounded-pill" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-5 w-3/4" />
      ))}
    </div>
    <div className="flex w-full shrink-0 flex-col border-r border-line bg-surface md:w-[min(var(--spacing-inbox-list),40%)]">
      <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
        <Skeleton className="h-4 w-24" />
      </div>
      <SkeletonRows rows={10} columns={2} />
    </div>
    <div className="hidden min-w-0 flex-1 flex-col gap-3 bg-canvas p-6 md:flex">
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-40" />
    </div>
  </div>
)

export default Loading
