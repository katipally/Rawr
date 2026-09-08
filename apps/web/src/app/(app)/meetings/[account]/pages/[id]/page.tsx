import { getRegistry, readBookingPage, readPageHostList } from '@rawr/db'
import { Alert, EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { redirect } from 'next/navigation'
import { googleCalendarConfigured, publicBaseUrl } from '~/lib/env.ts'
import { availabilityPath, bookedPath, bookingPagesPath, calendarsPath } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession, sessionIsAdmin, sessionIsReadOnly } from '~/server/session.ts'
import { zoomReady } from '~/server/zoom.ts'
import { PageEditor } from './editor.tsx'

/** One booking page, everything about it on one screen: what it offers, who hosts
 *  it, what it asks, and what lands on the calendar. */

const BookingPageEditorScreen = async ({
  params,
}: {
  params: Promise<{ account: string; id: string }>
}) => {
  const { account, id } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const page = await readBookingPage(ctx, id)

  if (!page) {
    return (
      <div className="w-full max-w-4xl">
        <EmptyState
          title="That meeting page does not exist"
          description="It may have been deleted, or the link may belong to another account."
          action={<LinkButton variant="primary" href={bookingPagesPath(account)}>Back to meeting links</LinkButton>}
        />
      </div>
    )
  }

  // A personal link belongs to its owner. An admin can see and change any page.
  const mine = page.ownerId === session.userId
  if (page.kind === 'one_on_one' && !mine && !sessionIsAdmin(session)) {
    return (
      <div className="w-full max-w-4xl">
        <EmptyState
          title="That is somebody else's personal link"
          description="Personal calendar links are private to the person who owns them. Ask them for the link if you need it."
          action={<LinkButton variant="primary" href={bookingPagesPath(account)}>Back to meeting links</LinkButton>}
        />
      </div>
    )
  }

  const [hosts, lookups, registry, zoom] = await Promise.all([
    readPageHostList(ctx, id),
    readLookups(ctx),
    getRegistry(ctx),
    zoomReady(ctx),
  ])

  // Straight from the registry, so a custom field marketing added is available to
  // map an answer onto without a deploy. Contact and company only: a stranger
  // booking a meeting does not create a deal.
  const targets = registry.objects
    .filter((object) => object.key === 'contact' || object.key === 'company')
    .flatMap((object) =>
      object.fields
        .filter((field) => field.type !== 'relation' && field.type !== 'user' && field.type !== 'json')
        .map((field) => ({
          value: `${object.key}.${field.key}`,
          label: `${object.nameSingular} · ${field.label}`,
        })),
    )

  const editable =
    sessionIsAdmin(session) || (page.kind === 'one_on_one' && mine && !sessionIsReadOnly(session))

  return (
    <div className="w-full max-w-5xl">
      <nav className="mb-1 text-sm">
        <Link href={bookingPagesPath(account)} className="font-semibold text-link">
          Meeting links
        </Link>
      </nav>
      <PageHeader
        className="mb-4"
        title={page.name}
        action={
          <>
            <Link href={bookedPath(account, { page: page.bookingPageId })} className="text-sm text-link">
              Booked meetings
            </Link>
            <Link href={availabilityPath(account)} className="text-sm text-link">
              My hours
            </Link>
            <Link href={calendarsPath(account)} className="text-sm text-link">
              Calendars
            </Link>
          </>
        }
      />

      {!editable ? (
        <Alert tone="warning" className="mb-4">
          You need sales access to change this page. A shared round robin is an
          admin&apos;s to configure.
        </Alert>
      ) : null}

      <PageEditor
        account={account}
        accountSlug={session.accountSlug}
        baseUrl={publicBaseUrl}
        page={page}
        hosts={hosts}
        members={lookups.users}
        targets={targets}
        working={{ zoom, google_meet: googleCalendarConfigured }}
        editable={editable}
        canPublishShared={sessionIsAdmin(session)}
      />
    </div>
  )
}

export default BookingPageEditorScreen
