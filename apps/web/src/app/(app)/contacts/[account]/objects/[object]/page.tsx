import { redirect } from 'next/navigation'
import { objectView } from '~/lib/links.ts'

const ObjectRoot = async ({ params }: { params: Promise<{ account: string; object: string }> }) => {
  const { account, object } = await params
  redirect(objectView(account, object, 'all'))
}

export default ObjectRoot
