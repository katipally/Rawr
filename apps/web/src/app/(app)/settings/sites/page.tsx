import { listCollectorNotices, listSites } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { publicBaseUrl } from '~/lib/env.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { SiteList } from './site-list.tsx'

/** F4. The hosts that may send events, and what the collector refused.
 *
 *  The two live together because they answer one question: is tracking working,
 *  and if not, why. A PII rejection is a bug in the product that fired it, and it
 *  is invisible unless somebody puts it on a screen. */
const SitesPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (session.role !== 'admin') {
    return (
      <EmptyState
        title="Tracked sites are admin only"
        description={`Ask an admin in ${session.workspaceName}. A site key lets a host write into this workspace, so adding one is an admin act.`}
      />
    )
  }

  const ctx = contextFrom(session)
  const [sites, notices] = await Promise.all([listSites(ctx), listCollectorNotices(ctx)])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Tracked sites"
          lead="Each host that sends page views carries a site key."
          why={
            <p>
              Nothing is collected without one, and nothing is collected from anyone who has not
              accepted analytics cookies.
            </p>
          }
        />
      </div>

      <SiteList
        baseUrl={publicBaseUrl}
        rows={sites.map((row) => ({
          ...row,
          lastEventAt: row.lastEventAt?.toISOString() ?? null,
        }))}
      />

      <section className="flex flex-col gap-2">
        <div>
          <h2 className="font-medium">What the collector refused</h2>
          <p className="text-secondary">
            Aggregated per day, so a loop firing the same rejected event ten thousand times is one
            row rather than ten thousand.
          </p>
        </div>

        {notices.length === 0 ? (
          <p className="text-secondary">Nothing refused. Every event that arrived was stored.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notices.map((row) => (
              <li
                key={`${row.kind}-${row.key}-${row.day}-${row.siteName}`}
                className="rounded-panel border border-error bg-error-subtle p-3"
              >
                <p className="break-words font-medium">
                  {row.kind === 'pii'
                    ? `"${row.key}" carried personal data`
                    : `${row.siteName} fired more distinct event names than the daily cap`}
                </p>
                <p className="break-words text-secondary">
                  {row.kind === 'pii'
                    ? `The offending properties were dropped and the rest of the event was kept. Fix it where it is fired, on ${row.siteName}.`
                    : 'Extra names were bucketed into "_overflow" so the table survives.'}{' '}
                  {row.n.toLocaleString()} time{row.n === 1 ? '' : 's'} on {row.day}, last{' '}
                  {formatDateTime(row.lastAt.toISOString())}.
                </p>
                <pre className="mt-1 overflow-x-auto text-small text-secondary">
                  {JSON.stringify(row.detail)}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default SitesPage
