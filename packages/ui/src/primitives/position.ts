/** Where an anchored layer goes. Pure arithmetic over rectangles so the flyout,
 *  the tooltip, the menu and the popover share one set of rules and one test,
 *  rather than each re-deriving "flip when it would fall off the bottom". */

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'
export type Box = { top: number; left: number; width: number; height: number }
export type Placement = { top: number; left: number; side: Side }

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

const along = (anchorStart: number, anchorSize: number, layerSize: number, align: Align): number =>
  align === 'start'
    ? anchorStart
    : align === 'end'
      ? anchorStart + anchorSize - layerSize
      : anchorStart + (anchorSize - layerSize) / 2

const place = (anchor: Box, layer: Box, side: Side, align: Align, gap: number): Placement =>
  side === 'top'
    ? { top: anchor.top - layer.height - gap, left: along(anchor.left, anchor.width, layer.width, align), side }
    : side === 'bottom'
      ? { top: anchor.top + anchor.height + gap, left: along(anchor.left, anchor.width, layer.width, align), side }
      : side === 'left'
        ? { top: along(anchor.top, anchor.height, layer.height, align), left: anchor.left - layer.width - gap, side }
        : { top: along(anchor.top, anchor.height, layer.height, align), left: anchor.left + anchor.width + gap, side }

const fits = (p: Placement, layer: Box, viewport: { width: number; height: number }, pad: number): boolean =>
  p.top >= pad &&
  p.left >= pad &&
  p.top + layer.height <= viewport.height - pad &&
  p.left + layer.width <= viewport.width - pad

/** Preferred side unless it would overflow, then the opposite; either way the
 *  result is clamped inside the viewport, because a layer half off-screen is
 *  worse than one slightly off its anchor. Coordinates are viewport-relative,
 *  which is what `position: fixed` wants. */
export const anchor = (
  anchorBox: Box,
  layer: Box,
  options: {
    side?: Side
    align?: Align
    gap?: number
    padding?: number
    viewport?: { width: number; height: number }
  } = {},
): Placement => {
  const { side = 'bottom', align = 'center', gap = 6, padding = 8 } = options
  const viewport = options.viewport ?? { width: window.innerWidth, height: window.innerHeight }

  const first = place(anchorBox, layer, side, align, gap)
  const chosen = fits(first, layer, viewport, padding)
    ? first
    : (() => {
        const flipped = place(anchorBox, layer, OPPOSITE[side], align, gap)
        return fits(flipped, layer, viewport, padding) ? flipped : first
      })()

  return {
    side: chosen.side,
    top: Math.min(Math.max(chosen.top, padding), Math.max(padding, viewport.height - layer.height - padding)),
    left: Math.min(Math.max(chosen.left, padding), Math.max(padding, viewport.width - layer.width - padding)),
  }
}
