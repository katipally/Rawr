'use client'

import { Button, EmptyState } from '@rawr/ui'

/** 03-build-order, FAILING: every failure has a real message on screen. The
 *  error's own text is shown because the data access layer writes its messages
 *  for a person to read; anything else is a bug worth seeing verbatim.
 *
 *  React redacts a server error's message before it crosses to the client, so in
 *  a production build all that survives is a minified error code and the digest
 *  that ties the screen to the line in the server log. Showing that code helps
 *  nobody; the digest does. */
const readable = (error: Error): string | null =>
  error.message && !error.message.startsWith('Minified React error') ? error.message : null

export const ErrorScreen = ({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) => (
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
