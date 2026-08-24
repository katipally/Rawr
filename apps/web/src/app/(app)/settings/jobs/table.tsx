'use client'

import { Button, DataTable, EmptyState, useToast, type Column } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export type DeadLetter = {
  id: string
  jobName: string
  error: string
  attempts: number
  at: string
  payload: unknown
}

export const DeadLetterTable = ({ rows }: { rows: DeadLetter[] }) => {
  const toast = useToast()
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)

  const replay = async (id: string) => {
    setBusyId(id)
    try {
      const response = await fetch('/api/trpc/jobs.replay?batch=0', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: { id } }),
      })
      const body = (await response.json()) as { error?: { json?: { message?: string } } }
      if (!response.ok) {
        throw new Error(body.error?.json?.message ?? `The server answered ${response.status}.`)
      }
      toast('success', 'Queued again. The dispatcher picks it up within a minute.')
      router.refresh()
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }

  const columns: Column<DeadLetter>[] = [
    { key: 'jobName', header: 'Job', width: 200, render: (row) => row.jobName },
    {
      key: 'at',
      header: 'Failed at',
      width: 200,
      render: (row) => new Date(row.at).toLocaleString(),
    },
    { key: 'attempts', header: 'Attempts', width: 100, align: 'right', render: (row) => row.attempts },
    { key: 'error', header: 'Error', render: (row) => <span className="break-words">{row.error}</span> },
    {
      key: 'replay',
      header: 'Replay',
      width: 120,
      render: (row) => (
        <Button busy={busyId === row.id} onClick={() => void replay(row.id)}>
          Replay
        </Button>
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      caption="Jobs that exhausted their retries"
      empty={
        <EmptyState
          title="No failed jobs"
          description="Every job has either succeeded or is still retrying. Nothing here needs a person."
        />
      }
    />
  )
}
