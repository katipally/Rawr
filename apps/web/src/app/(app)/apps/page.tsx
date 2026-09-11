import { listIntegrationsForAccount, PERSONAL_KINDS } from '@rawr/db'
import { Alert, EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { redirect } from 'next/navigation'
import { AppLogo } from '~/components/app-logo.tsx'
import { formatAgo } from '~/components/crm/value.tsx'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { appPath } from '~/lib/links.ts'
import { connectPathFor, metaFor } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AppsTable } from './apps-table.tsx'
import { errorSummary } from './health.ts'
import { AppsTabs } from './tabs.tsx'

/** Connections home: what this company has connected, what is wrong with any of
 *  it, and who connected it.
 *
 *  Account-scoped, because the credential is. One Slack token serves the whole
 *  account, so "who installed it" is a question about the company rather than
 *  about whichever person happens to be looking at it. */
const AppsPage = async () => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const rows = await listIntegrationsForAccount(contextFrom(session))
  const connected = rows.filter((row) => row.state !== 'not_configured')
  const attention = connected.filter((row) => row.lastError !== null || row.state === 'disconnected')

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Connected apps"
        lead={`${session.accountName} · ${connected.length} connected`}
        why={
          <p>
            An app is connected once for the whole account and everybody in it uses the same
            credential. Only a super admin can connect or disconnect one; anybody can see what is
            connected and whether it is working.
          </p>
        }
      />

      <AppsTabs current="home" connectedCount={connected.length} />

      {devIntegrationsEnabled ? (
        <Alert tone="warning">
          Development providers are on. Connection tests pass without a key, enrichment returns a
          fixed match, and nothing is sent to Brevo, Apollo, Clay, Slack or Google. Turn
          RAWR_DEV_INTEGRATIONS off to talk to the real services.
        </Alert>
      ) : null}

      {attention.length === 0 ? null : (
      <section className="flex flex-col gap-2">
        <div className="rounded-panel border border-line bg-surface shadow-panel">
          <h2 className="border-b border-divider px-4 py-3 font-medium text-small">Needs attention ({attention.length})</h2>
          <ul>
              {attention.map((row) => {
                const meta = metaFor(row.kind)
                const personal = PERSONAL_KINDS.has(row.kind)
                const reported = row.lastError ? errorSummary(row.lastError) : null
                return (
                  <li key={row.kind} className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-3 last:border-b-0">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-hs bg-fill">
                      <AppLogo kind={row.kind} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      {row.lastErrorAt ? <span className="text-small text-secondary">{formatAgo(row.lastErrorAt)}</span> : null}
                      <span className="break-words">
                        <Link href={appPath(row.kind)} className="font-medium text-link no-underline hover:underline">
                          {meta.name}
                        </Link>{' '}
                        {reported?.headline ?? 'is disconnected and is not being retried.'}
                      </span>
                      {reported?.detail ? (
                        <details className="text-small text-secondary">
                          <summary className="cursor-pointer">What the provider answered</summary>
                          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-hs bg-fill p-2">
                            {reported.detail}
                          </pre>
                        </details>
                      ) : null}
                    </span>
                    <LinkButton
                      href={personal ? connectPathFor(row.kind, session.accountSlug) : appPath(row.kind, 'settings')}
                    >
                      {personal ? 'Reconnect' : 'Fix now'}
                    </LinkButton>
                  </li>
                )
              })}
          </ul>
        </div>
      </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">My apps</h2>
        {connected.length === 0 ? (
          <EmptyState
            title="Nothing is connected yet"
            description="Everything Rawr can talk to is under Available apps, with what each one is for."
          />
        ) : (
          <AppsTable
            canManage={session.isSuperAdmin}
            rows={connected.map((row) => {
              const meta = metaFor(row.kind)
              return {
                kind: row.kind,
                name: meta.name,
                category: meta.category,
                personal: PERSONAL_KINDS.has(row.kind),
                connectPath: connectPathFor(row.kind, session.accountSlug),
                state: row.state,
                lastError: row.lastError,
                installedAt: row.installedAt?.toISOString() ?? null,
                installedByName: row.installedByName,
                installedByEmail: row.installedByEmail,
                lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
                people: row.people,
              }
            })}
          />
        )}
      </section>
    </div>
  )
}

export default AppsPage
