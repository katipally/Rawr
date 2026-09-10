import {
  ACTIVITY_GROUPS,
  enrichmentQueued,
  getRecord,
  getRegistry,
  groupFor,
  isActivityType,
  isObjectKey,
  isUuid,
  listIntegrations,
  listSuggestions,
  listTaskQueues,
  listTasks,
  readAssociations,
  readDealScore,
  SCORE_COMPONENTS,
  readEmailEngagement,
  readMemberships,
  readSubscriptions,
  threadsForContact,
  enrollmentsForContact,
  readTimeline,
  timelineCounts,
  websiteActivity,
  listAttachments,
  withAccountReads,
  type ObjectKey,
} from '@rawr/db'
import { Avatar, EmptyState, cn } from '@rawr/ui'
import { ChevronLeft, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { notFound, redirect } from 'next/navigation'
import { AssociationRail } from '~/components/crm/association-rail.tsx'
import { EnrichmentPanel } from '~/components/crm/enrichment-panel.tsx'
import { PropertyPanel, type PropertySection } from '~/components/crm/property-panel.tsx'
import { RecordActions } from '~/components/crm/record-actions.tsx'
import { RecordOverview, type Touch } from '~/components/crm/record-overview.tsx'
import { RecordQuickActions } from '~/components/crm/record-quick-actions.tsx'
import { MailPanel } from '~/components/crm/mail-panel.tsx'
import { SegmentsPanel } from '~/components/crm/segments-panel.tsx'
import { SequencesPanel } from '~/components/crm/sequences-panel.tsx'
import { SubscriptionsPanel } from '~/components/crm/subscriptions-panel.tsx'
import { AttachmentsPanel } from '~/components/crm/attachments-panel.tsx'
import { TasksPanel } from '~/components/crm/tasks-panel.tsx'
import { WebsiteActivity } from '~/components/crm/website-activity.tsx'
import { Timeline } from '~/components/crm/timeline.tsx'
import { Value, formatDateTime } from '~/components/crm/value.tsx'
import { ScoreRing } from '~/components/crm/score-ring.tsx'
import { objectView, recordPath } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields } from '~/server/crm.ts'
import { apolloContactUrl } from '~/server/integrations/apollo.ts'
import { ENRICHABLE } from '~/server/integrations/index.ts'
import { storageConfigured } from '~/server/storage.ts'
import { inSentence } from '~/lib/label-case.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'

/** HubSpot's record anatomy, because familiarity is the point:
 *
 *    HEADER   name, key fields, primary actions
 *    LEFT     properties, sectioned, collapsible, inline edit
 *    CENTRE   activity timeline with its type filter
 *    RIGHT    association rail
 */
