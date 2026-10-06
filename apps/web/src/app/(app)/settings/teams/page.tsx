import { listAssignable, listTeams } from '@rawr/db'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { TeamList } from './team-list.tsx'
import { UsersTeamsHeader } from '../members/users-teams-header.tsx'

/** Named groups inside this account. A form or a booking page that round-robins
 *  within a team hands European inbound to the people who work it, rather than to
 *  whoever happens to own the fewest contacts overall. */
const TeamsPage = async () => {
  const session = await readSession()
  if (!session) return null

  const ctx = contextFrom(session)
  const [teams, people] = await Promise.all([listTeams(ctx), listAssignable(ctx)])

  return (
    <div className="flex flex-col gap-4">
      <UsersTeamsHeader current="teams" />

      <TeamList teams={teams} people={people} canWrite={sessionIsAdmin(session)} hub="account" />
    </div>
  )
}

export default TeamsPage
