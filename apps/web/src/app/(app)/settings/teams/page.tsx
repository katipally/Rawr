import { PageHeader } from '@rawr/ui'
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
      <PageHeader
        as="h2"
        title="Teams"
        lead={`Groups inside ${session.workspaceName}.`}
        why={
          <p>
            A form set to round-robin within a team rotates through its members rather than through
            everybody.
          </p>
        }
      />

      <TeamList teams={teams} people={people} canWrite={session.role === 'admin'} role={session.role} />
    </div>
  )
}

export default TeamsPage