const SECTIONS: Record<ObjectKey, PropertySection[]> = {
  contact: [
    { title: 'About this contact', fieldKeys: ['first_name', 'last_name', 'email', 'phone', 'title', 'seniority', 'department', 'linkedin_url', 'city', 'country'] },
    { title: 'Ownership and status', fieldKeys: ['owner_id', 'company_id', 'lifecycle_stage_id', 'lead_status'] },
    { title: 'Where they came from', fieldKeys: ['lead_source', 'marketing_status', 'original_source', 'latest_source'] },
    { title: 'Email engagement', fieldKeys: ['tracking_consent', 'last_contacted_at', 'last_replied_at', 'emails_sent', 'emails_received'] },
    { title: 'Record', fieldKeys: ['created_at'] },
  ],
  company: [
    { title: 'About this company', fieldKeys: ['name', 'domain', 'industry', 'phone', 'description', 'linkedin_url'] },
    { title: 'Size and location', fieldKeys: ['employee_count', 'annual_revenue', 'founded_year', 'funding_raised', 'city', 'state', 'postal_code', 'country'] },
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
  contact: [],
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

/** One of the record page's three columns: its own scroller once there is room
 *  for three, part of the single page scroller when there is not. */
const COLUMN = 'flex min-w-0 flex-col gap-4 @4xl:min-h-0 @4xl:overflow-y-auto'

/** Shaped like an object key. The registry decides whether it is one. */
const USABLE_OBJECT_KEY = /^[a-z][a-z0-9_]{1,58}$/

const RecordPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; object: string; id: string }>
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
  const zone = session.timezone

  const { account, object: objectParam, id } = await params
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
  // withAccountReads for why they are not pinned to one transaction. The
  // panels all take the id as given, so a mangled link is stopped here rather
  // than by whichever of them Postgres rejects first.
  const screen = !isUuid(id) ? null : await withAccountReads(ctx, async () => {
    // A timeline entry, an association, a task and a file all name an object key,
    // and that is text rather than an enum of three, so every panel below works
    // the same whether the object is one Rawr ships or one an admin invented.
    // `core` survives for the one panel that is genuinely core-only: enrichment
    // matches on an email or a domain, which a custom object does not have.
    const core = isObjectKey(objectParam) ? objectParam : null
    const entity = { entityType: objectParam, entityId: id }
    const enrichable = objectParam === 'contact' || objectParam === 'company'
    // The record itself is fetched alongside its panels, not before them: the
    // panels only need the id, and a missing record just discards their answers.
    const [{ object, lookups, canWrite }, registry, record, timeline, counts, rail, tasks, queues, subscriptions, activity, memberships, threads, suggestions, integrations, attachments, queued, enrollments, dealScore] = await Promise.all([
      loadCrmContext(ctx, objectParam),
      getRegistry(ctx),
      getRecord(ctx, objectParam, id),
      // A hand-edited type in a link is dropped rather than failing the page.
      readTimeline(ctx, { entity, types: (type?.split(',') ?? []).filter(isActivityType), limit: 50 }),
      timelineCounts(ctx, entity),
      readAssociations(ctx, entity),
      listTasks(ctx, { entity }),
      listTaskQueues(ctx),
      objectParam === 'contact' ? readSubscriptions(ctx, id) : Promise.resolve([]),
      objectParam === 'contact' ? websiteActivity(ctx, id) : Promise.resolve(null),
      readMemberships(ctx, id),
      objectParam === 'contact' ? threadsForContact(ctx, id) : Promise.resolve([]),
      enrichable ? listSuggestions(ctx, objectParam, id) : Promise.resolve([]),
      enrichable ? listIntegrations(ctx) : Promise.resolve([]),
      // Only when storage is connected: reading a table to draw a panel that
      // can only say "not connected" is a query for nothing.
      storageConfigured ? listAttachments(ctx, entity) : Promise.resolve([]),
      enrichable ? enrichmentQueued(ctx, objectParam, id) : Promise.resolve(null),
      objectParam === 'contact' ? enrollmentsForContact(ctx, id) : Promise.resolve([]),
      objectParam === 'deal' ? readDealScore(ctx, id) : Promise.resolve(null),
    ])
    if (!record) return null
    return { object, lookups, canWrite, registry, record, entity, core, timeline, counts, rail, tasks, queues, subscriptions, activity, memberships, threads, suggestions, integrations, attachments, queued, enrollments, dealScore }
  })

  if (!screen) {
    const { object } = await loadCrmContext(ctx, objectParam)
    return (
      <EmptyState
        title={`That ${inSentence(object.nameSingular)} is not here`}
        description="It was deleted, or the link points at a record in another account. Its history is still on the records it touched."
        action={<LinkButton variant="primary" href={objectView(account, objectParam, 'all')}>Back to {inSentence(object.namePlural)}</LinkButton>}
      />
    )
  }

  const { object, lookups, canWrite, registry, record, entity, core, timeline, counts, rail, tasks, queues, subscriptions, activity, memberships, threads, suggestions, integrations, attachments, queued, enrollments, dealScore } = screen

  const health = (kind: 'apollo' | 'lusha' | 'clay') => {
    const row = integrations.find((i) => i.kind === kind)
    return { state: row?.state ?? ('not_configured' as const), lastError: row?.lastError ?? null }
  }
  const email = typeof record.values.email === 'string' && record.values.email ? record.values.email : null
  // A company and a deal have no address of their own. The rail is already
  // loaded, so the composer opens on the first contact linked to this record that
  // has one rather than the button being dead.
  const via = email || objectParam === 'contact' ? null : (groupFor(rail, 'contact')?.records.find((row) => row.email) ?? null)
  const composeOn = (target: string, targetId: string) =>
    recordPath(account, target, targetId, { tab: 'activities', compose: '1' })
  const emailAction = email
    ? { href: composeOn(objectParam, id), title: `Email ${email}` }
    : via
      ? { href: composeOn('contact', via.id), title: `Email ${via.displayName}` }
      : {
          href: null,
          title:
            objectParam === 'contact'
              ? 'No email address on this record'
              : `No contact linked to this ${objectParam} has an email address`,
        }
  const domain = typeof record.values.domain === 'string' && record.values.domain ? record.values.domain : null
  // What an enricher can fill on this object, so the panel can name what is
  // still blank rather than offering a button with nothing behind it.
  const blankFields = (core === 'contact' || core === 'company' ? ENRICHABLE[core] : [])
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

  // Every other object in the account. The primary company still lives on
  // company_id; anything linked beyond that is an association row, the way
  // HubSpot lets one contact sit on several companies and one company hold many
  // deals. An object cannot be linked to itself from here, which is what the
  // filter is for.
  const linkable = registry.objects.map((entry) => entry.key).filter((key) => key !== objectParam)
  const createFields = Object.fromEntries(
    linkable.flatMap((key) => {
      const target = registry.byKey.get(key)
      return target ? [[key, toEditableFields(target, lookups)]] : []
    }),
  )
  const createInitial = objectParam === 'company' ? { company_id: id } : {}

  const phone = typeof record.values.phone === 'string' && record.values.phone ? record.values.phone : null
  const website = typeof record.values.domain === 'string' && record.values.domain ? record.values.domain : null
  /** The line under the name: a contact's title at their company, a company's
   *  domain, a deal's stage. */
  const subtitle = [record.labels.title ?? (typeof record.values.title === 'string' ? record.values.title : null), record.labels.company_id]
    .filter(Boolean)
    .join(' at ') || record.labels.stage_id || null

  return (
    // HubSpot's record page: three columns of cards straight on the canvas. One
    // column when there is no room, measured against the shell's card rather
    // than the window, because collapsing the rail widens the page without the
    // window changing size.
    //
    // Where there are three columns each one carries its own scrollbar, so a long
    // property list does not push the association rail off the bottom of a screen
    // it would otherwise fit on. One column means one scroller again: nested
    // scrollers on a phone are a trap, not a feature.
    <div className="grid gap-4 p-2 @4xl:h-full @4xl:min-h-0 @4xl:grid-cols-[minmax(0,25.5rem)_minmax(0,1fr)_minmax(0,26.25rem)] sm:p-4">
      <div className={COLUMN}>
        <div className="rounded-panel border border-line bg-surface shadow-panel">
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <Link
              href={objectView(account, objectParam, 'all')}
              className="flex h-10 items-center gap-1 rounded-hs text-body no-underline hover:underline"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
              {object.namePlural}
            </Link>
            <RecordActions
              startCompose={compose === '1'}
              account={account}
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
          <div className="flex flex-col gap-2 px-4 pt-2 pb-6">
            <div className="flex items-center gap-3">
              <Avatar name={record.displayName} size="lg" />
              <div className="min-w-0">
                <h1 className="line-clamp-2 break-words text-[1.375rem] font-medium leading-tight" title={record.displayName}>
                  {record.displayName}
                </h1>
              </div>
            </div>
            {subtitle ? <p className="break-words">{subtitle}</p> : null}
            {email ? (
              <p className="flex min-w-0 items-center gap-1">
                <a href={`mailto:${email}`} className="min-w-0 truncate">{email}</a>
                <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-secondary" />
              </p>
            ) : null}
            {website ? (
              <p className="flex min-w-0 items-center gap-1">
                <a href={`https://${website}`} target="_blank" rel="noreferrer" className="min-w-0 truncate">{website}</a>
                <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-secondary" />
              </p>
            ) : null}
            {phone ? (
              <p>
                <a href={`tel:${phone}`}>{phone}</a>
              </p>
            ) : null}
            {headerFields.length > 0 ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                {headerFields.map((field) => (
                  <div key={field.key} className="min-w-0">
                    <dt className="text-small text-secondary">{field.label}</dt>
                    <dd className="min-w-0">
                      <Value zone={zone}
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
            ) : null}
            <div className="mt-2 flex justify-center">
              <RecordQuickActions
                account={account}
                object={objectParam}
                recordId={id}
                email={emailAction}
                canWrite={canWrite}
              />
            </div>
          </div>
        </div>

          {dealScore ? (
            // The number and the arithmetic behind it. HubSpot's own deal score
            // is an AI figure with no explanation, which is why nobody argues
            // with it and nobody acts on it either.
            <section className="rounded-panel border border-line bg-surface p-4 shadow-panel">
              <div className="flex items-center gap-3">
                <ScoreRing score={dealScore.score} className="text-base" />
                <div className="min-w-0">
                  <h2 className="font-medium">Deal score</h2>
                  <p className="text-small text-secondary">
                    {dealScore.scoredAt
                      ? `Out of 100, worked out ${formatDateTime(dealScore.scoredAt.toISOString(), zone)}.`
                      : 'Not worked out yet. It is computed nightly and whenever the stage changes.'}
                  </p>
                </div>
              </div>
              {dealScore.score === null ? null : (
                <dl className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3 text-small">
                  {SCORE_COMPONENTS.map((component) => (
                    <div key={component.key} className="flex items-baseline justify-between gap-3">
                      <dt className="min-w-0" title={component.why}>
                        {component.label}
                      </dt>
                      <dd className="shrink-0 tabular-nums">
                        {dealScore.detail[component.key] ?? 0} / {component.max}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          ) : null}

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
              account={account}
              contactId={id}
              contactName={record.displayName}
              siteVisits={activity.siteVisits}
              pagesViewed={activity.pagesViewed}
              lastSeenAt={activity.lastSeenAt?.toISOString() ?? null}
              devices={activity.devices}
              isAdmin={sessionIsAdmin(session)}
            />
          ) : null}
          {memberships.length > 0 || objectParam === 'contact' ? (
            <SegmentsPanel zone={zone} account={account} recordName={record.displayName} rows={memberships} />
          ) : null}
          {core && core !== 'deal' ? (
            <EnrichmentPanel
              account={account}
              object={core}
              recordId={id}
              matchKey={core === 'contact' ? email : domain}
              blankFields={blankFields}
              apolloUrl={email ? apolloContactUrl(email) : null}
              apollo={health('apollo')}
              lusha={health('lusha')}
              clay={health('clay')}
              queued={queued}
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
          {objectParam === 'company' ? (
            <SequencesPanel
              account={account}
              companyId={id}
              contactName={record.displayName}
              canWrite={canWrite}
              rows={[]}
            />
          ) : null}
          {objectParam === 'contact' ? (
            <SequencesPanel
              account={account}
              contactId={id}
              contactName={record.displayName}
              canWrite={canWrite}
              rows={enrollments.map((row) => ({
                id: row.id,
                sequenceId: row.sequenceId,
                sequenceName: row.sequenceName,
                state: row.state,
                currentStep: row.currentStep,
                stepCount: row.stepCount,
                nextRunAt: row.nextRunAt?.toISOString() ?? null,
                lastSentAt: row.lastSentAt?.toISOString() ?? null,
                stopReason: row.stopReason,
                enrolledAt: row.enrolledAt.toISOString(),
              }))}
            />
          ) : null}
          {objectParam === 'contact' ? (
            <MailPanel zone={zone} contactName={record.displayName} threads={threads} engagement={readEmailEngagement(record.values)} />
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

        <div className={COLUMN}>
          {/* Pinned, so switching between Overview and the timeline never means
              scrolling back up the column to find the tabs. */}
          <nav aria-label="Record sections" className="sticky top-0 z-10 flex shrink-0 overflow-hidden rounded-t-hs border-b border-line bg-canvas">
            {[
              { key: 'overview', label: 'Overview', href: recordPath(account, objectParam, id) },
              { key: 'activities', label: `Activities (${timelineTotal.toLocaleString()})`, href: recordPath(account, objectParam, id, { tab: 'activities' }) },
            ].map((item) => (
              <Link
                key={item.key}
                href={item.href}
                aria-current={activeTab === item.key ? 'page' : undefined}
                className={cn(
                  'flex h-12 flex-1 items-center justify-center border-r border-line px-7 text-body no-underline last:border-r-0',
                  activeTab === item.key ? 'bg-surface font-medium' : 'bg-fill font-normal hover:bg-fill-hover',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {activeTab === 'overview' ? (
            <RecordOverview zone={zone}
              account={account}
              object={objectParam}
              threads={threads.map((thread) => ({
                threadId: thread.id,
                subject: thread.subject,
                lastAt: thread.lastAt?.toISOString() ?? thread.firstAt?.toISOString() ?? null,
                messageCount: thread.messageCount,
              }))}
              firstTouch={touchFrom(record.values.original_source)}
              lastTouch={touchFrom(record.values.latest_source)}
            />
          ) : (
          <Timeline
            openKind={openKind}
            object={objectParam}
            recordId={id}
            account={account}
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
              stats: row.stats,
            }))}
            initialCursor={
              timeline.nextCursor
                ? { occurredAt: timeline.nextCursor.occurredAt.toISOString(), id: timeline.nextCursor.id }
                : null
            }
            counts={counts}
            groups={ACTIVITY_GROUPS}
            canWrite={canWrite}
            viewer={{ userId: session.userId, isAdmin: sessionIsAdmin(session) }}
          />
          )}
        </div>

        <div className={COLUMN}>
          <AssociationRail
            account={account}
            object={objectParam}
            recordId={id}
            cards={rail.groups}
            linkable={linkable}
            createFields={createFields}
            createInitial={createInitial}
            canWrite={canWrite}
          />
          <TasksPanel
            account={account}
            rows={tasks.map((row) => ({
              id: row.id,
              title: row.title,
              body: row.body,
              type: row.type,
              priority: row.priority,
              dueDate: row.dueDate,
              remindAt: row.remindAt,
              queueId: row.queueId,
              queueName: row.queueName,
              status: row.status,
              assigneeId: row.assigneeId,
              assigneeName: row.assigneeName,
              entityType: row.entityType,
              entityId: row.entityId,
              entityName: row.entityName,
            }))}
            assignees={lookups.users}
            queues={queues}
            entity={entity}
            canWrite={canWrite}
            startNew={task === 'new'}
          />
          <AttachmentsPanel
            object={objectParam}
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
    </div>
  )
}


export default RecordPage
