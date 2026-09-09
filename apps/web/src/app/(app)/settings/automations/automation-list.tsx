'use client'

import { Alert, Badge, Button, EmptyState, Field, IconButton, Modal, Select, Switch, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { FilterBuilder, type FilterField, type Group } from '~/components/crm/filter-builder.tsx'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'

type Trigger = 'record_created' | 'stage_changed' | 'lifecycle_changed' | 'form_submitted'
type ActionType = 'set_field' | 'set_lifecycle' | 'assign_owner' | 'create_task' | 'notify_slack'

/** What the editor holds. Config values are strings here and coerced on save:
 *  every one of them comes out of an input, and a half-typed number is a string
 *  either way. */
export type StepView =
  | { kind: 'action'; type: ActionType; config: Record<string, string> }
  | { kind: 'delay'; minutes: number }
  | { kind: 'guard'; conditions: Group[] }

export type AutomationRowView = {
  id: string
  name: string
  isActive: boolean
  trigger: Trigger
  objectKey: string
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
  /** The same shape segments pass their builder. Keyed by object because a rule
   *  can be repointed at another one while the editor is open. */
  filterFieldsByObject: Record<string, FilterField[]>
}

/** The words a person uses, against the words the enum uses. `objects: null` means
 *  any object in the account; the rest are fixed by what the trigger needs (only
 *  a deal has a pipeline, only a contact comes from a form fill). */
const TRIGGERS: { key: Trigger; label: string; objects: string[] | null }[] = [
  { key: 'record_created', label: 'a record is created', objects: null },
  { key: 'stage_changed', label: 'a deal changes stage', objects: ['deal'] },
  { key: 'lifecycle_changed', label: 'a lifecycle stage changes', objects: ['contact', 'company'] },
  { key: 'form_submitted', label: 'a form is submitted', objects: ['contact'] },
]

const ACTIONS: { key: ActionType; label: string }[] = [
  { key: 'set_field', label: 'Set a field' },
  { key: 'set_lifecycle', label: 'Move the lifecycle stage' },
  { key: 'assign_owner', label: 'Assign an owner' },
  { key: 'create_task', label: 'Create a task' },
  { key: 'notify_slack', label: 'Post to Slack' },
]

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
      : { kind: 'action', type: value as ActionType, config: {} }

/** The fields one action needs, which differ per action and per object.
 *
 *  Its own component because there are now as many of these on screen as the rule
 *  has steps, each with its own config, and inlining them meant one `config`
 *  state for the whole form. Ids carry the step number so two "Task title" labels
 *  in one dialog still point at their own input. */
const ActionFields = ({
  index,
  type,
  config,
  object,
  people,
  stages,
  fieldsByObject,
  onChange,
}: {
  index: number
  type: ActionType
  config: Record<string, string>
  object: string
  people: { id: string; name: string }[]
  stages: string[]
  fieldsByObject: Record<string, string[]>
  onChange: (config: Record<string, string>) => void
}) => {
  const id = (part: string) => `automation-${index}-${part}`
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

export const AutomationList = ({
  rows,
  runs,
  people,
  stages,
  objects,
  fieldsByObject,
  filterFieldsByObject,
}: AutomationListProps) => {
  const router = useRouter()
  const toast = useToast()
  const [editing, setEditing] = useState<AutomationRowView | 'new' | null>(null)
  const [removing, setRemoving] = useState<AutomationRowView | null>(null)
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState<Trigger>('record_created')
  const [object, setObject] = useState<string>('contact')
  const [steps, setSteps] = useState<StepView[]>([])
  const [conditions, setConditions] = useState<Group[]>([])

  const only = TRIGGERS.find((entry) => entry.key === trigger)?.objects ?? null
  const allowedObjects = only ? objects.filter((entry) => only.includes(entry.key)) : objects
  const labelOf = (key: string): string => objects.find((entry) => entry.key === key)?.label ?? key

  const openNew = () => {
    setName('')
    setTrigger('record_created')
    setObject('contact')
    setConditions([])
    setSteps([{ kind: 'action', type: 'create_task', config: {} }])
    setEditing('new')
  }

  const openEdit = (row: AutomationRowView) => {
    setName(row.name)
    setTrigger(row.trigger)
    setObject(row.objectKey)
    setConditions(row.conditions)
    setSteps(row.steps.length > 0 ? row.steps : [{ kind: 'action', type: 'create_task', config: {} }])
    setEditing(row)
  }

  const run = async (what: () => Promise<unknown>, said: string) => {
    setBusy(true)
    try {
      await what()
      toast('success', said)
      setEditing(null)
      setRemoving(null)
      router.refresh()
    } catch (cause) {
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
          conditions,
          steps: steps.map((step) =>
            step.kind === 'action'
              ? { kind: 'action' as const, type: step.type, config: step.config }
              : step.kind === 'delay'
                ? { kind: 'delay' as const, minutes: step.minutes }
                : // A guard with no conditions of its own re-checks the rule's,
                  // which is the reading somebody means by "and if it still
                  // matches".
                  { kind: 'guard' as const, conditions: step.conditions },
          ),
        }),
      'Saved. Turn it on when you are ready.',
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
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{row.name}</span>
                  {row.isActive ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>}
                </p>
                <p className="text-small text-secondary">
                  When {TRIGGERS.find((entry) => entry.key === row.trigger)?.label} on a{' '}
                  {labelOf(row.objectKey).toLowerCase()}:{' '}
                  {row.steps.map(summarise).join(', then ')}
                </p>
                <p className="text-small text-secondary tabular-nums">
                  {row.runCount === 0
                    ? 'Has not fired yet'
                    : `Fired ${row.runCount.toLocaleString()} time${row.runCount === 1 ? '' : 's'}, last ${new Date(row.lastRunAt ?? row.createdAt).toLocaleString()}`}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Switch
                  checked={row.isActive}
                  label={row.isActive ? 'On' : 'Off'}
                  onChange={(event) => {
                    const next = event.target.checked
                    void run(
                      () => api.admin.automations.setActive.mutate({ id: row.id, isActive: next }),
                      next ? 'Running from now on.' : 'Stopped.',
                    )
                  }}
                />
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
                    ? `continues ${formatDateTime(entry.resumeAt)}`
                    : formatDateTime(entry.at)}
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
        title={editing === 'new' ? 'New automation' : 'Edit automation'}
        footer={
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>
              Save
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
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
            <ol className="flex flex-col gap-2">
              {steps.map((step, index) => (
                <li
                  key={index}
                  className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-small text-secondary tabular-nums">{index + 1}</span>
                    <Select
                      aria-label={`Step ${index + 1}`}
                      className="w-auto"
                      value={step.kind === 'action' ? step.type : step.kind}
                      onChange={(event) => setSteps(replace(steps, index, kindFrom(event.target.value)))}
                    >
                      <optgroup label="Do">
                        {ACTIONS.map((entry) => (
                          <option key={entry.key} value={entry.key}>
                            {entry.label}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Then">
                        <option value="delay">Wait</option>
                        <option value="guard">Check it still matches</option>
                      </optgroup>
                    </Select>

                    {step.kind === 'delay' ? (
                      <Select
                        aria-label={`How long step ${index + 1} waits`}
                        className="w-auto"
                        value={String(step.minutes)}
                        onChange={(event) =>
                          setSteps(replace(steps, index, { kind: 'delay', minutes: Number(event.target.value) }))
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
                        onClick={() => setSteps(swap(steps, index, index - 1))}
                      />
                      <IconButton
                        label={`Move step ${index + 1} down`}
                        icon={<ACTION_ICONS.moveDown size={16} />}
                        disabled={index === steps.length - 1}
                        onClick={() => setSteps(swap(steps, index, index + 1))}
                      />
                      <IconButton
                        label={`Remove step ${index + 1}`}
                        tone="destructive"
                        icon={<ACTION_ICONS.delete size={16} />}
                        disabled={steps.length === 1}
                        onClick={() => setSteps(steps.filter((_, at) => at !== index))}
                      />
                    </span>
                  </div>

                  {step.kind === 'guard' ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-small text-secondary">
                        Looks at the record again, as it is now, and stops the rule here unless it
                        still matches. This is how a rule waits and then changes its mind. With
                        nothing of its own below, it re-checks the rule&apos;s own conditions.
                      </p>
                      <FilterBuilder
                        key={`${object}-guard-${index}`}
                        fields={filterFieldsByObject[object] ?? []}
                        value={step.conditions}
                        onApply={(next) => setSteps(replace(steps, index, { kind: 'guard', conditions: next }))}
                      />
                    </div>
                  ) : null}

                  {step.kind === 'action' ? (
                    <ActionFields
                      index={index}
                      type={step.type}
                      config={step.config}
                      object={object}
                      people={people}
                      stages={stages}
                      fieldsByObject={fieldsByObject}
                      onChange={(config) => setSteps(replace(steps, index, { ...step, config }))}
                    />
                  ) : null}
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setSteps([...steps, { kind: 'action', type: 'create_task', config: {} }])}>
                Add an action
              </Button>
              <Button onClick={() => setSteps([...steps, { kind: 'delay', minutes: 60 * 24 }])}>
                Add a wait
              </Button>
              <Button onClick={() => setSteps([...steps, { kind: 'guard', conditions: [] }])}>Add a check</Button>
            </div>
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
          <div className="flex gap-2">
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
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
          </div>
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
