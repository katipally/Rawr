'use client'

import { useEffect, useState } from 'react'
import { Button } from './button.tsx'

/** Escape, the close button and the scrim all mean "I am done here". On a form
 *  with something typed into it that is a question, not an order: closing threw
 *  the text away without a word. `dismiss` is the one handler all three share. It
 *  closes a clean dialog, asks about a dirty one, and answers "keep editing" when
 *  the question is already open, so a second Escape backs out of it. */
export const useDismiss = (open: boolean, dirty: boolean, onClose: () => void) => {
  const [asking, setAsking] = useState(false)
  // A dialog closed from outside (the save finished) must not reopen mid-question.
  if (!open && asking) setAsking(false)

  const dismiss = () => {
    if (asking) setAsking(false)
    else if (dirty) setAsking(true)
    else onClose()
  }
  return {
    asking,
    dismiss,
    keep: () => setAsking(false),
    discard: () => {
      setAsking(false)
      onClose()
    },
  }
}

/** The question itself, laid over the dialog that asked it. The dialog behind is
 *  made inert by its owner, so Tab cannot reach a field the person cannot see
 *  past the scrim. */
export const DiscardConfirm = ({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) => {
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null
    return () => from?.focus()
  }, [])

  return (
    <div className="absolute inset-0 z-10 grid place-items-center rounded-[inherit] bg-scrim p-4">
      <div
        role="alertdialog"
        aria-label="Discard changes?"
        className="flex w-full max-w-[min(24rem,100%)] flex-col gap-3 rounded-panel border border-line bg-surface-raised p-4 shadow-overlay"
      >
        <p className="font-medium">Discard changes?</p>
        <p className="text-small text-secondary">What you entered here has not been saved.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="destructive" onClick={onDiscard}>
            Discard
          </Button>
          <Button variant="primary" autoFocus onClick={onKeep}>
            Keep editing
          </Button>
        </div>
      </div>
    </div>
  )
}
