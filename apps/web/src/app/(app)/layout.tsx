import { redirect } from 'next/navigation'
import { ToastProvider } from '@rawr/ui'
import { AppShell, type NavSection } from '~/components/app-shell.tsx'
import { CommandPalette } from '~/components/crm/command-palette.tsx'
import {
  accountPath,
  bookingPagesPath,
  createRecordPath,
  formsPath,
  importsPath,
  inboxPath,
  integrationsPath,
  objectView,
  propertiesPath,
  segmentsPath,
  newsletterPath,
  reportsPath,
  sequencesPath,
  sitesPath,
  submissionsPath,
  tasksPath,
  workspaceHome,
} from '~/lib/links.ts'
import { memberships, readSession } from '~/server/session.ts'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const workspace = session.workspaceSlug
  const mine = await memberships(session.userId)
  // Built from the session, because every CRM address carries its workspace.
  // The four sections are HubSpot's: the records and the work on them, what goes
  // out to the market, what the numbers say, and the plumbing. Settings is not a
  // section; it is its own place, reached from the top bar.
  const nav: NavSection[] = [
    { key: 'home', label: 'Home', icon: 'home', href: workspaceHome(workspace) },
    {
      key: 'crm',
      label: 'CRM',
      icon: 'crm',
      groups: [
        {
          label: 'Records',
          items: [
            { href: objectView(workspace, 'contact', 'all'), label: 'Contacts', match: `/contacts/${workspace}/objects/contact` },
            { href: objectView(workspace, 'company', 'all'), label: 'Companies', match: `/contacts/${workspace}/objects/company` },
            { href: objectView(workspace, 'deal', 'all'), label: 'Deals', match: `/contacts/${workspace}/objects/deal` },
          ],
        },
        {
          label: 'Work',
          items: [
            { href: inboxPath(workspace), label: 'Inbox', match: `/contacts/${workspace}/inbox` },
            { href: segmentsPath(workspace), label: 'Segments', match: `/contacts/${workspace}/segments` },
            { href: tasksPath(workspace), label: 'Tasks' },
            { href: bookingPagesPath(workspace), label: 'Meetings', match: `/meetings/${workspace}` },
          ],
        },
      ],
    },
    {
      key: 'marketing',
      label: 'Marketing',
      icon: 'marketing',
      groups: [
        {
          label: 'Capture',
          items: [
            { href: formsPath(workspace), label: 'Forms', match: `/contacts/${workspace}/forms` },
            { href: submissionsPath(workspace, { state: 'quarantined' }), label: 'Review', match: `/contacts/${workspace}/submissions` },
          ],
        },
        {
          label: 'Outreach',
          items: [
            { href: sequencesPath(workspace), label: 'Sequences', match: `/contacts/${workspace}/sequences` },
            { href: newsletterPath(workspace), label: 'Newsletter', match: `/contacts/${workspace}/newsletter` },
          ],
        },
      ],
    },
    {
      key: 'reporting',
      label: 'Reporting',
      icon: 'reporting',
      groups: [
        {
          label: 'Reports',
          items: [
            { href: reportsPath(workspace), label: 'Overview', match: `/contacts/${workspace}/reports` },
            { href: reportsPath(workspace, { tab: 'pipeline' }), label: 'Pipeline' },
            { href: reportsPath(workspace, { tab: 'forms' }), label: 'Forms' },
            { href: reportsPath(workspace, { tab: 'sequences' }), label: 'Sequences' },
            { href: reportsPath(workspace, { tab: 'email' }), label: 'Email' },
            { href: reportsPath(workspace, { tab: 'website' }), label: 'Website' },
            { href: reportsPath(workspace, { tab: 'attribution' }), label: 'Attribution' },
          ],
        },
      ],
    },
    {
      key: 'data',
      label: 'Data management',
      icon: 'data',
      groups: [
        {
          label: 'Move data',
          items: [{ href: importsPath(workspace), label: 'Import' }],
        },
        {
          label: 'Configure',
          items: [
            { href: propertiesPath(), label: 'Properties' },
            { href: integrationsPath(), label: 'Integrations' },
            { href: sitesPath(), label: 'Tracked sites' },
          ],
        },
      ],
    },
  ]

  return (
    <ToastProvider>
      <AppShell
        workspaceName={session.workspaceName}
        workspaceSlug={workspace}
        workspaces={mine.map((m) => ({
          slug: m.workspaceSlug,
          name: m.workspaceName,
          organisation: m.organisationName,
        }))}
        email={session.email}
        role={session.role}
        nav={nav}
        create={[
          { key: 'contact', label: 'Contact', href: createRecordPath(workspace, 'contact') },
          { key: 'company', label: 'Company', href: createRecordPath(workspace, 'company') },
          { key: 'deal', label: 'Deal', href: createRecordPath(workspace, 'deal') },
          { key: 'task', label: 'Task', href: tasksPath(workspace) },
        ]}
        settingsHref={accountPath()}
        accountHref={accountPath()}
        homeHref={workspaceHome(workspace)}
        search={<CommandPalette workspace={workspace} />}
      >
        {children}
      </AppShell>
    </ToastProvider>
  )
}

export default AppLayout
