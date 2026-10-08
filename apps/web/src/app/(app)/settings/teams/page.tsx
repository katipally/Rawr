import { listAssignable, listTeams } from '@rawr/db'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { TeamList } from './team-list.tsx'
import { UsersTeamsHeader } from '../members/users-teams-header.tsx'

/** Named groups of people inside this account. A form or booking page can hand its work to a team, which takes its members in turn. */
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
