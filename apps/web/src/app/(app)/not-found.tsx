import { EmptyState } from '@rawr/ui'
import { LinkButton } from '~/components/link-button.tsx'

const NotFound = () => (
  <EmptyState
    title="There is nothing at this address"
    description="The link may be old, or the record it pointed at was deleted. Its history is still on the records it touched."
    action={<LinkButton variant="primary" href="/">Go to Home</LinkButton>}
  />
)

export default NotFound
