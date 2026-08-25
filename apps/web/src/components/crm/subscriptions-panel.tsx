'use client'

import { Select, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

export type SubscriptionRow = {
  typeId: string
  name: string
  description: string | null
  isInternal: boolean
  state: 'subscribed' | 'unsubscribed' | 'unspecified'
}

export type SubscriptionsPanelProps = {
  contactId: string
  contactName: string
  rows: SubscriptionRow[]
  canWrite: boolean
}

const LABELS: Record<SubscriptionRow['state'], string> = {
  subscribed: 'Subscribed',
  unsubscribed: 'Unsubscribed',
  unspecified: 'Not specified',
}

/** Three states, and "not specified" is one of them. A contact who has never said
 *  anything reads as exactly that, never as subscribed, never as unsubscribed,
 *  never as blank. D15, A2. */
export const SubscriptionsPanel = ({ contactId, contactName, rows, canWrite }: SubscriptionsPanelProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  const allUnspecified = rows.every((row) => row.state === 'unspecified')

  const set = async (typeId: string, state: SubscriptionRow['state']) => {
    setBusy(typeId)
    try {
      await api.crm.subscriptions.set.mutate({ contactId, typeId, state })
      toast('success', 'Preference recorded. Rawr is the authoritative copy of it.')
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-panel border border-line bg-surface">
      <h3 className="border-b border-divider px-3 py-2 font-medium">Communication preferences</h3>

      {allUnspecified ? (
        <p className="px-3 pt-2 text-secondary">{contactName} has not specified any preferences.</p>
      ) : null}

      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={row.typeId} className="flex flex-wrap items-center gap-2 border-b border-divider px-3 py-2 last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block break-words font-medium">{row.name}</span>
              {row.description ? <span className="block text-secondary">{row.description}</span> : null}
            </span>

            {canWrite ? (
              <Select
                aria-label={`${row.name} preference`}
                value={row.state}
                disabled={busy === row.typeId}
                onChange={(event) => void set(row.typeId, event.target.value as SubscriptionRow['state'])}
                className="w-auto min-w-36"
              >
                <option value="unspecified">Not specified</option>
                <option value="subscribed">Subscribed</option>
                <option value="unsubscribed">Unsubscribed</option>
              </Select>
            ) : (
              <span className="text-secondary">{LABELS[row.state]}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
