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
}): PageRange => {
  const { count, offset, total, hasMore, noun = 'rows' } = input
  const from = count === 0 ? 0 : offset + 1
  const to = offset + count
  const number = (value: number) => value.toLocaleString()

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
