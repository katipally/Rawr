import { internalDomainOf, listBlocklist, listMailboxes } from '@rawr/db'
import { devGmailEnabled, googleConfigured } from '~/lib/env.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { MailboxList } from './mailbox-list.tsx'

/** F1 phase B. Trevor's continuity requirement: a successor opens a contact and
 *  sees the whole email history without anybody having forwarded anything.
 *
 *  Read only, `gmail.readonly` and nothing else. Rawr never sends mail and builds
 *  no tracking pixel; opens and clicks come from Apollo. D7, D8. */
const MailboxesPage = async ({ searchParams }: { searchParams: Promise<{ error?: string }> }) => {
  const session = await readSession()
  if (!session) return null

  const { error } = await searchParams
  const ctx = contextFrom(session)
  const [mailboxes, blocklist, internalDomain] = await Promise.all([
    listMailboxes(ctx),
    listBlocklist(ctx),
    internalDomainOf(ctx),
  ])

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Mailboxes</h2>
        <p className="text-secondary">
          Gmail, read only. Rawr reads threads so they appear on the right contacts, companies
          and deals; it never sends, never modifies, and never asks for permission to. Everything
          internal, personal, or on an exclusion list is refused before it is stored rather than
          stored and hidden.
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
