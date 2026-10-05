'use client'

import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DiscardConfirm, useDismiss } from './discard-guard.tsx'
import { useOverlay } from './overlay.ts'

export type SidePanelProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Pinned under the body, so the actions are on screen however long the form is. */
  footer?: ReactNode
  /** Makes the body and the footer one `<form>`; see `Modal`. */
  onSubmit?: () => void
  /** Something has been entered that closing would lose; see `Modal`. */
  dirty?: boolean
}

export const SidePanel = ({
  open,
  onClose,
  title,
  children,
  footer,
  onSubmit,
  dirty = false,
}: SidePanelProps) => {
  const dialog = useRef<HTMLElement>(null)
  const { asking, dismiss, keep, discard } = useDismiss(open, dirty, onClose)
  const shown = useOverlay(open, dismiss, dialog)
  const Shell = onSubmit ? 'form' : 'div'

  // Portalled to the body for the same reason the modal is: `position: fixed` is
  // measured against the app shell's content card, which establishes a containing
  // block with `container-type: inline-size`, so in place the scrim covered the
  // card rather than the window.
  if (!shown) return null

  return createPortal(
    <div className="fixed inset-0 z-overlay flex justify-end">
      <div aria-hidden="true" onClick={dismiss} className="flex-1 bg-scrim" />
      <aside
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // Full width on a phone, a panel on a desktop, never a fixed pixel width.
        className="relative flex h-full w-full flex-col border-l border-line bg-surface-raised shadow-overlay outline-none sm:max-w-[min(32rem,90vw)]"
      >
        <header inert={asking} className="flex shrink-0 items-center justify-between gap-3 border-b border-divider px-4 py-3">
          <h2 className="truncate font-medium">{title}</h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className="shrink-0 rounded-hs px-2 py-1 text-secondary hover:bg-fill-hover"
          >
            ✕
          </button>
        </header>
        <Shell
          inert={asking}
          onSubmit={
            onSubmit &&
            ((event) => {
              event.preventDefault()
              onSubmit()
            })
          }
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          {footer ? (
            <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-divider p-4">
              {footer}
            </footer>
          ) : null}
        </Shell>
        {asking ? <DiscardConfirm onKeep={keep} onDiscard={discard} /> : null}
      </aside>
    </div>,
    document.body,
  )
}
