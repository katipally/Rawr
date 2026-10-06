'use client'

import { Button, cn, useMounted, usePresence } from '@rawr/ui'
import { useRef } from 'react'
import { createPortal } from 'react-dom'

/** How long the bar takes to drop out, matching --rawr-duration-slow, which
 *  HubSpot's save bar runs for. */
const SAVE_BAR_EXIT_MS = 300

/** HubSpot's save bar on its scheduling page editor: pinned to the window's
 *  foot only while something differs from what was saved, Save and Cancel and
 *  how many settings changed. Portalled because the shell's content card is a
 *  size container, which a fixed box would otherwise be measured against.
 *  Save submits the form named by `form`, so Enter in a field and the bar's
 *  button are one path. */
export const SaveBar = ({
  form,
  changes,
  busy,
  onCancel,
}: {
  form: string
  changes: number
  busy: boolean
  onCancel: () => void
}) => {
  const mounted = useMounted()
  const { present, closing } = usePresence(changes > 0, SAVE_BAR_EXIT_MS)
  // Kept while the bar drops out, so it leaves saying what it said.
  const shown = useRef(changes)
  if (changes > 0) shown.current = changes
  if (!mounted || !present) return null
  return createPortal(
    <div
      inert={closing}
      className={cn(
        'fixed inset-x-0 bottom-0 z-topbar flex flex-wrap items-center gap-3 border-t border-line bg-canvas px-4 py-5 sm:px-12 motion-reduce:animate-none',
        closing ? 'animate-rise-out' : 'animate-rise-in',
      )}
    >
      <Button type="submit" form={form} variant="primary" busy={busy}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <Button type="button" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <span>{shown.current === 1 ? "You've made 1 change" : `You've made ${shown.current} changes`}</span>
    </div>,
    document.body,
  )
}
