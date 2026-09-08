import { LinkButton } from '~/components/link-button.tsx'
import { EmptyState } from '@rawr/ui'

/** A settings tab that was removed, or a link from a Rawr that had one more of
 *  them than this one does. */
const NotFound = () => (
  <EmptyState
    title="There is no settings page here"
    description="The link may be from an older version, or point at something only an admin can open."
    action={
      <LinkButton variant="primary" href="/settings">
        Back to settings
      </LinkButton>
    }
  />
)

export default NotFound
