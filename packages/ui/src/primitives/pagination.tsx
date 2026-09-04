'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../cn.ts'
import { pageRange } from './pagination.ts'

const SIZES = [25, 50, 100]

export type PaginationProps = {
  count: number
  offset: number
  total?: number | undefined
  hasMore?: boolean | undefined
  perPage: number
  noun?: string | undefined
  onPrevious: () => void
  onNext: () => void
  onPerPage?: ((size: number) => void) | undefined
  className?: string | undefined
}

/** Previous, next, and a count. No page numbers: these lists are keyset paged, so
 *  page seven has no address to jump to, and a control that pretends otherwise
 *  would lie. */
export const Pagination = ({
  count,
  offset,
  total,
  hasMore,
  perPage,
  noun = 'rows',
  onPrevious,
  onNext,
  onPerPage,
  className,
}: PaginationProps) => {
  const range = pageRange({ count, offset, total, hasMore, noun })
  const face =
    'inline-flex min-h-8 items-center gap-1 rounded-hs border border-line px-2 font-medium hover:bg-fill-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-secondary'

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3 py-2', className)}
    >
      {/* Polite, not assertive: the count changing is worth hearing after the
          rows, not over the top of them. */}
      <p aria-live="polite" className="text-secondary">
        {range.label}
      </p>
      <div className="flex items-center gap-2">
        {onPerPage ? (
          <label className="flex items-center gap-1.5 text-secondary">
            <span>Per page</span>
            <select
              value={perPage}
              onChange={(event) => onPerPage(Number(event.target.value))}
              className="min-h-8 rounded-hs border border-line bg-surface pl-2 text-body"
            >
              {SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" onClick={onPrevious} disabled={!range.canPrevious} className={face}>
          <ChevronLeft aria-hidden="true" className="size-4" />
          Previous
        </button>
        <button type="button" onClick={onNext} disabled={!range.canNext} className={face}>
          Next
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </nav>
  )
}
