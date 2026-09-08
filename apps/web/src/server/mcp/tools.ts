import {
  ACTIVITY_TYPES,
  ConflictError,
  DuplicateError,
  ForbiddenError,
  UnknownFieldError,
  ValueError,
  logByHand,
  createRecord,
  createTask,
  describeAmbiguity,
  getRecord,
  getRegistry,
  isActivityType,
  listTasks,
  logActivity,
  readBoard,
  readSchedule,
  readTimeline,
  resolveRecord,
  searchAll,
  updateRecord,
  type ActivityType,
  type McpCaller,
  type Registry,
  type RegistryObject } from '@rawr/db'
import { readLookups, type Lookups } from '~/server/crm.ts'
import { resolveDate, todayFor } from './dates.ts'
import { FieldError, objectFromArg, prepareFields } from './fields.ts'

/** F5 §2. The ten tools, and the one place that knows what each one does.
 *
 *  Every handler goes through the same data access layer as the screens, with the
 *  caller's own role, so a viewer's token is refused by `assertCanWrite` and not by
 *  a check written twice. There is no privileged MCP path; that is the property the
 *  whole feature rests on, and it is why this file contains no SQL.
 *
 *  Two shapes recur. Reads take a name where a person would say one and answer with
 *  rows plus a cursor. Writes resolve the reference first and refuse outright if it
 *  is ambiguous (§3), then report the before and the after so the assistant can
 *  state the change rather than claim success (§4). */

export type ToolResult = {
  /** What the assistant reads aloud. Written as sentences, not JSON, because the
   *  model repeats this to a person. */
  text: string
  /** The same answer as data, for a client that would rather parse it. */
  data?: unknown
  /** A refusal the model can act on: an ambiguous name, an unknown field, a role.
   *  Reported in the result rather than as a protocol error, so the model can
   *  correct itself instead of giving up. */
  isError?: boolean
}

export type ToolContext = {
  caller: McpCaller
  registry: Registry
  lookups: Lookups
  /** The caller's own calendar day, from their working-hours timezone. Every
   *  natural-language date is measured from it. */
  today: string
}

export type ToolDefinition = {
  name: string
  title: string
  description: (context: { registry: Registry }) => string
  inputSchema: (context: { registry: Registry }) => Record<string, unknown>
  /** Writes take an idempotency key and are replayed from the ledger on a retry. */
  writes: boolean
  run: (context: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

/** §Edge cases, "an agent asks for all 88,270 contacts". */
const DEFAULT_ROWS = 25
const MAX_ROWS = 100

/** Every object the account has, so a model is offered the ones an admin
 *  invented alongside the three the system is built on. Built per request from the
 *  registry rather than written out, which is why it is a function. */
const objectArg = (registry: Registry) => ({
  type: 'string',
  enum: registry.objects.map((entry) => entry.key),
})

const limit = (max: number) => ({
  type: 'integer',
  minimum: 1,
  maximum: max,
  description: `How many rows at most. Defaults to ${DEFAULT_ROWS}; ${max} is the ceiling.`,
})

/** The registry, rendered for a model rather than for a table header. Regenerated
 *  on every tools/list, so a custom field added in Settings is in the schema on the
 *  next call with no deploy. §Definition of done. */
const describeFields = (object: RegistryObject): string => {
  const lines = object.fields.map((field) => {
    const options = field.options.length > 0 ? ` (${field.options.join(' | ')})` : ''
    const required = field.isRequired ? ', required' : ''
    return `    ${field.key}: ${field.type}${options}${required}`
  })
  return [`  ${object.key}`, ...lines].join('\n')
}

const fieldCatalogue = (registry: Registry): string =>
  registry.objects.map(describeFields).join('\n')

const NAME_HINT =
  'A name, an email, a domain or an id. A name that matches more than one record is refused with the candidates rather than guessed at.'

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const searchRecords: ToolDefinition = {
  name: 'search_records',
  title: 'Search records',
  writes: false,
  description: ({ registry }) =>
    `Find records by name, email or domain across every object in this account (${registry.objects.map((entry) => entry.namePlural.toLowerCase()).join(', ')}). Full text plus fuzzy, so a misspelling still lands. Returns ids to pass to the other tools. Omit \`object\` to search everything.`,
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for.' },
      object: { ...objectArg(registry), description: 'Narrow to one object. Omit to search every object.' },
      limit: limit(25),
    },
    required: ['query'],
    additionalProperties: false,
  }),
  run: async ({ caller, registry }, args) => {
    const query = String(args.query ?? '').trim()
    if (!query) return { text: 'Give something to search for.', isError: true }
    const perObject = clamp(args.limit, 8, 25)

    const results = await searchAll(caller.ctx, query, perObject)
    const wanted = args.object ? objectFromArg(registry, args.object).key : null
    const shown = results.groups.filter((group) => !wanted || group.objectKey === wanted)
    const total = shown.reduce((sum, group) => sum + group.hits.length, 0)

    if (total === 0) return { text: `Nothing matches "${query}".`, data: { total: 0, results: [] } }

    const lines = shown.flatMap((group) => [
      `${group.namePlural}:`,
      ...group.hits.map((hit) => `  ${hit.displayName}${hit.detail ? ` (${hit.detail})` : ''} (id ${hit.id})`),
    ])

    return {
      text: [`${total} match${total === 1 ? '' : 'es'} for "${query}".`, ...lines].join('\n'),
      data: {
        total,
        results: shown.flatMap((group) =>
          group.hits.map((hit) => ({ object: group.objectKey, id: hit.id, name: hit.displayName, detail: hit.detail })),
        ),
      },
    }
  },
}

