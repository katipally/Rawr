'use client'

import { Badge, Button, Card, EmptyState, Field, IconButton, TextInput, cn, useToast } from '@rawr/ui'
import { Check, Copy } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { HealthState, IntegrationKind } from '@rawr/db'
import type { IntegrationMeta } from '~/server/integrations/index.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { INTEGRATION_ICONS } from '~/components/icons.ts'
import { sitesPath } from '~/lib/links.ts'
import Link from 'next/link'

export type IntegrationView = {
  kind: IntegrationKind
  meta: IntegrationMeta
  config: Record<string, unknown>
  hasSecret: boolean
  state: HealthState
  lastOkAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  deadLetters: number
}

export type UnmatchedRow = { id: string; source: string; kind: string; payload: unknown; at: string }

export type IntegrationPanelProps = {
  rows: IntegrationView[]
  unmatched: UnmatchedRow[]
  webhookBase: string
  /** Null until a tracked site exists; the webhook URL cannot be built without one. */
  siteKey: string | null
  canWrite: boolean
  role: string
  /** A provider to land on with its form open, from a "connect" link elsewhere. */
  openKind: IntegrationKind | null
}

/** F6 §1's four states, and what each one tells a person to do next. */
const HEALTH: Record<HealthState, { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral'; hint: string }> = {
  connected: { label: 'Connected', tone: 'ok', hint: 'Working, and it has answered recently.' },
  degraded: {
    label: 'Degraded',
    tone: 'warn',
    hint: 'Still configured, but the last call failed or nothing has succeeded lately. Work is queued and retried.',
  },
  disconnected: {
    label: 'Disconnected',
    tone: 'error',
    hint: 'The provider rejected the credential. Retrying has stopped; a new key is what fixes this.',
  },
  not_configured: { label: 'Not configured', tone: 'neutral', hint: 'No credential has been saved yet.' },
}

/** Providers that send Rawr webhooks. The URL is generated rather than documented
 *  because it carries the workspace key, which a person cannot be expected to
 *  assemble by hand. */
const WEBHOOK_SOURCES = new Set<IntegrationKind>(['brevo', 'apollo', 'clay', 'woodpecker'])

/** The two that prove themselves with a token in the URL rather than a signature,
 *  so their webhook URL cannot be shown until one has been minted. */
const TOKEN_SOURCES = new Set<IntegrationKind>(['brevo', 'woodpecker'])

