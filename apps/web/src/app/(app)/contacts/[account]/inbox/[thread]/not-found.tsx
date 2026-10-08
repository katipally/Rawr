import { LinkButton } from '~/components/link-button.tsx'
import { EmptyState } from '@rawr/ui'

const NotFound = () => (
  <EmptyState
    title="That conversation is not here"
    description="It may have been deleted, or the link may be from a different account."
    action={
      <LinkButton variant="primary" href="/">
        Go to Home
      </LinkButton>
    }
  />
)

export default NotFound