const getRecordTool: ToolDefinition = {
  name: 'get_record',
  title: 'Get a record',
  writes: false,
  description: ({ registry }) =>
    [
      'Read one record in full, by id or by name, of any object in this account. Every field the registry knows about, with relations shown as their readable label.',
      '',
      'Fields:',
      fieldCatalogue(registry),
    ].join('\n'),
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      object: { ...objectArg(registry), description: 'Which object.' },
      id: { type: 'string', description: NAME_HINT },
    },
    required: ['object', 'id'],
    additionalProperties: false,
  }),
  run: async (context, args) => {
    const object = objectFromArg(context.registry, args.object)
    const key = object.key
    const found = await resolveOrExplain(context, object, String(args.id ?? ''))
    if ('problem' in found) return found.problem

    const record = await getRecord(context.caller.ctx, key, found.id)
    if (!record) return { text: 'That record no longer exists.', isError: true }

    const lines = object.fields
      .map((field) => {
        const value = record.labels[field.key] ?? record.values[field.key]
        if (value === null || value === undefined || value === '') return null
        return `  ${field.key}: ${format(value)}`
      })
      .filter(Boolean)

    return {
      text: [`${record.displayName} (${key}, id ${record.id})`, ...lines].join('\n'),
      data: { id: record.id, object: key, name: record.displayName, values: record.values, labels: record.labels },
    }
  },
}

