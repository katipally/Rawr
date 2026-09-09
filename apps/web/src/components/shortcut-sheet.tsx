'use client'

import { Kbd, Modal } from '@rawr/ui'
import { useEffect, useState } from 'react'

/** What the keyboard already does, in the one place somebody would look for it.
 *
 *  All of these worked before this component existed and none of them were
 *  written down anywhere, which is the same as not existing. Opened with `?`, the
 *  key every tool that has this uses, and ignored while a field has focus, so
 *  typing a question mark into search does not open a dialog over it. */
const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ['cmd', 'k'], what: 'Search, or jump to a page or an action' },
  { keys: ['esc'], what: 'Close a dialog, a menu or a flyout' },
  { keys: ['enter'], what: 'Open the highlighted search result' },
  { keys: ['?'], what: 'Open this list' },
]

const typingInto = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

export const ShortcutSheet = () => {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return
      if (typingInto(event.target)) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Modal open={open} onClose={() => setOpen(false)} size="lg" title="Keyboard shortcuts">
      <ul className="flex flex-col">
        {SHORTCUTS.map((shortcut) => (
          <li
            key={shortcut.what}
            className="flex items-center justify-between gap-4 border-b border-divider py-1.5 last:border-0"
          >
            <span>{shortcut.what}</span>
            <Kbd keys={shortcut.keys} />
          </li>
        ))}
      </ul>
    </Modal>
  )
}
