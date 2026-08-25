import { redirect } from 'next/navigation'
import { ToastProvider } from '@rawr/ui'
import { AppShell, type NavItem } from '~/components/app-shell.tsx'
import { CommandPalette } from '~/components/crm/command-palette.tsx'
import { objectView, importsPath, tasksPath } from '~/lib/links.ts'
import { readSession } from '~/server/session.ts'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const workspace = session.workspaceSlug
  // Built from the session, because every CRM address carries its workspace.
  const nav: NavItem[] = [
    { href: objectView(workspace, 'contact', 'all'), label: 'Contacts', match: `/contacts/${workspace}/objects/contact` },
    { href: objectView(workspace, 'company', 'all'), label: 'Companies', match: `/contacts/${workspace}/objects/company` },
    { href: objectView(workspace, 'deal', 'all'), label: 'Deals', match: `/contacts/${workspace}/objects/deal` },
    { href: tasksPath(workspace), label: 'Tasks' },
    { href: importsPath(workspace), label: 'Import' },
  ]

  return (
    <ToastProvider>
      <AppShell
        workspaceName={session.workspaceName}
        email={session.email}
        role={session.role}
        nav={nav}
        search={<CommandPalette workspace={workspace} />}
      >
        {children}
      </AppShell>
    </ToastProvider>
  )
}

export default AppLayout
