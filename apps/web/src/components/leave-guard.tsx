'use client'

import { ConfirmDialog } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { leavesPage } from '~/lib/leave-guard.ts'

/** While `dirty`, a reload or close gets the browser's own question, and a click on
 *  a link that would leave the page asks in the app's own dialog first. The click
 *  listener is in the capture phase, so it runs before the link's handler and can
 *  stop it. Back buttons ask their own question and do not go through here. */
export const LeaveGuard = ({ dirty }: { dirty: boolean }) => {
  const router = useRouter()
  const [target, setTarget] = useState<URL | null>(null)
  const released = useRef(false)

  useEffect(() => {
    if (!dirty) return
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!released.current) event.preventDefault()
    }
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return
      if (!leavesPage(link.href, new URL(location.href))) return
      event.preventDefault()
      event.stopPropagation()
      setTarget(new URL(link.href))
    }
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('click', onClick, true)
    }
  }, [dirty])

  const leave = () => {
    if (!target) return
    setTarget(null)
    if (target.origin === location.origin) {
      router.push(target.pathname + target.search + target.hash)
    } else {
      released.current = true
      window.location.assign(target.href)
    }
  }

  return (
    <ConfirmDialog
      open={target !== null}
      title="Leave without saving?"
      confirm="Leave"
      onCancel={() => setTarget(null)}
      onConfirm={leave}
    >
      <p>Your changes have not been saved.</p>
    </ConfirmDialog>
  )
}
