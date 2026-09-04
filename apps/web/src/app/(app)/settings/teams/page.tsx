import { listAssignable, listTeams } from '@rawr/db'
import { contextFrom, readSession } from '~/server/session.ts'
import { TeamList } from './team-list.tsx'

/** Named groups inside this workspace. A form or a booking page that round-robins
 *  within a team hands European inbound to the people who work it, rather than to
 *  whoever happens to own the fewest contacts overall. */
const TeamsPage = async () => {
  const session = await readSession()
  if (!session) return null

  const ctx = contextFrom(session)
  const [teams, people] = await Promise.all([listTeams(ctx), listAssignable(ctx)])

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Teams</h2>
        <p className="text-secondary">
          Groups inside {session.workspaceName}. A form set to round-robin within a team rotates through
          its members rather than through everybody.
        </p>
      </div>

      <TeamList teams={teams} people={people} canWrite={session.role === 'admin'} role={session.role} />
    </div>
  )
}

export default TeamsPage
