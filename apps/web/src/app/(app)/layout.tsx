import { redirect } from 'next/navigation'
import { ToastProvider } from '@rawr/ui'
import { AppShell, type NavSection } from '~/components/app-shell.tsx'
import { CommandPalette } from '~/components/crm/command-palette.tsx'
import {
  bookingPagesPath,
  formsPath,
  importsPath,
  objectView,
  propertiesPath,
  segmentsPath,
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
  // Three sections rather than ten tabs: the record types and the two things
  // built on them, what the outside world sends in, and what somebody loads by
  // hand. Settings is not a section; it lives in the top bar and owns its own
  // sub-navigation once you are inside it.
  const nav: NavSection[] = [
    { key: 'home', label: 'Home', icon: 'home', href: workspaceHome(workspace) },
    {
      key: 'crm',
      label: 'CRM',
      icon: 'crm',
      groups: [
        [
          { href: objectView(workspace, 'contact', 'all'), label: 'Contacts', match: `/contacts/${workspace}/objects/contact` },
          { href: objectView(workspace, 'company', 'all'), label: 'Companies', match: `/contacts/${workspace}/objects/company` },
          { href: objectView(workspace, 'deal', 'all'), label: 'Deals', match: `/contacts/${workspace}/objects/deal` },
        ],
        [
          { href: segmentsPath(workspace), label: 'Segments', match: `/contacts/${workspace}/segments` },
          { href: tasksPath(workspace), label: 'Tasks' },
        ],
      ],
    },
    {
      key: 'capture',
      label: 'Capture',
      icon: 'capture',
      groups: [
        [
          { href: formsPath(workspace), label: 'Forms', match: `/contacts/${workspace}/forms` },
          { href: bookingPagesPath(workspace), label: 'Meetings', match: `/meetings/${workspace}` },
        ],
        [
          { href: submissionsPath(workspace, { state: 'quarantined' }), label: 'Review', match: `/contacts/${workspace}/submissions` },
        ],
      ],
    },
    {
      key: 'data',
      label: 'Data',
      icon: 'data',
      groups: [[{ href: importsPath(workspace), label: 'Import' }]],
    },
  ]

  return (
    <ToastProvider>
      <AppShell
        workspaceName={session.workspaceName}
        workspaceSlug={workspace}
        workspaces={mine.map((m) => ({ slug: m.workspaceSlug, name: m.workspaceName }))}
        email={session.email}
        role={session.role}
        nav={nav}
        settingsHref={propertiesPath()}
        search={<CommandPalette workspace={workspace} />}
      >
        {children}
      </AppShell>
    </ToastProvider>
  )
}

export default AppLayout
