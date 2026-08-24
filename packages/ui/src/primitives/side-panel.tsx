'use client'

import { useEffect, type ReactNode } from 'react'
import { cn } from '../cn.ts'

export type SidePanelProps = {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

export const SidePanel = ({ open, onClose, title, children, footer }: SidePanelProps) => {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="flex-1 cursor-default bg-black/20"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          // Full width on a phone, a panel on a desktop, never a fixed pixel width.
          'flex h-full w-full flex-col bg-surface shadow-overlay sm:max-w-[min(32rem,90vw)]',
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3">
          <h2 className="truncate font-medium">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-hs px-2 py-1 text-secondary hover:bg-fill-hover"
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
    </div>
  )
}
