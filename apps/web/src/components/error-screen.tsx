'use client'

import { Button, EmptyState } from '@rawr/ui'
import { useEffect } from 'react'

/** 03-build-order, FAILING: every failure has a real message on screen. The
 *  error's own text is shown because the data access layer writes its messages
 *  for a person to read; anything else is a bug worth seeing verbatim.
 *
 *  Development only. Next redacts a Server Component's message before it crosses
 *  to the client, but an error thrown on the client arrives verbatim, and a
 *  DrizzleQueryError carries the statement and its parameters in its text. In a
 *  production build the digest is what ties the screen to the server log. */
const readable = (error: Error): string | null =>
  process.env.NODE_ENV !== 'production' && error.message && !error.message.startsWith('Minified React error')
    ? error.message
    : null

export const ErrorScreen = ({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) => {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <EmptyState
      title="This screen could not load"
      description={
        readable(error) ??
        `Something failed on the server. Try again, and if it keeps happening, tell whoever runs Rawr${error.digest ? ` and quote reference ${error.digest}` : ''}.`
      }
      action={
        <div className="flex gap-2">
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <Button onClick={() => window.location.reload()}>Reload the page</Button>
        </div>
      }
    />
  )
}
