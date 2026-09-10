'use client'

import { Alert, Badge, Button, EmptyState, Field, IconButton, Modal, Select, Switch, TextInput, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { FilterBuilder, type FilterField, type Group } from '~/components/crm/filter-builder.tsx'
import { ACTION_ICONS } from '~/components/icons.ts'
import { usePagedRows } from '~/components/paged.tsx'
import { automationRunsPath } from '~/lib/links.ts'
import { inSentence } from '~/lib/label-case.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime, formatNumber } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

type Trigger =
  | 'record_created'
  | 'stage_changed'
  | 'lifecycle_changed'
  | 'form_submitted'
  | 'date_reached'
  | 'no_activity'

type ActionType =
  | 'set_field'
  | 'set_lifecycle'
  | 'assign_owner'
  | 'create_task'
  | 'notify_slack'
  | 'send_email'
  | 'enroll_in_sequence'
  | 'webhook'

/** What the editor holds. Config values are strings here and coerced on save:
 *  every one of them comes out of an input, and a half-typed number is a string
 *  either way. */
export type StepView =
  | { kind: 'action'; type: ActionType; config: Record<string, string> }
  | { kind: 'delay'; minutes: number }
  | { kind: 'guard'; conditions: Group[] }
  | { kind: 'branch'; conditions: Group[]; matched: StepView[]; otherwise: StepView[] }

export type AutomationRowView = {
  id: string
  name: string
  isActive: boolean
  trigger: Trigger
  objectKey: string
  /** What the trigger needs beyond the object: which date field and how many
   *  days either side, or how many days of silence count. Strings, because every
   *  one of them came out of an input. */
  triggerConfig: Record<string, string>
  /** The rule's own conditions. A guard step with none of its own re-checks
   *  these, which is why an empty list made "and if it still matches" a no-op. */
  conditions: Group[]
  steps: StepView[]
  runCount: number
  lastRunAt: string | null
  createdAt: string
}

export type RunView = {
  id: string
  automationName: string
  entityType: string
  entityId: string
  state: 'waiting' | 'done' | 'skipped' | 'failed'
  detail: string | null
  /** Set only while it is parked, which is what the list leads with. */
  resumeAt: string | null
  at: string
}

export type AutomationListProps = {
  rows: AutomationRowView[]
  runs: RunView[]
  people: { id: string; name: string }[]
  stages: string[]
  /** Every object in the account, named. A rule can watch one an admin
   *  invented, so this cannot be written out here. */
  objects: { key: string; label: string }[]
  fieldsByObject: Record<string, string[]>
  /** Only the date fields, for the trigger that waits for one to arrive. */
  dateFieldsByObject: Record<string, { key: string; label: string }[]>
  /** The same shape segments pass their builder. Keyed by object because a rule
   *  can be repointed at another one while the editor is open. */
  filterFieldsByObject: Record<string, FilterField[]>
  templates: { id: string; name: string }[]
  mailboxes: { id: string; email: string }[]
  sequences: { id: string; name: string }[]
}

/** The words a person uses, against the words the enum uses. `objects: null` means
 *  any object in the account; the rest are fixed by what the trigger needs (only
 *  a deal has a pipeline, only a contact comes from a form fill). */
const TRIGGERS: { key: Trigger; label: string; objects: string[] | null }[] = [
  { key: 'record_created', label: 'a record is created', objects: null },
  { key: 'stage_changed', label: 'a deal changes stage', objects: ['deal'] },
  { key: 'lifecycle_changed', label: 'a lifecycle stage changes', objects: ['contact', 'company'] },
  { key: 'form_submitted', label: 'a form is submitted', objects: ['contact'] },
  { key: 'date_reached', label: 'a date arrives', objects: null },
  { key: 'no_activity', label: 'nothing has happened for a while', objects: ['contact', 'company', 'deal'] },
]

/** The two nothing announces. Rawr looks for them once an hour instead, and a
 *  rule fires at most once a day per record, which is what the copy says. */
const SCANNED: Trigger[] = ['date_reached', 'no_activity']

const ACTIONS: { key: ActionType; label: string }[] = [
  { key: 'set_field', label: 'Set a field' },
  { key: 'set_lifecycle', label: 'Move the lifecycle stage' },
  { key: 'assign_owner', label: 'Assign an owner' },
  { key: 'create_task', label: 'Create a task' },
  { key: 'notify_slack', label: 'Post to Slack' },
  { key: 'send_email', label: 'Send an email' },
  { key: 'enroll_in_sequence', label: 'Enrol in a sequence' },
  { key: 'webhook', label: 'Call a webhook' },
]

/** The two that write to a person. A rule watching a company or a deal cannot
 *  offer them: only a contact has an inbox. */
const CONTACT_ONLY: ActionType[] = ['send_email', 'enroll_in_sequence']

const STATE_TONE = { waiting: 'accent', done: 'ok', skipped: 'neutral', failed: 'error' } as const

/** The delays a person actually reaches for, so the common case is one click and
 *  the odd one is still typeable in minutes. */
const DELAYS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 60 * 4, label: '4 hours' },
  { minutes: 60 * 24, label: '1 day' },
  { minutes: 60 * 24 * 3, label: '3 days' },
  { minutes: 60 * 24 * 7, label: '1 week' },
  { minutes: 60 * 24 * 14, label: '2 weeks' },
  { minutes: 60 * 24 * 30, label: '30 days' },
]

