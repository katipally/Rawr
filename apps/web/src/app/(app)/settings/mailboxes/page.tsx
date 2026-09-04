import { Alert, PageHeader } from '@rawr/ui'
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
      <PageHeader
        as="h2"
        title="Mailboxes"
        lead="Gmail threads on the contacts, companies and deals they are about."
        why={
          <>
            <p>
              Threads are kept here, so one stays readable after the mailbox that brought it in is
              disconnected. A mailbox that granted sending is also what sequences and one-off
              replies go out through, so the conversation stays in one place.
            </p>
            <p>
              Everything internal, personal, or on an exclusion list is refused before it is stored
              rather than stored and hidden.
            </p>
          </>
        }
      />

      {error ? (
        <Alert>
          {error}
        </Alert>
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