export const IntegrationPanel = ({
  rows,
  unmatched,
  webhookBase,
  siteKey,
  canWrite,
  role,
  openKind,
}: IntegrationPanelProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  // A "connect Apollo" link from a record lands with that provider's form open.
  const opened = openKind ? rows.find((row) => row.kind === openKind) : null
  const [editing, setEditing] = useState<IntegrationKind | null>(canWrite && opened ? opened.kind : null)
  const [secret, setSecret] = useState('')
  const [config, setConfig] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(opened?.config ?? {}).map(([key, value]) => [key, String(value ?? '')])),
  )
  const [result, setResult] = useState<{ kind: IntegrationKind; ok: boolean; detail: string } | null>(null)
  // Which provider's webhook URL was just copied, so the button can say so for a
  // moment. A toast for something this small is more interruption than it is worth.
  const [copied, setCopied] = useState<IntegrationKind | null>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (openKind) document.getElementById(`integration-${openKind}`)?.scrollIntoView({ block: 'start' })
  }, [openKind])

  const webhookUrl = (row: IntegrationView, key: string) =>
    `${webhookBase}/w/${row.kind}?w=${key}${typeof row.config.webhookToken === 'string' ? `&t=${row.config.webhookToken}` : ''}`

  const open = (row: IntegrationView) => {
    setEditing(row.kind)
    setSecret('')
    setConfig(Object.fromEntries(Object.entries(row.config).map(([key, value]) => [key, String(value ?? '')])))
    setResult(null)
  }

  const run = async (kind: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(kind)
    try {
      await fn()
      if (done) toast('success', done)
      router.refresh()
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(null)
    }
  }

  const save = async (row: IntegrationView) => {
    const ok = await run(row.kind, () =>
      api.integrations.save.mutate({
        kind: row.kind,
        config: Object.fromEntries(Object.entries(config).filter(([, value]) => value !== '')),
        // Left blank means "leave the stored key alone", so saving a config change
        // does not require re-typing a credential nobody can read back.
        ...(secret ? { secret } : {}),
      }),
    )
    if (!ok) return
    // The test runs on save, which is what F6 §1 asks for: nobody should have to
    // remember to press a second button to find out whether it works.
    const test = await api.integrations.test.mutate({ kind: row.kind }).catch((cause: unknown) => ({
      ok: false,
      detail: errorMessage(cause),
    }))
    setResult({ kind: row.kind, ...test })
    setSecret('')
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-4">
      {!canWrite ? (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Your role ({role}) can see the health of every integration and cannot change credentials.
        </p>
      ) : null}

      <ul className="grid gap-3 @3xl:grid-cols-2">
        {rows.map((row) => {
          const health = HEALTH[row.state]
          const isOpen = editing === row.kind
          const Icon = INTEGRATION_ICONS[row.kind]

          return (
            <li
              key={row.kind}
              id={`integration-${row.kind}`}
              className={cn('min-w-0', isOpen && '@3xl:col-span-2')}
            >
              <Card
                className="h-full"
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-secondary" />
                    <span className="min-w-0 truncate">{row.meta.name}</span>
                  </span>
                }
                action={
                  <Badge tone={health.tone} dot>
                    {health.label}
                  </Badge>
                }
              >
                <div className="flex flex-col gap-2">
                  <p className="text-secondary">{row.meta.purpose}</p>

                  {row.meta.rows.length > 0 ? (
                    <p className="flex flex-wrap gap-1">
                      {row.meta.rows.map((notionRow) => (
                        <Badge key={notionRow}>{notionRow}</Badge>
                      ))}
                    </p>
                  ) : null}

                  <dl className="flex flex-col gap-0.5 text-small text-secondary">
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="font-medium">State</dt>
                      <dd className="min-w-0">{health.hint}</dd>
                    </div>
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="font-medium">Last success</dt>
                      <dd className="min-w-0">
                        {row.lastOkAt ? formatDateTime(row.lastOkAt) : 'Never yet'}
                        {row.deadLetters > 0
                          ? ` · ${row.deadLetters} failure${row.deadLetters === 1 ? '' : 's'} waiting to be replayed`
                          : ''}
                      </dd>
                    </div>
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="font-medium">When it is down</dt>
                      <dd className="min-w-0">{row.meta.failureMode}</dd>
                    </div>
                  </dl>

                  {row.lastError ? (
                    <p role="alert" className="break-words text-small text-error">
                      {row.lastError}
                      {row.lastErrorAt ? ` (${formatDateTime(row.lastErrorAt)})` : ''}
                    </p>
                  ) : null}

                  {canWrite ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        busy={busy === row.kind}
                        onClick={() =>
                          void run(row.kind, async () => {
                            const test = await api.integrations.test.mutate({ kind: row.kind })
                            setResult({ kind: row.kind, ...test })
                          })
                        }
                      >
                        Test
                      </Button>
                      <Button variant="tertiary" onClick={() => (isOpen ? setEditing(null) : open(row))}>
                        {isOpen ? 'Close' : row.hasSecret ? 'Change' : 'Connect'}
                      </Button>
                      {row.hasSecret ? (
                        <Button
                          variant="destructive"
                          busy={busy === row.kind}
                          onClick={() =>
                            void run(
                              row.kind,
                              () => api.integrations.disconnect.mutate({ kind: row.kind }),
                              'Disconnected. Nothing is sent to it any more.',
                            )
                          }
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {result?.kind === row.kind ? (
                  <p
                    role="status"
                    className={cn('mt-3 border-t border-divider pt-3', result.ok ? 'text-success' : 'text-error')}
                  >
                    {result.detail}
                  </p>
                ) : null}

                {isOpen && canWrite ? (
                  <div className="mt-3 flex flex-col gap-3 border-t border-divider pt-3">
                  <ol className="flex list-decimal flex-col gap-1 pl-5 text-secondary">
                    {row.meta.setup.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  {row.meta.secretLabel ? (
                    <Field
                      id={`secret-${row.kind}`}
                      label={row.meta.secretLabel}
                      hint={
                        row.hasSecret
                          ? 'A key is stored. Leave this blank to keep it, or paste a new one to replace it. It is never shown again.'
                          : 'Encrypted with a key held outside this database, and never shown again after saving.'
                      }
                    >
                      <TextInput
                        id={`secret-${row.kind}`}
                        type="password"
                        autoComplete="off"
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                      />
                    </Field>
                  ) : (
                    <p className="text-secondary">
                      This one has no workspace-level credential. {row.meta.failureMode}
                    </p>
                  )}

                  {row.meta.configFields.map((field) => (
                    <Field key={field.key} id={`config-${row.kind}-${field.key}`} label={field.label} hint={field.hint}>
                      <TextInput
                        id={`config-${row.kind}-${field.key}`}
                        value={config[field.key] ?? ''}
                        onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value }))}
                      />
                    </Field>
                  ))}

                  {WEBHOOK_SOURCES.has(row.kind) ? (
                    TOKEN_SOURCES.has(row.kind) && typeof row.config.webhookToken !== 'string' ? (
                      <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
                        Save once and the webhook URL appears here with the token {row.meta.name} will present.
                      </p>
                    ) : siteKey ? (
                      <Field
                        id={`webhook-${row.kind}`}
                        label="Webhook URL to paste at the provider"
                        hint="Carries the workspace key. Requests without a valid signature are refused and counted against this integration's health."
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <TextInput
                            id={`webhook-${row.kind}`}
                            readOnly
                            className="min-w-0 flex-1"
                            value={webhookUrl(row, siteKey)}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                          <IconButton
                            label={copied === row.kind ? 'Copied' : 'Copy the webhook URL'}
                            icon={copied === row.kind ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
                            tone={copied === row.kind ? 'accent' : 'default'}
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(webhookUrl(row, siteKey))
                                .then(() => setCopied(row.kind))
                                .catch(() => toast('error', 'Could not copy. Select the field and copy it by hand.'))
                            }
                          />
                        </div>
                      </Field>
                    ) : (
                      <p className="rounded-hs border border-warning bg-warning-subtle px-3 py-2">
                        The webhook URL needs a tracked site to name this workspace.{' '}
                        <Link href={sitesPath()}>Add one under Tracked sites</Link>, then come back.
                      </p>
                    )
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" busy={busy === row.kind} onClick={() => void save(row)}>
                      Save and test
                    </Button>
                      <Button variant="tertiary" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Card>
            </li>
          )
        })}
      </ul>

      <Card title="Events with nobody to attach them to" action={<Badge>{String(unmatched.length)}</Badge>}>
        <div className="flex flex-col gap-3">
          <p className="max-w-prose text-secondary">
            A tracked open or click for an address no contact holds. Kept rather than dropped,
            because &ldquo;nobody opened it&rdquo; and &ldquo;we could not tell who opened it&rdquo;
            are different answers. Rematching picks up anyone who has since become a contact.
          </p>

          {unmatched.length === 0 ? (
            <EmptyState
              title="Everything found an owner"
              description="Every event that arrived matched a contact. Anything that cannot be matched will wait here."
            />
          ) : (
            <>
              <div>
                <Button
                  busy={busy === 'rematch'}
                  onClick={() =>
                    void run('rematch', async () => {
                      const outcome = await api.integrations.rematch.mutate()
                      toast('info', `${outcome.matched} event${outcome.matched === 1 ? '' : 's'} found an owner.`)
                    })
                  }
                >
                  Try matching again
                </Button>
              </div>
              <ul className="flex flex-col rounded-panel border border-line">
                {unmatched.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-divider px-3 py-1.5 last:border-0">
                    <span className="min-w-0 font-medium">
                      {(row.payload as { email?: string }).email ?? 'an unknown address'}
                    </span>
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
    </div>
  )
}