const listPipeline: ToolDefinition = {
  name: 'list_pipeline',
  title: 'List the pipeline',
  writes: false,
  description: () =>
    'Every open deal by stage, with per-stage counts and totals, and the weighted total by stage probability. Totals are shown per currency and never summed across them.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      pipeline: { type: 'string', description: 'Pipeline name. Omit for the default one.' },
      stage: { type: 'string', description: 'Only this stage.' },
    },
    additionalProperties: false,
  }),
  run: async ({ caller, lookups }, args) => {
    const wanted = args.pipeline ? String(args.pipeline).trim().toLowerCase() : null
    const pipeline = wanted
      ? lookups.pipelines.find((p) => p.label.toLowerCase().includes(wanted))
      : lookups.pipelines[0]
    if (wanted && !pipeline) {
      return {
        text: `No pipeline called "${args.pipeline}". There ${lookups.pipelines.length === 1 ? 'is' : 'are'}: ${lookups.pipelines.map((p) => p.label).join(', ')}.`,
        isError: true,
      }
    }

    const board = await readBoard(caller.ctx, { pipelineId: pipeline?.id ?? null })
    const stage = args.stage ? String(args.stage).trim().toLowerCase() : null
    const columns = stage
      ? board.columns.filter((column) => column.name.toLowerCase().includes(stage))
      : board.columns

    if (stage && columns.length === 0) {
      return {
        text: `No stage matching "${args.stage}" in ${pipeline?.label ?? 'that pipeline'}. Stages: ${board.columns.map((c) => c.name).join(', ')}.`,
        isError: true,
      }
    }

    const lines = columns.map((column) => {
      const totals = column.totals
        .map((total) => `${total.currency} ${total.total} (weighted ${total.weighted})`)
        .join(', ')
      const header = `${column.name} — ${column.count} deal${column.count === 1 ? '' : 's'}${totals ? `, ${totals}` : ''}`
      const cards = column.cards
        .slice(0, 10)
        .map((card) => `    ${card.displayName}${card.amount ? ` — ${card.currency} ${card.amount}` : ''}${card.closeDate ? `, closes ${card.closeDate}` : ''} (id ${card.id})`)
      const more = column.count > cards.length ? [`    …and ${column.count - cards.length} more`] : []
      return [header, ...cards, ...more].join('\n')
    })

    return {
      text: [`${pipeline?.label ?? 'Pipeline'}:`, ...lines].join('\n'),
      data: {
        pipeline: pipeline?.label ?? null,
        stages: columns.map((column) => ({
          name: column.name,
          probability: column.probability,
          count: column.count,
          totals: column.totals,
          deals: column.cards.map((card) => ({
            id: card.id,
            name: card.displayName,
            amount: card.amount,
            currency: card.currency,
            closeDate: card.closeDate,
            company: card.companyName,
            owner: card.ownerName,
          })),
        })),
      },
    }
  },
}

const listActivities: ToolDefinition = {
  name: 'list_activities',
  title: 'List a timeline',
  writes: false,
  description: () =>
    `Everything that has happened on one record, newest first: notes, calls, meetings, emails, stage changes, form fills, bookings. Filter with \`type\`. Valid types: ${ACTIVITY_TYPES.join(', ')}.`,
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      object: { ...objectArg(registry), description: 'Which object the record is.' },
      id: { type: 'string', description: NAME_HINT },
      type: {
        type: 'array',
        items: { type: 'string', enum: ACTIVITY_TYPES },
        description: 'Only these activity types.',
      },
      limit: limit(MAX_ROWS),
    },
    required: ['object', 'id'],
    additionalProperties: false,
  }),
  run: async (context, args) => {
    const object = objectFromArg(context.registry, args.object)
    const key = object.key
    const found = await resolveOrExplain(context, object, String(args.id ?? ''))
    if ('problem' in found) return found.problem

    const requested = Array.isArray(args.type) ? args.type.map(String) : []
    const unknown = requested.filter((one) => !isActivityType(one))
    if (unknown.length > 0) {
      return {
        text: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an activity type' : 'are not activity types'}. Valid types: ${ACTIVITY_TYPES.join(', ')}.`,
        isError: true,
      }
    }

    const page = await readTimeline(context.caller.ctx, {
      entity: { entityType: key, entityId: found.id },
      ...(requested.length > 0 ? { types: requested as ActivityType[] } : {}),
      limit: clamp(args.limit, DEFAULT_ROWS, MAX_ROWS),
    })

    if (page.rows.length === 0) {
      return { text: `Nothing on ${found.displayName}'s timeline yet.`, data: { activities: [] } }
    }

    const lines = page.rows.map((row) => {
      const when = row.occurredAt.toISOString().slice(0, 16).replace('T', ' ')
      const who = row.actorName ?? (row.actorKind === 'public' ? 'a visitor' : row.actorKind)
      const what = row.subject ?? row.body?.slice(0, 120) ?? ''
      return `  ${when} · ${row.type} · ${what}${who ? ` — ${who}` : ''}`
    })

    return {
      text: [`${page.rows.length} on ${found.displayName}'s timeline, newest first:`, ...lines].join('\n'),
      data: {
        record: { id: found.id, name: found.displayName },
        activities: page.rows.map((row) => ({
          id: row.id,
          type: row.type,
          subject: row.subject,
          body: row.body,
          occurredAt: row.occurredAt.toISOString(),
          actor: row.actorName,
        })),
        hasMore: page.nextCursor !== null,
      },
    }
  },
}

