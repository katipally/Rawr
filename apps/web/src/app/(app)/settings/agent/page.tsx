import { PageHeader } from '@rawr/ui'
import { listMcpTokens } from '@rawr/db'
import { publicBaseUrl } from '~/lib/env.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { TokenList } from './token-list.tsx'

/** F5 §1. Where a person creates the token their assistant uses.
 *
 *  Not an admin screen. Trevor's daily workflow is "open Claude and say update the
 *  close date", and putting his own access behind somebody else's approval would
 *  break exactly the thing this feature exists to keep working. */
const AgentAccessPage = async () => {
  const session = await readSession()
  if (!session) return null

  const tokens = await listMcpTokens(contextFrom(session))
  const endpoint = `${publicBaseUrl}/api/mcp`

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agent access"
        lead="An assistant connects by signing in, or with a token created here."
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
        isAdmin={session.role === 'admin'}
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
