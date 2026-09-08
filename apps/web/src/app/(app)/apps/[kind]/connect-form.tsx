'use client'

import { Alert, Button, Field, IconButton, TextInput, cn, useToast } from '@rawr/ui'
import { Check, Copy } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { IntegrationKind } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'
import { sitesPath } from '~/lib/links.ts'

export type ConnectFormProps = {
  kind: IntegrationKind
  name: string
  hasSecret: boolean
  secretLabel: string | null
  configFields: { key: string; label: string; hint: string }[]
  setup: string[]
  config: Record<string, unknown>
  webhookBase: string
  /** Null until a tracked site exists; the webhook URL cannot be built without one. */
  siteKey: string | null
  canWrite: boolean
}

/** Providers that send Rawr webhooks. The URL is generated rather than documented
 *  because it carries the account key, which a person cannot be expected to
 *  assemble by hand. */
const WEBHOOK_SOURCES = new Set<IntegrationKind>(['brevo', 'apollo', 'clay', 'woodpecker'])

/** The two that prove themselves with a token in the URL rather than a signature,
 *  so their webhook URL cannot be shown until one has been minted. */
const TOKEN_SOURCES = new Set<IntegrationKind>(['brevo', 'woodpecker'])

/** The settings tab of a shared app: the credential, whatever else the provider
 *  needs, and the webhook URL to paste back at it. Saving runs the connection
 *  test, which is what F6 §1 asks for: nobody should have to remember a second
 *  button to find out whether it works. */
export const ConnectForm = (props: ConnectFormProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState('')
  const [config, setConfig] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(props.config).map(([key, value]) => [key, String(value ?? '')])),
  )
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  // Says "Copied" for a moment. A toast for something this small is more
  // interruption than it is worth.
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const webhookToken = typeof props.config.webhookToken === 'string' ? props.config.webhookToken : null
  const webhookUrl = (key: string) => `${props.webhookBase}/w/${props.kind}?w=${key}${webhookToken ? `&t=${webhookToken}` : ''}`

  const save = async () => {
    setBusy(true)
    try {
      await api.integrations.save.mutate({
        kind: props.kind,
        config: Object.fromEntries(Object.entries(config).filter(([, value]) => value !== '')),
        // Left blank means "leave the stored key alone", so saving a config change
        // does not require re-typing a credential nobody can read back.
        ...(secret ? { secret } : {}),
      })
      const test = await api.integrations.test.mutate({ kind: props.kind }).catch((cause: unknown) => ({
        ok: false,
        detail: errorMessage(cause),
      }))
      setResult(test)
      setSecret('')
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!props.canWrite ? (
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          Only a super admin can change how {props.name} is connected. You can see what is set.
        </p>
      ) : null}

      <ol className="flex list-decimal flex-col gap-1 pl-5 text-secondary">
        {props.setup.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      {props.secretLabel ? (
        <Field
          id={`secret-${props.kind}`}
          label={props.secretLabel}
          hint={
            props.hasSecret
              ? 'A key is stored. Leave this blank to keep it, or paste a new one to replace it. It is never shown again.'
              : 'Encrypted with a key held outside this database, and never shown again after saving.'
          }
        >
          <TextInput
            id={`secret-${props.kind}`}
            type="password"
            autoComplete="off"
            value={secret}
            disabled={!props.canWrite}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
      ) : null}

      {props.configFields.map((field) => (
        <Field key={field.key} id={`config-${props.kind}-${field.key}`} label={field.label} hint={field.hint}>
          <TextInput
            id={`config-${props.kind}-${field.key}`}
            value={config[field.key] ?? ''}
            disabled={!props.canWrite}
            onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value }))}
          />
        </Field>
      ))}

      {WEBHOOK_SOURCES.has(props.kind) ? (
        TOKEN_SOURCES.has(props.kind) && !webhookToken ? (
          <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
            Save once and the webhook URL appears here with the token {props.name} will present.
          </p>
        ) : props.siteKey ? (
          <Field
            id={`webhook-${props.kind}`}
            label="Webhook URL to paste at the provider"
            hint="Carries the account key. Requests without a valid signature are refused and counted against this app's health."
          >
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                id={`webhook-${props.kind}`}
                readOnly
                className="min-w-0 flex-1"
                value={webhookUrl(props.siteKey)}
                onFocus={(event) => event.currentTarget.select()}
              />
              <IconButton
                label={copied ? 'Copied' : 'Copy the webhook URL'}
                icon={copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
                tone={copied ? 'accent' : 'default'}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(webhookUrl(props.siteKey as string))
                    .then(() => setCopied(true))
                    .catch(() => toast('error', 'Could not copy. Select the field and copy it by hand.'))
                }
              />
            </div>
          </Field>
        ) : (
          <Alert tone="warning">
            The webhook URL needs a tracked site to name this account.{' '}
            <Link href={sitesPath()}>Add one under Tracked sites</Link>, then come back.
          </Alert>
        )
      ) : null}

      {props.canWrite ? (
        <div>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {props.hasSecret ? 'Save and test' : 'Connect and test'}
          </Button>
        </div>
      ) : null}

      {result ? (
        <p role="status" className={cn('border-t border-divider pt-3', result.ok ? 'text-success' : 'text-error')}>
          {result.detail}
        </p>
      ) : null}
    </div>
  )
}