const listTasksTool: ToolDefinition = {
  name: 'list_tasks',
  title: 'List tasks',
  writes: false,
  description: () =>
    'Open tasks, soonest due first. Defaults to yours; name somebody else to see theirs, or set overdue_only to see what is being chased late.',
  inputSchema: () => ({
    type: 'object',
    properties: {
      assignee: { type: 'string', description: 'A person\'s name. Omit for your own; "anyone" for the whole account.' },
      overdue_only: { type: 'boolean', description: 'Only tasks past their due date.' },
      include_done: { type: 'boolean', description: 'Include finished tasks. Off by default.' },
      limit: limit(MAX_ROWS),
    },
    additionalProperties: false,
  }),
  run: async ({ caller, lookups }, args) => {
    let assigneeId: string | undefined = caller.userId
    const wanted = args.assignee === undefined ? null : String(args.assignee).trim()
    if (wanted && wanted.toLowerCase() !== 'anyone' && wanted.toLowerCase() !== 'all') {
      const match = lookups.users.find(
        (user) => user.label.toLowerCase() === wanted.toLowerCase() || user.id === wanted,
      ) ?? lookups.users.find((user) => user.label.toLowerCase().includes(wanted.toLowerCase()))
      if (!match) {
        return {
          text: `Nobody here is called "${wanted}". The account has: ${lookups.users.map((u) => u.label).join(', ')}.`,
          isError: true,
        }
      }
      assigneeId = match.id
    } else if (wanted) {
      assigneeId = undefined
    }

    const rows = await listTasks(caller.ctx, {
      assigneeId,
      status: args.include_done ? undefined : 'open',
      overdueOnly: args.overdue_only === true,
    })
    const capped = rows.slice(0, clamp(args.limit, DEFAULT_ROWS, MAX_ROWS))

    if (capped.length === 0) {
      return { text: args.overdue_only ? 'Nothing overdue.' : 'No open tasks.', data: { tasks: [] } }
    }

    const lines = capped.map(
      (row) =>
        `  ${row.dueDate ?? 'no due date'} · ${row.title}${row.entityName ? ` — on ${row.entityName}` : ''}${row.assigneeName ? ` (${row.assigneeName})` : ''}`,
    )
    const more = rows.length > capped.length ? [`  …and ${rows.length - capped.length} more`] : []

    return {
      text: [`${rows.length} task${rows.length === 1 ? '' : 's'}:`, ...lines, ...more].join('\n'),
      data: {
        tasks: capped.map((row) => ({
          id: row.id,
          title: row.title,
          dueDate: row.dueDate,
          status: row.status,
          assignee: row.assigneeName,
          record: row.entityName,
        })),
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const updateRecordTool: ToolDefinition = {
  name: 'update_record',
  title: 'Update a record',
  writes: true,
  description: ({ registry }) =>
    [
      'Change fields on one record, of any object in this account. Dates may be written the way a person says them ("October 15th", "next Friday") and are resolved in your timezone; the response states the ISO date that was actually set.',
      'Stages, owners and companies may be named rather than given as ids. A name that matches more than one record changes nothing and comes back with the candidates.',
      '',
      'Fields, with their types and allowed values:',
      fieldCatalogue(registry),
    ].join('\n'),
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      object: { ...objectArg(registry), description: 'Which object.' },
      id: { type: 'string', description: NAME_HINT },
      fields: {
        type: 'object',
        description: `The fields to change, keyed by field key. Valid keys per object: ${registry.objects.map((o) => `${o.key} (${o.fields.map((f) => f.key).join(', ')})`).join('; ')}.`,
        additionalProperties: true,
      },
    },
    required: ['object', 'id', 'fields'],
    additionalProperties: false,
  }),
  run: async (context, args) => {
    const object = objectFromArg(context.registry, args.object)
    const key = object.key
    const found = await resolveOrExplain(context, object, String(args.id ?? ''))
    if ('problem' in found) return found.problem

    const prepared = await prepareFields(
      context.caller.ctx,
      object,
      context.lookups,
      asRecord(args.fields),
      context.today,
    )

    // Read first, so the response can state the change rather than assert it. §4.
    const before = await getRecord(context.caller.ctx, key, found.id)
    if (!before) return { text: 'That record no longer exists.', isError: true }

    await updateRecord(context.caller.ctx, key, found.id, prepared.values)
    const after = await getRecord(context.caller.ctx, key, found.id)

    const changes = Object.keys(prepared.values).map((field) => ({
      field,
      before: before.labels[field] ?? before.values[field] ?? null,
      after: after?.labels[field] ?? after?.values[field] ?? null,
    }))

    return {
      text: [
        `${before.displayName} updated.`,
        ...changes.map((change) => `  ${change.field}: ${format(change.before)} → ${format(change.after)}`),
        ...prepared.notes,
      ].join('\n'),
      data: { id: found.id, object: key, name: after?.displayName ?? before.displayName, changes },
    }
  },
}

const createRecordTool: ToolDefinition = {
  name: 'create_record',
  title: 'Create a record',
  writes: true,
  description: ({ registry }) =>
    [
      'Create a record of any object in this account. A contact created with a work email is associated to its company automatically by the same domain rules the forms use.',
      '',
      'Fields:',
      fieldCatalogue(registry),
    ].join('\n'),
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      object: { ...objectArg(registry), description: 'Which object to create.' },
      fields: { type: 'object', description: 'The values, keyed by field key.', additionalProperties: true },
    },
    required: ['object', 'fields'],
    additionalProperties: false,
  }),
  run: async (context, args) => {
    const object = objectFromArg(context.registry, args.object)
    const key = object.key
    const prepared = await prepareFields(
      context.caller.ctx,
      object,
      context.lookups,
      asRecord(args.fields),
      context.today,
    )

    const created = await createRecord(context.caller.ctx, key, prepared.values)
    const record = await getRecord(context.caller.ctx, key, created.id)

    return {
      text: [
        `Created ${object.nameSingular.toLowerCase()} ${record?.displayName ?? ''} (id ${created.id}).`,
        ...prepared.notes,
        ...created.warnings,
        ...(created.autoCompanyId ? ['Associated to its company by email domain.'] : []),
      ]
        .filter(Boolean)
        .join('\n'),
      data: { id: created.id, object: key, name: record?.displayName ?? null, warnings: created.warnings },
    }
  },
}