const describeDelay = (minutes: number): string =>
  DELAYS.find((entry) => entry.minutes === minutes)?.label ??
  (minutes % 1440 === 0
    ? `${minutes / 1440} days`
    : minutes % 60 === 0
      ? `${minutes / 60} hours`
      : `${minutes} minutes`)

/** One line per step, for the row in the list. */
const summarise = (step: StepView): string => {
  if (step.kind === 'delay') return `wait ${describeDelay(step.minutes)}`
  if (step.kind === 'guard') return 'check it still matches'
  if (step.kind === 'branch') {
    const arm = (steps: StepView[]) => steps.map(summarise).join(', then ') || 'nothing'
    return `if it matches: ${arm(step.matched)}; otherwise: ${arm(step.otherwise)}`
  }
  return ACTIONS.find((entry) => entry.key === step.type)?.label.toLowerCase() ?? step.type
}

const replace = (steps: StepView[], at: number, step: StepView): StepView[] =>
  steps.map((existing, index) => (index === at ? step : existing))

const swap = (steps: StepView[], a: number, b: number): StepView[] =>
  steps.map((step, index) => (index === a ? steps[b] : index === b ? steps[a] : step) as StepView)

/** What the dropdown's value means. An action's value is its own type, so the two
 *  groups share one control and the reader picks a step rather than picking a
 *  kind and then a step. */
const kindFrom = (value: string): StepView =>
  value === 'delay'
    ? { kind: 'delay', minutes: 60 * 24 }
    : value === 'guard'
      ? { kind: 'guard', conditions: [] }
      : value === 'branch'
        ? { kind: 'branch', conditions: [], matched: [], otherwise: [] }
        : { kind: 'action', type: value as ActionType, config: {} }

/** How deep a branch may sit inside a branch, matching what the layer will
 *  accept. Past this the dropdown stops offering one rather than saving a rule
 *  whose inner arms are silently dropped. */
const MAX_BRANCH_DEPTH = 3

/** The fields one action needs, which differ per action and per object.
 *
 *  Its own component because there are now as many of these on screen as the rule
 *  has steps, each with its own config, and inlining them meant one `config`
 *  state for the whole form. Ids carry the step number so two "Task title" labels
 *  in one dialog still point at their own input. */
/** Everything an arm of the editor needs that does not change as it recurses.
 *  One object rather than nine props threaded through a branch and its arms. */
type EditorContext = {
  object: string
  people: { id: string; name: string }[]
  stages: string[]
  fieldsByObject: Record<string, string[]>
  filterFields: FilterField[]
  templates: { id: string; name: string }[]
  mailboxes: { id: string; email: string }[]
  sequences: { id: string; name: string }[]
}

