import { canWrite, listTaskQueues } from '@rawr/db'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { safePath, tasksPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { QueueManager } from './queue-manager.tsx'

const TaskQueuesPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ back?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const { back } = await searchParams
  const ctx = contextFrom(session)
  const queues = await listTaskQueues(ctx)

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-1 border-b border-line pb-4">
        <Link href={safePath(back, tasksPath(account))} className="flex w-fit items-center gap-0.5 text-small text-body no-underline hover:underline">
          <ChevronLeft aria-hidden="true" className="size-3.5" />
          Back
        </Link>
        <h1 className="text-xl font-semibold">Task queues</h1>
      </div>
      <QueueManager account={account} queues={queues} canWrite={canWrite(ctx, 'task')} />
    </div>
  )
}

export default TaskQueuesPage
