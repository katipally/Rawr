'use client'

import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../cn.ts'
import { DiscardConfirm, useDismiss } from './discard-guard.tsx'
import { SLIDE_EXIT_MS, useOverlay, usePresence } from './overlay.ts'

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
  const { present, closing } = usePresence(shown, SLIDE_EXIT_MS)
  const Shell = onSubmit ? 'form' : 'div'

  // Portalled to the body for the same reason the modal is: `position: fixed` is
  // measured against the app shell's content card, which establishes a containing
  // block with `container-type: inline-size`, so in place the panel ran the
  // height of the card rather than the window.
  if (!present) return null

  // HubSpot's create panel: the full height of the window over the top bar, no
  // scrim, so the page behind stays readable. On the way out the content goes
  // first and the empty panel slides away.
  return createPortal(
    <aside
      ref={dialog}
      inert={closing}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className={cn(
        'fixed inset-y-0 right-0 z-overlay flex w-[min(var(--spacing-side-panel),100vw)] flex-col border-l border-line bg-surface-raised text-body shadow-side outline-none motion-reduce:animate-none',
        closing ? 'animate-slide-out' : 'animate-slide-in',
      )}
    >
      <div className={cn('flex min-h-0 flex-1 flex-col', closing && 'invisible')}>
        <header
          inert={asking}
          className="flex min-h-17 shrink-0 items-center justify-between gap-3 border-b border-line py-3 pr-6 pl-[clamp(1rem,5vw,2.5rem)]"
        >
          <h2 className="truncate text-xl font-medium">{title}</h2>
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
          <div className="min-h-0 flex-1 overflow-y-auto px-[clamp(1rem,5vw,2.5rem)] py-6">{children}</div>
          {footer ? (
            <footer className="flex shrink-0 flex-wrap gap-2 border-t border-line bg-surface-raised px-[clamp(1rem,5vw,2.5rem)] py-4">
              {footer}
            </footer>
          ) : null}
        </Shell>
        {asking ? <DiscardConfirm onKeep={keep} onDiscard={discard} /> : null}
      </div>
    </aside>,
    document.body,
  )
}