const createNoteTool: ToolDefinition = {
  name: 'create_note',
  title: 'Add a note',
  writes: true,
  description: () =>
    'Put a note on a record\'s timeline. It appears on that record and on the ones associated with it, the same as a note typed into the app.',
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      object: { ...objectArg(registry), description: 'Which object the record is.' },
      id: { type: 'string', description: NAME_HINT },
      body: { type: 'string', description: 'The note.' },
    },
    required: ['object', 'id', 'body'],
    additionalProperties: false,
  }),
  run: async (context, args) => {
    const object = objectFromArg(context.registry, args.object)
    const key = object.key
    const found = await resolveOrExplain(context, object, String(args.id ?? ''))
    if ('problem' in found) return found.problem

    const body = String(args.body ?? '').trim()
    if (!body) return { text: 'A note needs something in it.', isError: true }

    const note = await logByHand(context.caller.ctx, {
      type: 'note',
      body,
      entity: { entityType: key, entityId: found.id },
    })
    return {
      text: `Note added to ${found.displayName}.`,
      data: { id: note.id, record: { id: found.id, name: found.displayName } },
    }
  },
}

const createTaskTool: ToolDefinition = {
  name: 'create_task',
  title: 'Create a task',
  writes: true,
  description: () =>
    'Create a task against a record. The due date may be written the way a person says it; the response states the ISO date that was set. Unassigned tasks come to you.',
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      object: { ...objectArg(registry), description: 'Which object the record is.' },
      id: { type: 'string', description: NAME_HINT },
      title: { type: 'string', description: 'What needs doing.' },
      due_date: { type: 'string', description: 'YYYY-MM-DD, or a phrase like "next Friday".' },
      assignee: { type: 'string', description: "A person's name. Omit to assign it to yourself." },
      body: { type: 'string', description: 'Any detail.' },
    },
    required: ['object', 'id', 'title'],
    additionalProperties: false,
  }),
  run: async (context, args) => {
    const object = objectFromArg(context.registry, args.object)
    const key = object.key
    const found = await resolveOrExplain(context, object, String(args.id ?? ''))
    if ('problem' in found) return found.problem

    const title = String(args.title ?? '').trim()
    if (!title) return { text: 'A task needs a title.', isError: true }

    const notes: string[] = []
    let dueDate: string | null = null
    if (args.due_date) {
      const resolved = resolveDate(String(args.due_date), context.today)
      if (!resolved.ok) return { text: `Due date: ${resolved.reason}`, isError: true }
      dueDate = resolved.day
      notes.push(`Due ${dueDate}${resolved.how === 'as given' ? '' : ` (${args.due_date} read as ${resolved.how})`}.`)
    }

    let assigneeId = context.caller.userId
    if (args.assignee) {
      const wanted = String(args.assignee).trim().toLowerCase()
      const match =
        context.lookups.users.find((user) => user.label.toLowerCase() === wanted) ??
        context.lookups.users.find((user) => user.label.toLowerCase().includes(wanted))
      if (!match) {
        return {
          text: `Nobody here is called "${args.assignee}". The account has: ${context.lookups.users.map((u) => u.label).join(', ')}.`,
          isError: true,
        }
      }
      assigneeId = match.id
      notes.push(`Assigned to ${match.label}.`)
    }

    const created = await createTask(context.caller.ctx, {
      title,
      body: args.body ? String(args.body) : null,
      dueDate,
      assigneeId,
      entity: { entityType: key, entityId: found.id },
    })

    return {
      text: [`Task "${title}" created on ${found.displayName}.`, ...notes].join('\n'),
      data: { id: created.id, title, dueDate, record: { id: found.id, name: found.displayName } },
    }
  },
}

