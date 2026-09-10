'use client'

import { Button, DataTable, EmptyState, PageHeader, useToast, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
import { recordPath, segmentsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Member = { id: string; displayName: string; enteredAt: string }

export type ListMembersProps = {
  account: string
  list: {
    id: string
    name: string
    description: string | null
    objectKey: ObjectKey
    isStatic: boolean
    memberCount: number
  }
  initial: Member[]
  /** One screenful. The list itself can hold eighty thousand, so the page walks
   *  it rather than asking for it. Set by the server page, which fetched the
   *  first screenful with the same number. */
  pageSize: number
  canWrite: boolean
}

export const ListMembers = ({ account, list, initial, pageSize, canWrite }: ListMembersProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [members, setMembers] = useState(initial)
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = async (next: number) => {
    setBusy(true)
    try {
      const rows = await api.segments.members.query({ id: list.id, limit: pageSize, offset: next })
      setMembers(rows.map((row) => ({ ...row, enteredAt: row.enteredAt.toISOString() })))
      setOffset(next)
      setSelected(new Set())
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ids: string[]) => {
    setBusy(true)
    try {
      const result = await api.segments.removeMembers.mutate({ id: list.id, ids })
      toast('success', `${result.removed} taken off ${list.name}.`)
      setSelected(new Set())
      // Back to the same place in the list, which is now one page shorter than it
      // was; asking for an offset past the end returns nothing, so step back.
      const stillThere = Math.max(0, Math.min(offset, list.memberCount - result.removed - 1))
      await load(stillThere)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<Member>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      render: (row) => (
        <Link href={recordPath(account, list.objectKey, row.id)} title={row.displayName} className="min-w-0 truncate text-link hover:underline">
          {row.displayName}
        </Link>
      ),
    },
    {
      key: 'entered',
      header: 'Added',
      width: 220,
      render: (row) => formatDateTime(row.enteredAt, zone),
    },
    ...(canWrite && list.isStatic
      ? [
          {
            key: 'actions',
            header: '',
            width: 110,
            render: (row: Member) => (
              <Button variant="tertiary" busy={busy} onClick={() => void remove([row.id])}>
                Remove
              </Button>
            ),
          } satisfies Column<Member>,
        ]
      : []),
  ]

  const ticked = [...selected]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <PageHeader
        title={list.name}
        lead={`${list.memberCount.toLocaleString()} member${list.memberCount === 1 ? '' : 's'}${
          list.description ? ` · ${list.description}` : ''
        }`}
        why={
          list.isStatic ? (
            <p>
              A static list holds whoever was put in it. Nothing recomputes it, so a record that
              stops matching the reason you added it stays until somebody takes it off. Removing
              one ends its spell rather than erasing it, so the timeline still says when it was on
              here.
            </p>
          ) : (
            <p>
              An active list decides its own membership from its conditions, so members cannot be
              added or removed by hand. Change the conditions instead.
            </p>
          )
        }
        action={
          <Link href={segmentsPath(account)} className="text-link hover:underline">
            Back to segments
          </Link>
        }
      />

      {canWrite && list.isStatic && ticked.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-panel border border-line-interactive bg-accent-subtle p-3">
          <p className="font-medium">{ticked.length} selected</p>
          <Button variant="destructive" busy={busy} onClick={() => void remove(ticked)}>
            Remove from list
          </Button>
          <Button variant="tertiary" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      ) : null}

      <DataTable
        fill
        columns={columns}
        rows={members}
        rowKey={(row) => row.id}
        caption={`Members of ${list.name}`}
        storageKey={`segment.${list.id}`}
        {...(canWrite && list.isStatic
          ? { selection: { selected, onChange: setSelected, noun: 'member' } }
          : {})}
        empty={
          <div className="flex flex-1 flex-col justify-center">
            <EmptyState
              title="Nobody is on this list"
              description={
                list.isStatic
                  ? 'Tick records on any list and use "Add to list" to fill it.'
                  : 'It has no members right now. Recompute it, or widen its conditions.'
              }
            />
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - pageSize))}>
          Previous
        </Button>
        <span className="text-small text-secondary">
          {members.length === 0
            ? 'Nothing on this page'
            : `${(offset + 1).toLocaleString()} to ${(offset + members.length).toLocaleString()} of ${list.memberCount.toLocaleString()}`}
        </span>
        <Button
          disabled={busy || offset + members.length >= list.memberCount}
          onClick={() => void load(offset + pageSize)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
