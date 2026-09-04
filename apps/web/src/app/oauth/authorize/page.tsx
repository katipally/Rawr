import { Alert } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { checkAuthorizeRequest, SCOPE_DESCRIPTION } from '~/server/mcp/oauth.ts'
import { memberships, readSession } from '~/server/session.ts'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** The consent screen. A person signed in to Rawr sees who is asking, where they
 *  will be sent back to, and which workspace the assistant will act in, then
 *  approves or refuses. Nothing is issued until they press Approve. */
const AuthorizePage = async ({ searchParams }: Props) => {
  const raw = await searchParams
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value)
  }

  const session = await readSession()
  if (!session) {
    redirect(`/sign-in?next=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`)
  }

  const checked = await checkAuthorizeRequest(params)
  if (!checked.ok) {
    return (
      <Frame title="This connection cannot continue">
        <Alert>
          {checked.problem}
        </Alert>
        <p className="text-secondary">Go back to the assistant and start the connection again.</p>
      </Frame>
    )
  }

  const { client, request } = checked
  const redirectHost = new URL(request.redirectUri).host
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(redirectHost)
  const workspaces = await memberships(session.userId)

  return (
    <Frame title={`Connect ${client.name} to Rawr`}>
      <p>
        <span className="font-medium">{client.name}</span> wants to act in Rawr as{' '}
        <span className="font-medium">{session.email}</span>. {SCOPE_DESCRIPTION} Every change it
        makes lands on the timeline under your name, and you can revoke it any time from Settings,
        under Agent access.
      </p>

      <p className="text-small text-secondary">
        After you approve, you will be sent to <span className="font-medium">{redirectHost}</span>.
        {loopback
          ? ' That is an application running on this computer. Only approve if you started this connection yourself just now.'
          : ''}
      </p>

      <form method="post" action="/api/oauth/authorize" className="flex flex-col gap-4">
        {[...params.entries()].map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}

        <label className="flex flex-col gap-1">
          <span className="font-medium">Workspace</span>
          <select
            name="workspace_id"
            defaultValue={session.workspaceId}
            className="h-9 rounded-hs border border-line bg-fill px-3 text-body outline-none focus:border-line-interactive"
          >
            {workspaces.map((membership) => (
              <option key={membership.workspaceId} value={membership.workspaceId}>
                {membership.workspaceName} · {membership.role}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            name="decision"
            value="approve"
            className="h-9 rounded-hs bg-cta px-4 font-semibold text-white transition-colors hover:bg-cta-hover"
          >
            Approve
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className="h-9 rounded-hs border border-line bg-surface px-4 font-medium transition-colors hover:bg-fill-hover"
          >
            Cancel
          </button>
        </div>
      </form>
    </Frame>
  )
}

const Frame = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-6">
    <h1 className="text-lg font-medium break-words">{title}</h1>
    {children}
  </main>
)

export default AuthorizePage
