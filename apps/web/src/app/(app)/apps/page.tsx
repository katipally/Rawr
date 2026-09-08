import { listIntegrationsForOrg } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { metaFor } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AppsTable } from './apps-table.tsx'
import { AppsTabs } from './tabs.tsx'

/** Connections home: what this company has connected, what is wrong with any of
 *  it, and who connected it.
 *
 *  Organisation-scoped, because the credential is. One Slack token serves every
 *  account here, so "who installed it" is a question about the company rather
 *  than about whichever account somebody happens to be looking at. */
const AppsPage = async () => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const rows = await listIntegrationsForOrg(contextFrom(session))
  const connected = rows.filter((row) => row.state !== 'not_configured')
  const attention = connected.filter((row) => row.lastError !== null || row.state === 'disconnected')

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Connected apps"
        lead={`${session.accountName} · ${connected.length} connected`}
        why={
          <p>
            An app is connected once for the whole organisation and every account in it uses the
            same credential. Only an organisation admin can connect or disconnect one; anybody can
            see what is connected and whether it is working.
          </p>
        }
      />

      <AppsTabs current="home" connectedCount={connected.length} />

      {attention.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Needs attention ({attention.length})</h2>
          <ul className="flex flex-col rounded-panel border border-line bg-surface">
            {attention.map((row) => (
              <li key={row.kind} className="flex flex-wrap items-center gap-3 border-b border-divider px-4 py-3 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <strong>{metaFor(row.kind).name}</strong>{' '}
                  <span className="text-secondary">
                    {row.lastError ?? 'is disconnected and is not being retried.'}
                  </span>
                </span>
                <a href={`/apps/${row.kind}`} className="shrink-0 font-medium text-link no-underline hover:underline">
                  Fix
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">My apps</h2>
        {connected.length === 0 ? (
          <EmptyState
            title="Nothing is connected yet"
            description="Everything Rawr can talk to is under Available apps, with what each one is for."
          />
        ) : (
          <AppsTable
            rows={connected.map((row) => {
              const meta = metaFor(row.kind)
              return {
                kind: row.kind,
                name: meta.name,
                category: meta.category,
                state: row.state,
                lastError: row.lastError,
                installedAt: row.installedAt?.toISOString() ?? null,
                installedByName: row.installedByName,
                lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
              }
            })}
          />
        )}
      </section>
    </div>
  )
}

export default AppsPage
