import { PageHeader } from '@rawr/ui'
import { listMcpTokens } from '@rawr/db'
import { requestOrigin } from '~/server/origin.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { TokenList } from './token-list.tsx'

/** F5 §1. Where a person connects their assistant, or creates the token it uses.
 *
 *  Not an admin screen. The daily workflow is "open an assistant and say update the
 *  close date", and putting somebody's own access behind another person's approval
 *  would break exactly the thing this feature exists to keep working. */
const AgentAccessPage = async () => {
  const session = await readSession()
  if (!session) return null

  const tokens = await listMcpTokens(contextFrom(session))
  // The address the person is reading this on is the address their client should
  // be given, whatever host this deployment answers as.
  const endpoint = `${await requestOrigin()}/api/mcp`

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agent access"
        lead="Any MCP client connects by signing in, or with a token created here."
        why={
          <p>
            Either way it reads and changes records as you, with your role: it can do nothing you
            cannot do yourself, every change is on the timeline under your name, and revoking the
            connection stops it on the next call.
          </p>
        }
      />

      <TokenList
        endpoint={endpoint}
        isAdmin={sessionIsAdmin(session)}
        userId={session.userId}
        rows={tokens.map((token) => ({
          ...token,
          createdAt: token.createdAt.toISOString(),
          lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
          revokedAt: token.revokedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  )
}

export default AgentAccessPage
