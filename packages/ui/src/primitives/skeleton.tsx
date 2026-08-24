import { cn } from '../cn.ts'

export const Skeleton = ({ className }: { className?: string }) => (
  <span
    aria-hidden
    className={cn('block animate-pulse rounded-hs bg-fill-hover', 'h-4 w-full', className)}
  />
)

/** Matches the real row height so the page does not jump when data lands. */
export const SkeletonRows = ({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) => (
  <div role="status" aria-label="Loading" className="divide-y divide-divider">
    {Array.from({ length: rows }, (_, r) => (
      <div key={r} className="flex h-row items-center gap-3 px-3">
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} className={c === 0 ? 'w-1/3' : 'w-1/6'} />
        ))}
      </div>
    ))}
  </div>
)
