import { Skeleton, SkeletonRows, cn } from '@rawr/ui'
import { RECORD_COLUMNS } from '~/lib/record-layout.ts'

/** The record page's own three columns, so nothing jumps sideways when the real
 *  panels arrive. */
const Loading = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-10 w-72" />
    <div className={cn('grid gap-4', RECORD_COLUMNS)}>
      <SkeletonRows rows={8} />
      <SkeletonRows rows={10} />
      <SkeletonRows rows={6} />
    </div>
  </div>
)

export default Loading
