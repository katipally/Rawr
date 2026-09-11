'use client'

import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from './overlay.ts'

export type SidePanelProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

export const SidePanel = ({ open, onClose, title, children, footer }: SidePanelProps) => {
  const dialog = useRef<HTMLElement>(null)
  useOverlay(open, onClose, dialog)

  // Portalled to the body for the same reason the modal is: `position: fixed` is
  // measured against the app shell's content card, which establishes a containing
  // block with `container-type: inline-size`, so in place the scrim covered the
  // card rather than the window.
  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-overlay flex justify-end">
      <div aria-hidden="true" onClick={onClose} className="flex-1 bg-scrim" />
      <aside
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // Full width on a phone, a panel on a desktop, never a fixed pixel width.
        className="flex h-full w-full flex-col border-l border-line bg-surface-raised shadow-overlay outline-none sm:max-w-[min(32rem,90vw)]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3">
          <h2 className="truncate font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-hs px-2 py-1 text-secondary hover:bg-fill-hover"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-divider p-4">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>,
    document.body,
  )
}
