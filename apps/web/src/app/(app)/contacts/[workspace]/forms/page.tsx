import { listForms } from '@rawr/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Button, EmptyState, PageHeader } from '@rawr/ui'
import { formsPath, submissionsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { publicBaseUrl } from '~/lib/env.ts'
import { FormsTable } from './forms-table.tsx'

/** Every form in the workspace, with the two numbers that matter on a Monday:
 *  how many leads it has taken, and how many are sitting in review waiting for a
 *  person. */

const FormsPage = async ({ params }: { params: Promise<{ workspace: string }> }) => {
  const { workspace } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const forms = await listForms(contextFrom(session))
  const held = forms.reduce((total, form) => total + form.quarantined, 0)
  const canCreate = session.role === 'admin' || session.role === 'marketing'
  const newForm = canCreate ? (
    <Link href={formsPath(workspace, 'new')} className="no-underline">
      <Button variant="primary" tabIndex={-1}>
        Create form
      </Button>
    </Link>
  ) : null

  return (
    <div className="flex flex-col">
      <PageHeader
        className="mb-4"
        title="Forms"
        lead={
          <>
            {forms.length === 1 ? '1 form' : `${forms.length} forms`}
            {held > 0 ? (
              <>
                {' · '}
                <Link href={submissionsPath(workspace, { state: 'quarantined' })} className="font-semibold text-link">
                  {held === 1 ? '1 submission held for review' : `${held} submissions held for review`}
                </Link>
              </>
            ) : null}
          </>
        }
        why="Every form in the workspace with the two numbers that matter on a Monday: how many leads it has taken, and how many are sitting in review waiting for a person."
        action={newForm}
      />

      {forms.length === 0 ? (
        <EmptyState
          title="No forms yet"
          description="A form captures a lead from the website and files it as a contact."
          action={newForm}
        />
      ) : (
        <FormsTable
          workspace={workspace}
          baseUrl={publicBaseUrl}
          rows={forms.map((form) => ({
            id: form.id,
            name: form.name,
            slug: form.slug,
            isActive: form.isActive,
            fieldCount: form.fieldCount,
            submissions: form.submissions,
            quarantined: form.quarantined,
            lastSubmissionAt: form.lastSubmissionAt?.toISOString() ?? null,
          }))}
        />
      )}
    </div>
  )
}

export default FormsPage
