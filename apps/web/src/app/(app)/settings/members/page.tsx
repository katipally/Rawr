import { PageHeader } from '@rawr/ui'
import { ROLE_TEMPLATES, listInvitations, listMembers } from '@rawr/db'
import { contextFrom, readSession } from '~/server/session.ts'
import { MemberList } from './member-list.tsx'

/** Who is in the account and what each of them holds. Hubs, at view or edit, the
 *  way HubSpot's permission grid grants them, with super admin above the grid.
 *
 *  Ending somebody's access happens here and only here: one account means one
 *  place to do it, and no leaver keeps a login nobody remembers. */
const MembersPage = async () => {
  const session = await readSession()
  if (!session) return null

  const ctx = contextFrom(session)
  const [people, invitations] = await Promise.all([
    listMembers(ctx),
    session.isSuperAdmin ? listInvitations(ctx) : Promise.resolve([]),
  ])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Members"
        lead={`Everyone in ${session.accountName}.`}
        why={
          <p>
            Anyone with a verified {session.hostedDomain} Google account joins the first time they
            sign in, reading the hubs this account opens by default. Invite somebody to seat them
            with the hubs you choose; deactivating ends their access at once.
          </p>
        }
      />

      <MemberList
        rows={people.map((person) => ({
          ...person,
          joinedAt: person.joinedAt.toISOString(),
        }))}
        invitations={invitations.map((row) => ({
          ...row,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        }))}
        templates={Object.entries(ROLE_TEMPLATES).map(([key, template]) => ({
          key,
          label: template.label,
          description: template.description,
          grants: {
            isSuperAdmin: template.grants.isSuperAdmin,
            viewHubs: [...template.grants.viewHubs],
            editHubs: [...template.grants.editHubs],
            viewScopes: template.grants.viewScopes,
            editScopes: template.grants.editScopes,
            criticalGrants: [...template.grants.criticalGrants],
          },
        }))}
        selfId={session.userId}
        isSuperAdmin={session.isSuperAdmin}
      />
    </div>
  )
}

export default MembersPage
