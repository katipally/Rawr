/** The column widths a browser remembers between visits.
 *
 *  Split out of the table so the part a reload depends on can be exercised
 *  without a DOM: what was stored, what the caller asked for and what is finally
 *  rendered are three different numbers, and only the last one is visible. */

/** Narrower than this is a column nobody can grab the handle of again. */
export const MIN_WIDTH = 64

/** What a column with no opinion asks for. */
export const DEFAULT_WIDTH = 180

export const widthsKey = (storageKey: string): string => `rawr.widths.${storageKey}`

/** Anything a hand-edited, half-written or older entry can hold is dropped
 *  rather than rendered. A column sized `null` or `NaN` collapses to nothing and
 *  takes its own resize handle off the screen with it. */
export const parseWidths = (raw: string | null): Record<string, number> => {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const widths: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'number' && Number.isFinite(value)) widths[key] = Math.max(MIN_WIDTH, value)
  }
  return widths
}

/** What a remembered width beats: the width the caller asked for, and failing
 *  that the default. This is the whole of "a resize outlives a reload". */
export const widthFor = (
  widths: Record<string, number>,
  column: { key: string; width?: number },
): number => widths[column.key] ?? column.width ?? DEFAULT_WIDTH

/** The widths a table actually renders, given how wide its box is.
 *
 *  A column the reader has dragged keeps exactly the width it was dragged to.
 *  Every other column shares what is left in proportion to the width it asked
 *  for, never going under MIN_WIDTH, so the default table ends on the edge of
 *  its box rather than off the side of it. The result overflows only when the
 *  dragged widths plus the minimums cannot fit, which is when a scrollbar is the
 *  honest answer. O(n) in the number of columns, twice over.
 *
 *  `available` is the box's content width, or 0 before it has been measured, in
 *  which case the asked-for widths are returned unchanged. */
export const layoutWidths = (
  widths: Record<string, number>,
  columns: readonly { key: string; width?: number }[],
  available: number,
): number[] => {
  const sized = columns.map((column) => ({
    width: widthFor(widths, column),
    dragged: widths[column.key] !== undefined,
  }))
  const asked = sized.map((column) => column.width)
  if (!Number.isFinite(available) || available <= 0) return asked

  let dragged = 0
  let flexible = 0
  for (const column of sized) {
    if (column.dragged) dragged += column.width
    else flexible += column.width
  }
  if (flexible === 0) return asked

  const share = available - dragged
  const scale = share / flexible
  let used = 0
  let last = -1
  const out = sized.map((column, index) => {
    if (column.dragged) return column.width
    const width = Math.max(MIN_WIDTH, Math.floor(column.width * scale))
    used += width
    last = index
    return width
  })
  // Flooring leaves up to a pixel per column on the table; handing the remainder
  // to the last flexible column is what makes the row end on the box edge exactly.
  const tail = out[last]
  if (tail !== undefined && used < share) out[last] = tail + (share - used)
  return out
}
