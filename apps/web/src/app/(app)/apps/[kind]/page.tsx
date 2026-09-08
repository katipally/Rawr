import { INTEGRATION_KINDS, listIntegrationsForOrg, type IntegrationKind } from '@rawr/db'
import { Alert, Badge, Card, PageHeader } from '@rawr/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { formatDateTime } from '~/components/crm/value.tsx'
import { INTEGRATION_ICONS } from '~/components/icons.ts'
import { appsPath, failedJobsPath, integrationsPath } from '~/lib/links.ts'
import { metaFor } from '~/server/integrations/index.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AppActions } from './actions.tsx'

/** One app: what it is, who installed it, what it is allowed to reach, and what
 *  it has been doing.
 *
 *  The permissions list is the part worth having. Every other screen says an
 *  integration is connected; none of them says what "connected" lets it touch,
 *  and that is the question somebody asks before they disconnect it. */
const AppPage = async ({ params }: { params: Promise<{ kind: string }> }) => {
  const { kind } = await params
  if (!INTEGRATION_KINDS.includes(kind as IntegrationKind)) notFound()

  const session = await readSession()
  if (!session) redirect('/sign-in')

  const rows = await listIntegrationsForOrg(contextFrom(session))
  const row = rows.find((entry) => entry.kind === kind)
  if (!row) notFound()

  const meta = metaFor(row.kind)
  const Icon = INTEGRATION_ICONS[row.kind]
  const connected = row.state !== 'not_configured'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link href={appsPath()} className="text-small text-body no-underline hover:underline">
          ‹ Back to connections
        </Link>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-secondary" />
      </div>

      <PageHeader
        title={meta.name}
        lead={meta.purpose}
        action={
          connected && session.isSuperAdmin ? <AppActions kind={row.kind} name={meta.name} /> : null
        }
      />

      {row.lastError ? (
        <Alert tone="warning">
          {meta.name} last reported: {row.lastError}
          {row.lastErrorAt ? ` (${formatDateTime(row.lastErrorAt.toISOString())})` : ''}
        </Alert>
      ) : null}

      {!connected ? (
        <Alert>
          Not connected. {meta.failureMode}{' '}
          {session.isSuperAdmin ? (
            <Link href={integrationsPath(row.kind)} className="font-medium text-link">
              Connect it
            </Link>
          ) : (
            'An organisation admin connects this.'
          )}
        </Alert>
      ) : null}

      <div className="grid gap-4 @3xl:grid-cols-[20rem_1fr]">
        <Card title="App info">
          <dl className="flex flex-col gap-3">
            <div>
              <dt className="text-secondary">Installed by</dt>
              <dd>{row.installedByName ?? 'Not by a person'}</dd>
            </div>
            <div>
              <dt className="text-secondary">Installed date</dt>
              <dd>{row.installedAt ? formatDateTime(row.installedAt.toISOString()) : '--'}</dd>
            </div>
            <div>
              <dt className="text-secondary">App type</dt>
              <dd>
                <Badge tone="neutral">{meta.appType}</Badge>
                <p className="pt-1 text-secondary">
                  {meta.appType === 'Shared'
                    ? 'One connection the whole organisation uses.'
                    : 'Granted per person, from their own account.'}
                </p>
              </dd>
            </div>
            <div>
              <dt className="text-secondary">Category</dt>
              <dd>{meta.category}</dd>
            </div>
            <div>
              <dt className="text-secondary">Last succeeded</dt>
              <dd>{row.lastOkAt ? formatDateTime(row.lastOkAt.toISOString()) : 'Never yet'}</dd>
            </div>
          </dl>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="App access and permissions">
            <div className="flex flex-col gap-4">
              <p className="text-secondary">
                What {meta.name} may reach through Rawr. Fixed by what the integration does, so it is
                the same for every organisation and there is nothing to grant or revoke per app
                beyond connecting it.
              </p>
              {meta.permissions.map((group) => (
                <details key={group.group} open className="border-t border-divider pt-3 first:border-t-0 first:pt-0">
                  <summary className="cursor-pointer font-medium">{group.group}</summary>
                  <ul className="flex flex-col gap-1 pt-2 pl-4 text-secondary">
                    {group.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </Card>

          <Card title="Insights">
            <div className="flex flex-col gap-3">
              <p>
                {row.deadLetters === 0
                  ? 'No failed jobs are waiting on this one.'
                  : `${row.deadLetters.toLocaleString()} failed job${row.deadLetters === 1 ? '' : 's'} can be replayed.`}
                {row.deadLetters > 0 ? (
                  <>
                    {' '}
                    <Link href={failedJobsPath()} className="font-medium text-link">
                      Open failed jobs
                    </Link>
                  </>
                ) : null}
              </p>
              <div>
                <h3 className="font-medium">When it is down</h3>
                <p className="text-secondary">{meta.failureMode}</p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default AppPage
