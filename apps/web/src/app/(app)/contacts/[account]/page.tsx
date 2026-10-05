import { redirect } from 'next/navigation'
import { accountHome } from '~/lib/links.ts'

const AccountRoot = async ({ params }: { params: Promise<{ account: string }> }) => redirect(accountHome((await params).account))

export default AccountRoot
