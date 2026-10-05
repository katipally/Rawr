import { redirect } from 'next/navigation'
import { calendarPath } from '~/lib/links.ts'

const MeetingsAccountRoot = async ({ params }: { params: Promise<{ account: string }> }) => redirect(calendarPath((await params).account))

export default MeetingsAccountRoot
