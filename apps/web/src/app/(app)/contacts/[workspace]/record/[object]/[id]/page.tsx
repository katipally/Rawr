import {
  ACTIVITY_GROUPS,
  getRecord,
  isActivityType,
  isObjectKey,
  listRecords,
  listTasks,
  readAssociations,
  readSubscriptions,
  readTimeline,
  timelineCounts,
  websiteActivity,
  type ObjectKey,
} from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AssociationRail } from '~/components/crm/association-rail.tsx'
import { PropertyPanel, type PropertySection } from '~/components/crm/property-panel.tsx'
import { RecordActions } from '~/components/crm/record-actions.tsx'
import { SubscriptionsPanel } from '~/components/crm/subscriptions-panel.tsx'
import { TasksPanel } from '~/components/crm/tasks-panel.tsx'
import { WebsiteActivity } from '~/components/crm/website-activity.tsx'
import { Timeline } from '~/components/crm/timeline.tsx'
import { Value } from '~/components/crm/value.tsx'
import { objectView } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields } from '~/server/crm.ts'
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
  ],
  company: [
    { title: 'About this company', fieldKeys: ['name', 'domain', 'industry', 'phone'] },
    { title: 'Size and location', fieldKeys: ['employee_count', 'annual_revenue', 'city', 'country'] },
    { title: 'Ownership and status', fieldKeys: ['owner_id', 'lifecycle_stage_id'] },
    { title: 'Where they came from', fieldKeys: ['original_source', 'latest_source'] },
  ],
  deal: [
    { title: 'About this deal', fieldKeys: ['name', 'amount', 'currency', 'close_date', 'deal_type'] },
    { title: 'Next step', fieldKeys: ['next_step', 'next_step_date'] },
    { title: 'Pipeline', fieldKeys: ['pipeline_id', 'stage_id'] },
    { title: 'Ownership', fieldKeys: ['owner_id', 'company_id'] },
    { title: 'Custom properties', fieldKeys: ['uttr_pipeline', 'deal_product_of_interest'] },
    { title: 'Where it came from', fieldKeys: ['original_source', 'latest_source'] },
  ],
}

/** The two or three values worth reading before anything else. */
const HEADER_FIELDS: Record<ObjectKey, string[]> = {
  contact: ['title', 'email', 'lifecycle_stage_id', 'owner_id'],
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
  const { object, lookups, companies, canWrite } = await loadCrmContext(ctx, objectParam)
  const record = await getRecord(ctx, objectParam, id)

  if (!record) {
    return (
      <EmptyState
        title={`That ${object.nameSingular.toLowerCase()} is not here`}
        description="It was deleted, or the link points at a record in another workspace. Its history is still on the records it touched."
        action={<Link href={objectView(workspace, objectParam, 'all')}>Back to {object.namePlural.toLowerCase()}</Link>}
      />
    )
  }

  const entity = { entityType: objectParam, entityId: id }
  const [timeline, counts, rail, tasks, subscriptions, mergeCandidates, activity] = await Promise.all([
    // A hand-edited type in a link is dropped rather than failing the page.
    readTimeline(ctx, { entity, types: (type?.split(',') ?? []).filter(isActivityType), limit: 50 }),
    timelineCounts(ctx, entity),
    readAssociations(ctx, entity),
    listTasks(ctx, { entity }),
    objectParam === 'contact' ? readSubscriptions(ctx, id) : Promise.resolve([]),
    listRecords(ctx, { object: objectParam, limit: 200, sorts: [{ key: 'created_at', direction: 'desc' }] }),
    objectParam === 'contact' ? websiteActivity(ctx, id) : Promise.resolve(null),
  ])

  const fields = toEditableFields(object, lookups, companies, { includeReadOnly: true })
  const headerFields = HEADER_FIELDS[objectParam].flatMap((key) => {
    const field = object.byKey.get(key)
    return field ? [field] : []
  })

  // Only the pairs that make sense: a deal links to contacts, a contact links to
  // deals, and a company's contacts and deals are held on the records themselves.
  const candidates =
    objectParam === 'deal'
      ? [{ objectKey: 'contact' as const, options: await contactOptions(ctx) }]
      : objectParam === 'contact'
        ? [{ objectKey: 'deal' as const, options: await dealOptions(ctx) }]
        : []

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
            candidates={mergeCandidates.rows.map((row) => ({ id: row.id, label: row.displayName }))}
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
            sections={SECTIONS[objectParam]}
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
            candidates={candidates}
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

const contactOptions = async (ctx: Parameters<typeof listRecords>[0]) => {
  const page = await listRecords(ctx, { object: 'contact', limit: 200 })
  return page.rows.map((row) => ({ id: row.id, label: row.displayName }))
}

const dealOptions = async (ctx: Parameters<typeof listRecords>[0]) => {
  const page = await listRecords(ctx, { object: 'deal', limit: 200 })
  return page.rows.map((row) => ({ id: row.id, label: row.displayName }))
}

export default RecordPage
