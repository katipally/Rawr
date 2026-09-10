import { CONSENT_PAGE, listConsentRecords } from '@rawr/db'
import { PageHeader } from '@rawr/ui'
import { contextFrom, readSession } from '~/server/session.ts'
import { ConsentTable } from './consent-table.tsx'

/** Every cookie choice a visitor made, newest first.
 *
 *  Append-only, so this is evidence and not a settings screen: it says what was
 *  lawful at the moment a given day's browsing was collected, which is the one
 *  question anybody asks of a consent record. Paged at the database, because the
 *  table grows with traffic rather than with the account. */
const ConsentRecordsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ skip?: string }>
}) => {
  const session = await readSession()
  if (!session) return null

  const { skip } = await searchParams
  const offset = Math.max(0, Number(skip) || 0)
  const page = await listConsentRecords(contextFrom(session), { limit: CONSENT_PAGE, offset })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Consent records"
        lead="What each visitor agreed to, and when."
        why={
          <p>
            A choice is appended, never updated. Overwriting the row would destroy the only
            evidence of what was lawful when the data next to it was collected, so a visitor who
            changes their mind leaves two rows rather than one.
          </p>
        }
      />
      <ConsentTable
        rows={page.rows.map((row) => ({ ...row, at: row.at.toISOString() }))}
        offset={offset}
        perPage={CONSENT_PAGE}
        hasMore={page.hasMore}
      />
    </div>
  )
}

export default ConsentRecordsPage
