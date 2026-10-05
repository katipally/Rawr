'use client'

import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
const FIELD = 'input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled])'

const never = () => () => {}

/** False for the server render and for the render that hydrates it, true from the
 *  next one on. A portal the server never drew has to wait for that, or the
 *  client's first tree has a node the server's did not, and React throws the
 *  server's markup away and resets the state a deep link arrived with. */
export const useMounted = (): boolean =>
  useSyncExternalStore(
    never,
    () => true,
    () => false,
  )

/** Everything a dialog owes the person using it: Escape closes, the page behind
 *  stops scrolling, Tab cannot walk out into it, and focus returns to whatever
 *  opened it. Shared by the modal and the side panel, which are the same contract
 *  in two shapes. Returns whether to draw it: open, and past hydration. */
export const useOverlay = (
  open: boolean,
  onClose: () => void,
  dialog: RefObject<HTMLElement | null>,
): boolean => {
  const mounted = useMounted()
  const shown = open && mounted
  const opener = useRef<HTMLElement | null>(null)
  // Callers pass an inline closure, which is a new function every render. Read
  // through a ref so the effect runs once per open, not once per keystroke;
  // otherwise every re-render moved focus back to the first control.
  const close = useRef(onClose)
  close.current = onClose

  // Taken on the render that opens the dialog, not in the effect: React's autoFocus
  // runs at commit, before any effect, so by then focus has already moved into the
  // dialog and the opener would be recorded as one of its own fields.
  if (shown && !dialog.current) {
    opener.current = document.activeElement as HTMLElement | null
  }

  useEffect(() => {
    if (!shown) return

    const box = dialog.current
    // First focusable is the close button in every dialog that has a header, which
    // is the wrong place to land in one built around a field. A dialog says where
    // it wants focus with data-autofocus; otherwise the first field takes it, and a
    // dialog with none (a confirmation) falls back to the first control.
    // The dialog itself takes focus when it holds nothing focusable, so Tab has
    // somewhere to start and the screen reader announces the label.
    const asked = box?.querySelector<HTMLElement>('[data-autofocus]')
    const field = [...(box?.querySelectorAll<HTMLElement>(FIELD) ?? [])].find((node) => node.offsetParent !== null)
    const first = box?.querySelector<HTMLElement>(FOCUSABLE)
    ;(asked ?? field ?? first ?? box)?.focus()

    const onKey = (event: KeyboardEvent) => {
      // An inner control that handles Escape itself (a combobox closing its list)
      // calls preventDefault; closing the dialog too would throw away the edit.
      if (event.key === 'Escape') {
        if (!event.defaultPrevented) close.current()
        return
      }
      if (event.key !== 'Tab' || !box) return
      const stops = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null && !node.closest('[inert]'),
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
  }, [shown, dialog])
  return shown
}
