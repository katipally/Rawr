import { listOrgWorkspaces, readOrganisation } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { orgContextFrom, readSession } from '~/server/session.ts'
import { OrganisationPanel } from './organisation-panel.tsx'

/** The company itself: what it is called, how many seats it has, whether a
 *  verified account on its domain may let itself in, and which workspaces it
 *  owns. */
const OrganisationPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (session.orgRole !== 'org_admin') {
    return (
      <EmptyState
        title="Only an organisation admin can open this"
        description={`You are a member of ${session.organisationName}. Ask one of its admins if you need a workspace created or somebody seated.`}
      />
    )
  }

  const org = orgContextFrom(session)
  const [organisation, workspaces] = await Promise.all([readOrganisation(org), listOrgWorkspaces(org)])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Organisation"
        lead={`${organisation.name} owns every workspace below.`}
        why={
          <p>
            People, seats and access are held here, so somebody who leaves loses all of them at
            once.
          </p>
        }
      />

      <OrganisationPanel
        organisation={organisation}
        workspaces={workspaces.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))}
        currentWorkspaceId={session.workspaceId}
      />
    </div>
  )
}

export default OrganisationPage
