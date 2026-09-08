import { auditEntities, listAudit, listMembers } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { AuditTable } from './audit-table.tsx'

/** Who changed what. Two histories, because there are two scopes: what happened
 *  inside this account, and what happened to the company above it. */
const AuditPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (!sessionIsAdmin(session)) {
    return (
      <EmptyState
        title="Only an admin can read the history"
        description={`You need account access, which you do not have. can use this account but not audit it. A history is a security record.`}
      />
    )
  }

  const ctx = contextFrom(session)
  const [page, entities, members, orgRows] = await Promise.all([
    listAudit(ctx, { limit: 50 }),
    auditEntities(ctx),
    listMembers(ctx),
    session.isSuperAdmin ? listAudit(contextFrom(session), { limit: 25 }) : Promise.resolve([]),
  ])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="History"
        lead={`Every change made in ${session.accountName}, newest first.`}
        why={
          <p>
            It is append-only: the app cannot rewrite or delete a line here, even with a valid
            session.
          </p>
        }
      />

      <AuditTable
        initial={page.rows.map((row) => ({ ...row, at: row.at.toISOString() }))}
        cursor={page.cursor}
        entities={entities}
        people={members.map((member) => ({ userId: member.userId, name: member.name }))}
      />
    </div>
  )
}

export default AuditPage
