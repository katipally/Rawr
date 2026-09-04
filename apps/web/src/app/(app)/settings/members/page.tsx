import { listInvitations, listMembers, listOrgMembers, listOrgWorkspaces } from '@rawr/db'
import { contextFrom, orgContextFrom, readSession } from '~/server/session.ts'
import { MemberList } from './member-list.tsx'

/** Who is in the company, and what each of them may do in each workspace. Four
 *  fixed roles per workspace, Google as the only identity.
 *
 *  Organisation-wide rather than per workspace, because ending somebody's access
 *  is a company decision and doing it one workspace at a time is how a leaver
 *  keeps a login nobody remembers. */
const MembersPage = async () => {
  const session = await readSession()
  if (!session) return null

  const org = orgContextFrom(session)
  const isOrgAdmin = session.orgRole === 'org_admin'
  const [people, seatsHere, workspaces, invitations] = await Promise.all([
    listOrgMembers(org),
    listMembers(contextFrom(session)),
    listOrgWorkspaces(org),
    isOrgAdmin ? listInvitations(org) : Promise.resolve([]),
  ])

  const roleHere = new Map(seatsHere.map((row) => [row.userId, row.role]))

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Members</h2>
        <p className="text-secondary">
          Everyone in {session.organisationName}. Anyone with a verified {session.hostedDomain} Google
          account joins as a viewer the first time they sign in. Invite somebody to seat them with a
          role before that; deactivating ends their access to every workspace at once.
        </p>
      </div>

      <MemberList
        rows={people.map((person) => ({
          ...person,
          roleHere: roleHere.get(person.userId) ?? null,
          joinedAt: person.joinedAt.toISOString(),
          deactivatedAt: person.deactivatedAt?.toISOString() ?? null,
        }))}
        invitations={invitations.map((row) => ({
          ...row,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        }))}
        workspaces={workspaces.map((row) => ({ id: row.id, name: row.name }))}
        workspaceId={session.workspaceId}
        workspaceName={session.workspaceName}
        selfId={session.userId}
        canSetRole={session.role === 'admin'}
        isOrgAdmin={isOrgAdmin}
        role={session.role}
      />
    </div>
  )
}

export default MembersPage
