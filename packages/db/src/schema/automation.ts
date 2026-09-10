import { sql } from 'drizzle-orm'
import { boolean, date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, updatedAt, accountId } from './columns.ts'
import { automationStateEnum, automationTriggerEnum } from './enums.ts'
import { userAccount, account } from './identity.ts'

/** B11. When this happens, do that.
 *
 *  Everything automatic in Rawr before this was hard-wired: segments recompute on
 *  the hour, sequences advance, and one deal stage change posts to one Slack
 *  channel. Every other rule a team wanted — a form fill sets a lifecycle stage,
 *  a deal reaching Proposal creates a task for its owner, a new contact from paid
 *  search goes to whoever is on rotation — needed a deploy.
 *
 *  Most triggers are events Rawr already emits, so an automation fires on the
 *  write that caused it and nothing polls. Two are not: a date arriving and a
 *  record going quiet are both absences, and no write announces either. Those two
 *  are found by an hourly scan instead, and `automation_run.scan_day` below is
 *  what keeps twelve scans in a day from firing one rule twelve times. */
export const automation = pgTable(
  'automation',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    trigger: automationTriggerEnum('trigger').notNull(),
    /** Which object the trigger watches, and anything else it needs: a form id, a
     *  pipeline id. Shape depends on the trigger. */
    triggerConfig: jsonb('trigger_config').notNull().default({}),
    /** FilterGroup[], compiled against the record that triggered it, exactly as a
     *  segment's are. One filter language in the product, not two. */
    conditions: jsonb('conditions').notNull().default([]),
    /** Ordered steps. Three kinds: an action, a delay that parks the run, and a
     *  guard that re-reads the record and stops if it no longer matches.
     *
     *  Run in order, and a failure stops the rest: an automation half-applied is
     *  worse than one that did not run, because the record ends up in a state no
     *  rule describes. */
    steps: jsonb('steps').notNull().default([]),
    createdBy: uuid('created_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The only query the runner makes: what is armed for this event. */
    index('automation_trigger_idx').on(t.accountId, t.trigger, t.isActive),
  ],
)

/** Every firing, including the ones that did nothing and the ones still going.
 *
 *  "It did not run" and "it ran and the conditions were false" are different
 *  answers to the only question anybody asks about an automation, and a log that
 *  records just the successes cannot tell them apart.
 *
 *  Once a rule can wait, this is the run itself and not only its epitaph: a row
 *  in `waiting` is one record parked partway through, and the set of them is the
 *  dispatcher's entire queue. */
export const automationRun = pgTable(
  'automation_run',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automation.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    state: automationStateEnum('state').notNull(),
    /** What happened, in the words the screen shows: which actions ran, or the
     *  condition that was false, or the error verbatim. */
    detail: text('detail'),
    /** The next step to run, as a path from the root: `[2]` is the third step,
     *  `[2, 'else', 1]` is the second step of that step's else arm. Left where it
     *  stopped, so a failure says how far it got and not only that it failed.
     *
     *  A path rather than an index because a branch makes the steps a tree, and
     *  an integer can only describe a list. */
    stepPath: jsonb('step_path').notNull().default([]),
    /** When to pick this run up again. Null unless it is waiting, which is what
     *  makes the index below the queue rather than the history. */
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    /** Held while a resume is in flight, so two workers cannot advance one run
     *  twice. Swept like a sequence enrollment's. */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** What each finished step did, in order. `detail` is one string and a run
     *  spanning three days is written in three pieces. */
    trail: jsonb('trail').notNull().default([]),
    /** The day the scan fired this, for a trigger nothing announced. Null on
     *  every run a write caused, which is what keeps the index below off them:
     *  an event may legitimately happen to one record twice in an afternoon. */
    scanDay: date('scan_day'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('automation_run_recent_idx').on(t.accountId, t.automationId, t.at.desc()),
    index('automation_run_entity_idx').on(t.accountId, t.entityId),
    index('automation_run_due_idx')
      .on(t.accountId, t.resumeAt)
      .where(sql`resume_at is not null`),
    /** Once per rule, per record, per day, enforced here rather than by the
     *  scan asking first: two workers scanning the same hour would both find the
     *  record and both find no run. */
    uniqueIndex('automation_run_scan_idx')
      .on(t.accountId, t.automationId, t.entityId, t.scanDay)
      .where(sql`scan_day is not null`),
  ],
)
