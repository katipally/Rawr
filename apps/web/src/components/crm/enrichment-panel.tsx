'use client'

import { Button, Spinner, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useCallback, useEffect, useState } from 'react'
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
  account: string
  object: 'contact' | 'company'
  recordId: string
  /** What the enricher matches on: a contact's email, a company's domain. */
  matchKey: string | null
  /** Labels of the enrichable fields that are still blank on this record. */
  blankFields: string[]
  apolloUrl: string | null
  apollo: ProviderHealth
  lusha: ProviderHealth
  clay: ProviderHealth
  /** Where this record sits on the enrichment queue: 'waiting' for somebody to
   *  approve the batch, 'approved' and on its way, or off the queue entirely. */
  queued: 'waiting' | 'approved' | null
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

const usable = (health: ProviderHealth) => health.state === 'connected' || health.state === 'degraded'

/** F6 §3 and §4 on the record. Enrichment fills blanks and never overwrites a
 *  human; what it was not allowed to write waits here as a suggestion. Sequences
 *  are enrolled from here and read back onto the timeline. A provider that is
 *  not connected says so, with the link, rather than hiding the feature. */
export const EnrichmentPanel = ({
  account,
  object,
  recordId,
  matchKey,
  blankFields,
  apolloUrl,
  apollo,
  lusha,
  clay,
  queued,
  tracked,
  sequenced,
  suggestions,
  canWrite,
}: EnrichmentPanelProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  // Stable, so the sequence panel below reloads when the contact changes and not
  // every time this panel re-renders. Three requests hang off it.
  const refresh = useCallback(() => router.refresh(), [router])

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
      const outcome =
        object === 'contact'
          ? await api.integrations.enrich.mutate({ contactId: recordId })
          : await api.integrations.enrichCompany.mutate({ companyId: recordId })
      const wrote = outcome.written.length
      const held = outcome.suggested.length
      return `${outcome.detail} ${wrote ? `Filled ${wrote} blank field${wrote === 1 ? '' : 's'}.` : ''} ${held ? `${held} value${held === 1 ? '' : 's'} held for review below.` : ''}`.trim()
    })

  const anyUsable = usable(apollo) || usable(lusha) || usable(clay)
  const canEnrich = canWrite && anyUsable && Boolean(matchKey)
  const providers: [string, ProviderHealth][] = [
    ['apollo', apollo],
    ['lusha', lusha],
    ['clay', clay],
  ]
  const timeline = recordPath(account, object, recordId, { tab: 'activity', type: 'email_tracking,sequence_activity' })
  const matchLabel = object === 'contact' ? 'email' : 'domain'

  return (
    <section className="rounded-panel border border-line bg-surface shadow-panel">
      <header className="flex items-center justify-between gap-2 px-6 pt-6 pb-4">
        <h2 className="text-base font-semibold">Enrichment and outreach</h2>
        {canEnrich ? (
          <Button onClick={() => void enrich()} busy={busy === 'enrich'}>
            Enrich
          </Button>
        ) : null}
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-6 py-2 text-small">
        {providers.map(([kind, health]) => (
          <Fragment key={kind}>
            <dt className="text-secondary capitalize">{kind}</dt>
            <dd className={HEALTH[health.state].tone} title={health.lastError ?? undefined}>
              {HEALTH[health.state].label}
              {health.state === 'not_configured' || health.state === 'disconnected' ? (
                <>
                  {' · '}
                  <Link href={integrationsPath(kind)}>connect</Link>
                </>
              ) : null}
            </dd>
          </Fragment>
        ))}
      </dl>

      {!anyUsable ? (
        <p className="border-t border-divider px-6 py-2 text-small text-secondary">
          <Link href={integrationsPath('apollo')}>Connect an enricher</Link>
          {blankFields.length > 0 ? ` to fill ${blankFields.join(', ')}` : ` to keep this ${object} current`}
          {object === 'contact' ? ', and see opens, clicks and replies from Apollo here' : ''}. New records queue up for
          enrichment and are only looked up once somebody approves the batch.
        </p>
      ) : queued === 'approved' ? (
        <p className="border-t border-divider px-6 py-2 text-small text-secondary">
          On its way. Enrichment runs within a minute{blankFields.length > 0 ? ` and can fill ${blankFields.join(', ')}` : ''}.
        </p>
      ) : queued === 'waiting' ? (
        <p className="border-t border-divider px-6 py-2 text-small text-secondary">
          Waiting for approval with the rest of the batch, so no credits have been spent.
          {blankFields.length > 0 ? ` It can fill ${blankFields.join(', ')}.` : ''} Enrich runs this one record now.
        </p>
      ) : blankFields.length > 0 ? (
        <p className="border-t border-divider px-6 py-2 text-small text-secondary">
          Blank and fillable: {blankFields.join(', ')}.
          {!matchKey ? ` Add ${object === 'contact' ? 'an email address' : 'a domain'} first: that is what an enricher matches on.` : ''}
        </p>
      ) : !matchKey ? (
        <p className="border-t border-divider px-6 py-2 text-small text-secondary">
          No {matchLabel}, so nothing to look up.
        </p>
      ) : null}

      {apollo.state === 'degraded' || apollo.state === 'disconnected' ? (
        <p className="border-t border-divider px-6 py-2 text-small text-warning">
          Recent opens, clicks and sequence steps may be missing. {apollo.lastError ?? 'The last sync did not succeed.'}
        </p>
      ) : null}

      {object === 'contact' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider px-6 py-2">
          {apolloUrl && matchKey ? (
            <a href={apolloUrl} target="_blank" rel="noreferrer">
              Open in Apollo
            </a>
          ) : null}
          <Link href={timeline} className="text-small">
            {tracked + sequenced === 0
              ? 'No opens, clicks or sequence steps yet'
              : `${tracked} tracking event${tracked === 1 ? '' : 's'} · ${sequenced} sequence step${sequenced === 1 ? '' : 's'}`}
          </Link>
        </div>
      ) : null}

      {object === 'contact' && usable(apollo) && matchKey ? (
        <Sequences contactId={recordId} onChanged={refresh} />
      ) : null}

      {suggestions.length > 0 ? (
        <ul className="flex flex-col border-t border-divider">
          {suggestions.map((s) => (
            <li key={s.id} className="flex flex-col gap-1 border-b border-divider px-6 py-2 last:border-0">
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

type Status = { sequenceId: string; sequenceName: string; status: string; currentStep: number | null; failureReason: string | null }
type Loaded = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; statuses: Status[] }

/** What Apollo's own sequences did for this contact.
 *
 *  Read-only: enrolling happens in Rawr's own sequences now, from the member's
 *  Gmail, which is what makes the mail thread with the rest of the conversation
 *  and stop when somebody replies. Anything already running in Apollo still shows
 *  here and still reaches the timeline. */
const Sequences = ({ contactId, onChanged }: { contactId: string; onChanged: () => void }) => {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })

  // One request, so it must run once per contact and not once per render of the
  // record page. That holds because onChanged is stable at the call site.
  const load = useCallback(async () => {
    setLoaded({ state: 'loading' })
    try {
      const status = await api.integrations.apolloStatus.query({ contactId })
      setLoaded({ state: 'ready', statuses: status.statuses })
      if (status.recorded > 0) onChanged()
    } catch (cause) {
      setLoaded({ state: 'error', message: errorMessage(cause) })
    }
  }, [contactId, onChanged])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex flex-col gap-2 border-t border-divider px-6 py-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-small font-medium">Apollo sequences</h4>
        {loaded.state !== 'loading' ? (
          <Button variant="tertiary" onClick={() => void load()}>
            Sync now
          </Button>
        ) : null}
      </div>

      {loaded.state === 'loading' ? <Spinner /> : null}
      {loaded.state === 'error' ? (
        <p role="alert" className="text-small text-error">
          {loaded.message}
        </p>
      ) : null}
      {loaded.state === 'ready' ? (
        loaded.statuses.length === 0 ? (
          <p className="text-small text-secondary">
            Not in any Apollo sequence. Rawr’s own sequences are on the Marketing menu.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-small">
            {loaded.statuses.map((row) => (
              <li key={row.sequenceId} className="flex flex-wrap justify-between gap-x-3">
                <span className="break-words font-medium">{row.sequenceName}</span>
                <span className={row.status === 'failed' ? 'text-error' : 'text-secondary'}>
                  {row.status}
                  {row.currentStep ? ` · step ${row.currentStep}` : ''}
                  {row.failureReason ? ` · ${row.failureReason.replace(/_/g, ' ')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}
