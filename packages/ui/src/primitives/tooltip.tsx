'use client'

import {
  cloneElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { anchor, type Box, type Side } from './position.ts'

const DELAY_MS = 350

export type TooltipProps = {
  /** What the tooltip says. Keep it to a phrase; a sentence belongs on the page. */
  label: ReactNode
  side?: Side
  /** The control being described. It receives the aria and the pointer handlers,
   *  so it must forward props and take a ref. */
  children: ReactElement<Record<string, unknown>>
}

/** A description attached to a control, shown on hover and on keyboard focus, so
 *  an icon-only button is never a mystery to either. Never use it for anything a
 *  person needs in order to act: a tooltip cannot be reached by touch. */
export const Tooltip = ({ label, side = 'bottom', children }: TooltipProps) => {
  const id = useId()
  const [around, setAround] = useState<Box | null>(null)
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)

  // Measured in a layout effect, after the offscreen render has committed and the
  // layer has a real width: a bare rAF fires before the commit, so the tooltip was
  // placed as if it were zero wide and could not flip honestly.
  useLayoutEffect(() => {
    if (!around || !layer.current) return
    const size = layer.current.getBoundingClientRect()
    setBox(anchor(around, { top: 0, left: 0, width: size.width, height: size.height }, { side }))
  }, [around, side])

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const hide = () => {
    cancel()
    setAround(null)
    setBox(null)
  }
  const show = (target: HTMLElement, delay: number) => {
    cancel()
    timer.current = window.setTimeout(() => {
      const rect = target.getBoundingClientRect()
      setAround({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }, delay)
  }

  const child = cloneElement(children, {
    'aria-describedby': around ? id : undefined,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      show(event.currentTarget, DELAY_MS)
      ;(children.props.onMouseEnter as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(event)
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      hide()
      ;(children.props.onMouseLeave as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(event)
    },
    // Focus shows it with no delay: a keyboard user has already committed. Only
    // keyboard focus, though: returning focus from a closed dialog refocuses the
    // control that opened it, and a tooltip left hanging there was never asked for.
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget, 0)
      ;(children.props.onFocus as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(event)
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      hide()
      ;(children.props.onBlur as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(event)
    },
    // Once the control has been pressed the description has done its job, and a
    // tooltip left up behind the menu it just opened is only clutter.
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      hide()
      ;(children.props.onClick as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(event)
    },
    // Escape dismisses it, which WCAG 1.4.13 requires of anything hover-triggered.
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') hide()
      ;(children.props.onKeyDown as ((e: React.KeyboardEvent<HTMLElement>) => void) | undefined)?.(event)
    },
  })

  // The layer is portalled to the body: its coordinates are viewport coordinates,
  // and a fixed element inside the shell's content card is placed against the
  // card, which carries `container-type: inline-size`.
  const layerNode =
    around && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={layer}
            id={id}
            role="tooltip"
            style={box ? { top: box.top, left: box.left } : { top: -9999, left: -9999 }}
            className="pointer-events-none fixed z-overlay max-w-64 rounded-hs bg-nav px-2 py-1 text-small text-nav-text shadow-overlay"
          >
            {label}
          </div>,
          document.body,
        )
      : null

  return (
    <>
      {child}
      {layerNode}
    </>
  )
}
