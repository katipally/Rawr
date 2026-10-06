import { Skeleton } from '@rawr/ui'

/** The title, then the export card centred under it with its fields. */
const Loading = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-7 w-40" />
    <Skeleton className="h-4 w-80 max-w-full" />
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col gap-5 rounded-panel border border-line p-6">
      <Skeleton className="h-6 w-48" />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
      <Skeleton className="h-9 w-24" />
    </div>
  </div>
)

export default Loading