const ActionFields = ({
  path,
  type,
  config,
  ctx,
  onChange,
}: {
  /** Where this step sits, so two "Task title" labels in one dialog still point
   *  at their own input however deep inside a branch they are. */
  path: string
  type: ActionType
  config: Record<string, string>
  ctx: EditorContext
  onChange: (config: Record<string, string>) => void
}) => {
  const { object, people, stages, fieldsByObject, templates, mailboxes, sequences } = ctx
  const id = (part: string) => `automation-${path}-${part}`
  const set = (key: string, value: string) => onChange({ ...config, [key]: value })

  if (type === 'set_field') {
    return (
      <div className="grid gap-2 @md:grid-cols-2">
        <Field id={id('field')} label="Field">
          <Select id={id('field')} value={config.field ?? ''} onChange={(e) => set('field', e.target.value)}>
            <option value="">Pick one</option>
            {(fieldsByObject[object] ?? []).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id('value')} label="To">
          <TextInput id={id('value')} value={config.value ?? ''} onChange={(e) => set('value', e.target.value)} />
        </Field>
      </div>
    )
  }

  if (type === 'set_lifecycle') {
    return (
      <Field id={id('stage')} label="Stage">
        <Select id={id('stage')} value={config.stage ?? ''} onChange={(e) => set('stage', e.target.value)}>
          <option value="">Pick one</option>
          {stages.map((stage) => (
            <option key={stage} value={stage}>
              {stage}
            </option>
          ))}
        </Select>
      </Field>
    )
  }

  if (type === 'assign_owner') {
    return (
      <Field id={id('owner')} label="Owner">
        <Select id={id('owner')} value={config.userId ?? ''} onChange={(e) => set('userId', e.target.value)}>
          <option value="">Pick one</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </Field>
    )
  }

  if (type === 'create_task') {
    return (
      <div className="grid gap-2 @md:grid-cols-2">
        <Field id={id('title')} label="Task title" hint="{{name}} becomes the record's name.">
          <TextInput
            id={id('title')}
            value={config.title ?? ''}
            placeholder="Follow up on {{name}}"
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
        <Field id={id('due')} label="Due in days" hint="Leave empty for no due date.">
          <TextInput
            id={id('due')}
            inputMode="numeric"
            value={config.dueInDays ?? ''}
            onChange={(e) => set('dueInDays', e.target.value)}
          />
        </Field>
      </div>
    )
  }

  if (type === 'send_email') {
    return (
      <div className="grid gap-2 @md:grid-cols-2">
        <Field id={id('template')} label="Template">
          <Select id={id('template')} value={config.templateId ?? ''} onChange={(e) => set('templateId', e.target.value)}>
            <option value="">Pick one</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id('from')} label="From" hint="Sends from this mailbox, and stops if they have opted out.">
          <Select id={id('from')} value={config.mailboxId ?? ''} onChange={(e) => set('mailboxId', e.target.value)}>
            <option value="">Pick one</option>
            {mailboxes.map((box) => (
              <option key={box.id} value={box.id}>
                {box.email}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    )
  }

  if (type === 'enroll_in_sequence') {
    return (
      <div className="grid gap-2 @md:grid-cols-2">
        <Field id={id('sequence')} label="Sequence">
          <Select id={id('sequence')} value={config.sequenceId ?? ''} onChange={(e) => set('sequenceId', e.target.value)}>
            <option value="">Pick one</option>
            {sequences.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id('sender')} label="From">
          <Select id={id('sender')} value={config.mailboxId ?? ''} onChange={(e) => set('mailboxId', e.target.value)}>
            <option value="">Pick one</option>
            {mailboxes.map((box) => (
              <option key={box.id} value={box.id}>
                {box.email}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    )
  }

  if (type === 'webhook') {
    return (
      <div className="grid gap-2 @md:grid-cols-2">
        <Field id={id('url')} label="Address" hint="https only. Five seconds to answer, then one retry.">
          <TextInput
            id={id('url')}
            inputMode="url"
            value={config.url ?? ''}
            placeholder="https://example.com/hooks/rawr"
            onChange={(e) => set('url', e.target.value)}
          />
        </Field>
        <Field id={id('secret')} label="Secret" hint="Signs the call, so the receiver can prove it came from Rawr.">
          <TextInput id={id('secret')} value={config.secret ?? ''} onChange={(e) => set('secret', e.target.value)} />
        </Field>
      </div>
    )
  }

  return (
    <div className="grid gap-2 @md:grid-cols-2">
      <Field id={id('message')} label="Message" hint="{{name}} becomes the record's name.">
        <TextInput
          id={id('message')}
          value={config.message ?? ''}
          placeholder="{{name}} reached Proposal"
          onChange={(e) => set('message', e.target.value)}
        />
      </Field>
      <Field id={id('channel')} label="Channel" hint="Leave empty for the integration's default.">
        <TextInput id={id('channel')} value={config.channel ?? ''} onChange={(e) => set('channel', e.target.value)} />
      </Field>
    </div>
  )
}

/** One list of steps, and the arms of any branch inside it.
 *
 *  Recursive because a branch holds two lists of exactly these steps. `path`
 *  makes every label and every key unique down the tree, and `depth` is what
 *  stops the dropdown offering a branch deeper than the layer will accept. */
const StepList = ({
  steps,
  onChange,
  path,
  depth,
  ctx,
}: {
  steps: StepView[]
  onChange: (steps: StepView[]) => void
  path: string
  depth: number
  ctx: EditorContext
}) => {
  const canBranch = depth < MAX_BRANCH_DEPTH - 1
  const actions = ACTIONS.filter((entry) => ctx.object === 'contact' || !CONTACT_ONLY.includes(entry.key))

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={`${path}-${index}`}
            className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-small text-secondary tabular-nums">{index + 1}</span>
              <Select
                aria-label={`Step ${index + 1}`}
                className="w-auto"
                value={step.kind === 'action' ? step.type : step.kind}
                onChange={(event) => onChange(replace(steps, index, kindFrom(event.target.value)))}
              >
                <optgroup label="Do">
                  {actions.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Then">
                  <option value="delay">Wait</option>
                  <option value="guard">Check it still matches</option>
                  {canBranch || step.kind === 'branch' ? <option value="branch">If it matches, otherwise</option> : null}
                </optgroup>
              </Select>

              {step.kind === 'delay' ? (
                <Select
                  aria-label={`How long step ${index + 1} waits`}
                  className="w-auto"
                  value={String(step.minutes)}
                  onChange={(event) =>
                    onChange(replace(steps, index, { kind: 'delay', minutes: Number(event.target.value) }))
                  }
                >
                  {DELAYS.map((entry) => (
                    <option key={entry.minutes} value={entry.minutes}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              ) : null}

              <span className="ml-auto flex items-center gap-0.5">
                <IconButton
                  label={`Move step ${index + 1} up`}
                  icon={<ACTION_ICONS.moveUp size={16} />}
                  disabled={index === 0}
                  onClick={() => onChange(swap(steps, index, index - 1))}
                />
                <IconButton
                  label={`Move step ${index + 1} down`}
                  icon={<ACTION_ICONS.moveDown size={16} />}
                  disabled={index === steps.length - 1}
                  onClick={() => onChange(swap(steps, index, index + 1))}
                />
                <IconButton
                  label={`Remove step ${index + 1}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  // An arm is allowed to be empty while it is being written. The
                  // rule itself is not: a rule with no steps does nothing.
                  disabled={depth === 0 && steps.length === 1}
                  onClick={() => onChange(steps.filter((_, at) => at !== index))}
                />
              </span>
            </div>

            {step.kind === 'guard' ? (
              <div className="flex flex-col gap-2">
                <p className="text-small text-secondary">
                  Looks at the record again, as it is now, and stops the rule here unless it still
                  matches. This is how a rule waits and then changes its mind. With nothing of its
                  own below, it re-checks the rule&apos;s own conditions.
                </p>
                <FilterBuilder
                  key={`${ctx.object}-${path}-${index}-guard`}
                  fields={ctx.filterFields}
                  value={step.conditions}
                  onApply={(next) => onChange(replace(steps, index, { ...step, conditions: next }))}
                />
              </div>
            ) : null}

            {step.kind === 'branch' ? (
              <div className="flex flex-col gap-3">
                <p className="text-small text-secondary">
                  Looks at the record now and takes one of two roads. Unlike a check, both roads
                  carry on: whichever arm runs, the steps after this one still follow.
                </p>
                <FilterBuilder
                  key={`${ctx.object}-${path}-${index}-branch`}
                  fields={ctx.filterFields}
                  value={step.conditions}
                  onApply={(next) => onChange(replace(steps, index, { ...step, conditions: next }))}
                />
                <div className="flex flex-col gap-2 border-l-2 border-divider pl-3">
                  <p className="font-medium">If it matches</p>
                  <StepList
                    steps={step.matched}
                    onChange={(next) => onChange(replace(steps, index, { ...step, matched: next }))}
                    path={`${path}-${index}t`}
                    depth={depth + 1}
                    ctx={ctx}
                  />
                </div>
                <div className="flex flex-col gap-2 border-l-2 border-divider pl-3">
                  <p className="font-medium">Otherwise</p>
                  <StepList
                    steps={step.otherwise}
                    onChange={(next) => onChange(replace(steps, index, { ...step, otherwise: next }))}
                    path={`${path}-${index}e`}
                    depth={depth + 1}
                    ctx={ctx}
                  />
                </div>
              </div>
            ) : null}

            {step.kind === 'action' ? (
              <ActionFields
                path={`${path}-${index}`}
                type={step.type}
                config={step.config}
                ctx={ctx}
                onChange={(config) => onChange(replace(steps, index, { ...step, config }))}
              />
            ) : null}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onChange([...steps, { kind: 'action', type: 'create_task', config: {} }])}>
          Add an action
        </Button>
        <Button onClick={() => onChange([...steps, { kind: 'delay', minutes: 60 * 24 }])}>Add a wait</Button>
        <Button onClick={() => onChange([...steps, { kind: 'guard', conditions: [] }])}>Add a check</Button>
        {canBranch ? (
          <Button onClick={() => onChange([...steps, { kind: 'branch', conditions: [], matched: [], otherwise: [] }])}>
            Add an if/then
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export const AutomationList = ({
  rows,
  runs,
  people,
  stages,
  objects,
  fieldsByObject,
  dateFieldsByObject,
  filterFieldsByObject,
  templates,
  mailboxes,
  sequences,
}: AutomationListProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [editing, setEditing] = useState<AutomationRowView | 'new' | null>(null)
  const [removing, setRemoving] = useState<AutomationRowView | null>(null)
  const { page, pager } = usePagedRows(rows, 'automations')
  const [busy, setBusy] = useState(false)
  /** Whether a rule is on, as this browser has just set it. router.refresh takes a
   *  round trip, and a switch that snaps back for that long reads as a failure.
   *  Dropped on failure, leaving the server's answer. */
  const [switched, setSwitched] = useState<Record<string, boolean>>({})

  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState<Trigger>('record_created')
  const [object, setObject] = useState<string>('contact')
  const [steps, setSteps] = useState<StepView[]>([])
  const [conditions, setConditions] = useState<Group[]>([])
  const [triggerConfig, setTriggerConfig] = useState<Record<string, string>>({})

  const only = TRIGGERS.find((entry) => entry.key === trigger)?.objects ?? null
  const allowedObjects = only ? objects.filter((entry) => only.includes(entry.key)) : objects
  const labelOf = (key: string): string => objects.find((entry) => entry.key === key)?.label ?? key
  const isOn = (row: AutomationRowView): boolean => switched[row.id] ?? row.isActive
  const setTrigger_ = (key: string, value: string) => setTriggerConfig({ ...triggerConfig, [key]: value })

  const editor: EditorContext = {
    object,
    people,
    stages,
    fieldsByObject,
    filterFields: filterFieldsByObject[object] ?? [],
    templates,
    mailboxes,
    sequences,
  }

  const openNew = () => {
    setName('')
    setTrigger('record_created')
    setObject('contact')
    setConditions([])
    setTriggerConfig({ direction: 'before', offsetDays: '3', days: '30' })
    setSteps([{ kind: 'action', type: 'create_task', config: {} }])
    setEditing('new')
  }

  const openEdit = (row: AutomationRowView) => {
    setName(row.name)
    setTrigger(row.trigger)
    setObject(row.objectKey)
    setConditions(row.conditions)
    setTriggerConfig({ direction: 'before', offsetDays: '3', days: '30', ...row.triggerConfig })
    setSteps(row.steps.length > 0 ? row.steps : [{ kind: 'action', type: 'create_task', config: {} }])
    setEditing(row)
  }

  const run = async (what: () => Promise<unknown>, said: string, undo?: () => void) => {
    setBusy(true)
    try {
      await what()
      toast('success', said)
      setEditing(null)
      setRemoving(null)
      router.refresh()
    } catch (cause) {
      undo?.()
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const save = () =>
    run(
      () =>
        api.admin.automations.save.mutate({
          ...(editing !== 'new' && editing ? { id: editing.id } : {}),
          name,
          trigger,
          object,
          triggerConfig,
          conditions,
          // A guard with no conditions of its own re-checks the rule's, which is
          // the reading somebody means by "and if it still matches". The shape
          // the editor holds is already the shape the layer parses.
          steps,
        }),
      editing === 'new' ? 'Saved. Turn it on when you are ready.' : 'Saved.',
    )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="primary" onClick={openNew}>
          Create automation
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing runs on its own yet"
          description="A rule watches for something that happens and does one thing about it."
        />
      ) : (
        <ul className="flex flex-col rounded-panel border border-line bg-surface">
          {page.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{row.name}</span>
                  {isOn(row) ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>}
                </p>
                <p className="text-small text-secondary">
                  When {TRIGGERS.find((entry) => entry.key === row.trigger)?.label} on a{' '}
                  {inSentence(labelOf(row.objectKey))}:{' '}
                  {row.steps.map(summarise).join(', then ')}
                </p>
                <p className="text-small text-secondary tabular-nums">
                  {row.runCount === 0
                    ? 'Has not fired yet'
                    : `Fired ${formatNumber(row.runCount)} time${row.runCount === 1 ? '' : 's'}, last ${formatDateTime(row.lastRunAt ?? row.createdAt, zone)}`}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Switch
                  checked={isOn(row)}
                  label={isOn(row) ? 'On' : 'Off'}
                  onChange={(event) => {
                    const next = event.target.checked
                    setSwitched((current) => ({ ...current, [row.id]: next }))
                    void run(
                      () => api.admin.automations.setActive.mutate({ id: row.id, isActive: next }),
                      next ? 'Running from now on.' : 'Stopped.',
                      () =>
                        setSwitched((current) => {
                          const rest = { ...current }
                          delete rest[row.id]
                          return rest
                        }),
                    )
                  }}
                />
                <Link href={automationRunsPath(row.id)} className="text-small">
                  Runs
                </Link>
                <IconButton
                  label={`Edit ${row.name}`}
                  icon={<ACTION_ICONS.edit size={16} />}
                  onClick={() => openEdit(row)}
                />
                <IconButton
                  label={`Delete ${row.name}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  onClick={() => setRemoving(row)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {pager}

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">What they did</h3>
        {runs.length === 0 ? (
          <p className="text-secondary">Nothing has fired yet.</p>
        ) : (
          <ul className="flex flex-col rounded-panel border border-line bg-surface">
            {runs.slice(0, 50).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-divider px-3 py-1.5 last:border-0">
                <Badge tone={STATE_TONE[entry.state]}>{entry.state}</Badge>
                <span className="font-medium">{entry.automationName}</span>
                <span className="min-w-0 truncate text-secondary">{entry.detail}</span>
                {/* A waiting run's useful time is when it wakes, not when it
                    started: "fired an hour ago" says nothing about a rule that
                    has two more days to sit. */}
                <span className="ml-auto shrink-0 text-small text-secondary tabular-nums">
                  {entry.resumeAt
                    ? `continues ${formatDateTime(entry.resumeAt, zone)}`
                    : formatDateTime(entry.at, zone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing === 'new' ? 'Create automation' : 'Edit automation'}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="automation-name" label="Name">
            <TextInput id="automation-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          <Field id="automation-trigger" label="When">
            <Select
              id="automation-trigger"
              value={trigger}
              onChange={(event) => {
                const next = event.target.value as Trigger
                setTrigger(next)
                const allowed = TRIGGERS.find((entry) => entry.key === next)?.objects ?? null
                if (allowed && !allowed.includes(object)) setObject(allowed[0]!)
              }}
            >
              {TRIGGERS.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="automation-object" label="On a">
            <Select
              id="automation-object"
              value={object}
              onChange={(event) => setObject(event.target.value)}
            >
              {allowedObjects.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>

          {trigger === 'date_reached' ? (
            <div className="grid gap-2 @md:grid-cols-3">
              <Field id="automation-datefield" label="Date">
                <Select
                  id="automation-datefield"
                  value={triggerConfig.fieldKey ?? ''}
                  onChange={(event) => setTrigger_('fieldKey', event.target.value)}
                >
                  <option value="">Pick one</option>
                  {(dateFieldsByObject[object] ?? []).map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="automation-offset" label="Days" hint="0 fires on the day itself.">
                <TextInput
                  id="automation-offset"
                  inputMode="numeric"
                  value={triggerConfig.offsetDays ?? ''}
                  onChange={(event) => setTrigger_('offsetDays', event.target.value)}
                />
              </Field>
              <Field id="automation-direction" label="Which side">
                <Select
                  id="automation-direction"
                  value={triggerConfig.direction ?? 'before'}
                  onChange={(event) => setTrigger_('direction', event.target.value)}
                >
                  <option value="before">before the date</option>
                  <option value="after">after the date</option>
                </Select>
              </Field>
            </div>
          ) : null}

          {trigger === 'no_activity' ? (
            <Field
              id="automation-quiet"
              label="Days of silence"
              hint="Counted from the last thing on the timeline, or from when the record was created if there is nothing on it."
            >
              <TextInput
                id="automation-quiet"
                inputMode="numeric"
                value={triggerConfig.days ?? ''}
                onChange={(event) => setTrigger_('days', event.target.value)}
              />
            </Field>
          ) : null}

          {SCANNED.includes(trigger) ? (
            <Alert tone="info">
              Nothing announces this one, so Rawr looks for it once an hour. A rule fires at most
              once a day for any one record, and a silence rule fires on the day the record goes
              quiet rather than every day after it.
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <p className="font-medium">Only if</p>
            <p className="text-small text-secondary">
              Leave this empty and the rule fires on every one of those. A guard step later re-checks
              exactly these conditions, so an empty list makes that step a no-op.
            </p>
            <FilterBuilder
              key={object}
              fields={filterFieldsByObject[object] ?? []}
              value={conditions}
              onApply={setConditions}
            />
          </div>

          <div className="flex flex-col gap-2">
            <p className="font-medium">Then, in order</p>
            <StepList steps={steps} onChange={setSteps} path="s" depth={0} ctx={editor} />
          </div>

          <Alert tone="info">
            A new rule is saved off. Nothing happens until you turn it on, so a half-written rule
            cannot start changing records while you are still deciding what it should do.
          </Alert>
        </div>
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={`Delete ${removing?.name ?? ''}?`}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() =>
                removing &&
                void run(() => api.admin.automations.remove.mutate({ id: removing.id }), 'Deleted.')
              }
            >
              Delete
            </Button>
          </>
        }
      >
        <p>
          The rule stops. The work it did stays: the tasks it created, the fields it set, and the
          timeline entries it wrote. Its log of when it fired goes with it, so take what you need
          from &ldquo;What they did&rdquo; first.
        </p>
      </Modal>
    </div>
  )
}
