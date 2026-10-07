import { LinkButton } from '~/components/link-button.tsx'
import { EmptyState } from '@rawr/ui'

/** An object key that names nothing in this account: a mistyped address, or a
 *  custom object that was deleted after the link was shared. */
const NotFound = () => (
  <EmptyState
    title="That object is not in this account"
    description="It may have been deleted, or the link may be from a different account."
    action={
      <LinkButton variant="primary" href="/">
        Go to Home
      </LinkButton>
    }
  />
)

export default NotFound
