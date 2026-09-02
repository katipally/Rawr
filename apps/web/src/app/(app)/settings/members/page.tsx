import { listMembers } from '@rawr/db'
import { contextFrom, readSession } from '~/server/session.ts'
import { MemberList } from './member-list.tsx'

/** D5 and D6. Four fixed roles, Google as the only identity. A person joins as a
 *  viewer on their first sign-in; this is where an admin raises them. */
const MembersPage = async () => {
  const session = await readSession()
  if (!session) return null

  const members = await listMembers(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Members</h2>
        <p className="text-secondary">
          Everyone who can open {session.workspaceName}. Anyone with a verified{' '}
          {session.hostedDomain} Google account joins as a
          viewer the first time they sign in. Add somebody here to seat them with a role before
          that, or to change what a member may do.
        </p>
      </div>

      <MemberList
        rows={members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))}
        selfId={session.userId}
        canWrite={session.role === 'admin'}
        role={session.role}
      />
    </div>
  )
}

export default MembersPage
