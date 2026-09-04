import { listGrants, listMailboxes, listMcpTokens, listMembers, readSchedule } from '@rawr/db'
import { devCalendarEnabled, devGmailEnabled, googleCalendarConfigured, googleConfigured } from '~/lib/env.ts'
import { agentAccessPath, availabilityPath, calendarsPath, mailboxesPath } from '~/lib/links.ts'
import { contextFrom, memberships, readSession } from '~/server/session.ts'
import { AccountPanel } from './account-panel.tsx'

/** The one screen that is about the signed-in person rather than the workspace:
 *  who Rawr thinks they are, what they may do here and who can change that, which
 *  Google services they have connected, and the sessions they hold. */
const AccountPage = async () => {
  const session = await readSession()
  if (!session) return null

  const ctx = contextFrom(session)
  const [mine, members, schedule, mailboxes, grants, tokens] = await Promise.all([
    memberships(session.userId),
    listMembers(ctx),
    readSchedule(ctx, session.userId),
    listMailboxes(ctx),
    listGrants(ctx),
    listMcpTokens(ctx),
  ])

  const mailbox = mailboxes.find((row) => row.userId === session.userId) ?? null
  const grant = grants.find((row) => row.userId === session.userId) ?? null
  const workspace = session.workspaceSlug

  return (
    <AccountPanel
      me={{
        email: session.email,
        displayName: session.displayName,
        avatarUrl: session.avatarUrl,
        role: session.role,
        userId: session.userId,
      }}
      workspaces={mine.map((m) => ({ slug: m.workspaceSlug, name: m.workspaceName, role: m.role, joinedAt: m.joinedAt.toISOString() }))}
      admins={members.filter((m) => m.role === 'admin' && m.userId !== session.userId).map((m) => ({ name: m.name, email: m.email }))}
      timezone={schedule.timezone}
      weekly={schedule.weekly}
      gmail={{
        state: mailbox?.state ?? null,
        detail: mailbox?.lastError ?? (mailbox ? `${mailbox.threadCount.toLocaleString()} threads on records.` : null),
        canConnect: googleConfigured || devGmailEnabled,
        href: googleConfigured ? '/api/auth/google/gmail' : mailboxesPath(),
        managePath: mailboxesPath(),
      }}
      calendar={{
        state: grant?.state ?? null,
        detail: grant?.lastError ?? (grant ? `${grant.provider === 'dev' ? 'Development calendar' : grant.calendarId}.` : null),
        canConnect: googleCalendarConfigured || devCalendarEnabled,
        href: googleCalendarConfigured ? `/api/auth/google/calendar?return=${encodeURIComponent('/settings/account')}` : calendarsPath(workspace),
        managePath: calendarsPath(workspace),
      }}
      tokens={tokens.filter((t) => t.userId === session.userId && !t.revokedAt).length}
      links={{ agent: agentAccessPath(), availability: availabilityPath(workspace) }}
    />
  )
}

export default AccountPage
