'use client'

import { Button, EmptyState } from '@rawr/ui'

/** 03-build-order, FAILING: every failure has a real message on screen. The
 *  error's own text is shown because the data access layer writes its messages
 *  for a person to read; anything else is a bug worth seeing verbatim. */
const AppError = ({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) => (
  <EmptyState
    title="This screen could not load"
    description={error.message || 'Something failed without saying what. Try again, and if it keeps happening, copy this page address to whoever runs Rawr.'}
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

export default AppError
