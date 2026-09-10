'use client'

import { Button, DataTable, EmptyState, useToast, type Column } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

export type DeadLetter = {
  id: string
  jobName: string
  error: string
  /** Null for work that never reached the queue, so it never had an attempt. */
  attempts: number | null
  at: string
  payload: unknown
}

export const DeadLetterTable = ({ rows }: { rows: DeadLetter[] }) => {
  const zone = useZone()
  const toast = useToast()
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)

  /** Safe to press twice: every replay path is keyed on the work rather than on
   *  the attempt, so a second press is a no-op at the provider. F6 §1. */
  const replay = async (id: string) => {
    setBusyId(id)
    try {
      const result = await api.integrations.replay.mutate({ id })
      toast('success', result.detail)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
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
      render: (row) => formatDateTime(row.at, zone),
    },
    {
      key: 'attempts',
      header: 'Attempts',
      width: 120,
      align: 'right',
      render: (row) => (row.attempts === null ? <span className="text-secondary">not queued</span> : row.attempts),
    },
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
      caption="Jobs that could not be delivered"
      empty={
        <EmptyState
          title="No failed jobs"
          description="Every job has either succeeded or is still retrying. Nothing here needs a person."
        />
      }
    />
  )
}
