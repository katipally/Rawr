'use client'

import { Button, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

export type TokenRow = {
  id: string
  name: string
  prefix: string
  userId: string
  userName: string
  lastUsedAt: string | null
  createdAt: string
  revokedAt: string | null
}

/** The plaintext is shown once, here, and nowhere else ever again.
 *
 *  Shown as text rather than hidden behind a reveal, because the next thing a
 *  person does with it is paste it into a terminal, and a token they cannot see is
 *  a token they will create twice. */
export const TokenList = ({
  rows,
  endpoint,
  userId,
  isAdmin,
}: {
  rows: TokenRow[]
  endpoint: string
  userId: string
  isAdmin: boolean
}) => {
  const toast = useToast()
  const router = useRouter()
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast('error', 'Give the token a name, so the right one can be revoked later.')
      return
    }
    setBusy('create')
    try {
      const created = await api.mcp.create.mutate({ name: trimmed })
      setIssued(created.token)
      setName('')
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (row: TokenRow) => {
    setBusy(row.id)
    try {
      const stopped = await api.mcp.revoke.mutate({ id: row.id })
      toast(
        'success',
        stopped
          ? `"${row.name}" is revoked. It stops working on its next call.`
          : `"${row.name}" was already revoked.`,
      )
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast('success', `${what} copied.`)
    } catch {
      toast('error', 'Your browser would not let this page use the clipboard. Select it and copy by hand.')
    }
  }

  const live = rows.filter((row) => !row.revokedAt)
  const dead = rows.filter((row) => row.revokedAt)

  return (
    <div className="flex flex-col gap-6">
      {issued ? (
        <div className="rounded-panel border border-line-interactive bg-accent-subtle p-4">
          <p className="font-medium">Copy this now. It is not shown again.</p>
          <code className="mt-2 block overflow-x-auto rounded-hs bg-surface p-3 text-small break-all">
            {issued}
          </code>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void copy(issued, 'Token')}>Copy token</Button>
            <Button
              variant="secondary"
              onClick={() =>
                void copy(
                  `claude mcp add --transport http rawr ${endpoint} --header "Authorization: Bearer ${issued}"`,
                  'Command',
                )
              }
            >
              Copy the Claude Code command
            </Button>
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <div className="rounded-panel border border-line p-4">
        <h2 className="font-medium">New token</h2>
        <p className="text-secondary">
          Name it after where it will live, so the right one can be revoked when that laptop or
          that machine goes away.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <TextInput
            aria-label="Token name"
            className="w-auto min-w-64"
            placeholder="Trevor's laptop"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
          />
          <Button onClick={() => void create()} disabled={busy === 'create'}>
            {busy === 'create' ? 'Creating…' : 'Create token'}
          </Button>
        </div>
      </div>

      <div className="rounded-panel border border-line p-4">
        <h2 className="font-medium">Connecting an assistant</h2>
        <p className="text-secondary">
          Rawr speaks MCP over HTTP and signs you in with OAuth, so most clients need no token at
          all: add the server, approve the connection in the browser, and it acts as you.
        </p>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-small">
          <dt className="text-secondary">claude.ai, Claude Desktop</dt>
          <dd>
            Settings, Connectors, Add custom connector. Paste{' '}
            <code className="rounded-hs bg-fill px-1 break-all">{endpoint}</code> and leave the client
            secret empty.
          </dd>
          <dt className="text-secondary">Claude Code</dt>
          <dd>
            <code className="block overflow-x-auto rounded-hs bg-fill p-2">
              claude mcp add --transport http rawr {endpoint}
            </code>
            then <code>/mcp</code> to sign in.
          </dd>
          <dt className="text-secondary">A fixed token</dt>
          <dd>
            For a client that cannot open a browser, create a token above and send it as{' '}
            <code>Authorization: Bearer YOUR_TOKEN</code>. A stdio-only client can run{' '}
            <code>node apps/web/scripts/mcp-stdio.ts</code> with <code>RAWR_MCP_URL</code> and{' '}
            <code>RAWR_MCP_TOKEN</code> set.
          </dd>
        </dl>
        <p className="mt-3 text-secondary">
          Either way, every tool the screens have is available: records, pipeline, tasks, timeline,
          mail threads, meetings, forms, segments, integrations and settings, each under your role.
          A connection made through OAuth appears in the list below under the client&apos;s name
          and is revoked the same way.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">
          {isAdmin ? 'Tokens in this workspace' : 'Your tokens'}{' '}
          <span className="text-secondary">
            {live.length} active{dead.length > 0 ? `, ${dead.length} revoked` : ''}
          </span>
        </h2>
        {rows.length === 0 ? (
          <p className="text-secondary">No tokens yet. Create one above to connect an assistant.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {[...live, ...dead].map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words">
                    {row.name}{' '}
                    <span className="text-secondary">
                      {row.prefix}… · {row.userId === userId ? 'you' : row.userName}
                    </span>
                  </p>
                  <p className="text-secondary text-small">
                    {row.revokedAt
                      ? `Revoked ${when(row.revokedAt)}`
                      : row.lastUsedAt
                        ? `Last used ${when(row.lastUsedAt)}`
                        : 'Never used'}{' '}
                    · created {when(row.createdAt)}
                  </p>
                </div>
                {row.revokedAt ? null : (
                  <Button
                    variant="destructive"
                    onClick={() => void revoke(row)}
                    disabled={busy === row.id}
                  >
                    {busy === row.id ? 'Revoking…' : 'Revoke'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