/** The five a person actually does by hand. Everything else in the enum is written
 *  by Rawr when it happens, and a hand-written `form_submission` or `merge` would be
 *  a lie on a timeline people trust. */
const LOGGABLE: ActivityType[] = ['call', 'meeting', 'email', 'note', 'task']

const logActivityTool: ToolDefinition = {
  name: 'log_activity',
  title: 'Log an activity',
  writes: true,
  description: () =>
    `Record something that happened outside Rawr: a call, a meeting, an email. It lands on the record's timeline dated when it happened, not when it was logged. Valid types: ${LOGGABLE.join(', ')}.`,
  inputSchema: ({ registry }) => ({
    type: 'object',
    properties: {
      object: { ...objectArg(registry), description: 'Which object the record is.' },
      id: { type: 'string', description: NAME_HINT },
      type: { type: 'string', enum: LOGGABLE, description: 'What kind of thing happened.' },
      subject: { type: 'string', description: 'One line summarising it.' },
      body: { type: 'string', description: 'Any detail.' },
      occurred_at: { type: 'string', description: 'When, as YYYY-MM-DD or a phrase. Defaults to now.' },
    },
    required: ['object', 'id', 'type', 'subject'],
    additionalProperties: false,
  }),
  run: async (context, args) => {
    const object = objectFromArg(context.registry, args.object)
    const key = object.key
    const found = await resolveOrExplain(context, object, String(args.id ?? ''))
    if ('problem' in found) return found.problem

    const type = String(args.type ?? '')
    if (!LOGGABLE.includes(type as ActivityType)) {
      return {
        text: `"${type}" is not something that can be logged by hand. Valid types: ${LOGGABLE.join(', ')}. The rest are written by Rawr itself.`,
        isError: true,
      }
    }

    const subject = String(args.subject ?? '').trim()
    if (!subject) return { text: 'An activity needs a subject.', isError: true }

    let occurredAt: Date | undefined
    const notes: string[] = []
    if (args.occurred_at) {
      const resolved = resolveDate(String(args.occurred_at), context.today)
      if (!resolved.ok) return { text: `When it happened: ${resolved.reason}`, isError: true }
      // Midday, so a day written as a date lands on that day in every timezone the
      // timeline is read from rather than sliding to the one before.
      occurredAt = new Date(`${resolved.day}T12:00:00Z`)
      notes.push(`Dated ${resolved.day}.`)
    }

    const logged = await logActivity(context.caller.ctx, {
      type: type as ActivityType,
      subject,
      body: args.body ? String(args.body) : null,
      ...(occurredAt ? { occurredAt } : {}),
      links: [{ entityType: key, entityId: found.id }],
    })

    return {
      text: [`Logged a ${type} on ${found.displayName}.`, ...notes].join('\n'),
      data: { id: logged.id, type, subject, record: { id: found.id, name: found.displayName } },
    }
  },
}

