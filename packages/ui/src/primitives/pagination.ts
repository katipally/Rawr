/** What the pager says and which buttons it may offer. Pure so the wording, the
 *  arithmetic and the edge cases (no rows, a single row, an unknown total) are
 *  testable without a browser. */

export type PageRange = {
  /** "Showing 51-100 of 1,204" — or "No rows" when there are none. */
  label: string
  from: number
  to: number
  canPrevious: boolean
  canNext: boolean
}

export const pageRange = (input: {
  /** Rows on this page. The source of truth for the upper bound, because a keyset
   *  page can be short without being the last one. */
  count: number
  /** Zero-based offset of the first row on this page. */
  offset: number
  /** Total across all pages, when it is known. Keyset lists often do not know. */
  total?: number | undefined
  /** Whether the reader may go forward. A cursor list knows this from its cursor. */
  hasMore?: boolean | undefined
  noun?: string | undefined
  /** How a count is written, so the reader's grouping is used; plain digits when
   *  the caller does not know it. */
  format?: ((value: number) => string) | undefined
}): PageRange => {
  const { count, offset, total, hasMore, noun = 'rows', format: number = String } = input
  const from = count === 0 ? 0 : offset + 1
  const to = offset + count

  return {
    from,
    to,
    canPrevious: offset > 0,
    canNext: hasMore ?? (total === undefined ? count > 0 : to < total),
    label:
      count === 0
        ? `No ${noun}`
        : total === undefined
          ? `Showing ${number(from)}-${number(to)}`
          : `Showing ${number(from)}-${number(to)} of ${number(total)}`,
  }
}

/** The page buttons a numbered pager shows: the first and last page, the two on
 *  either side of the current one, and 'gap' where a run is skipped. A gap never
 *  hides a single page, since the page itself takes no more room than the dots.
 *  At most nine entries whatever `last` is. Pages count from one. */
export const pageNumbers = (current: number, last: number): (number | 'gap')[] => {
  if (last < 1) return []
  const at = Math.min(Math.max(1, current), last)
  const from = Math.max(1, at - 2)
  const to = Math.min(last, at + 2)
  const pages: (number | 'gap')[] = []
  if (from > 1) pages.push(1)
  if (from === 3) pages.push(2)
  else if (from > 3) pages.push('gap')
  for (let page = from; page <= to; page += 1) pages.push(page)
  if (to === last - 2) pages.push(last - 1)
  else if (to < last - 2) pages.push('gap')
  if (to < last) pages.push(last)
  return pages
}
