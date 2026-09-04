import {
  ACTIVITY_GROUPS,
  getRecord,
  getRegistry,
  isActivityType,
  isObjectKey,
  isUuid,
  listIntegrations,
  listSuggestions,
  listTasks,
  readAssociations,
  readEmailEngagement,
  readMemberships,
  readSubscriptions,
  threadsForContact,
  readTimeline,
  timelineCounts,
  websiteActivity,
  withWorkspaceReads,
  type ObjectKey,
} from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AssociationRail } from '~/components/crm/association-rail.tsx'
import { EnrichmentPanel } from '~/components/crm/enrichment-panel.tsx'
import { PropertyPanel, type PropertySection } from '~/components/crm/property-panel.tsx'
import { RecordActions } from '~/components/crm/record-actions.tsx'
import { MailPanel } from '~/components/crm/mail-panel.tsx'
import { SegmentsPanel } from '~/components/crm/segments-panel.tsx'
import { SubscriptionsPanel } from '~/components/crm/subscriptions-panel.tsx'
import { TasksPanel } from '~/components/crm/tasks-panel.tsx'
import { WebsiteActivity } from '~/components/crm/website-activity.tsx'
import { Timeline } from '~/components/crm/timeline.tsx'
import { Value } from '~/components/crm/value.tsx'
import { objectView } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields } from '~/server/crm.ts'
import { apolloContactUrl } from '~/server/integrations/apollo.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** HubSpot's record anatomy, because familiarity is the point. 00-context.md
 *  sections 3 and 4:
 *
 *    HEADER   name, key fields, primary actions
 *    LEFT     properties, sectioned, collapsible, inline edit
 *    CENTRE   activity timeline with its type filter
 *    RIGHT    association rail
 */
const SECTIONS: Record<ObjectKey, PropertySection[]> = {
  contact: [
    { title: 'About this contact', fieldKeys: ['first_name', 'last_name', 'email', 'phone', 'title', 'linkedin_url'] },
    { title: 'Ownership and status', fieldKeys: ['owner_id', 'company_id', 'lifecycle_stage_id', 'lead_status'] },
    { title: 'Where they came from', fieldKeys: ['lead_source', 'marketing_status', 'original_source', 'latest_source'] },
    { title: 'Email engagement', fieldKeys: ['last_contacted_at', 'last_replied_at', 'emails_sent', 'emails_received'] },
    { title: 'Record', fieldKeys: ['created_at'] },
  ],
  company: [
    { title: 'About this company', fieldKeys: ['name', 'domain', 'industry', 'phone'] },
    { title: 'Size and location', fieldKeys: ['employee_count', 'annual_revenue', 'city', 'country'] },
    { title: 'Ownership and status', fieldKeys: ['owner_id', 'lifecycle_stage_id'] },
    { title: 'Where they came from', fieldKeys: ['original_source', 'latest_source'] },
    { title: 'Record', fieldKeys: ['created_at'] },
  ],
  deal: [
    { title: 'About this deal', fieldKeys: ['name', 'amount', 'currency', 'close_date', 'deal_type'] },
    { title: 'Next step', fieldKeys: ['next_step', 'next_step_date'] },
    { title: 'Pipeline', fieldKeys: ['pipeline_id', 'stage_id'] },
    { title: 'Ownership', fieldKeys: ['owner_id', 'company_id'] },
    { title: 'Custom properties', fieldKeys: ['uttr_pipeline', 'deal_product_of_interest'] },
    { title: 'Where it came from', fieldKeys: ['original_source', 'latest_source'] },
    { title: 'Record', fieldKeys: ['created_at'] },
  ],
}

/** The two or three values worth reading before anything else. */
const HEADER_FIELDS: Record<ObjectKey, string[]> = {
  contact: ['title', 'email', 'last_contacted_at', 'owner_id'],
  company: ['domain', 'industry', 'country', 'owner_id'],
  deal: ['stage_id', 'amount', 'close_date', 'owner_id'],
}

const RecordPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; object: string; id: string }>
  searchParams: Promise<{ type?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace, object: objectParam, id } = await params
  if (!isObjectKey(objectParam)) notFound()
  const { type } = await searchParams

  const ctx = contextFrom(session)
  // Every read on this screen runs at once, each on its own connection; see
  // withWorkspaceReads for why they are not pinned to one transaction. The
  // panels all take the id as given, so a mangled link is stopped here rather
  // than by whichever of them Postgres rejects first.
  const screen = !isUuid(id) ? null : await withWorkspaceReads(ctx, async () => {
    const entity = { entityType: objectParam, entityId: id }
    const enrichable = objectParam === 'contact' || objectParam === 'company'
    // The record itself is fetched alongside its panels, not before them: the
    // panels only need the id, and a missing record just discards their answers.
    const [{ object, lookups, canWrite }, registry, record, timeline, counts, rail, tasks, subscriptions, activity, memberships, threads, suggestions, integrations] = await Promise.all([
      loadCrmContext(ctx, objectParam),
      getRegistry(ctx),
      getRecord(ctx, objectParam, id),
      // A hand-edited type in a link is dropped rather than failing the page.
      readTimeline(ctx, { entity, types: (type?.split(',') ?? []).filter(isActivityType), limit: 50 }),
      timelineCounts(ctx, entity),
      readAssociations(ctx, entity),
      listTasks(ctx, { entity }),
      objectParam === 'contact' ? readSubscriptions(ctx, id) : Promise.resolve([]),
      objectParam === 'contact' ? websiteActivity(ctx, id) : Promise.resolve(null),
      readMemberships(ctx, id),
      objectParam === 'contact' ? threadsForContact(ctx, id) : Promise.resolve([]),
      enrichable ? listSuggestions(ctx, objectParam, id) : Promise.resolve([]),
      enrichable ? listIntegrations(ctx) : Promise.resolve([]),
    ])
    if (!record) return null
    return { object, lookups, canWrite, registry, record, entity, timeline, counts, rail, tasks, subscriptions, activity, memberships, threads, suggestions, integrations }
  })

  if (!screen) {
    const { object } = await loadCrmContext(ctx, objectParam)
    return (
      <EmptyState
        title={`That ${object.nameSingular.toLowerCase()} is not here`}
        description="It was deleted, or the link points at a record in another workspace. Its history is still on the records it touched."
        action={<Link href={objectView(workspace, objectParam, 'all')}>Back to {object.namePlural.toLowerCase()}</Link>}
      />
    )
  }

  const { object, lookups, canWrite, registry, record, entity, timeline, counts, rail, tasks, subscriptions, activity, memberships, threads, suggestions, integrations } = screen

  const health = (kind: 'apollo' | 'clay') => {
    const row = integrations.find((i) => i.kind === kind)
    return { state: row?.state ?? ('not_configured' as const), lastError: row?.lastError ?? null }
  }
  const email = typeof record.values.email === 'string' && record.values.email ? record.values.email : null
  const domain = typeof record.values.domain === 'string' && record.values.domain ? record.values.domain : null
  // What each enricher can fill on this object, so the panel can name what is
  // still blank rather than offering a button with nothing behind it.
  const enrichable = objectParam === 'contact' ? ['title', 'linkedin_url'] : ['industry', 'employee_count', 'annual_revenue', 'city', 'country']
  const blankFields = enrichable
    .filter((key) => record.values[key] === null || record.values[key] === undefined || record.values[key] === '')
    .map((key) => object.byKey.get(key)?.label ?? key)

  const fields = toEditableFields(object, lookups, { includeReadOnly: true })
  // Every field the layout above does not place, in registry order. This is what
  // makes a property created in Settings show up here without a deploy (D4).
  const placed = new Set(SECTIONS[objectParam].flatMap((section) => section.fieldKeys))
  const unplaced = fields.filter((field) => !placed.has(field.key)).map((field) => field.key)
  const sections = unplaced.length
    ? [...SECTIONS[objectParam], { title: 'More properties', fieldKeys: unplaced }]
    : SECTIONS[objectParam]
  const headerFields = HEADER_FIELDS[objectParam].flatMap((key) => {
    const field = object.byKey.get(key)
    return field ? [field] : []
  })

  // Only the pairs that make sense: a deal links to contacts, a contact links to
  // deals, and a company's contacts and deals are held on the records themselves.
  // Every other object. The primary company still lives on company_id; anything
  // linked here beyond that is an association row, the way HubSpot lets one
  // contact sit on several companies and one company hold many deals.
  const linkable = (['contact', 'company', 'deal'] as const).filter((key): key is ObjectKey => key !== objectParam)
  const createFields = Object.fromEntries(
    linkable.flatMap((key) => {
      const target = registry.byKey.get(key)
      return target ? [[key, toEditableFields(target, lookups)]] : []
    }),
  ) as Partial<Record<ObjectKey, ReturnType<typeof toEditableFields>>>
  const createInitial = objectParam === 'company' ? { company_id: id } : {}

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-small text-secondary uppercase">{object.nameSingular}</p>
            <h1 className="break-words text-lg font-medium">{record.displayName}</h1>
          </div>
          <RecordActions
            workspace={workspace}
            object={objectParam}
            objectLabel={object.nameSingular}
            recordId={id}
            displayName={record.displayName}
            fields={fields.filter((field) => !field.readOnly)}
            values={record.values}
            labels={record.labels}
            canWrite={canWrite}
          />
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          {headerFields.map((field) => (
            <div key={field.key} className="min-w-0">
              <dt className="text-small text-secondary">{field.label}</dt>
              <dd className="min-w-0">
                <Value
                  type={field.type}
                  value={record.values[field.key]}
                  label={record.labels[field.key]}
                  currency={String(record.values.currency ?? 'USD')}
                  placeholder="—"
                />
              </dd>
            </div>
          ))}
        </dl>
      </header>

      {/* One column on a phone, three on a wide screen. Nothing is a fixed width. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,20rem)]">
        <div className="flex min-w-0 flex-col gap-3">
          <PropertyPanel
            object={objectParam}
            recordId={id}
            fields={fields}
            values={record.values}
            labels={record.labels}
            updatedAt={record.updatedAt.toISOString()}
            sections={sections}
            canWrite={canWrite}
          />
          {objectParam === 'contact' && activity ? (
            <WebsiteActivity
              workspace={workspace}
              contactId={id}
              contactName={record.displayName}
              siteVisits={activity.siteVisits}
              pagesViewed={activity.pagesViewed}
              lastSeenAt={activity.lastSeenAt?.toISOString() ?? null}
              devices={activity.devices}
              isAdmin={session.role === 'admin'}
            />
          ) : null}
          {memberships.length > 0 || objectParam === 'contact' ? (
            <SegmentsPanel workspace={workspace} recordName={record.displayName} rows={memberships} />
          ) : null}
          {objectParam !== 'deal' ? (
            <EnrichmentPanel
              workspace={workspace}
              object={objectParam}
              recordId={id}
              matchKey={objectParam === 'contact' ? email : domain}
              blankFields={blankFields}
              apolloUrl={email ? apolloContactUrl(email) : null}
              apollo={health('apollo')}
              clay={health('clay')}
              tracked={counts.email_tracking ?? 0}
              sequenced={counts.sequence_activity ?? 0}
              suggestions={suggestions.map((s) => ({
                id: s.id,
                fieldKey: s.fieldKey,
                fieldLabel: object.byKey.get(s.fieldKey)?.label ?? s.fieldKey,
                suggested: s.suggested,
                current: s.current,
                provider: s.provider,
                at: s.at.toISOString(),
              }))}
              canWrite={canWrite}
            />
          ) : null}
          {objectParam === 'contact' ? (
            <MailPanel contactName={record.displayName} threads={threads} engagement={readEmailEngagement(record.values)} />
          ) : null}
          {objectParam === 'contact' ? (
            <SubscriptionsPanel
              contactId={id}
              contactName={record.displayName}
              rows={subscriptions}
              canWrite={canWrite}
            />
          ) : null}
        </div>

        <div className="min-w-0">
          <Timeline
            object={objectParam}
            recordId={id}
            workspace={workspace}
            recordName={record.displayName}
            initial={timeline.rows.map((row) => ({
              id: row.id,
              type: row.type,
              subject: row.subject,
              body: row.body,
              occurredAt: row.occurredAt.toISOString(),
              actorId: row.actorId,
              actorName: row.actorName,
              actorKind: row.actorKind,
              payload: row.payload,
            }))}
            initialCursor={
              timeline.nextCursor
                ? { occurredAt: timeline.nextCursor.occurredAt.toISOString(), id: timeline.nextCursor.id }
                : null
            }
            counts={counts}
            groups={ACTIVITY_GROUPS}
            canWrite={canWrite}
            viewer={{ userId: session.userId, role: session.role }}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <AssociationRail
            workspace={workspace}
            object={objectParam}
            recordId={id}
            contacts={rail.contacts}
            companies={rail.companies}
            deals={rail.deals}
            linkable={linkable}
            createFields={createFields}
            createInitial={createInitial}
            canWrite={canWrite}
          />
          <TasksPanel
            workspace={workspace}
            rows={tasks.map((row) => ({
              id: row.id,
              title: row.title,
              dueDate: row.dueDate,
              status: row.status,
              assigneeName: row.assigneeName,
              entityType: row.entityType,
              entityId: row.entityId,
              entityName: row.entityName,
            }))}
            assignees={lookups.users}
            entity={entity}
            canWrite={canWrite}
          />
        </div>
      </div>
    </div>
  )
}


export default RecordPage
