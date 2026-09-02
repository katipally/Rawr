import { EmptyState } from '@rawr/ui'
import Link from 'next/link'

const NotFound = () => (
  <EmptyState
    title="There is nothing at this address"
    description="The link may be old, or the record it pointed at was deleted. Its history is still on the records it touched."
    action={<Link href="/">Go to Home</Link>}
  />
)

export default NotFound
