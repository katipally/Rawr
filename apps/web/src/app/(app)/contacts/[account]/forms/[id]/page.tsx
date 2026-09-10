import {
  getForm,
  getRegistry,
  listMembers,
  listSubscriptionTypes,
  readSettings,
  SEED_FORMS,
  type FormDetail,
} from '@rawr/db'
import { Breadcrumb, EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { formsPath } from '~/lib/links.ts'
import { notFound, redirect } from 'next/navigation'
import { publicBaseUrl } from '~/lib/env.ts'
import { slackCredentials } from '~/server/integrations/slack.ts'
import { contextFrom, readSession, sessionCanEdit } from '~/server/session.ts'
import { FormBuilder } from './builder.tsx'

/** The builder. Field mapping targets come from the registry, so a custom field
 *  added by marketing is available to map to without a deploy: that is the whole
 *  point of the registry existing. */

const BuilderPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; id: string }>
  searchParams: Promise<{ from?: string }>
}) => {
  const { account, id } = await params
  const { from } = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const canEdit = sessionCanEdit(session, 'marketing')

  // /forms/new is the builder with nothing in it. Saving creates the form and
  // moves to its real address.
  if (id === 'new' && !canEdit) {
    return (
      <EmptyState
        title="Forms are built by marketing"
        description="Building one needs marketing access, which you do not have. You can read forms and their submissions, but not create one."
        action={<LinkButton variant="primary" href={formsPath(account)}>Back to forms</LinkButton>}
      />
    )
  }
  // A new form starts from one of the shapes this company actually builds, or
  // from nothing. Offered before the builder rather than inside it, because the
  // choice changes every field on the screen behind it.
  if (id === 'new' && !from) return <TemplatePicker account={account} />

  // ?from=<template slug> starts the builder on one of the shapes the account
  // was seeded with. Name and address are left blank on purpose: the seeded form
  // already holds that slug, and a unique index is a poor way to learn that.
  const template = from ? SEED_FORMS.find((seed) => seed.slug === from) : undefined
  const blank: FormDetail = {
    id: '',
    name: '',
    slug: '',
    isActive: false,
    fields: template?.fields ?? [],
    settings: template?.settings ?? readSettings({}),
  }
  const [form, registry, members, subscriptions, slack] = await Promise.all([
    id === 'new' ? blank : getForm(ctx, id),
    getRegistry(ctx),
    listMembers(ctx),
    listSubscriptionTypes(ctx),
    slackCredentials(ctx),
  ])
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
          conditional: field.conditional !== null,
        })),
    )

  return (
    <FormBuilder
      account={account}
      form={form}
      targets={targets}
      members={members.filter((m) => m.isSuperAdmin || m.editHubs.includes('sales')).map((m) => ({ id: m.userId, name: m.name }))}
      subscriptions={subscriptions.map((type) => ({ name: type.name, isInternal: type.isInternal }))}
      baseUrl={publicBaseUrl}
      canEdit={canEdit}
      slack={slack === null ? 'none' : slack.webhookUrl != null ? 'webhook' : 'bot'}
    />
  )
}

/** The shapes a new form can start from: every seeded form, plus nothing.
 *
 *  Cards rather than a dropdown, because what distinguishes them is the questions
 *  they ask, and that has to be readable before the choice, not after it. */
const TemplatePicker = ({ account }: { account: string }) => (
  <div className="w-full max-w-5xl">
    <header className="mb-4 flex flex-col gap-2">
      <Breadcrumb items={[{ label: 'Forms', href: formsPath(account) }, { label: 'Start a form' }]} />
      <h1 className="text-lg font-medium">Start a form</h1>
    </header>

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {SEED_FORMS.map((seed) => (
        <Link
          key={seed.slug}
          href={`${formsPath(account, 'new')}?from=${seed.slug}`}
          className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3 no-underline hover:border-line-strong"
        >
          <span className="font-medium text-primary">{seed.name}</span>
          <span className="text-small text-secondary">
            {seed.fields.length} {seed.fields.length === 1 ? 'question' : 'questions'}
            {seed.settings.steps?.length ? ` · ${seed.settings.steps.length} steps` : ''}
          </span>
          <ul className="m-0 flex flex-wrap gap-1 p-0">
            {seed.fields.map((field) => (
              <li
                key={field.key}
                className="list-none rounded-pill border border-line px-2 py-0.5 text-small text-secondary"
              >
                {field.label}
              </li>
            ))}
          </ul>
        </Link>
      ))}

      <Link
        href={`${formsPath(account, 'new')}?from=blank`}
        className="flex flex-col gap-2 rounded-panel border border-dashed border-line-strong p-3 no-underline"
      >
        <span className="font-medium text-primary">Blank form</span>
        <span className="text-small text-secondary">
          Start with nothing. A form needs a name, an address and an email question before it can be
          saved.
        </span>
      </Link>
    </div>
  </div>
)

export default BuilderPage
