'use client'

import { DataTable, EmptyState, useToast, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useState } from 'react'
import { rowPill } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useOrigin } from '~/lib/use-origin.ts'

type Side = { id: string; displayName: string; createdAt: string }

export type SetAsideRow = {
  keep: Side
  absorb: Side
  setAsideAt: string
}

export type SetAsideListProps = {
  account: string
  object: 'contact' | 'company'
  pairs: SetAsideRow[]
  /** The most the server returns, so a full list says it may stop there. */
  limit: number
}

/** The pairs Reject set aside, with Put back on each. A put-back pair leaves this
 *  list at once and reappears in the queue on the next visit, which is the same
 *  rule the queue follows for Reject. */
export const SetAsideList = ({ account, object, pairs, limit }: SetAsideListProps) => {
  const fmt = useFormat()
  const origin = useOrigin()
  const toast = useToast()
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const keyOf = (pair: SetAsideRow) => `${pair.keep.id}:${pair.absorb.id}`
  const visible = pairs.filter((pair) => !hidden.has(keyOf(pair)))

  /** Hidden the moment it is clicked and written behind that, the same as Reject. */
  const putBack = async (pair: SetAsideRow) => {
    const key = keyOf(pair)
    setHidden((all) => new Set(all).add(key))
    try {
      await api.crm.records.putBackDuplicate.mutate({ object, leftId: pair.keep.id, rightId: pair.absorb.id })
    } catch (cause) {
      setHidden((all) => {
        const next = new Set(all)
        next.delete(key)
        return next
      })
      toast('error', errorMessage(cause))
    }
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        title={pairs.length === 0 ? 'Nothing set aside' : 'Nothing left set aside'}
        description="Pairs you reject land here. Put one back to see it in the queue again."
      />
    )
  }

  const columns: Column<SetAsideRow>[] = [
    {
      key: 'records',
      header: object === 'company' ? 'Company' : 'Contact',
      width: 320,
      render: (pair) => (
        <span className="flex min-w-0 flex-col gap-1 py-2">
          {[pair.keep, pair.absorb].map((side) => (
            <Link
              key={side.id}
              href={recordPath(account, object, side.id, { from: origin })}
              title={side.displayName}
              className="block truncate font-semibold"
            >
              {side.displayName}
            </Link>
          ))}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Create date',
      width: 180,
      render: (pair) => (
        <span className="flex flex-col gap-1 py-2 whitespace-nowrap">
          <span>{fmt.date(pair.keep.createdAt)}</span>
          <span>{fmt.date(pair.absorb.createdAt)}</span>
        </span>
      ),
    },
    {
      key: 'setAside',
      header: 'Set aside',
      width: 160,
      render: (pair) => <span className="py-2 whitespace-nowrap">{fmt.date(pair.setAsideAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      width: 120,
      render: (pair) => (
        <span className="flex py-2">
          <button type="button" className={rowPill} onClick={() => void putBack(pair)}>
            Put back
          </button>
        </span>
      ),
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-secondary tabular-nums">
        {fmt.number(visible.length)} set aside
        {pairs.length >= limit ? `, the ${fmt.number(limit)} most recent` : ''}
      </p>
      <DataTable
        columns={columns}
        rows={visible}
        rowKey={keyOf}
        caption={`Set aside ${object === 'company' ? 'companies' : 'contacts'}`}
        storageKey="duplicates.set-aside"
      />
    </div>
  )
}
