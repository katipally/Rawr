import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Home in outline: the greeting, the figures and two columns of cards. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <div className="flex flex-col gap-2 border-b border-line bg-surface px-6 py-4">
      <Skeleton className="h-6 w-64 max-w-full" />
      <Skeleton className="h-4 w-48 max-w-full" />
    </div>
    <div className="flex flex-col gap-2.5 px-2 pb-2 sm:px-4 sm:pb-4">
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-panel" />
        ))}
      </div>
      <div className="grid gap-2.5 @3xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-3">
            <Skeleton className="h-5 w-40 max-w-full" />
            <SkeletonRows rows={5} />
          </div>
        ))}
      </div>
    </div>
  </div>
)

export default Loading
