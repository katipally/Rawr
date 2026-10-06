'use client'

import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../cn.ts'
import { DropdownMenu } from './dropdown-menu.tsx'
import { pageNumbers, pageRange } from './pagination.ts'

const SIZES = [25, 50, 100]

export type PaginationProps = {
  count: number
  offset: number
  total?: number | undefined
  hasMore?: boolean | undefined
  perPage: number
  noun?: string | undefined
  /** How a count is written; see `pageRange`. */
  format?: ((value: number) => string) | undefined
  onPrevious: () => void
  onNext: () => void
  onPerPage?: ((size: number) => void) | undefined
  /** Given, with a total, for a list that can jump to any page: the count is
   *  replaced by numbered buttons. Pages count from one. */
  onPage?: ((page: number) => void) | undefined
  className?: string | undefined
}

/** Previous, next, and either a count or page numbers. A keyset list shows the
 *  count, since page seven has no address to jump to there and a control that
 *  pretended otherwise would lie; an offset list with a total shows numbers. */
export const Pagination = ({
  count,
  offset,
  total,
  hasMore,
  perPage,
  noun = 'rows',
  format,
  onPrevious,
  onNext,
  onPerPage,
  onPage,
  className,
}: PaginationProps) => {
  const range = pageRange({ count, offset, total, hasMore, noun, format })
  const current = Math.floor(offset / perPage) + 1
  const write = format ?? String
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
      {onPage && total !== undefined && total > 0 ? (
        <ol className="flex items-center gap-1">
          {pageNumbers(current, Math.ceil(total / perPage)).map((page, index) =>
            page === 'gap' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a gap has no identity but its place
              <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-secondary">
                …
              </li>
            ) : (
              <li key={page}>
                <button
                  type="button"
                  onClick={() => onPage(page)}
                  aria-current={page === current ? 'page' : undefined}
                  aria-label={page === current ? `You are on page ${write(page)}` : `Page ${write(page)}`}
                  className={cn(
                    'min-h-7 min-w-7 rounded-pill border border-transparent px-1.5 font-semibold tabular-nums transition-all duration-150 ease-out hover:bg-fill',
                    'aria-[current=page]:border-line-strong aria-[current=page]:bg-canvas',
                  )}
                >
                  {write(page)}
                </button>
              </li>
            ),
          )}
        </ol>
      ) : (
        // Polite, not assertive: the count changing is worth hearing after the
        // rows, not over the top of them.
        <p aria-live="polite" className="px-2 text-secondary">
          {range.label}
        </p>
      )}
      <button type="button" onClick={onNext} disabled={!range.canNext} className={face}>
        Next
        <ChevronRight aria-hidden="true" className="size-4" />
      </button>
      {onPerPage ? (
        <DropdownMenu
          label="Rows per page"
          side="top"
          groups={[
            {
              key: 'sizes',
              items: (SIZES.includes(perPage) ? SIZES : [...SIZES, perPage].sort((a, b) => a - b)).map((size) => ({
                key: String(size),
                label: `${size} per page`,
                checked: size === perPage,
                onSelect: () => onPerPage(size),
              })),
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className={cn(face, 'ml-2 px-3')}>
              {perPage} per page
              <ChevronDown aria-hidden="true" className="size-4" />
            </button>
          )}
        />
      ) : null}
    </nav>
  )
}
