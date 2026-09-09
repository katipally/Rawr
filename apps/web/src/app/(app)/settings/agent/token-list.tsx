'use client'

import { Button, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

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
  const zone = useZone()
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
            <Button variant="secondary" onClick={() => void copy(endpoint, 'Endpoint')}>
              Copy the endpoint
            </Button>
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <div className="rounded-panel border border-line p-4">
        <h2 className="font-medium">New token</h2>
        <p className="text-secondary">Name it after where it will live, so it can be revoked when that machine goes.</p>
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

      <div className="flex flex-col gap-3 rounded-panel border border-line p-4">
        <div>
          <h2 className="font-medium">Connecting an assistant</h2>
          <p className="text-secondary">
            Rawr is a standard MCP server over HTTP, with OAuth 2.1 and dynamic client
            registration. Any MCP client can connect: give it this address, approve the
            connection in the browser, and it acts as you, under your role.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-hs bg-fill p-2 text-small break-all">
            {endpoint}
          </code>
          <Button variant="secondary" onClick={() => void copy(endpoint, 'Endpoint')}>
            Copy
          </Button>
        </div>

        <p className="text-small text-secondary">
          Most clients need nothing else: they read{' '}
          <code className="rounded-hs bg-fill px-1">/.well-known/oauth-protected-resource</code> from
          that address, register themselves, and open the sign-in page. No client id, no secret, no
          token to paste.
        </p>

        <details className="text-small">
          <summary className="cursor-pointer text-secondary">
            Where the address goes, in a few common clients
          </summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt className="text-secondary">A desktop or web assistant</dt>
            <dd>
              Look for Connectors, Integrations or MCP servers in its settings, choose to add a
              custom or remote server, and paste the address. Leave any client secret field empty.
            </dd>
            <dt className="text-secondary">A command-line agent</dt>
            <dd>
              Most take an HTTP MCP server directly, for example{' '}
              <code className="block overflow-x-auto rounded-hs bg-fill p-2">
                claude mcp add --transport http rawr {endpoint}
              </code>
            </dd>
            <dt className="text-secondary">A client that cannot open a browser</dt>
            <dd>
              Create a token above and send it as{' '}
              <code>Authorization: Bearer YOUR_TOKEN</code>. A stdio-only client can run{' '}
              <code>node apps/web/scripts/mcp-stdio.ts</code> with <code>RAWR_MCP_URL</code> and{' '}
              <code>RAWR_MCP_TOKEN</code> set.
            </dd>
          </dl>
        </details>

        <p className="text-secondary">
          Every screen in Rawr has a tool behind it. A connection made through OAuth appears below
          under the client&apos;s own name and is revoked the same way as a token.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">
          {isAdmin ? 'Tokens in this account' : 'Your tokens'}{' '}
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
                      ? `Revoked ${formatDateTime(row.revokedAt, zone)}`
                      : row.lastUsedAt
                        ? `Last used ${formatDateTime(row.lastUsedAt, zone)}`
                        : 'Never used'}{' '}
                    · created {formatDateTime(row.createdAt, zone)}
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

