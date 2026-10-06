import { redirect } from 'next/navigation'
import { bookingPagesPath } from '~/lib/links.ts'

/** HubSpot's /meetings/<portal> is the scheduling pages list, so the same
 *  address here opens Meeting links. */
const MeetingsAccountRoot = async ({ params }: { params: Promise<{ account: string }> }) => redirect(bookingPagesPath((await params).account))

export default MeetingsAccountRoot
