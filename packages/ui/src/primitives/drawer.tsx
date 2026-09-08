'use client'

import { useRef, type ReactNode } from 'react'
import { cn } from '../cn.ts'
import { useOverlay } from './overlay.ts'

export type DrawerProps = {
  open: boolean
  onClose: () => void
  title: string
  /** Sits at the right of the title row: a settings link, a filter, whatever the
   *  panel needs beside its own name. */
  action?: ReactNode
  children: ReactNode
  className?: string
}

/** A panel down the right of the whole window.
 *
 *  Three things separate it from `SidePanel`, and each one is why it exists
 *  rather than a prop on that: it runs the full height *over* the top bar rather
 *  than under it, it draws no scrim so the page behind stays readable while you
 *  work through the list, and it sits above the top bar in the stack rather than
 *  level with it.
 *
 *  Nothing here is modal in the blocking sense, but it still traps focus and
 *  closes on Escape, because a panel you can tab out of and cannot see is worse
 *  than one that holds on to you. */
export const Drawer = ({ open, onClose, title, action, children, className }: DrawerProps) => {
  const dialog = useRef<HTMLElement>(null)
  useOverlay(open, onClose, dialog)

  if (!open) return null

  return (
    <aside
      ref={dialog}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      // Full width on a phone, a panel on a desktop, never a fixed pixel width.
      className={cn(
        // text-body is not decoration: this is usually opened from a control in
        // the charcoal top bar, and without it every unstyled word inside
        // inherits that bar's near-white ink and renders white on white.
        'fixed inset-y-0 right-0 z-overlay flex w-full flex-col border-l border-line bg-surface-raised text-body shadow-overlay outline-none sm:max-w-[min(26rem,92vw)]',
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
        {action}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-hs px-2 py-1 text-secondary hover:bg-fill-hover"
        >
          ✕
        </button>
      </header>
      {children}
    </aside>
  )
}
