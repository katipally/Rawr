import { LinkButton } from '~/components/link-button.tsx'
import { EmptyState } from '@rawr/ui'

/** A segment id that names nothing in this account: a deleted list, or a link
 *  from a different account. */
const NotFound = () => (
  <EmptyState
    title="There is no segment at this address"
    description="It may have been deleted, or the link may be from a different account."
    action={
      <LinkButton variant="primary" href="/">
        Go to Home
      </LinkButton>
    }
  />
)

export default NotFound
