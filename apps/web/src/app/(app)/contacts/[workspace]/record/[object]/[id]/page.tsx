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
  listAttachments,
  withWorkspaceReads,
  type ObjectKey,
} from '@rawr/db'
import { Breadcrumb, EmptyState, Tabs } from '@rawr/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AssociationRail } from '~/components/crm/association-rail.tsx'
import { EnrichmentPanel } from '~/components/crm/enrichment-panel.tsx'
import { PropertyPanel, type PropertySection } from '~/components/crm/property-panel.tsx'
import { RecordActions } from '~/components/crm/record-actions.tsx'
import { RecordOverview, type Touch } from '~/components/crm/record-overview.tsx'
import { RecordQuickActions } from '~/components/crm/record-quick-actions.tsx'
import { MailPanel } from '~/components/crm/mail-panel.tsx'
import { SegmentsPanel } from '~/components/crm/segments-panel.tsx'
import { SubscriptionsPanel } from '~/components/crm/subscriptions-panel.tsx'
import { AttachmentsPanel } from '~/components/crm/attachments-panel.tsx'
import { TasksPanel } from '~/components/crm/tasks-panel.tsx'
import { WebsiteActivity } from '~/components/crm/website-activity.tsx'
import { Timeline } from '~/components/crm/timeline.tsx'
import { Value } from '~/components/crm/value.tsx'
import { objectView, recordPath, workspaceHome } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields } from '~/server/crm.ts'
import { apolloContactUrl } from '~/server/integrations/apollo.ts'
import { storageConfigured } from '~/server/storage.ts'
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

/** What the quick-action row may ask the timeline composer to open. Narrowed
 *  here because it arrives from an address a person can hand-edit. */
const LOG_KINDS = ['note', 'call', 'meeting', 'email'] as const

/** The two or three values worth reading before anything else. */
const HEADER_FIELDS: Record<ObjectKey, string[]> = {
  contact: ['title', 'email', 'last_contacted_at', 'owner_id'],
  company: ['domain', 'industry', 'country', 'owner_id'],
  deal: ['stage_id', 'amount', 'close_date', 'owner_id'],
}

/** What `original_source` and `latest_source` hold: a channel plus the evidence
 *  it came from. Only the two readable parts are shown here; the evidence is on
 *  the property panel, which renders the whole object. */
const touchFrom = (value: unknown): Touch => {
  if (typeof value !== 'object' || value === null) return null
  const source = value as { channel?: unknown; detail?: { firstSeenAt?: unknown } }
  if (typeof source.channel !== 'string') return null
  const at = source.detail?.firstSeenAt
  return { channel: source.channel, at: typeof at === 'string' ? at : null }
}

/** Shaped like an object key. The registry decides whether it is one. */
const USABLE_OBJECT_KEY = /^[a-z][a-z0-9_]{1,58}$/

const RecordPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; object: string; id: string }>
  searchParams: Promise<{
    type?: string
    tab?: string
    log?: string
    task?: string
    compose?: string
  }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace, object: objectParam, id } = await params
  // Not `isObjectKey`: an admin can invent an object, and its records are opened
  // through exactly this page. Whether the key names one is the registry's
  // answer, which loadCrmContext gives below.
  if (!USABLE_OBJECT_KEY.test(objectParam)) notFound()
  const { type, tab, log, task, compose } = await searchParams
  // Overview is the landing tab, the way HubSpot opens on a summary rather than
  // on a wall of history. An unknown value falls back rather than 404ing.
  const activeTab = tab === 'activities' ? 'activities' : 'overview'
  const openKind = LOG_KINDS.find((kind) => kind === log)

  const ctx = contextFrom(session)
  // Every read on this screen runs at once, each on its own connection; see
  // withWorkspaceReads for why they are not pinned to one transaction. The
  // panels all take the id as given, so a mangled link is stopped here rather
  // than by whichever of them Postgres rejects first.
  const screen = !isUuid(id) ? null : await withWorkspaceReads(ctx, async () => {
    // Narrowed once, here: `entity` is what every core-only read below takes,
    // and its type is the enum those tables actually hold.
    const core = isObjectKey(objectParam) ? objectParam : null
    const entity = { entityType: core ?? 'contact', entityId: id }
    const enrichable = objectParam === 'contact' || objectParam === 'company'
    // The record itself is fetched alongside its panels, not before them: the
    // panels only need the id, and a missing record just discards their answers.
    const [{ object, lookups, canWrite }, registry, record, timeline, counts, rail, tasks, subscriptions, activity, memberships, threads, suggestions, integrations, attachments] = await Promise.all([
      loadCrmContext(ctx, objectParam),
      getRegistry(ctx),
      getRecord(ctx, objectParam, id),
      // A hand-edited type in a link is dropped rather than failing the page.
      // A custom object has no timeline, associations or tasks: all three name
      // an entity type that is an enum of the three core objects. Not read at
      // all rather than read and discarded, which would be four queries for a
      // panel that cannot be drawn.
      core
        ? readTimeline(ctx, { entity, types: (type?.split(',') ?? []).filter(isActivityType), limit: 50 })
        : Promise.resolve({ rows: [], nextCursor: null }),
      core ? timelineCounts(ctx, entity) : Promise.resolve({} as Record<string, number>),
      core ? readAssociations(ctx, entity) : Promise.resolve({ companies: [], contacts: [], deals: [], totals: {} }),
      core ? listTasks(ctx, { entity }) : Promise.resolve([]),
      objectParam === 'contact' ? readSubscriptions(ctx, id) : Promise.resolve([]),
      objectParam === 'contact' ? websiteActivity(ctx, id) : Promise.resolve(null),
      readMemberships(ctx, id),
      objectParam === 'contact' ? threadsForContact(ctx, id) : Promise.resolve([]),
      enrichable ? listSuggestions(ctx, objectParam, id) : Promise.resolve([]),
      enrichable ? listIntegrations(ctx) : Promise.resolve([]),
      // Only when storage is connected: reading a table to draw a panel that
      // can only say "not connected" is a query for nothing.
      core && storageConfigured ? listAttachments(ctx, entity) : Promise.resolve([]),
    ])
    if (!record) return null
    return { object, lookups, canWrite, registry, record, entity, core, timeline, counts, rail, tasks, subscriptions, activity, memberships, threads, suggestions, integrations, attachments }
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

  const { object, lookups, canWrite, registry, record, entity, core, timeline, counts, rail, tasks, subscriptions, activity, memberships, threads, suggestions, integrations, attachments } = screen

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

  // Every activity on this record, whatever the timeline filter is narrowed to,
  // because the tab counts what is there rather than what is showing.
  const timelineTotal = Object.values(counts).reduce((sum, n) => sum + n, 0)

  const fields = toEditableFields(object, lookups, { includeReadOnly: true })
  // The core three have a hand-made layout, because which fields belong beside
  // each other on a contact is a judgement nobody can derive. A custom object
  // has no such layout and needs none: its fields are in the order the admin put
  // them in, which is the only order that means anything.
  const layout = object.isCustom ? [] : (SECTIONS[objectParam as ObjectKey] ?? [])
  // Every field the layout does not place, in registry order. This is what makes
  // a property created in Settings show up here without a deploy (D4), and for a
  // custom object it is every field it has.
  const placed = new Set(layout.flatMap((section) => section.fieldKeys))
  const unplaced = fields.filter((field) => !placed.has(field.key)).map((field) => field.key)
  const sections = unplaced.length
    ? [...layout, { title: object.isCustom ? 'Details' : 'More properties', fieldKeys: unplaced }]
    : layout
  const headerFields = (object.isCustom ? [] : (HEADER_FIELDS[objectParam as ObjectKey] ?? [])).flatMap((key) => {
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
      <Breadcrumb
        items={[
          { label: 'Home', href: workspaceHome(workspace) },
          { label: object.namePlural, href: objectView(workspace, objectParam, 'all') },
          { label: record.displayName },
        ]}
      />

      <header className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-small text-secondary uppercase">{object.nameSingular}</p>
            <h1 className="line-clamp-2 break-words text-lg font-medium" title={record.displayName}>
              {record.displayName}
            </h1>
            {/* Log a note, a call, a meeting: every one of them writes an
                activity, so a custom record has none of them to offer. */}
            {core ? (
            <RecordQuickActions
              workspace={workspace}
              object={objectParam}
              recordId={id}
              email={email}
              canWrite={canWrite}
            />
            ) : null}
          </div>
          <RecordActions
            startCompose={compose === '1'}
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
                  oneLine
                />
              </dd>
            </div>
          ))}
        </dl>
      </header>

      {/* One column when there is no room, three when there is. Measured against
          the card this sits in rather than the window, because collapsing the rail
          widens the card without the window changing size, and a viewport rule
          would keep squeezing three columns into eight hundred pixels. */}
      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,20rem)]">
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
          {core && core !== 'deal' ? (
            <EnrichmentPanel
              workspace={workspace}
              object={core}
              recordId={id}
              matchKey={core === 'contact' ? email : domain}
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

        <div className="flex min-w-0 flex-col gap-3">
          {/* Two tabs over content only a core record has. Without them a custom
              record showed an Overview and an Activities tab that were both
              empty and always would be. */}
          <div className={core ? 'border-b border-divider' : 'hidden'}>
            <Tabs
              label="Record sections"
              items={[
                {
                  key: 'overview',
                  label: 'Overview',
                  href: recordPath(workspace, objectParam, id),
                  current: activeTab === 'overview',
                },
                {
                  key: 'activities',
                  label: 'Activities',
                  href: recordPath(workspace, objectParam, id, { tab: 'activities' }),
                  hint: timelineTotal.toLocaleString(),
                  current: activeTab === 'activities',
                },
              ]}
            />
          </div>

          {/* Both of these are core-only: the overview reads the association
              rail and the timeline reads activities, and a custom object has
              neither. It gets its properties and nothing it cannot have. */}
          {!core ? null : activeTab === 'overview' ? (
            <RecordOverview
              workspace={workspace}
              object={core}
              tasks={tasks.map((row) => ({
                id: row.id,
                title: row.title,
                dueDate: row.dueDate,
                status: row.status,
              }))}
              threads={threads.map((thread) => ({
                threadId: thread.id,
                subject: thread.subject,
                lastAt: thread.lastAt?.toISOString() ?? thread.firstAt?.toISOString() ?? null,
                messageCount: thread.messageCount,
              }))}
              deals={rail.deals.map((deal) => ({
                id: deal.id,
                displayName: deal.displayName,
                detail: deal.detail,
              }))}
              firstTouch={touchFrom(record.values.original_source)}
              lastTouch={touchFrom(record.values.latest_source)}
            />
          ) : (
          <Timeline
            openKind={openKind}
            object={core}
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
          )}
        </div>

        {/* The right column is entirely core-only: associations, tasks and
            attachments each name an entity type that is an enum of the three, so
            a custom record has none of them. Not rendered rather than hidden — a
            hidden column is still built, and this one is three panels of it. */}
        {!core ? null : (
        <div className="flex min-w-0 flex-col gap-3">
          <AssociationRail
            workspace={workspace}
            object={core ?? 'contact'}
            recordId={id}
            contacts={rail.contacts}
            companies={rail.companies}
            deals={rail.deals}
            totals={'contacts' in rail.totals ? rail.totals : { contacts: 0, companies: 0, deals: 0 }}
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
            startNew={task === 'new'}
          />
          <AttachmentsPanel
            object={core ?? 'contact'}
            recordId={id}
            configured={storageConfigured}
            canWrite={canWrite}
            rows={attachments.map((row) => ({
              id: row.id,
              filename: row.filename,
              bytes: row.bytes,
              mime: row.mime,
              at: row.at.toISOString(),
            }))}
          />
        </div>
        )}
      </div>
    </div>
  )
}


export default RecordPage
