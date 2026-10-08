import { auditEntities, isUuid, listAudit, listMembers } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { AuditTable } from './audit-table.tsx'

/** Who changed what. Two histories, because there are two scopes: what happened
 *  inside this account, and what happened to the company above it. */
const AuditPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; actor?: string }>
}) => {
  const session = await readSession()
  if (!session) return null

  if (!sessionIsAdmin(session)) {
    return (
      <EmptyState
        title="Only an admin can read the history"
        description="You need account access, which you do not have. You can use this account but not audit it. A history is a security record."
      />
    )
  }

  const ctx = contextFrom(session)
  const { entity: askedEntity, actor: askedActor } = await searchParams
  // A hand-edited address must not reach a uuid comparison with something that
  // is not one.
  const actor = askedActor && isUuid(askedActor) ? askedActor : null
  // Read here rather than only in the client, so a link somebody pasted arrives
  // already filtered instead of flashing the whole history first. An entity
  // outside the list has no chip to show, so it is dropped like a bad actor.
  const entities = await auditEntities(ctx)
  const entity = askedEntity && entities.includes(askedEntity) ? askedEntity : null
  const [page, members] = await Promise.all([
    listAudit(ctx, { entity, actorId: actor, limit: 50 }),
    listMembers(ctx),
  ])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Audit Logs"
        lead={`Every change made in ${session.accountName}, newest first.`}
        why={
          <p>
            It is append-only: the app cannot rewrite or delete a line here, even with a valid
            session.
          </p>
        }
      />

      <AuditTable
        key={`${entity ?? ''}|${actor ?? ''}`}
        initial={page.rows.map((row) => ({ ...row, at: row.at.toISOString() }))}
        cursor={page.cursor}
        entities={entities}
        people={members.map((member) => ({ userId: member.userId, name: member.name }))}
        entity={entity}
        actorId={actor}
      />
    </div>
  )
}

export default AuditPage
