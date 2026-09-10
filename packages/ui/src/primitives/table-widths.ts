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
