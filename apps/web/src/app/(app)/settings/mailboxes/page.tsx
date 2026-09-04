import { bodyProgress, internalDomainOf, listBlocklist, listMailboxes } from '@rawr/db'
import { devGmailEnabled, googleConfigured } from '~/lib/env.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { MailboxList } from './mailbox-list.tsx'

/** The continuity requirement: a successor opens a contact and sees the whole
 *  email history without anybody having forwarded anything.
 *
 *  Read only for now, `gmail.readonly` and nothing else. Bodies are stored here
 *  rather than fetched from Gmail on demand, which is what makes a thread outlive
 *  the mailbox that brought it in; each mailbox says who may read what it read. */
const MailboxesPage = async ({ searchParams }: { searchParams: Promise<{ error?: string }> }) => {
  const session = await readSession()
  if (!session) return null

  const { error } = await searchParams
  const ctx = contextFrom(session)
  const [mailboxes, blocklist, internalDomain, progress] = await Promise.all([
    listMailboxes(ctx),
    listBlocklist(ctx),
    internalDomainOf(ctx),
    bodyProgress(ctx),
  ])
  const bodies = new Map(progress.map((row) => [row.mailboxId, row]))

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Mailboxes</h2>
        <p className="text-secondary">
          Gmail. Rawr reads threads so they appear on the right contacts, companies and deals,
          and keeps them here, so a thread stays readable after the mailbox that brought it in is
          disconnected. A mailbox that granted sending is also what sequences and one-off replies
          go out through, so the conversation stays in one place. Everything internal, personal,
          or on an exclusion list is refused before it is stored rather than stored and hidden.
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-hs border border-error bg-error-subtle px-3 py-2 text-error">
          {error}
        </p>
      ) : null}

      <MailboxList
        rows={mailboxes.map((row) => ({
          ...row,
          lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
          lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
          pendingBodies: bodies.get(row.id)?.pending ?? 0,
          storedBodies: bodies.get(row.id)?.stored ?? 0,
        }))}
        blocklist={blocklist}
        currentUserId={session.userId}
        role={session.role}
        internalDomain={internalDomain}
        googleReady={googleConfigured}
        devReady={devGmailEnabled}
      />
    </div>
  )
}

export default MailboxesPage
