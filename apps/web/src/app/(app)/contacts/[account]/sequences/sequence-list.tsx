'use client'

import type { SequenceRow } from '@rawr/db'
import { Badge, Button, Card, EmptyState, Field, Modal, NOTHING_MATCHED, TextArea, TextInput, useToast, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { usePagedRows } from '~/components/paged.tsx'
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

/** Archived is deliberately not one: an archived sequence is out of the way, and
 *  the tab that shows it is "All". */
const FILTERS: (string | null)[] = [null, 'draft', 'active', 'paused', 'archived']

export const SequenceList = ({
  account,
  rows,
  canWrite,
  hub,
}: {
  account: string
  rows: SequenceRow[]
  canWrite: boolean
  hub: string
}) => {
  const router = useRouter()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [state, setState] = useState<string | null>(null)
  const [needle, setNeedle] = useState('')
  const [draft, setDraft] = useState({ name: '', description: '' })
  const [busy, setBusy] = useState(false)

  // Filtered here rather than refetched: the whole list is already on the page,
  // and an account has tens of sequences, not thousands.
  const wanted = needle.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (state === null || row.state === state) &&
      (wanted === '' ||
        row.name.toLowerCase().includes(wanted) ||
        (row.description ?? '').toLowerCase().includes(wanted) ||
        (row.ownerName ?? '').toLowerCase().includes(wanted)),
  )
  const { page, pager } = usePagedRows(shown, 'sequences')

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PageHeader
        title="Sequences"
        lead="A run of emails and tasks, sent from your own Gmail."
        why={
          <p>
            The mail comes from you and lands in the same conversation as everything else. A reply
            stops it on the sync that reads the reply.
          </p>
        }
        action={
          canWrite ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create sequence
            </Button>
          ) : undefined
        }
      />
      {canWrite ? null : (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          You need {hub} access to change these.
        </p>
      )}

      {rows.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((each) => (
            <Button
              key={each ?? 'all'}
              variant={state === each ? 'primary' : 'tertiary'}
              onClick={() => setState(each)}
            >
              {each === null ? `All (${rows.length})` : `${each} (${rows.filter((row) => row.state === each).length})`}
            </Button>
          ))}
          <div className="ml-auto min-w-48">
            <TextInput
              aria-label="Search sequences"
              placeholder="Search"
              value={needle}
              onChange={(event) => setNeedle(event.target.value)}
            />
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No sequences yet"
          description="A sequence is a run of steps with a wait between them. The first one takes a couple of minutes to write."
        />
      ) : shown.length === 0 ? (
        <EmptyState {...NOTHING_MATCHED} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {page.map((row) => (
            <Card
              key={row.id}
              title={
                <Link href={sequencePath(account, row.id)} className="no-underline">
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

      {pager}

      {creating ? (
        <Modal open title="Create sequence" onClose={() => setCreating(false)}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              setBusy(true)
              void api.sequences.save
                .mutate({ name: draft.name.trim(), description: draft.description.trim() || null })
                .then((created) => {
                  toast('success', 'Add the steps next. Nothing sends until you turn it on.')
                  router.push(sequencePath(account, created.id))
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
