import { auditEntities, listAudit, listMembers, listOrgAudit } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { contextFrom, orgContextFrom, readSession } from '~/server/session.ts'
import { AuditTable } from './audit-table.tsx'

/** Who changed what. Two histories, because there are two scopes: what happened
 *  inside this workspace, and what happened to the company above it. */
const AuditPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (session.role !== 'admin') {
    return (
      <EmptyState
        title="Only an admin can read the history"
        description={`Your role (${session.role}) can use this workspace but not audit it. A history is a security record.`}
      />
    )
  }

  const ctx = contextFrom(session)
  const [page, entities, members, orgRows] = await Promise.all([
    listAudit(ctx, { limit: 50 }),
    auditEntities(ctx),
    listMembers(ctx),
    session.orgRole === 'org_admin' ? listOrgAudit(orgContextFrom(session), { limit: 25 }) : Promise.resolve([]),
  ])

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">History</h2>
        <p className="text-secondary">
          Every change made in {session.workspaceName}, newest first. It is append-only: the app cannot
          rewrite or delete a line here, even with a valid session.
        </p>
      </div>

      <AuditTable
        initial={page.rows.map((row) => ({ ...row, at: row.at.toISOString() }))}
        cursor={page.cursor}
        entities={entities}
        people={members.map((member) => ({ userId: member.userId, name: member.name }))}
        organisation={orgRows.map((row) => ({ ...row, at: row.at.toISOString() }))}
        organisationName={session.organisationName}
      />
    </div>
  )
}

export default AuditPage
