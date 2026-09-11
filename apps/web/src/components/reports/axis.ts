/** Which labels a category axis can actually draw.
 *
 *  A 30-day range across a half-width card has room for about six dates and
 *  thirty slots, so every label drawn is a slot two characters wide: "A… A… S…"
 *  down the whole axis, which names nothing. Thinning is the answer rather than
 *  truncating, and the arithmetic is here so it can be exercised without a DOM. */

/** How wide one character of the small text runs. Lexend Deca at 0.75rem
 *  measures a shade over 6px across digits and capitals; 7 rounds it up so the
 *  estimate errs towards one label too few rather than one too many. */
const CHAR_PX = 7
/** Clear space either side of a label, so two of them never touch. */
const GAP_PX = 12
/** What is assumed before the row has been measured: a phone. Thinning too hard
 *  for one frame reads as a sparse axis; not thinning at all reads as the bug. */
const UNMEASURED_PX = 320

/** Draw every nth label, where n is the fewest that still fits the widest label
 *  in the space each drawn one gets. `width` is the row's measured pixel width,
 *  or 0 before it has been measured. */
export const tickStride = (count: number, longest: number, width: number): number => {
  if (count <= 1) return 1
  const per = Math.max(1, longest * CHAR_PX + GAP_PX)
  const fits = Math.max(1, Math.floor((width > 0 ? width : UNMEASURED_PX) / per))
  return Math.max(1, Math.ceil(count / fits))
}

/** The column numbers whose label is drawn: the first, the last, and every
 *  `stride`th in between. The last is the date a reader looks for, so a label
 *  that would crowd it is dropped instead. O(count / stride). */
export const visibleTicks = (count: number, stride: number): Set<number> => {
  if (count <= 0) return new Set()
  const kept = new Set<number>()
  for (let column = 0; column < count; column += stride) kept.add(column)
  const last = count - 1
  if (kept.size > 1) for (const column of kept) if (last - column < stride) kept.delete(column)
  kept.add(last)
  return kept
}
