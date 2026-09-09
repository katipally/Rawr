'use client'

import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Modal, Switch, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

export type EndpointView = {
  id: string
  name: string
  url: string
  events: string[]
  isActive: boolean
  lastOkAt: string | null
  lastStatus: number | null
  lastError: string | null
  lastErrorAt: string | null
}

export type WebhookPanelProps = {
  rows: EndpointView[]
  events: string[]
  canWrite: boolean
}

/** The other direction: what Rawr tells somebody else.
 *
 *  Health is the point of the list, not the URL. An endpoint that quietly stopped
 *  receiving looks exactly like one that was never called, so every row leads
 *  with what the last delivery answered. */
const health = (row: EndpointView, zone: string): { tone: 'ok' | 'warn' | 'error' | 'neutral'; text: string } => {
  if (!row.isActive) return { tone: 'neutral', text: 'off' }
  if (row.lastError) {
    return {
      tone: 'error',
      text: `failing since ${row.lastErrorAt ? formatDateTime(row.lastErrorAt, zone) : 'recently'}`,
    }
  }
  if (row.lastOkAt) return { tone: 'ok', text: `last delivered ${formatDateTime(row.lastOkAt, zone)}` }
  return { tone: 'warn', text: 'nothing sent yet' }
}

export const WebhookPanel = ({ rows, events, canWrite }: WebhookPanelProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  /** 'new', or the endpoint being changed. One form for both: a URL that moves
   *  used to mean delete and recreate, which rolls the signing key and takes the
   *  receiver down until somebody redeploys it. */
  const [composing, setComposing] = useState<'new' | EndpointView | null>(null)
  const [removing, setRemoving] = useState<EndpointView | null>(null)
  /** Shown once and never again, so it is state rather than anything read back. */
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [wanted, setWanted] = useState<string[]>([])

  const run = async (what: () => Promise<unknown>, said: string) => {
    setBusy(true)
    try {
      await what()
      toast('success', said)
      router.refresh()
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const open = (what: 'new' | EndpointView) => {
    setComposing(what)
    setName(what === 'new' ? '' : what.name)
    setUrl(what === 'new' ? '' : what.url)
    setWanted(what === 'new' ? [] : what.events)
  }

  const close = () => {
    setComposing(null)
    setName('')
    setUrl('')
    setWanted([])
  }

  const submit = async () => {
    setBusy(true)
    try {
      if (composing === 'new') {
        const made = await api.integrations.webhooks.create.mutate({ name, url, events: wanted })
        // The key is shown once, so this modal closes into the one that shows it.
        setIssued({ name, secret: made.secret })
      } else if (composing) {
        await api.integrations.webhooks.update.mutate({ id: composing.id, name, url, events: wanted })
        toast('success', 'Saved. The signing key is unchanged.')
      }
      close()
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Outgoing webhooks"
      action={
        canWrite ? (
          <Button onClick={() => open('new')}>Add an endpoint</Button>
        ) : null
      }
    >
      <p className="mb-3 text-secondary">
        Rawr posts to these when something happens here, signed so the receiver can prove it came
        from us. A delivery that fails is on the Failed jobs screen and can be replayed from there.
      </p>

      {issued ? (
        <div className="mb-3 rounded-panel border border-line-interactive bg-accent-subtle p-4">
          <p className="font-medium">Copy the signing key for {issued.name} now. It is not shown again.</p>
          <code className="mt-2 block overflow-x-auto rounded-hs bg-surface p-3 text-small break-all">
            {issued.secret}
          </code>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(issued.secret)
                  .then(() => toast('success', 'Signing key copied.'))
                  .catch(() => toast('error', 'The clipboard refused. Select it and copy by hand.'))
              }
            >
              Copy the key
            </Button>
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing is subscribed"
          description="An endpoint gets a signed POST whenever a record is created, a deal moves, a lifecycle stage changes or a form is filled."
        />
      ) : (
        <ul className="flex flex-col rounded-panel border border-line bg-surface">
          {rows.map((row) => {
            const state = health(row, zone)
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{row.name}</span>
                    <Badge tone={state.tone}>{state.text}</Badge>
                    {row.lastStatus ? (
                      <span className="text-small text-secondary tabular-nums">HTTP {row.lastStatus}</span>
                    ) : null}
                  </p>
                  <p className="truncate text-small text-secondary" title={row.url}>
                    {row.url}
                  </p>
                  <p className="text-small text-secondary">
                    {row.events.length === 0 ? 'every event' : row.events.join(', ')}
                  </p>
                  {row.lastError ? <p className="text-small text-error">{row.lastError}</p> : null}
                </div>

                {canWrite ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={row.isActive}
                      label={row.isActive ? 'On' : 'Off'}
                      onChange={(event) => {
                        const isActive = event.target.checked
                        void run(
                          () => api.integrations.webhooks.update.mutate({ id: row.id, isActive }),
                          isActive ? 'Sending again.' : 'Stopped.',
                        )
                      }}
                    />
                    <Button variant="tertiary" onClick={() => open(row)}>
                      Edit
                    </Button>
                    <Button
                      variant="tertiary"
                      busy={busy}
                      onClick={() =>
                        void api.integrations.webhooks.rollSecret
                          .mutate({ id: row.id })
                          .then((secret) => setIssued({ name: row.name, secret }))
                          .catch((cause) => toast('error', errorMessage(cause)))
                      }
                    >
                      New key
                    </Button>
                    <IconButton
                      label={`Delete ${row.name}`}
                      tone="destructive"
                      icon={<ACTION_ICONS.delete size={16} />}
                      onClick={() => setRemoving(row)}
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <Modal
        open={composing !== null}
        onClose={close}
        title={composing === 'new' || composing === null ? 'Add an endpoint' : `Edit ${composing.name}`}
        footer={
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} disabled={!name.trim() || !url.trim()} onClick={() => void submit()}>
              {composing === 'new' ? 'Create' : 'Save'}
            </Button>
            <Button onClick={close}>Cancel</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="hook-name" label="Name" hint="What is at the other end, so the right one can be turned off later.">
            <TextInput id="hook-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field id="hook-url" label="URL" hint="https only, and reachable from the internet.">
            <TextInput
              id="hook-url"
              value={url}
              placeholder="https://example.com/hooks/rawr"
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>

          <fieldset className="min-w-0">
            <legend className="font-medium">Events</legend>
            <p className="mb-2 text-small text-secondary">
              Choose none to receive every event, including ones added later.
            </p>
            <div className="grid gap-1 @md:grid-cols-2">
              {events.map((event) => (
                <Checkbox
                  key={event}
                  label={event}
                  checked={wanted.includes(event)}
                  onChange={(changed) =>
                    setWanted((current) =>
                      changed.target.checked
                        ? [...current, event]
                        : current.filter((each) => each !== event),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>

          <Alert tone="info">
            The signing key is shown once, when the endpoint is created, and changing anything here
            leaves it alone. Verify a delivery by
            recomputing HMAC-SHA256 over <code>&lt;t&gt;.&lt;body&gt;</code> with it and comparing
            against the <code>rawr-signature</code> header, refusing anything whose{' '}
            <code>t</code> is far from your own clock.
          </Alert>
        </div>
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={`Delete ${removing?.name ?? ''}?`}
        footer={
          <div className="flex gap-2">
            <Button
              variant="destructive"
              busy={busy}
              onClick={() =>
                void run(
                  () => api.integrations.webhooks.remove.mutate({ id: removing!.id }),
                  'The endpoint was deleted.',
                ).then((ok) => ok && setRemoving(null))
              }
            >
              Delete
            </Button>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
          </div>
        }
      >
        <p>
          Nothing more is sent to {removing?.url}. Switching it off instead keeps the endpoint and
          its key, which is what you want if this is temporary.
        </p>
      </Modal>
    </Card>
  )
}
