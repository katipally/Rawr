import { readPageView } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatDateTime } from '~/components/crm/value.tsx'
import { objectView, pageViewPath, recordPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** One page view, addressed by its own id. F4 §4's third surface.
 *
 *  It exists because "viewed Data Studio" on a timeline is not enough to act on: a
 *  salesperson wants the full URL, where they came from, and what else they looked
 *  at in that visit. Everything on this screen is in the path, so it pastes. */

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-0">
    <dt className="text-small text-secondary uppercase">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
)

const PageViewScreen = async ({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace, id } = await params
  const view = await readPageView(contextFrom(session), id)

  if (!view) {
    return (
      <EmptyState
        title="That page view is not here"
        description="It was erased, it aged past the retention window, or the link points at another workspace."
        action={<Link href={objectView(workspace, 'contact', 'all')}>Back to contacts</Link>}
      />
    )
  }

  const utm = Object.entries(view.utm)

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
        <p className="text-small text-secondary uppercase">Page view</p>
        <h1 className="break-words text-lg font-medium">{view.title ?? view.path}</h1>
        <p className="break-words text-secondary">
          {view.contactId ? (
            <Link className="text-link" href={recordPath(workspace, 'contact', view.contactId)}>
              {view.contactName ?? 'this contact'}
            </Link>
          ) : (
            // Not yet stitched, or never will be. Saying so is better than an
            // empty slot that reads like a bug.
            <span>Not attributed to anyone. This visitor has not identified themselves.</span>
          )}{' '}
          · {formatDateTime(view.at.toISOString())}
        </p>
      </header>

      <section className="rounded-panel border border-line bg-surface p-3">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="URL">
            {/* rel=noreferrer so opening a prospect's page does not announce Rawr
                in their analytics. */}
            <a className="text-link" href={view.url} target="_blank" rel="noreferrer noopener">
              {view.url}
            </a>
          </Row>
          <Row label="Path">{view.path}</Row>
          <Row label="Referrer">{view.referrer ?? 'Direct, no referrer'}</Row>
          <Row label="Site">{view.siteName ?? 'Unknown'}</Row>
          <Row label="Browser">{view.browser ?? 'Unknown'}</Row>
          <Row label="Device">{view.device ?? 'Unknown'}</Row>
          <Row label="Country">{view.country ?? 'Unknown'}</Row>
        </dl>
      </section>

      {utm.length > 0 ? (
        <section className="rounded-panel border border-line bg-surface p-3">
          <h2 className="mb-2 font-medium">Campaign parameters</h2>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {utm.map(([key, value]) => (
              <Row key={key} label={key}>
                {value}
              </Row>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="rounded-panel border border-line bg-surface">
        <h2 className="border-b border-divider px-3 py-2 font-medium">
          {view.session
            ? `This visit · ${view.session.pageCount.toLocaleString()} page${view.session.pageCount === 1 ? '' : 's'}`
            : 'This visit'}
        </h2>

        {view.session ? (
          <>
            <p className="px-3 py-2 text-secondary">
              {formatDateTime(view.session.startedAt.toISOString())} to{' '}
              {formatDateTime(view.session.endedAt.toISOString())}
              {view.session.referrer ? ` · arrived from ${view.session.referrer}` : ''}
            </p>
            <ol className="flex flex-col">
              {view.session.views.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline gap-x-3 border-t border-divider px-3 py-2"
                >
                  <span className="min-w-0 break-words">
                    {row.id === view.id ? (
                      <strong>{row.title ?? row.path}</strong>
                    ) : (
                      <Link className="text-link" href={pageViewPath(workspace, row.id)}>
                        {row.title ?? row.path}
                      </Link>
                    )}
                  </span>
                  <time
                    dateTime={row.at.toISOString()}
                    className="ml-auto shrink-0 text-small text-secondary"
                  >
                    {formatDateTime(row.at.toISOString())}
                  </time>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="px-3 py-2 text-secondary">
            The visit this belonged to has aged past the retention window.
          </p>
        )}
      </section>
    </div>
  )
}

export default PageViewScreen
