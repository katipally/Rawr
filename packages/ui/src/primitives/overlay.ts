'use client'

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Everything a dialog owes the person using it: Escape closes, the page behind
 *  stops scrolling, Tab cannot walk out into it, and focus returns to whatever
 *  opened it. Shared by the modal and the side panel, which are the same contract
 *  in two shapes. */
export const useOverlay = (
  open: boolean,
  onClose: () => void,
  dialog: RefObject<HTMLElement | null>,
): void => {
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement as HTMLElement | null

    const box = dialog.current
    // The dialog itself takes focus when it holds nothing focusable, so Tab has
    // somewhere to start and the screen reader announces the label.
    const first = box?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? box)?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab' || !box) return
      const stops = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null,
      )
      if (stops.length === 0) {
        event.preventDefault()
        return
      }
      const edge = event.shiftKey ? stops[0] : stops[stops.length - 1]
      if (document.activeElement === edge || !box.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? stops[stops.length - 1] : stops[0])?.focus()
      }
    }

    // Reinstated on close rather than assumed to be "", so a page that already
    // locked scrolling for its own reason is not quietly unlocked.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      opener.current?.focus()
    }
  }, [open, onClose, dialog])
}
