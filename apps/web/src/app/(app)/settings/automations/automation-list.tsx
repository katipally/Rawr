'use client'

import { Alert, Badge, Button, EmptyState, Field, IconButton, Modal, Select, Switch, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Trigger = 'record_created' | 'stage_changed' | 'lifecycle_changed' | 'form_submitted'
type ActionType = 'set_field' | 'set_lifecycle' | 'assign_owner' | 'create_task' | 'notify_slack'
type ObjectKey = 'contact' | 'company' | 'deal'

export type AutomationRowView = {
  id: string
  name: string
  isActive: boolean
  trigger: Trigger
  objectKey: ObjectKey
  actions: { type: ActionType; config: Record<string, unknown> }[]
  runCount: number
  lastRunAt: string | null
  createdAt: string
}

export type RunView = {
  id: string
  automationName: string
  entityType: string
  entityId: string
  state: 'done' | 'skipped' | 'failed'
  detail: string | null
  at: string
}

export type AutomationListProps = {
  rows: AutomationRowView[]
  runs: RunView[]
  people: { id: string; name: string }[]
  stages: string[]
  fieldsByObject: Record<ObjectKey, string[]>
}

/** The words a person uses, against the words the enum uses. */
const TRIGGERS: { key: Trigger; label: string; objects: ObjectKey[] }[] = [
  { key: 'record_created', label: 'a record is created', objects: ['contact', 'company', 'deal'] },
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

const OBJECT_LABEL: Record<ObjectKey, string> = { contact: 'Contact', company: 'Company', deal: 'Deal' }

const STATE_TONE = { done: 'ok', skipped: 'neutral', failed: 'error' } as const

export const AutomationList = ({ rows, runs, people, stages, fieldsByObject }: AutomationListProps) => {
  const router = useRouter()
  const toast = useToast()
  const [editing, setEditing] = useState<AutomationRowView | 'new' | null>(null)
  const [removing, setRemoving] = useState<AutomationRowView | null>(null)
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState<Trigger>('record_created')
  const [object, setObject] = useState<ObjectKey>('contact')
  const [actionType, setActionType] = useState<ActionType>('create_task')
  const [config, setConfig] = useState<Record<string, string>>({})

  const allowedObjects = TRIGGERS.find((entry) => entry.key === trigger)?.objects ?? ['contact']

  const openNew = () => {
    setName('')
    setTrigger('record_created')
    setObject('contact')
    setActionType('create_task')
    setConfig({})
    setEditing('new')
  }

  const openEdit = (row: AutomationRowView) => {
    setName(row.name)
    setTrigger(row.trigger)
    setObject(row.objectKey)
    const first = row.actions[0]
    setActionType(first?.type ?? 'create_task')
    setConfig(
      Object.fromEntries(Object.entries(first?.config ?? {}).map(([key, value]) => [key, String(value ?? '')])),
    )
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
          conditions: [],
          // One action for now, on purpose: the engine runs a list in order and
          // this screen writes a list of one. A second action is a row in this
          // form, not a change to anything behind it.
          actions: [{ type: actionType, config }],
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
                  {OBJECT_LABEL[row.objectKey].toLowerCase()}:{' '}
                  {row.actions.map((action) => ACTIONS.find((a) => a.key === action.type)?.label).join(', ')}
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
        <h3 className="font-medium">What they did</h3>
        {runs.length === 0 ? (
          <p className="text-secondary">Nothing has fired yet.</p>
        ) : (
          <ul className="flex flex-col rounded-panel border border-line bg-surface">
            {runs.slice(0, 50).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-divider px-3 py-1.5 last:border-0">
                <Badge tone={STATE_TONE[entry.state]}>{entry.state}</Badge>
                <span className="font-medium">{entry.automationName}</span>
                <span className="text-secondary">{entry.detail}</span>
                <span className="ml-auto text-small text-secondary tabular-nums">
                  {new Date(entry.at).toLocaleString()}
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
                const objects = TRIGGERS.find((entry) => entry.key === next)?.objects ?? ['contact']
                if (!objects.includes(object)) setObject(objects[0] as ObjectKey)
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
              onChange={(event) => setObject(event.target.value as ObjectKey)}
            >
              {allowedObjects.map((key) => (
                <option key={key} value={key}>
                  {OBJECT_LABEL[key]}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="automation-action" label="Do">
            <Select
              id="automation-action"
              value={actionType}
              onChange={(event) => {
                setActionType(event.target.value as ActionType)
                setConfig({})
              }}
            >
              {ACTIONS.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>

          {actionType === 'set_field' ? (
            <>
              <Field id="automation-field" label="Field">
                <Select
                  id="automation-field"
                  value={config.field ?? ''}
                  onChange={(event) => setConfig({ ...config, field: event.target.value })}
                >
                  <option value="">Pick one</option>
                  {(fieldsByObject[object] ?? []).map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="automation-value" label="To">
                <TextInput
                  id="automation-value"
                  value={config.value ?? ''}
                  onChange={(event) => setConfig({ ...config, value: event.target.value })}
                />
              </Field>
            </>
          ) : null}

          {actionType === 'set_lifecycle' ? (
            <Field id="automation-stage" label="Stage">
              <Select
                id="automation-stage"
                value={config.stage ?? ''}
                onChange={(event) => setConfig({ ...config, stage: event.target.value })}
              >
                <option value="">Pick one</option>
                {stages.map((stage) => (
                  <option key={stage} value={stage}>
                    {stage}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {actionType === 'assign_owner' ? (
            <Field id="automation-owner" label="Owner">
              <Select
                id="automation-owner"
                value={config.userId ?? ''}
                onChange={(event) => setConfig({ ...config, userId: event.target.value })}
              >
                <option value="">Pick one</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {actionType === 'create_task' ? (
            <>
              <Field id="automation-title" label="Task title" hint="{{name}} becomes the record's name.">
                <TextInput
                  id="automation-title"
                  value={config.title ?? ''}
                  placeholder="Follow up on {{name}}"
                  onChange={(event) => setConfig({ ...config, title: event.target.value })}
                />
              </Field>
              <Field id="automation-due" label="Due in days" hint="Leave empty for no due date.">
                <TextInput
                  id="automation-due"
                  inputMode="numeric"
                  value={config.dueInDays ?? ''}
                  onChange={(event) => setConfig({ ...config, dueInDays: event.target.value })}
                />
              </Field>
            </>
          ) : null}

          {actionType === 'notify_slack' ? (
            <>
              <Field id="automation-message" label="Message" hint="{{name}} becomes the record's name.">
                <TextInput
                  id="automation-message"
                  value={config.message ?? ''}
                  placeholder="{{name}} reached Proposal"
                  onChange={(event) => setConfig({ ...config, message: event.target.value })}
                />
              </Field>
              <Field id="automation-channel" label="Channel" hint="Leave empty for the integration's default.">
                <TextInput
                  id="automation-channel"
                  value={config.channel ?? ''}
                  onChange={(event) => setConfig({ ...config, channel: event.target.value })}
                />
              </Field>
            </>
          ) : null}

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
