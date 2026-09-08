'use client'

import { Badge, Button, Card, EmptyState, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formatDateTime } from '~/components/crm/value.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

export type UnmatchedRow = { id: string; source: string; kind: string; payload: unknown; at: string }

/** A tracked open or click for an address no contact holds. Kept rather than
 *  dropped, because "nobody opened it" and "we could not tell who opened it" are
 *  different answers. */
export const UnmatchedPanel = ({ rows }: { rows: UnmatchedRow[] }) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const rematch = async () => {
    setBusy(true)
    try {
      const outcome = await api.integrations.rematch.mutate()
      toast('info', `${outcome.matched} event${outcome.matched === 1 ? '' : 's'} found an owner.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Events with nobody to attach them to" action={<Badge>{String(rows.length)}</Badge>}>
      <div className="flex flex-col gap-3">
        <p className="max-w-prose text-secondary">
          Rematching picks up anyone who has since become a contact.
        </p>
        {rows.length === 0 ? (
          <EmptyState
            title="Everything found an owner"
            description="Every event that arrived matched a contact. Anything that cannot be matched will wait here."
          />
        ) : (
          <>
            <div>
              <Button busy={busy} onClick={() => void rematch()}>
                Try matching again
              </Button>
            </div>
            <ul className="flex flex-col rounded-panel border border-line">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-divider px-3 py-1.5 last:border-0">
                  <span className="min-w-0 font-medium">{(row.payload as { email?: string }).email ?? 'an unknown address'}</span>
                  <span className="text-small text-secondary">
                    {row.kind} via {row.source} · {formatDateTime(row.at)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  )
}
