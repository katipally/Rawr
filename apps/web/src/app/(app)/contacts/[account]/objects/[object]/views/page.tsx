import { redirect } from 'next/navigation'
import { objectView, type ListParams } from '~/lib/links.ts'

const ObjectRoot = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; object: string }>
  searchParams: Promise<ListParams>
}) => {
  const { account, object } = await params
  redirect(objectView(account, object, 'all', 'list', await searchParams))
}

export default ObjectRoot
