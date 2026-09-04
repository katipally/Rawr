'use client'

import type { SequenceRow } from '@rawr/db'
import { Badge, Button, Card, EmptyState, Field, Modal, TextArea, TextInput, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { sequencePath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

const STATE_TONE = {
  draft: 'neutral',
  active: 'ok',
  paused: 'warn',
  archived: 'neutral',
} as const

/** A rate over a count, because "12 opened" means nothing without how many went
 *  out, and 0 of 0 is not 0%. */
const rate = (part: number, whole: number): string => (whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`)

export const SequenceList = ({
  workspace,
  rows,
  canWrite,
  role,
}: {
  workspace: string
  rows: SequenceRow[]
  canWrite: boolean
  role: string
}) => {
  const router = useRouter()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '' })
  const [busy, setBusy] = useState(false)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {canWrite ? (
        <div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create sequence
          </Button>
        </div>
      ) : (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Your role ({role}) can read these and cannot change them.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No sequences yet"
          description="A sequence is a run of steps with a wait between them. The first one takes a couple of minutes to write."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <Card
              key={row.id}
              title={
                <Link href={sequencePath(workspace, row.id)} className="no-underline">
                  {row.name}
                </Link>
              }
              action={<Badge tone={STATE_TONE[row.state]} dot>{row.state}</Badge>}
            >
              <div className="flex flex-col gap-2">
                {row.description ? <p className="text-secondary">{row.description}</p> : null}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  <div>
                    <dt className="text-small text-secondary">In flight</dt>
                    <dd className="tabular-nums">{row.stats.active}</dd>
                  </div>
                  <div>
                    <dt className="text-small text-secondary">Sent</dt>
                    <dd className="tabular-nums">{row.stats.sent}</dd>
                  </div>
                  <div>
                    <dt className="text-small text-secondary">Opened</dt>
                    <dd className="tabular-nums">{rate(row.stats.opened, row.stats.sent)}</dd>
                  </div>
                  <div>
                    <dt className="text-small text-secondary">Replied</dt>
                    <dd className="tabular-nums">{rate(row.stats.replied, row.stats.sent)}</dd>
                  </div>
                </dl>
                <p className="text-small text-secondary">
                  {row.stepCount} step{row.stepCount === 1 ? '' : 's'}
                  {row.ownerName ? ` · ${row.ownerName}` : ''}
                  {row.stats.bounced > 0 ? ` · ${row.stats.bounced} bounced` : ''}
                  {row.stats.unsubscribed > 0 ? ` · ${row.stats.unsubscribed} unsubscribed` : ''}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating ? (
        <Modal open title="Create a sequence" onClose={() => setCreating(false)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              setBusy(true)
              void api.sequences.save
                .mutate({ name: draft.name.trim(), description: draft.description.trim() || null })
                .then((created) => {
                  toast('success', 'Add the steps next. Nothing sends until you turn it on.')
                  router.push(sequencePath(workspace, created.id))
                })
                .catch((cause) => toast('error', errorMessage(cause)))
                .finally(() => setBusy(false))
            }}
          >
            <Field label="Name" id="sequence-name" required>
              <TextInput
                id="sequence-name"
                required
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="What it is for" id="sequence-description" hint="Optional. Only your team sees it.">
              <TextArea
                id="sequence-description"
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" type="button" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" busy={busy} disabled={draft.name.trim() === ''}>
                Create
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  )
}
