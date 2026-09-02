import { getForm, getRegistry, readSettings, type FormDetail } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { formsPath } from '~/lib/links.ts'
import { notFound, redirect } from 'next/navigation'
import { publicBaseUrl } from '~/lib/env.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { FormBuilder } from './builder.tsx'

/** The builder. Field mapping targets come from the registry, so a custom field
 *  added by marketing is available to map to without a deploy: that is the whole
 *  point of the registry existing. */

const BuilderPage = async ({ params }: { params: Promise<{ workspace: string; id: string }> }) => {
  const { workspace, id } = await params
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const canEdit = session.role === 'admin' || session.role === 'marketing'

  // /forms/new is the builder with nothing in it. Saving creates the form and
  // moves to its real address.
  if (id === 'new' && !canEdit) {
    return (
      <EmptyState
        title="Forms are built by marketing"
        description={`Your role (${session.role}) can read forms and their submissions, and cannot create one.`}
        action={<Link href={formsPath(workspace)}>Back to forms</Link>}
      />
    )
  }
  const blank: FormDetail = { id: '', name: '', slug: '', isActive: false, fields: [], settings: readSettings({}) }
  const [form, registry] = await Promise.all([id === 'new' ? blank : getForm(ctx, id), getRegistry(ctx)])
  if (!form) notFound()

  // Only contact and company: a form fills in a person and where they work. A
  // deal is created by a person, not by a stranger filling in a web form.
  const targets = registry.objects
    .filter((object) => object.key === 'contact' || object.key === 'company')
    .flatMap((object) =>
      object.fields
        .filter((field) => field.type !== 'relation' && field.type !== 'user' && field.type !== 'json')
        .map((field) => ({
          value: `${object.key}.${field.key}`,
          label: `${object.nameSingular} · ${field.label}`,
        })),
    )

  return (
    <FormBuilder
      workspace={workspace}
      form={form}
      targets={targets}
      baseUrl={publicBaseUrl}
      canEdit={canEdit}
    />
  )
}

export default BuilderPage
