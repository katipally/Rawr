import { readCustomEvent, readPageView, type PageViewDetail } from '@rawr/db'
import { Breadcrumb, EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { redirect } from 'next/navigation'
import { EMPTY_VALUE, Value } from '~/components/crm/value.tsx'
import { objectView, pageViewPath, recordPath, reportsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { getFormat } from '~/server/format.ts'

/** One thing a person did on the site, addressed by its own id. F4 §4's third
 *  surface.
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

/** Where this was reached from, as far as the data says: the person it belongs to,
 *  or the website report when it belongs to nobody. */
const Trail = ({ account, contactId, contactName, what }: { account: string; contactId: string | null; contactName: string | null; what: string }) => (
  <Breadcrumb
    items={[
      contactId
        ? { label: contactName ?? 'Contact', href: recordPath(account, 'contact', contactId) }
        : { label: 'Website activity', href: reportsPath(account, { tab: 'website' }) },
      { label: what },
    ]}
  />
)

const PageViewScreen = async ({
  params,
}: {
  params: Promise<{ account: string; id: string }>
}) => {
  const fmt = await getFormat()
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  const ctx = contextFrom(session)
  const view = await readPageView(ctx, id)
  // A tracked event shares this address space: both are "something they did on
  // the site", and the timeline links them the same way. Ids are uuids, so one
  // of the two reads finds nothing and the other one answers.
  const event = view ? null : await readCustomEvent(ctx, id)

  if (event) {
    const properties = Object.entries(event.properties)
    return (
      <div className="flex flex-col gap-4">
        <Trail account={account} contactId={event.contactId} contactName={event.contactName} what="Tracked event" />
        <header className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
          <p className="text-small text-secondary uppercase">Tracked event</p>
          <h1 className="break-words text-lg font-medium">{event.name}</h1>
          <p className="break-words text-secondary">
            {event.contactId ? (
              <Link className="text-link" href={recordPath(account, 'contact', event.contactId)}>
                {event.contactName ?? 'this contact'}
              </Link>
            ) : (
              <span>Not attributed to anyone. This visitor has not identified themselves.</span>
            )}{' '}
            · {fmt.dateTime(event.at.toISOString())}
            {event.siteName ? ` · ${event.siteName}` : ''}
          </p>
        </header>

        <section className="rounded-panel border border-line bg-surface p-3">
          <h2 className="mb-2 font-medium">What was sent with it</h2>
          {properties.length === 0 ? (
            <p className="text-secondary">
              Nothing. The event carries only its name, so there is no detail to read.
            </p>
          ) : (
            <dl className="grid gap-x-6 gap-y-3 @lg:grid-cols-2">
              {properties.map(([key, value]) => (
                <Row key={key} label={key}>
                  {/* A property is whatever the site sent, so a nested object is
                      as likely as a string. Same renderer as a json field on a
                      record, rather than a second answer to the same question. */}
                  <Value format={fmt} type={typeof value === 'object' && value !== null ? 'json' : 'text'} value={value} placeholder={EMPTY_VALUE} />
                </Row>
              ))}
            </dl>
          )}
        </section>

        <Visit account={account} session={event.session} currentId={event.id} />
      </div>
    )
  }

  if (!view) {
    return (
      <EmptyState
        title="There is nothing at that address"
        description="It was erased, it aged past the retention window, or the link points at another account."
        action={<LinkButton variant="primary" href={objectView(account, 'contact', 'all')}>Back to contacts</LinkButton>}
      />
    )
  }

  const utm = Object.entries(view.utm)

  return (
    <div className="flex flex-col gap-4">
      <Trail account={account} contactId={view.contactId} contactName={view.contactName} what="Page view" />
      <header className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
        <p className="text-small text-secondary uppercase">Page view</p>
        <h1 className="break-words text-lg font-medium">{view.title ?? view.path}</h1>
        <p className="break-words text-secondary">
          {view.contactId ? (
            <Link className="text-link" href={recordPath(account, 'contact', view.contactId)}>
              {view.contactName ?? 'this contact'}
            </Link>
          ) : (
            // Not yet stitched, or never will be. Saying so is better than an
            // empty slot that reads like a bug.
            <span>Not attributed to anyone. This visitor has not identified themselves.</span>
          )}{' '}
          · {fmt.dateTime(view.at.toISOString())}
        </p>
      </header>

      <section className="rounded-panel border border-line bg-surface p-3">
        <dl className="grid gap-x-6 gap-y-3 @lg:grid-cols-2">
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
          <dl className="grid gap-x-6 gap-y-2 @lg:grid-cols-2">
            {utm.map(([key, value]) => (
              <Row key={key} label={key}>
                {value}
              </Row>
            ))}
          </dl>
        </section>
      ) : null}

      <Visit account={account} session={view.session} currentId={view.id} />
    </div>
  )
}

/** The visit a page view or an event belonged to, and what else happened in it.
 *  The reason this screen exists rather than a tooltip on the timeline. */
const Visit = async ({
  account,
  session,
  currentId,
}: {
  account: string
  session: PageViewDetail['session']
  currentId: string
}) => {
  const fmt = await getFormat()
  return (
  <section className="rounded-panel border border-line bg-surface shadow-panel">
    <h2 className="px-6 pt-6 pb-4 text-base font-semibold">
      {session
        ? `This visit · ${fmt.number(session.pageCount)} page${session.pageCount === 1 ? '' : 's'}`
        : 'This visit'}
    </h2>

    {session ? (
      <>
        <p className="px-3 py-2 text-secondary">
          {fmt.dateTime(session.startedAt.toISOString())} to{' '}
          {fmt.dateTime(session.endedAt.toISOString())}
          {session.referrer ? ` · arrived from ${session.referrer}` : ''}
        </p>
        <ol className="flex flex-col">
          {session.views.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-baseline gap-x-3 border-t border-divider px-3 py-2"
            >
              <span className="min-w-0 break-words">
                {row.id === currentId ? (
                  <strong>{row.title ?? row.path}</strong>
                ) : (
                  <Link className="text-link" href={pageViewPath(account, row.id)}>
                    {row.title ?? row.path}
                  </Link>
                )}
              </span>
              <time
                dateTime={row.at.toISOString()}
                className="ml-auto shrink-0 text-small text-secondary"
              >
                {fmt.dateTime(row.at.toISOString())}
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
)
}

export default PageViewScreen
