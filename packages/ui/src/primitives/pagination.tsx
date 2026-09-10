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
    'inline-flex min-h-8 items-center gap-1 rounded-pill px-2 font-semibold hover:bg-fill disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent'

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-center gap-1 py-2', className)}
    >
      <button type="button" onClick={onPrevious} disabled={!range.canPrevious} className={face}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        Prev
      </button>
      {/* Polite, not assertive: the count changing is worth hearing after the
          rows, not over the top of them. */}
      <p aria-live="polite" className="px-2 text-secondary">
        {range.label}
      </p>
      <button type="button" onClick={onNext} disabled={!range.canNext} className={face}>
        Next
        <ChevronRight aria-hidden="true" className="size-4" />
      </button>
      {onPerPage ? (
        <label className="ml-2 flex items-center">
          <span className="sr-only">Rows per page</span>
          <select
            value={perPage}
            onChange={(event) => onPerPage(Number(event.target.value))}
            className="min-h-8 rounded-pill bg-transparent pl-3 font-semibold text-body hover:bg-fill"
          >
            {(SIZES.includes(perPage) ? SIZES : [...SIZES, perPage].sort((a, b) => a - b)).map((size) => (
              <option key={size} value={size}>
                {size} per page
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </nav>
  )
}
