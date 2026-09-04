'use client'

import { Button, Select, Spinner, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
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
  /** What the enricher matches on: a contact's email, a company's domain. */
  matchKey: string | null
  /** Labels of the enrichable fields that are still blank on this record. */
  blankFields: string[]
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

const usable = (health: ProviderHealth) => health.state === 'connected' || health.state === 'degraded'

/** F6 §3 and §4 on the record. Enrichment fills blanks and never overwrites a
 *  human; what it was not allowed to write waits here as a suggestion. Sequences
 *  are enrolled from here and read back onto the timeline. A provider that is
 *  not connected says so, with the link, rather than hiding the feature. */
export const EnrichmentPanel = ({
  workspace,
  object,
  recordId,
  matchKey,
  blankFields,
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

  const canEnrich = canWrite && usable(apollo) && Boolean(matchKey)
  const timeline = recordPath(workspace, object, recordId, { tab: 'activity', type: 'email_tracking,sequence_activity' })
  const matchLabel = object === 'contact' ? 'email' : 'domain'

  return (
    <section className="rounded-panel border border-line bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
        <h3 className="font-medium">Enrichment and outreach</h3>
        {canEnrich ? (
          <Button onClick={() => void enrich()} busy={busy === 'enrich'}>
            Enrich
          </Button>
        ) : null}
      </header>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-small">
        <dt className="text-secondary">Apollo</dt>
        <dd className={HEALTH[apollo.state].tone} title={apollo.lastError ?? undefined}>
          {HEALTH[apollo.state].label}
          {apollo.state === 'not_configured' || apollo.state === 'disconnected' ? (
            <>
              {' · '}
              <Link href={integrationsPath('apollo')}>connect</Link>
            </>
          ) : null}
        </dd>
        <dt className="text-secondary">Clay</dt>
        <dd className={HEALTH[clay.state].tone} title={clay.lastError ?? undefined}>
          {HEALTH[clay.state].label}
          {clay.state === 'not_configured' || clay.state === 'disconnected' ? (
            <>
              {' · '}
              <Link href={integrationsPath('clay')}>connect</Link>
            </>
          ) : null}
        </dd>
      </dl>

      {!usable(apollo) ? (
        <p className="border-t border-divider px-3 py-2 text-small text-secondary">
          <Link href={integrationsPath('apollo')}>Connect Apollo</Link>
          {blankFields.length > 0 ? ` to fill ${blankFields.join(', ')} from its data` : ` to keep this ${object} current from its data`}
          {object === 'contact' ? ', enrol this person in a sequence, and see opens, clicks and replies here' : ''}.
          {!usable(clay) ? ' Clay fills whatever Apollo leaves blank on a company.' : ''}
        </p>
      ) : blankFields.length > 0 ? (
        <p className="border-t border-divider px-3 py-2 text-small text-secondary">
          Blank and fillable: {blankFields.join(', ')}.
          {!matchKey ? ` Add ${object === 'contact' ? 'an email address' : 'a domain'} first: that is what Apollo matches on.` : ''}
        </p>
      ) : null}

      {usable(apollo) && !matchKey && blankFields.length === 0 ? (
        <p className="border-t border-divider px-3 py-2 text-small text-secondary">
          No {matchLabel}, so nothing to look up in Apollo.
        </p>
      ) : null}

      {apollo.state === 'degraded' || apollo.state === 'disconnected' ? (
        <p className="border-t border-divider px-3 py-2 text-small text-warning">
          Recent opens, clicks and sequence steps may be missing. {apollo.lastError ?? 'The last sync did not succeed.'}
        </p>
      ) : null}

      {object === 'contact' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider px-3 py-2">
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
        <Sequences contactId={recordId} canWrite={canWrite} onChanged={refresh} />
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

type Status = { sequenceId: string; sequenceName: string; status: string; currentStep: number | null; failureReason: string | null }
type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; statuses: Status[]; sequences: { id: string; name: string }[]; accounts: { id: string; email: string }[] }

/** F6 §3 on the record: where each sequence got to, and the one write a person
 *  asks for, "add them to the follow-up". Loaded after paint, because it is a
 *  call to Apollo and the rest of the record should not wait on it. */
const Sequences = ({ contactId, canWrite, onChanged }: { contactId: string; canWrite: boolean; onChanged: () => void }) => {
  const toast = useToast()
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [sequenceId, setSequenceId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [busy, setBusy] = useState(false)

  // Three requests, so it must run once per contact and not once per render of
  // the record page. That holds because onChanged is stable at the call site.
  const load = useCallback(async () => {
    setLoaded({ state: 'loading' })
    try {
      const [status, sequences, accounts] = await Promise.all([
        api.integrations.apolloStatus.query({ contactId }),
        api.integrations.apolloSequences.query(),
        api.integrations.apolloEmailAccounts.query(),
      ])
      setLoaded({ state: 'ready', statuses: status.statuses, sequences, accounts })
      if (status.recorded > 0) onChanged()
    } catch (cause) {
      setLoaded({ state: 'error', message: errorMessage(cause) })
    }
  }, [contactId, onChanged])

  useEffect(() => {
    void load()
  }, [load])

  const enroll = async () => {
    if (!sequenceId || !accountId) {
      toast('error', 'Pick a sequence and the inbox it sends from.')
      return
    }
    setBusy(true)
    try {
      const outcome = await api.integrations.apolloEnroll.mutate({ contactId, sequenceId, emailAccountId: accountId })
      toast(outcome.enrolled ? 'success' : 'error', outcome.detail)
      await load()
      onChanged()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-divider px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-small font-medium">Sequences</h4>
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
        <>
          {loaded.statuses.length === 0 ? (
            <p className="text-small text-secondary">Not in any sequence.</p>
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
          )}

          {canWrite ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-small">
                <span className="text-secondary">Add to sequence</span>
                <Select value={sequenceId} onChange={(event) => setSequenceId(event.target.value)}>
                  <option value="">Choose one…</option>
                  {loaded.sequences.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex min-w-40 flex-1 flex-col gap-1 text-small">
                <span className="text-secondary">Send from</span>
                <Select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  <option value="">Choose an inbox…</option>
                  {loaded.accounts.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.email}
                    </option>
                  ))}
                </Select>
              </label>
              <Button onClick={() => void enroll()} busy={busy} disabled={loaded.sequences.length === 0}>
                Enrol
              </Button>
              {loaded.sequences.length === 0 ? (
                <span className="text-small text-secondary">No sequences exist in Apollo yet. Create one there first.</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