/** The ten that talk the way a person does, first, then one tool per procedure
 *  so nothing the screens can do is out of an assistant's reach. */
export const CURATED_TOOLS: ToolDefinition[] = [
  searchRecords,
  getRecordTool,
  listPipeline,
  listActivities,
  listTasksTool,
  updateRecordTool,
  createRecordTool,
  createNoteTool,
  createTaskTool,
  logActivityTool,
]

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** §3, in one place: a write never proceeds on an ambiguous reference, and the
 *  refusal carries enough detail on each candidate that the answer is obvious. */
const resolveOrExplain = async (
  context: ToolContext,
  object: RegistryObject,
  query: string,
): Promise<{ id: string; displayName: string } | { problem: ToolResult }> => {
  const names = { singular: object.nameSingular, plural: object.namePlural }
  if (!query.trim()) {
    return { problem: { text: `Which ${names.singular.toLowerCase()}? Give a name or an id.`, isError: true } }
  }
  const resolution = await resolveRecord(context.caller.ctx, object.key, query)
  if (resolution.kind === 'one') {
    return { id: resolution.record.id, displayName: resolution.record.displayName }
  }
  return {
    problem: {
      text: describeAmbiguity(
        names,
        query,
        resolution.kind === 'many' ? resolution.candidates : resolution.suggestions,
      ),
      isError: true,
    },
  }
}

const clamp = (value: unknown, fallback: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), 1), max)
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const format = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '(empty)'
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Every refusal a person can act on comes back as a tool result rather than a
 *  protocol error, because the model can correct a sentence and cannot correct a
 *  -32603. A role refusal is included: "your role cannot change deals" is the
 *  answer, not a crash. */
export const explain = (cause: unknown): ToolResult => {
  if (cause instanceof ForbiddenError) return { text: cause.message, isError: true }
  if (cause instanceof FieldError) return { text: cause.message, isError: true }
  if (cause instanceof ValueError) return { text: cause.message, isError: true }
  if (cause instanceof UnknownFieldError) return { text: cause.message, isError: true }
  if (cause instanceof DuplicateError) {
    return { text: `${cause.message} Nothing was created.`, isError: true }
  }
  if (cause instanceof ConflictError) {
    return {
      text: 'Somebody else changed that record while this was in flight. Read it again and reapply the change.',
      isError: true,
    }
  }
  return { text: cause instanceof Error ? cause.message : String(cause), isError: true }
}

/** The caller's own working-hours timezone, which is where "today" comes from. A
 *  person who has never opened the availability screen has no row, and UTC is the
 *  honest answer rather than the server's own zone. */
export const contextFor = async (caller: McpCaller): Promise<ToolContext> => {
  const [registry, lookups, schedule] = await Promise.all([
    getRegistry(caller.ctx),
    readLookups(caller.ctx),
    readSchedule(caller.ctx, caller.userId).catch(() => null),
  ])
  return { caller, registry, lookups, today: todayFor(schedule?.timezone ?? 'UTC') }
}
