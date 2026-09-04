'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'
import { anchor, type Align, type Side } from './position.ts'

export type PopoverProps = {
  open: boolean
  onClose: () => void
  /** The element the panel hangs off. Kept as a ref rather than wrapping the
   *  trigger, so a trigger already inside a toolbar keeps its own layout. */
  anchorRef: React.RefObject<HTMLElement | null>
  side?: Side
  align?: Align
  label: string
  className?: string
  children: ReactNode
}

/** A panel anchored to a control: Escape and an outside click close it, focus
 *  moves into it, and it repositions on scroll and resize rather than drifting
 *  away from its trigger. Not modal: the page behind keeps working. */
export const Popover = ({
  open,
  onClose,
  anchorRef,
  side = 'bottom',
  align = 'end',
  label,
  className,
  children,
}: PopoverProps) => {
  const panel = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  const reposition = useCallback(() => {
    const trigger = anchorRef.current
    const layer = panel.current
    if (!trigger || !layer) return
    const size = layer.getBoundingClientRect()
    setBox(anchor(trigger.getBoundingClientRect(), { top: 0, left: 0, width: size.width, height: size.height }, { side, align }))
  }, [anchorRef, side, align])

  // Layout effect: measure and place before the browser paints, or the panel is
  // visible at 0,0 for a frame and jumps.
  useLayoutEffect(() => {
    if (open) reposition()
    else setBox(null)
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    panel.current?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current()
    }
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || anchorRef.current?.contains(target)) return
      close.current()
    }
    // Capture on scroll so a panel anchored inside a scrolling table follows it.
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, anchorRef, reposition])

  if (!open) return null

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={box ? { top: box.top, left: box.left } : { top: -9999, left: -9999 }}
      className={cn(
        'fixed z-overlay max-h-[min(80vh,32rem)] overflow-y-auto rounded-panel border border-line bg-surface-raised shadow-overlay outline-none',
        className,
      )}
    >
      {children}
    </div>
  )
}
