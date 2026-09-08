'use client'

import { useEffect } from 'react'

/** Tells the frame around this page how tall it is.
 *
 *  The embed is a frame rather than markup injected into the host page, which is
 *  what lets the hosted page and the embed be the same implementation. The one
 *  thing a frame cannot do for itself is size to its content, so this reports the
 *  height on every change and the loader script sets it.
 *
 *  The message names the widget and carries no visitor data. Anyone can read a
 *  cross-document message, so nothing here may be worth reading. */
export const EmbedHeight = ({ title }: { title: string }) => {
  useEffect(() => {
    if (window.parent === window) return

    const post = () =>
      window.parent.postMessage(
        { source: 'rawr-booking', type: 'height', height: document.documentElement.scrollHeight, title },
        '*',
      )

    post()
    const observer = new ResizeObserver(post)
    observer.observe(document.documentElement)
    return () => observer.disconnect()
  }, [title])

  return null
}
