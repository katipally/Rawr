import { Skeleton } from '@rawr/ui'

/** The title, then Brevo, the audience push and the campaigns stacked. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-56" />
    <Skeleton className="h-4 w-72 max-w-full" />
    <Skeleton className="h-28 w-full" />
    <Skeleton className="h-44 w-full" />
    <Skeleton className="h-28 w-full" />
  </div>
)

export default Loading
