'use client'

import { useRef, type ReactNode } from 'react'
import { cn } from '../cn.ts'
import { useOverlay } from './overlay.ts'

export type ModalSize = 'sm' | 'md' | 'lg'

/** Width is capped in rem so a dialog does not stretch across an ultrawide
 *  monitor, and height in vh so it never grows to the edge of the window: the
 *  body scrolls inside, the header and footer stay put. `min()` keeps both honest
 *  on a small screen, where the viewport is the smaller of the two.
 *
 *  Three sizes rather than a free width, so twenty dialogs cannot drift into
 *  twenty different shapes. */
const SIZES: Record<ModalSize, string> = {
  sm: 'sm:max-w-[min(28rem,92vw)] sm:max-h-[60vh]',
  md: 'sm:max-w-[min(40rem,92vw)] sm:max-h-[80vh]',
  lg: 'sm:max-w-[min(64rem,92vw)] sm:max-h-[85vh]',
}

export type ModalProps = {
  open: boolean
  onClose: () => void
  title: string
  /** How much room the content needs: `sm` for a confirmation or a rename, `lg`
   *  for a wizard or a builder. Anything else is `md`. */
  size?: ModalSize
  children: ReactNode
  footer?: ReactNode
}

export const Modal = ({ open, onClose, title, size = 'md', children, footer }: ModalProps) => {
  const dialog = useRef<HTMLDivElement>(null)
  useOverlay(open, onClose, dialog)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      {/* The scrim is a token: black at 30% over a dark canvas is invisible. */}
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-scrim" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          // A phone gets a sheet off the bottom edge, capped so the page behind
          // it stays visible and the dialog reads as a layer, not a new screen.
          'relative flex max-h-[85vh] w-full flex-col rounded-panel border border-line bg-surface-raised shadow-overlay outline-none',
          SIZES[size],
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-divider px-4 py-3">
          <h2 className="min-w-0 truncate font-medium" title={title}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="shrink-0 rounded-hs px-2 py-1 text-secondary hover:bg-fill-hover"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-divider p-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
