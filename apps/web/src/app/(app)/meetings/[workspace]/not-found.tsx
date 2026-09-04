import Link from 'next/link'
import { EmptyState } from '@rawr/ui'

/** A meeting link or a booking that is gone. Distinct from the public manage
 *  page's own not-found, which a visitor sees; this one is for staff. */
const NotFound = () => (
  <EmptyState
    title="That meeting link is not here"
    description="It may have been deleted, or the link may be from a different workspace."
    action={
      <Link href="/" className="font-medium">
        Go to Home
      </Link>
    }
  />
)

export default NotFound
