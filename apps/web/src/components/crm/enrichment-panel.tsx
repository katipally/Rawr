'use client'

import { Button, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { integrationsPath, recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

export type Suggestion = {
  id: string
  fieldKey: string
  fieldLabel: string
  suggested: string
  current: string | null
  provider: string
  at: string
}

export type ProviderHealth = {
  state: 'connected' | 'degraded' | 'disconnected' | 'not_configured'
  lastError: string | null
}

export type EnrichmentPanelProps = {
  workspace: string
  object: 'contact' | 'company'
  recordId: string
  /** The contact whose email enrichment runs on. For a company this is the
   *  primary contact, because Apollo matches people, not domains. */
  enrichContactId: string | null
  email: string | null
  apolloUrl: string | null
  apollo: ProviderHealth
  clay: ProviderHealth
  /** How many tracking and sequence events are on this record's timeline. */
  tracked: number
  sequenced: number
  suggestions: Suggestion[]
  canWrite: boolean
}

const HEALTH: Record<ProviderHealth['state'], { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'text-success' },
  degraded: { label: 'Degraded', tone: 'text-warning' },
  disconnected: { label: 'Disconnected', tone: 'text-error' },
  not_configured: { label: 'Not connected', tone: 'text-secondary' },
}

/** F6 §3 and §4 on the record. Enrichment fills blanks and never overwrites a
 *  human; what it was not allowed to write waits here as a suggestion. Apollo's
 *  opens, clicks and sequence steps land on the timeline, and a degraded provider
 *  says so here rather than reading as "nobody opened anything". */
export const EnrichmentPanel = ({
  workspace,
  object,
  recordId,
  enrichContactId,
  email,
  apolloUrl,
  apollo,
  clay,
  tracked,
  sequenced,
  suggestions,
  canWrite,
}: EnrichmentPanelProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key)
    try {
      toast('success', await fn())
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const enrich = () =>
    run('enrich', async () => {
      if (!enrichContactId) throw new Error('Enrichment matches on a contact email, and this company has no contact yet.')
      const outcome = await api.integrations.enrich.mutate({ contactId: enrichContactId })
      const wrote = outcome.written.length
      const held = outcome.suggested.length
      return `${outcome.detail} ${wrote ? `Filled ${wrote} blank field${wrote === 1 ? '' : 's'}.` : ''} ${held ? `${held} value${held === 1 ? '' : 's'} held for review below.` : ''}`.trim()
    })

  const canEnrich = canWrite && apollo.state !== 'not_configured' && apollo.state !== 'disconnected'
  const timeline = recordPath(workspace, object, recordId, { tab: 'activity', type: 'email_tracking,sequence_activity' })

  return (
    <section className="rounded-panel border border-line bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
        <h3 className="font-medium">Enrichment and outreach</h3>
        {canEnrich ? (
          <Button onClick={() => void enrich()} busy={busy === 'enrich'} disabled={!email && object === 'contact'}>
            Enrich
          </Button>
        ) : null}
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-small">
        <dt className="text-secondary">Apollo</dt>
        <dd className={HEALTH[apollo.state].tone} title={apollo.lastError ?? undefined}>
          {HEALTH[apollo.state].label}
          {apollo.state === 'not_configured' ? (
            <>
              {' · '}
              <Link href={integrationsPath()}>connect</Link>
            </>
          ) : null}
        </dd>
        <dt className="text-secondary">Clay</dt>
        <dd className={HEALTH[clay.state].tone} title={clay.lastError ?? undefined}>
          {HEALTH[clay.state].label}
        </dd>
      </dl>

      {apollo.state === 'degraded' || apollo.state === 'disconnected' ? (
        <p className="border-t border-divider px-3 py-2 text-small text-warning">
          Recent opens, clicks and sequence steps may be missing. {apollo.lastError ?? 'The last sync did not succeed.'}
        </p>
      ) : null}

      {object === 'contact' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider px-3 py-2">
          {apolloUrl && email ? (
            <a href={apolloUrl} target="_blank" rel="noreferrer">
              Open in Apollo
            </a>
          ) : (
            <span className="text-secondary">No email, so nothing to look up in Apollo.</span>
          )}
          <Link href={timeline} className="text-small">
            {tracked + sequenced === 0
              ? 'No opens, clicks or sequence steps yet'
              : `${tracked} tracking event${tracked === 1 ? '' : 's'} · ${sequenced} sequence step${sequenced === 1 ? '' : 's'}`}
          </Link>
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <ul className="flex flex-col border-t border-divider">
          {suggestions.map((s) => (
            <li key={s.id} className="flex flex-col gap-1 border-b border-divider px-3 py-2 last:border-0">
              <p className="text-small text-secondary">
                {s.provider} suggests <span className="font-medium text-body">{s.fieldLabel}</span>
                {s.current ? ' should change' : ''}
              </p>
              <p className="break-words">
                {s.current ? (
                  <>
                    <span className="text-secondary line-through">{s.current}</span> →{' '}
                  </>
                ) : null}
                {s.suggested}
              </p>
              {canWrite ? (
                <div className="flex gap-2">
                  <Button
                    busy={busy === `accept:${s.id}`}
                    onClick={() =>
                      void run(`accept:${s.id}`, async () => {
                        await api.integrations.acceptSuggestion.mutate({ id: s.id })
                        return `${s.fieldLabel} updated.`
                      })
                    }
                  >
                    Accept
                  </Button>
                  <Button
                    variant="tertiary"
                    busy={busy === `dismiss:${s.id}`}
                    onClick={() =>
                      void run(`dismiss:${s.id}`, async () => {
                        await api.integrations.dismissSuggestion.mutate({ id: s.id })
                        return 'Suggestion dismissed.'
                      })
                    }
                  >
                    Keep mine
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
