import { LinkButton } from '~/components/link-button.tsx'
import { EmptyState } from '@rawr/ui'

/** A record that was merged away, deleted, or never existed. The address is kept
 *  in the bar, so the person can see what they followed and where it came from. */
const NotFound = () => (
  <EmptyState
    title="That record is not here"
    description="It may have been merged into another one, deleted, or the link may be from a different account."
    action={
      <LinkButton variant="primary" href="/">
        Go to Home
      </LinkButton>
    }
  />
)

export default NotFound
