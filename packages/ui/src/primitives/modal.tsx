'use client'

import { useRef, type ReactNode } from 'react'
import { useOverlay } from './overlay.ts'

export type ModalProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

export const Modal = ({ open, onClose, title, children, footer }: ModalProps) => {
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
        className="relative flex max-h-full w-full flex-col rounded-panel border border-line bg-surface-raised shadow-overlay outline-none sm:max-w-lg"
      >
        <header className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3">
          <h2 className="min-w-0 font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
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
      </div>
    </div>
  )
}
