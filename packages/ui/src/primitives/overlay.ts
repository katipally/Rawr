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
  // Callers pass an inline closure, which is a new function every render. Read
  // through a ref so the effect runs once per open, not once per keystroke;
  // otherwise every re-render moved focus back to the first control.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement as HTMLElement | null

    const box = dialog.current
    // First focusable is the close button in every dialog that has a header, which
    // is the wrong place to land in one built around a single field. A dialog says
    // where it wants focus with data-autofocus; without it the old order holds.
    // The dialog itself takes focus when it holds nothing focusable, so Tab has
    // somewhere to start and the screen reader announces the label.
    const asked = box?.querySelector<HTMLElement>('[data-autofocus]')
    const first = box?.querySelector<HTMLElement>(FOCUSABLE)
    ;(asked ?? first ?? box)?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close.current()
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
  }, [open, dialog])
}
