import { Skeleton, SkeletonRows } from '@rawr/ui'

/** Shaped like the list it replaces: tabs, a toolbar, the summary figures, then
 *  rows. A spinner in the middle of the page moves the eye; this holds it where
 *  the table will be. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-48" />
    <div className="flex gap-2">
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-8 w-24" />
    </div>
    <Skeleton className="h-9 w-full" />
    <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
    <SkeletonRows rows={12} />
  </div>
)

export default Loading
