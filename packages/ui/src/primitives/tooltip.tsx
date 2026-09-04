'use client'

import { cloneElement, useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { anchor, type Side } from './position.ts'

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
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const trigger = useRef<HTMLElement | null>(null)

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const hide = () => {
    cancel()
    setBox(null)
  }
  const show = (target: HTMLElement, delay: number) => {
    cancel()
    trigger.current = target
    timer.current = window.setTimeout(() => {
      const rect = target.getBoundingClientRect()
      // Measured after the layer is in the DOM: it renders at 0,0 invisible for
      // one frame, which is what makes flipping possible without a guess.
      setBox({ top: -9999, left: -9999 })
      requestAnimationFrame(() => {
        const size = layer.current?.getBoundingClientRect()
        setBox(
          anchor(rect, { top: 0, left: 0, width: size?.width ?? 0, height: size?.height ?? 0 }, { side }),
        )
      })
    }, delay)
  }

  const child = cloneElement(children, {
    'aria-describedby': box ? id : undefined,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      show(event.currentTarget, DELAY_MS)
      ;(children.props.onMouseEnter as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(event)
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      hide()
      ;(children.props.onMouseLeave as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(event)
    },
    // Focus shows it with no delay: a keyboard user has already committed.
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      show(event.currentTarget, 0)
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

  return (
    <>
      {child}
      {box ? (
        <div
          ref={layer}
          id={id}
          role="tooltip"
          style={{ top: box.top, left: box.left }}
          className="pointer-events-none fixed z-overlay max-w-64 rounded-hs bg-nav px-2 py-1 text-small text-nav-text shadow-overlay"
        >
          {label}
        </div>
      ) : null}
    </>
  )
}
