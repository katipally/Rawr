'use client'

import { Button, Field, TextInput, cn, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { HealthState, IntegrationKind } from '@rawr/db'
import type { IntegrationMeta } from '~/server/integrations/index.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
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
const HEALTH: Record<HealthState, { label: string; tone: 'ok' | 'warn' | 'error' | 'muted'; hint: string }> = {
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
  not_configured: { label: 'Not configured', tone: 'muted', hint: 'No credential has been saved yet.' },
}

/** Providers that send Rawr webhooks. The URL is generated rather than documented
 *  because it carries the workspace key, which a person cannot be expected to
 *  assemble by hand. */
const WEBHOOK_SOURCES = new Set<IntegrationKind>(['brevo', 'apollo', 'clay'])

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

  useEffect(() => {
    if (openKind) document.getElementById(`integration-${openKind}`)?.scrollIntoView({ block: 'start' })
  }, [openKind])

  const webhookUrl = (row: IntegrationView, key: string) =>
    `${webhookBase}/w/${row.kind}?w=${key}${row.kind === 'brevo' ? `&t=${String(row.config.webhookToken)}` : ''}`

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

      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const health = HEALTH[row.state]
          const isOpen = editing === row.kind

          return (
            <li key={row.kind} id={`integration-${row.kind}`} className="rounded-panel border border-line bg-surface">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{row.meta.name}</span>
                    <span
                      className={cn(
                        'rounded-hs px-1.5 py-0.5 text-small',
                        health.tone === 'ok' && 'bg-success-subtle text-success',
                        health.tone === 'warn' && 'bg-warning-subtle text-warning',
                        health.tone === 'error' && 'bg-error-subtle text-error',
                        health.tone === 'muted' && 'bg-fill text-secondary',
                      )}
                    >
                      {health.label}
                    </span>
                    {row.meta.rows.map((notionRow) => (
                      <span key={notionRow} className="rounded-hs bg-fill px-1.5 py-0.5 text-small text-secondary">
                        {notionRow}
                      </span>
                    ))}
                  </p>
                  <p className="text-secondary">{row.meta.purpose}</p>
                  <p className="text-small text-secondary">{health.hint}</p>
                  <p className="text-small text-secondary">
                    {row.lastOkAt ? `Last succeeded ${formatDateTime(row.lastOkAt)}.` : 'Never succeeded yet.'}
                    {row.deadLetters > 0
                      ? ` ${row.deadLetters} failure${row.deadLetters === 1 ? '' : 's'} waiting to be replayed.`
                      : ''}
                  </p>
                  {row.lastError ? (
                    <p role="alert" className="break-words text-small text-error">
                      {row.lastError}
                      {row.lastErrorAt ? ` (${formatDateTime(row.lastErrorAt)})` : ''}
                    </p>
                  ) : null}
                  <p className="text-small text-secondary">
                    <span className="font-medium">When it is down:</span> {row.meta.failureMode}
                  </p>
                </div>

                {canWrite ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
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
                  className={cn(
                    'border-t border-divider px-3 py-2',
                    result.ok ? 'text-success' : 'text-error',
                  )}
                >
                  {result.detail}
                </p>
              ) : null}

              {isOpen && canWrite ? (
                <div className="flex flex-col gap-3 border-t border-divider px-3 py-3">
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
                    row.kind === 'brevo' && typeof row.config.webhookToken !== 'string' ? (
                      <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
                        Save once and the webhook URL appears here with the token Brevo will present.
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
                          <Button
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(webhookUrl(row, siteKey))
                                .then(() => toast('success', 'Copied.'))
                                .catch(() => toast('error', 'Could not copy. Select the field and copy it by hand.'))
                            }
                          >
                            Copy
                          </Button>
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
            </li>
          )
        })}
      </ul>

      <section className="flex flex-col gap-2">
        <div className="max-w-2xl">
          <h3 className="font-medium">Events with nobody to attach them to</h3>
          <p className="text-secondary">
            A tracked open or click for an address no contact holds. Kept rather than dropped,
            because &ldquo;nobody opened it&rdquo; and &ldquo;we could not tell who opened it&rdquo;
            are different answers. Rematching picks up anyone who has since become a contact.
          </p>
        </div>

        {unmatched.length === 0 ? (
          <p className="text-secondary">Every event that arrived matched a contact.</p>
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
            <ul className="flex flex-col rounded-panel border border-line bg-surface">
              {unmatched.map((row) => (
                <li key={row.id} className="border-b border-divider px-3 py-1.5 last:border-0">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">
                      {(row.payload as { email?: string }).email ?? 'an unknown address'}
                    </span>
                    <span className="text-small text-secondary">
                      {row.kind} via {row.source} · {formatDateTime(row.at)}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
