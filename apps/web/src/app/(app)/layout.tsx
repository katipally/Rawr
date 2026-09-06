import { canWrite, getRegistry, type Role } from '@rawr/db'
import { redirect } from 'next/navigation'
import { ToastProvider } from '@rawr/ui'
import { AppShell, type NavSection } from '~/components/app-shell.tsx'
import { ShortcutSheet } from '~/components/shortcut-sheet.tsx'
import { CommandPalette } from '~/components/crm/command-palette.tsx'
import {
  accountPath,
  availabilityPath,
  bookedPath,
  bookingPagesPath,
  calendarsPath,
  createRecordPath,
  formsPath,
  duplicatesPath,
  exportPath,
  importsPath,
  inboxPath,
  integrationsPath,
  objectsPath,
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
import { contextFrom, memberships, readSession } from '~/server/session.ts'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const workspace = session.workspaceSlug
  const [mine, registry] = await Promise.all([
    memberships(session.userId),
    getRegistry(contextFrom(session)),
  ])
  // Built from the session, because every CRM address carries its workspace.
  // The sections are HubSpot's hubs in HubSpot's order. Home is the logo, and
  // Settings is its own place, reached from the top bar.
  const nav: NavSection[] = [
    {
      key: 'crm',
      label: 'CRM',
      icon: 'crm',
      groups: [
        {
          label: 'Records',
          // From the registry, so an object an admin invents is in the menu the
          // moment it exists rather than only at an address somebody typed.
          items: registry.objects.map((object) => ({
            href: objectView(workspace, object.key, 'all'),
            label: object.namePlural,
            match: `/contacts/${workspace}/objects/${object.key}`,
          })),
        },
        {
          label: 'Work',
          items: [
            { href: segmentsPath(workspace), label: 'Segments (Lists)', match: `/contacts/${workspace}/segments` },
            { href: inboxPath(workspace), label: 'Inbox', match: `/contacts/${workspace}/inbox` },
            { href: bookedPath(workspace), label: 'Meetings', match: `/meetings/${workspace}/booked` },
            { href: tasksPath(workspace), label: 'Tasks' },
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
            { href: newsletterPath(workspace), label: 'Email', match: `/contacts/${workspace}/newsletter` },
            { href: formsPath(workspace), label: 'Forms', match: `/contacts/${workspace}/forms` },
            { href: submissionsPath(workspace, { state: 'quarantined' }), label: 'Form submissions', match: `/contacts/${workspace}/submissions` },
          ],
        },
        {
          label: 'Analytics',
          items: [
            { href: reportsPath(workspace, { tab: 'forms' }), label: 'Marketing Analytics', match: `/contacts/${workspace}/reports/forms` },
          ],
        },
      ],
    },
    {
      key: 'sales',
      label: 'Sales',
      icon: 'sales',
      groups: [
        {
          label: 'Selling',
          items: [
            { href: calendarsPath(workspace), label: 'Calendar', match: `/meetings/${workspace}/calendars` },
            { href: availabilityPath(workspace), label: 'Availability', match: `/meetings/${workspace}/availability` },
            { href: bookingPagesPath(workspace), label: 'Meetings Scheduler', match: `/meetings/${workspace}/pages` },
            { href: sequencesPath(workspace), label: 'Sequences', match: `/contacts/${workspace}/sequences` },
          ],
        },
        {
          label: 'Analytics',
          items: [
            { href: reportsPath(workspace, { tab: 'pipeline' }), label: 'Sales Analytics', match: `/contacts/${workspace}/reports/pipeline` },
          ],
        },
      ],
    },
    {
      key: 'data',
      label: 'Data Management',
      icon: 'data',
      groups: [
        {
          label: 'Move data',
          items: [
            { href: importsPath(workspace), label: 'Data Integration', match: `/contacts/${workspace}/import` },
            { href: exportPath(workspace), label: 'Export' },
            { href: duplicatesPath(workspace), label: 'Duplicates' },
          ],
        },
        {
          label: 'Configure',
          items: [
            { href: objectsPath(), label: 'Data Model' },
            { href: propertiesPath(), label: 'Properties' },
            { href: sitesPath(), label: 'Event Management' },
            { href: integrationsPath(), label: 'Data Enrichment' },
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
            { href: reportsPath(workspace, { tab: 'dashboards' }), label: 'Dashboards', match: `/contacts/${workspace}/reports/dashboards` },
            { href: reportsPath(workspace), label: 'Reports', match: `/contacts/${workspace}/reports` },
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
        // Only what this role can actually make. A viewer was offered four
        // things to create and every one of them landed on a page that quietly
        // ignored the request, because the create dialog checks the role and the
        // menu did not.
        create={[
          { key: 'contact', label: 'Contact', href: createRecordPath(workspace, 'contact'), entity: 'contact' },
          { key: 'company', label: 'Company', href: createRecordPath(workspace, 'company'), entity: 'company' },
          { key: 'deal', label: 'Deal', href: createRecordPath(workspace, 'deal'), entity: 'deal' },
          { key: 'task', label: 'Task', href: tasksPath(workspace, { new: '1' }), entity: 'task' },
        ].flatMap(({ entity, ...option }) =>
          canWrite(session.role as Role, entity) ? [option] : [],
        )}
        settingsHref={accountPath()}
        accountHref={accountPath()}
        homeHref={workspaceHome(workspace)}
        search={<CommandPalette workspace={workspace} />}
      >
        {children}
      </AppShell>
      <ShortcutSheet />
    </ToastProvider>
  )
}

export default AppLayout
