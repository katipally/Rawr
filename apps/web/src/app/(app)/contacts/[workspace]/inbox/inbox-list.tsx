'use client'

import { Badge, Button, Card, Combobox, EmptyState, Spinner, Switch, TextInput, useToast } from '@rawr/ui'
import { Mail, MailOpen } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { useNavigation } from '~/components/navigation.tsx'
import { inboxPath, threadPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Thread = {
  id: string
  subject: string | null
  lastAt: string | null
  messageCount: number
  lastDirection: 'inbound' | 'outbound' | null
  lastFrom: string | null
  snippet: string | null
  unread: boolean
  contacts: { id: string; name: string }[]
  mailboxEmails: string[]
}

type Cursor = { lastAt: string; id: string } | null

export const InboxList = ({
  workspace,
  initial,
  cursor: initialCursor,
  mailboxes,
  filters,
}: {
  workspace: string
  initial: Thread[]
  cursor: Cursor
  mailboxes: { id: string; email: string; own: boolean }[]
  filters: { scope: 'mine' | 'all'; mailboxId: string | null; unreplied: boolean; unread: boolean; q: string | null }
}) => {
  const { navigate } = useNavigation()
  const toast = useToast()
  const [threads, setThreads] = useState(initial)
  const [cursor, setCursor] = useState<Cursor>(initialCursor)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState(filters.q ?? '')

  /** Every filter is an address, so a filtered inbox pastes into Slack and the
   *  back button works. */
  const goTo = (next: Partial<typeof filters>) => {
    const merged = { ...filters, ...next }
    navigate(
      inboxPath(workspace, {
        scope: merged.scope === 'mine' ? 'mine' : undefined,
        mailbox: merged.mailboxId ?? undefined,
        unreplied: merged.unreplied ? '1' : undefined,
        unread: merged.unread ? '1' : undefined,
        q: merged.q ?? undefined,
      }),
    )
  }

  const more = async () => {
    if (!cursor) return
    setBusy(true)
    try {
      const page = await api.mail.inbox.query({ ...filters, cursor, limit: 25 })
      setThreads((current) => [
        ...current,
        ...page.threads.map((thread) => ({ ...thread, lastAt: thread.lastAt?.toISOString() ?? null })),
      ])
      setCursor(page.cursor)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1" role="tablist" aria-label="Whose mail">
          {(['all', 'mine'] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              role="tab"
              aria-selected={filters.scope === scope}
              onClick={() => goTo({ scope })}
              className={
                filters.scope === scope
                  ? 'rounded-hs bg-accent-subtle px-3 py-1.5 font-medium text-link'
                  : 'rounded-hs px-3 py-1.5 text-secondary hover:bg-fill'
              }
            >
              {scope === 'all' ? 'Everyone' : 'Mine'}
            </button>
          ))}
        </div>

        <form
          className="flex min-w-48 flex-1 gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            goTo({ q: search.trim() || null })
          }}
        >
          <TextInput
            aria-label="Search threads"
            placeholder="Subject, sender or preview"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="submit">Search</Button>
        </form>

        <Combobox
          label="Mailbox"
          className="w-56"
          value={filters.mailboxId}
          onChange={(mailboxId) => goTo({ mailboxId })}
          options={mailboxes.map((box) => ({
            value: box.id,
            label: box.email,
            hint: box.own ? 'Yours' : undefined,
          }))}
        />

        <Switch
          label="Waiting on us"
          checked={filters.unreplied}
          onChange={(event) => goTo({ unreplied: event.target.checked })}
        />
        <Switch label="Unread" checked={filters.unread} onChange={(event) => goTo({ unread: event.target.checked })} />
      </div>

      {threads.length === 0 ? (
        <EmptyState
          title="No threads match"
          description="Clear a filter, or connect a mailbox under Settings, Mailboxes. Internal, personal and excluded threads are never stored."
        />
      ) : (
        <Card flush>
          <ul className="divide-y divide-divider">
            {threads.map((thread) => (
              <li key={thread.id}>
                <Link
                  href={threadPath(workspace, thread.id)}
                  // Centred, not baseline-aligned: a badge and an icon have their
                  // own line boxes, and a baseline row drops them half a line.
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 no-underline hover:bg-fill-hover"
                >
                  <span className="flex w-6 shrink-0 justify-center">
                    {thread.unread ? (
                      <Mail aria-label="Unread" className="size-4 text-link" />
                    ) : (
                      <MailOpen aria-label="Read" className="size-4 text-secondary" />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className={thread.unread ? 'truncate font-medium text-body' : 'truncate text-body'}>
                        {thread.subject ?? '(no subject)'}
                      </span>
                      {/* Words, not an icon and words: the badge truncates its
                          content as one block, so a glyph beside the label wraps
                          onto its own line the moment the row gets narrow. */}
                      {thread.lastDirection === 'inbound' ? <Badge tone="warn">Waiting on us</Badge> : null}
                      {thread.messageCount > 1 ? <span className="text-small text-secondary">{thread.messageCount}</span> : null}
                    </span>
                    <span className="truncate text-small text-secondary">
                      {thread.lastFrom ?? 'unknown sender'}
                      {thread.snippet ? ` — ${thread.snippet}` : ''}
                    </span>
                    {thread.contacts.length > 0 ? (
                      <span className="truncate text-small text-secondary">
                        {thread.contacts.map((contact) => contact.name).join(', ')}
                      </span>
                    ) : null}
                  </span>
                  <time
                    className="shrink-0 text-small text-secondary tabular-nums"
                    dateTime={thread.lastAt ?? undefined}
                  >
                    {thread.lastAt ? new Date(thread.lastAt).toLocaleDateString() : ''}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex items-center gap-2">
        {cursor ? (
          <Button busy={busy} onClick={() => void more()}>
            Show older
          </Button>
        ) : threads.length > 0 ? (
          <p className="text-secondary">That is every thread that matches.</p>
        ) : null}
        {busy ? <Spinner label="Loading threads" /> : null}
      </div>
    </div>
  )
}
