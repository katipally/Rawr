import { redirect } from 'next/navigation'
import { ToastProvider } from '@rawr/ui'
import { AppShell } from '~/components/app-shell.tsx'
import { readSession } from '~/server/session.ts'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  return (
    <ToastProvider>
      <AppShell workspaceName={session.workspaceName} email={session.email} role={session.role}>
        {children}
      </AppShell>
    </ToastProvider>
  )
}

export default AppLayout
