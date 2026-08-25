import { listForms } from '@rawr/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { EmptyState } from '@rawr/ui'
import { formsPath, submissionsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { publicBaseUrl } from '~/lib/env.ts'
import { EmbedSnippet } from './embed-snippet.tsx'

/** Every form in the workspace, with the two numbers that matter on a Monday:
 *  how many leads it has taken, and how many are sitting in review waiting for a
 *  person. */

const FormsPage = async ({ params }: { params: Promise<{ workspace: string }> }) => {
  const { workspace } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const forms = await listForms(contextFrom(session))
  const held = forms.reduce((total, form) => total + form.quarantined, 0)

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-medium">Forms</h1>
        <span className="text-sm text-secondary">
          {forms.length === 1 ? '1 form' : `${forms.length} forms`}
        </span>
        {held > 0 ? (
          <Link
            href={submissionsPath(workspace, { state: 'quarantined' })}
            className="text-sm font-semibold text-link"
          >
            {held === 1 ? '1 submission held for review' : `${held} submissions held for review`}
          </Link>
        ) : null}
      </header>

      {forms.length === 0 ? (
        <EmptyState
          title="No forms yet"
          description="A form captures a lead from the website and files it as a contact."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {forms.map((form) => (
            <li
              key={form.id}
              className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <Link href={formsPath(workspace, form.id)} className="font-semibold text-link">
                  {form.name}
                </Link>
                {!form.isActive ? (
                  <span className="rounded-hs bg-disabled px-1.5 py-0.5 text-xs text-secondary">
                    Off
                  </span>
                ) : null}
              </div>

              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
                <div>
                  <dt className="inline">Fields </dt>
                  <dd className="inline font-medium text-body">{form.fieldCount}</dd>
                </div>
                <div>
                  <dt className="inline">Leads </dt>
                  <dd className="inline font-medium text-body">{form.submissions}</dd>
                </div>
                <div>
                  <dt className="inline">Held </dt>
                  <dd className="inline font-medium text-body">{form.quarantined}</dd>
                </div>
                <div>
                  <dt className="inline">Last </dt>
                  <dd className="inline font-medium text-body">
                    {form.lastSubmissionAt
                      ? form.lastSubmissionAt.toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })
                      : 'never'}
                  </dd>
                </div>
              </dl>

              <EmbedSnippet
                baseUrl={publicBaseUrl}
                formId={form.id}
                workspace={workspace}
                slug={form.slug}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default FormsPage
