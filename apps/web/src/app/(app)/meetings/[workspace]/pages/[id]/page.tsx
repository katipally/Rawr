import { getRegistry, readBookingPage, readPageHostList } from '@rawr/db'
import { Alert, EmptyState, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { publicBaseUrl } from '~/lib/env.ts'
import { availabilityPath, bookedPath, bookingPagesPath, calendarsPath } from '~/lib/links.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { PageEditor } from './editor.tsx'

/** One booking page, everything about it on one screen: what it offers, who hosts
 *  it, what it asks, and what lands on the calendar. */

const BookingPageEditorScreen = async ({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) => {
  const { workspace, id } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const page = await readBookingPage(ctx, id)

  if (!page) {
    return (
      <div className="w-full max-w-4xl">
        <EmptyState
          title="That meeting page does not exist"
          description="It may have been deleted, or the link may belong to another workspace."
          action={<Link href={bookingPagesPath(workspace)}>Back to meeting links</Link>}
        />
      </div>
    )
  }

  // A personal link belongs to its owner. An admin can see and change any page.
  const mine = page.ownerId === session.userId
  if (page.kind === 'one_on_one' && !mine && session.role !== 'admin') {
    return (
      <div className="w-full max-w-4xl">
        <EmptyState
          title="That is somebody else's personal link"
          description="Personal calendar links are private to the person who owns them. Ask them for the link if you need it."
          action={<Link href={bookingPagesPath(workspace)}>Back to meeting links</Link>}
        />
      </div>
    )
  }

  const [hosts, lookups, registry] = await Promise.all([
    readPageHostList(ctx, id),
    readLookups(ctx),
    getRegistry(ctx),
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
    session.role === 'admin' || (page.kind === 'one_on_one' && mine && session.role !== 'viewer')

  return (
    <div className="w-full max-w-5xl">
      <nav className="mb-1 text-sm">
        <Link href={bookingPagesPath(workspace)} className="font-semibold text-link">
          Meeting links
        </Link>
      </nav>
      <PageHeader
        className="mb-4"
        title={page.name}
        action={
          <>
            <Link href={bookedPath(workspace, { page: page.bookingPageId })} className="text-sm text-link">
              Booked meetings
            </Link>
            <Link href={availabilityPath(workspace)} className="text-sm text-link">
              My hours
            </Link>
            <Link href={calendarsPath(workspace)} className="text-sm text-link">
              Calendars
            </Link>
          </>
        }
      />

      {!editable ? (
        <Alert tone="warning" className="mb-4">
          Your role ({session.role}) can read this page but not change it. A shared round robin is an
          admin&apos;s to configure.
        </Alert>
      ) : null}

      <PageEditor
        workspace={workspace}
        workspaceSlug={session.workspaceSlug}
        baseUrl={publicBaseUrl}
        page={page}
        hosts={hosts}
        members={lookups.users}
        targets={targets}
        editable={editable}
        canPublishShared={session.role === 'admin'}
      />
    </div>
  )
}

export default BookingPageEditorScreen
