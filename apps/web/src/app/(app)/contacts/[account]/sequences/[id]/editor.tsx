'use client'

import type { SequenceRow, SequenceStep, StepKind, VariantResult } from '@rawr/db'
import {
  Button,
  Card,
  Checkbox,
  Combobox,
  DropdownMenu,
  Field,
  Select,
  SidePanel,
  Switch,
  TextArea,
  TextInput,
  cn,
  useToast,
} from '@rawr/ui'
import { ChevronDown, GripVertical, ListTodo, Mail, MessageSquare, Phone, Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { MergeFieldPicker } from '~/components/crm/merge-fields.tsx'
import { RichTextInput } from '~/components/crm/rich-text-input.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'
import { rowPill } from '~/components/row-actions.tsx'
import { STEP_KIND_LABEL } from '~/components/crm/value.tsx'
import { SequenceActions } from '../sequence-actions.tsx'
import { SequenceHeader } from './sequence-header.tsx'

type Draft = SequenceStep & { key: string }

type Template = { id: string; name: string; subject: string; bodyText: string }


const KIND_ICON: Record<StepKind, ReactNode> = {
  email: <Mail aria-hidden="true" className="size-4" />,
  call: <Phone aria-hidden="true" className="size-4" />,
  linkedin: <MessageSquare aria-hidden="true" className="size-4" />,
  task: <ListTodo aria-hidden="true" className="size-4" />,
}

const STEP_KINDS: StepKind[] = ['email', 'call', 'linkedin', 'task']

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
]

/** Every zone this runtime knows, with the one currently saved guaranteed to be
 *  among them. `supportedValuesOf` omits UTC in several runtimes, and a select
 *  whose value matches no option silently displays the first one: pressing Save
 *  would then move somebody's sending window to Africa/Abidjan without them
 *  touching it. */
const timezones = (current: string): string[] => {
  const known = Intl.supportedValuesOf?.('timeZone') ?? []
  const all = known.length > 0 ? known : ['UTC']
  return all.includes(current) ? all : [current, ...all]
}

export const SequenceEditor = ({
  account,
  sequence,
  steps: initial,
  variants,
  subscriptionTypes,
  canWrite,
}: {
  account: string
  sequence: SequenceRow
  steps: SequenceStep[]
  /** How each tested subject actually did, when a step is testing two. */
  variants: VariantResult[]
  subscriptionTypes: { id: string; name: string }[]
  canWrite: boolean
}) => {
  const router = useRouter()
  const toast = useToast()
  const [steps, setSteps] = useState<Draft[]>(initial.map((step) => ({ ...step, key: step.id })))
  /** A stable key for a step that has no id yet, so React does not remount the row
   *  a person is typing into every time the list re-renders. Per editor, so server and
   *  client render the same ids. */
  const newStepCount = useRef(0)
  // In the address so a HubSpot settings link, a reload or a pasted link opens it.
  const [settingsParam, setSettingsParam] = useUrlParam('settings')
  const settingsOpen = settingsParam === 'open'
  const setSettingsOpen = (open: boolean) => setSettingsParam(open ? 'open' : null)
  const [settings, setSettings] = useState(sequence.settings)
  const [sender, setSender] = useState(sequence.sender)
  const [campaigns, setCampaigns] = useState<{ id: number; name: string; status: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)

  // Fetched when the panel opens on a Woodpecker sequence, not on every render of
  // a Gmail one: the list is a call to Woodpecker and most sequences never need it.
  useEffect(() => {
    if (!settingsOpen || sender !== 'woodpecker' || campaigns) return
    let live = true
    void api.integrations.woodpeckerCampaigns
      .query()
      .then((rows) => {
        if (live) setCampaigns(rows)
      })
      .catch((cause: unknown) => {
        if (live) {
          setCampaigns([])
          toast('error', errorMessage(cause))
        }
      })
    return () => {
      live = false
    }
  }, [settingsOpen, sender, campaigns, toast])

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      router.refresh()
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const patch = (key: string, next: Partial<Draft>) =>
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...next } : step)))

  const move = (index: number, by: number) =>
    setSteps((current) => {
      const next = [...current]
      const target = index + by
      if (target < 0 || target >= next.length) return current
      const [moved] = next.splice(index, 1)
      if (moved) next.splice(target, 0, moved)
      return next
    })

  const addStep = (kind: StepKind, at: number) => {
    newStepCount.current += 1
    const key = `new-${newStepCount.current}`
    setSteps((current) => [
      ...current.slice(0, at),
      {
        key,
        id: '',
        position: at,
        kind,
        // A first step goes as soon as the window allows; a later one waits two
        // days, which is the gap most people want and nobody wants to type.
        delayDays: at === 0 ? 0 : 2,
        delayHours: 0,
        subject: kind === 'email' ? '' : null,
        subjectB: null,
        bodyHtml: null,
        bodyText: kind === 'email' ? '' : null,
        taskTitle: kind === 'email' ? null : STEP_KIND_LABEL[kind],
        taskBody: null,
      },
      ...current.slice(at),
    ])
  }

  const saveSteps = () =>
    run(
      () =>
        api.sequences.saveSteps.mutate({
          sequenceId: sequence.id,
          steps: steps.map((step) => ({
            id: step.id || null,
            kind: step.kind,
            delayDays: step.delayDays,
            delayHours: step.delayHours,
            subject: step.subject,
            subjectB: step.subjectB,
            bodyHtml: step.bodyHtml,
            bodyText: step.bodyText,
            taskTitle: step.taskTitle,
            taskBody: step.taskBody,
          })),
        }),
      'Saved.',
    )

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SequenceHeader
        account={account}
        sequence={sequence}
        current="steps"
        actions={
          canWrite ? (
            <>
              <Button onClick={() => setSettingsOpen(true)}>Settings</Button>
              {sequence.state === 'archived' ? null : sequence.state === 'active' ? (
                <Button
                  busy={busy}
                  onClick={() =>
                    void run(
                      () => api.sequences.setState.mutate({ id: sequence.id, state: 'paused' }),
                      'Paused. Nothing more goes out until you turn it back on.',
                    )
                  }
                >
                  Pause
                </Button>
              ) : (
                <Button
                  variant="primary"
                  busy={busy}
                  onClick={() =>
                    void run(
                      () => api.sequences.setState.mutate({ id: sequence.id, state: 'active' }),
                      'On. Anybody enrolled starts on the next tick.',
                    )
                  }
                >
                  Turn on
                </Button>
              )}
              <SequenceActions account={account} sequence={sequence} />
            </>
          ) : null
        }
      />

      <dl className="grid grid-cols-2 gap-y-4 rounded-panel border border-line p-4 @lg:grid-cols-3 @6xl:grid-cols-6">
        {[
          { label: 'In flight', value: sequence.stats.active },
          { label: 'Sent', value: sequence.stats.sent },
          { label: 'Opened', value: sequence.stats.opened },
          { label: 'Clicked', value: sequence.stats.clicked },
          { label: 'Replied', value: sequence.stats.replied },
          { label: 'Bounced', value: sequence.stats.bounced },
        ].map((tile) => (
          <div key={tile.label} className="flex min-w-0 flex-col items-center gap-1 text-center">
            <dt className="text-small font-semibold uppercase">{tile.label}</dt>
            <dd className="text-xl font-medium tabular-nums">{tile.value}</dd>
          </div>
        ))}
      </dl>

      {sender === 'woodpecker' ? (
        <Card title="Woodpecker owns the steps">
          <p className="text-secondary">
            This sequence hands each contact to{' '}
            {settings.woodpeckerCampaignId === null
              ? 'a Woodpecker campaign'
              : `Woodpecker campaign ${campaigns?.find((campaign) => campaign.id === settings.woodpeckerCampaignId)?.name ?? settings.woodpeckerCampaignId}`}
            , once. The steps, the delays and the sending accounts are Woodpecker's; what comes back
            here are its events, on the contact's timeline.
            {settings.woodpeckerCampaignId === null ? ' No campaign is picked yet. Pick the campaign in settings.' : null}
          </p>
        </Card>
      ) : null}

      <div className={cn('mx-auto flex w-full max-w-3xl min-w-0 flex-col', sender === 'woodpecker' && 'hidden')}>
        {steps.map((step, index) => (
          <div key={step.key} className="flex min-w-0 flex-col">
            <Connector canWrite={canWrite} onAdd={(kind) => addStep(kind, index)}>
              <span className="text-secondary">{index === 0 ? 'Wait before the first one' : 'Wait'}</span>
              <TextInput
                aria-label={`Days before step ${index + 1}`}
                inputMode="numeric"
                className="w-14"
                disabled={!canWrite}
                value={String(step.delayDays)}
                onChange={(event) => patch(step.key, { delayDays: Number(event.target.value.replaceAll(/\D/g, '') || 0) })}
              />
              <span className="text-secondary">days</span>
              <TextInput
                aria-label={`Hours before step ${index + 1}`}
                inputMode="numeric"
                className="w-14"
                disabled={!canWrite}
                value={String(step.delayHours)}
                onChange={(event) =>
                  patch(step.key, { delayHours: Math.min(23, Number(event.target.value.replaceAll(/\D/g, '') || 0)) })
                }
              />
              <span className="text-secondary">hours</span>
            </Connector>
            {/* A drop target for the grip. Dragging is the pointer shortcut; Move up
                and Move down in the step's Actions are the way a keyboard does it. */}
            <section
              aria-label={`Step ${index + 1}`}
              onDragOver={(event) => {
                if (dragging !== null) event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null) move(dragging, index - dragging)
                setDragging(null)
              }}
              className={cn(
                'min-w-0 overflow-hidden rounded-panel border border-line bg-surface shadow-panel',
                dragging === index && 'opacity-60',
              )}
            >
              <div className="flex min-w-0 items-center gap-2 border-b border-line bg-fill px-3 py-2">
                {canWrite ? (
                  // biome-ignore lint/a11y/noStaticElementInteractions: the grip is the pointer's shortcut; Actions is the keyboard's
                  <span
                    draggable
                    onDragStart={(event) => {
                      setDragging(index)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDragging(null)}
                    title="Drag to move"
                    className="flex shrink-0 cursor-grab text-secondary"
                  >
                    <GripVertical aria-hidden="true" className="size-4" />
                  </span>
                ) : null}
                <span className="flex shrink-0">{KIND_ICON[step.kind]}</span>
                <h2 className="min-w-0 flex-1 truncate font-semibold">
                  {index + 1}. {STEP_KIND_LABEL[step.kind]}
                </h2>
                {canWrite ? (
                  <DropdownMenu
                    label={`Actions for step ${index + 1}`}
                    groups={[
                      {
                        key: 'move',
                        items: [
                          { key: 'up', label: 'Move up', disabled: index === 0, onSelect: () => move(index, -1) },
                          { key: 'down', label: 'Move down', disabled: index === steps.length - 1, onSelect: () => move(index, 1) },
                        ],
                      },
                      {
                        key: 'remove',
                        items: [
                          {
                            key: 'delete',
                            label: 'Delete',
                            destructive: true,
                            onSelect: () => setSteps((current) => current.filter((row) => row.key !== step.key)),
                          },
                        ],
                      },
                    ]}
                    trigger={(props) => (
                      <button {...props} type="button" className={rowPill}>
                        Actions
                        <ChevronDown aria-hidden="true" className="size-3" />
                      </button>
                    )}
                  />
                ) : null}
              </div>
              <div className="flex min-w-0 flex-col gap-3 p-4">
              {step.kind === 'email' ? (
                <>
                  {canWrite ? (
                    <TemplatePicker
                      onPick={(template) =>
                        patch(step.key, {
                          // The step takes its own copy. Editing the template
                          // afterwards must not rewrite outreach already running.
                          subject: template.subject || step.subject || '',
                          bodyText: template.bodyText,
                        })
                      }
                    />
                  ) : null}
                  <Field
                    label={step.subjectB === null ? 'Subject' : 'Subject A'}
                    id={`${step.key}-subject`}
                    required
                  >
                    <TextInput
                      id={`${step.key}-subject`}
                      disabled={!canWrite}
                      value={step.subject ?? ''}
                      onChange={(event) => patch(step.key, { subject: event.target.value })}
                    />
                  </Field>
                  {step.subjectB !== null && step.id ? (
                    <VariantResults results={variants.filter((each) => each.stepId === step.id)} />
                  ) : null}
                  {step.subjectB === null ? (
                    canWrite ? (
                      <div>
                        <Button variant="tertiary" onClick={() => patch(step.key, { subjectB: '' })}>
                          Test a second subject
                        </Button>
                      </div>
                    ) : null
                  ) : (
                    <Field
                      label="Subject B"
                      id={`${step.key}-subject-b`}
                      hint="Half the contacts get this line instead. Which one a contact gets never changes, even if the step is retried."
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <TextInput
                            id={`${step.key}-subject-b`}
                            disabled={!canWrite}
                            value={step.subjectB ?? ''}
                            onChange={(event) => patch(step.key, { subjectB: event.target.value })}
                          />
                        </div>
                        {canWrite ? (
                          <Button variant="tertiary" onClick={() => patch(step.key, { subjectB: null })}>
                            Stop testing
                          </Button>
                        ) : null}
                      </div>
                    </Field>
                  )}
                  <Field
                    label="Message"
                    id={`${step.key}-body`}
                    hint="Merge fields go in double braces. Give one a fallback, like {{first_name|there}}, or a contact without it is refused rather than sent “Hi ,”."
                  >
                    <RichTextInput
                      id={`${step.key}-body`}
                      label="Message"
                      className="min-h-48"
                      disabled={!canWrite}
                      value={step.bodyText ?? ''}
                      onChange={(next) => patch(step.key, { bodyText: next })}
                    />
                  </Field>
                  {canWrite ? (
                    <MergeFieldPicker
                      onInsert={(token) => patch(step.key, { bodyText: `${step.bodyText ?? ''}${token}` })}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <Field label="What to do" id={`${step.key}-task`} required>
                    <TextInput
                      id={`${step.key}-task`}
                      disabled={!canWrite}
                      value={step.taskTitle ?? ''}
                      onChange={(event) => patch(step.key, { taskTitle: event.target.value })}
                    />
                  </Field>
                  <Field label="Notes" id={`${step.key}-task-body`} hint="Optional.">
                    <TextArea
                      id={`${step.key}-task-body`}
                      disabled={!canWrite}
                      value={step.taskBody ?? ''}
                      onChange={(event) => patch(step.key, { taskBody: event.target.value })}
                    />
                  </Field>
                  <p className="text-small text-secondary">
                    The sequence waits here. Completing the task is what moves it on.
                  </p>
                </>
              )}
              </div>
            </section>
          </div>
        ))}

        {steps.length === 0 ? (
          <Card>
            <p className="text-secondary">No steps yet. The first one is usually an email.</p>
          </Card>
        ) : null}

        <Connector canWrite={canWrite} onAdd={(kind) => addStep(kind, steps.length)} />

        {canWrite ? (
          <div className="sticky bottom-0 flex justify-end border-t border-line bg-surface py-3">
            <Button variant="primary" busy={busy} onClick={() => void saveSteps()}>
              Save steps
            </Button>
          </div>
        ) : null}
      </div>

      <SidePanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={`${sequence.name} settings`}
        footer={
          <>
            <Button
              variant="primary"
              busy={busy}
              onClick={() =>
                void run(
                  () => api.sequences.save.mutate({ id: sequence.id, name: sequence.name, sender, settings }),
                  'Saved.',
                ).then((ok) => ok && setSettingsOpen(false))
              }
            >
              Save
            </Button>
            <Button onClick={() => setSettingsOpen(false)}>Close</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field
            id="sequence-sender"
            label="Who sends it"
            hint="Gmail sends from the enroller's own mailbox, one step at a time. Woodpecker takes the contact and runs its own campaign."
          >
            <Select
              id="sequence-sender"
              disabled={!canWrite}
              value={sender}
              onChange={(event) => setSender(event.target.value === 'woodpecker' ? 'woodpecker' : 'gmail')}
            >
              <option value="gmail">Gmail, from the enroller's mailbox</option>
              <option value="woodpecker">Woodpecker</option>
            </Select>
          </Field>

          {sender === 'woodpecker' ? (
            <Field
              id="sequence-campaign"
              label="Woodpecker campaign"
              hint="Where a contact is handed to. Nothing is sent until one is picked."
            >
              <Select
                id="sequence-campaign"
                disabled={!canWrite || campaigns === null}
                value={settings.woodpeckerCampaignId === null ? '' : String(settings.woodpeckerCampaignId)}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    woodpeckerCampaignId: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              >
                <option value="">
                  {campaigns === null
                    ? 'Reading the campaign list…'
                    : campaigns.length === 0
                      ? 'No campaigns, or Woodpecker is not connected'
                      : 'Pick a campaign'}
                </option>
                {(campaigns ?? []).map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name} ({campaign.status.toLowerCase()})
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <fieldset className={cn('flex flex-col gap-2', sender === 'woodpecker' && 'hidden')}>
            <legend className="font-medium">When it may send</legend>
            <p className="text-small text-secondary">
              Wall-clock time in the timezone below, so it does not drift when the clocks change. A mailbox
              that has its own send window uses that one instead of this.
            </p>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((day) => (
                <Checkbox
                  key={day.value}
                  label={day.label}
                  disabled={!canWrite}
                  checked={settings.sendWindow.days.includes(day.value)}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      sendWindow: {
                        ...settings.sendWindow,
                        days: event.target.checked
                          ? [...settings.sendWindow.days, day.value].sort()
                          : settings.sendWindow.days.filter((value) => value !== day.value),
                      },
                    })
                  }
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <Field label="From" id="window-start">
                <TextInput
                  id="window-start"
                  type="time"
                  disabled={!canWrite}
                  value={settings.sendWindow.start}
                  onChange={(event) =>
                    setSettings({ ...settings, sendWindow: { ...settings.sendWindow, start: event.target.value } })
                  }
                />
              </Field>
              <Field label="Until" id="window-end">
                <TextInput
                  id="window-end"
                  type="time"
                  disabled={!canWrite}
                  value={settings.sendWindow.end}
                  onChange={(event) =>
                    setSettings({ ...settings, sendWindow: { ...settings.sendWindow, end: event.target.value } })
                  }
                />
              </Field>
              <Field label="Timezone" id="window-tz">
                <Select
                  id="window-tz"
                  disabled={!canWrite}
                  value={settings.sendWindow.timezone}
                  onChange={(event) =>
                    setSettings({ ...settings, sendWindow: { ...settings.sendWindow, timezone: event.target.value } })
                  }
                >
                  {timezones(settings.sendWindow.timezone).map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">When it stops</legend>
            <Switch
              label="Stop when they reply"
              hint="Read from the mailbox that sent it, so it stops on the sync that reads the reply."
              disabled={!canWrite}
              checked={settings.stopOnReply}
              onChange={(event) => setSettings({ ...settings, stopOnReply: event.target.checked })}
            />
            <Switch
              label="Stop when it bounces"
              disabled={!canWrite}
              checked={settings.stopOnBounce}
              onChange={(event) => setSettings({ ...settings, stopOnBounce: event.target.checked })}
            />
            <Switch
              label="Stop right away when they unsubscribe"
              hint="Off: they stop when their next step is due, and nothing is sent first. Either way, nothing more goes to someone who has opted out."
              disabled={!canWrite}
              checked={settings.stopOnUnsubscribe}
              onChange={(event) => setSettings({ ...settings, stopOnUnsubscribe: event.target.checked })}
            />
            <Combobox
              label="Which opt-out this counts as"
              value={settings.subscriptionTypeId}
              disabled={!canWrite}
              onChange={(subscriptionTypeId) => setSettings({ ...settings, subscriptionTypeId })}
              hint="Someone who has opted out of this type is never enrolled. Unsubscribing, from a mail or on their record, opts them out of it."
              options={subscriptionTypes.map((type) => ({ value: type.id, label: type.name }))}
            />
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium">What it measures</legend>
            <Switch
              label="Count opens"
              hint="A one-pixel image. Apple Mail loads it for everybody, so opens read high."
              disabled={!canWrite}
              checked={settings.trackOpens}
              onChange={(event) => setSettings({ ...settings, trackOpens: event.target.checked })}
            />
            <Switch
              label="Count clicks"
              hint="Links go through a redirect that records the click and sends them on."
              disabled={!canWrite}
              checked={settings.trackClicks}
              onChange={(event) => setSettings({ ...settings, trackClicks: event.target.checked })}
            />
            <Switch
              label="Keep it in one conversation"
              hint="Later steps reply to the first, so the recipient sees one thread rather than five mails."
              disabled={!canWrite}
              checked={settings.replyInThread}
              onChange={(event) => setSettings({ ...settings, replyInThread: event.target.checked })}
            />
          </fieldset>
        </div>
      </SidePanel>
    </div>
  )
}

/** The line between two steps: the wait before the step under it, and the
 *  round + that puts a new step in at that point. */
const Connector = ({
  canWrite,
  onAdd,
  children,
}: {
  canWrite: boolean
  onAdd: (kind: StepKind) => void
  children?: ReactNode
}) => (
  <div className="flex min-w-0 flex-col items-center">
    <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
    {canWrite ? (
      <DropdownMenu
        label="Choose step"
        groups={[
          {
            key: 'kinds',
            items: STEP_KINDS.map((kind) => ({ key: kind, label: STEP_KIND_LABEL[kind], onSelect: () => onAdd(kind) })),
          },
        ]}
        trigger={(props) => (
          <button
            {...props}
            type="button"
            aria-label="Add a step here"
            className="flex size-6 items-center justify-center rounded-pill border border-line-strong bg-surface transition-all duration-150 ease-out hover:bg-fill"
          >
            <Plus aria-hidden="true" className="size-3.5" />
          </button>
        )}
      />
    ) : null}
    {children ? (
      <>
        <span aria-hidden="true" className="h-2 w-px bg-line-strong" />
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-2 text-small">{children}</div>
      </>
    ) : null}
    <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
  </div>
)

/** Dropping a saved email into a step.
 *
 *  A copy, not a link: the step keeps the words, so editing the template later
 *  leaves every sequence already sending it alone. Somebody who wanted the change
 *  everywhere would be surprised by that; somebody whose live outreach silently
 *  rewrote itself would be worse off. */
const TemplatePicker = ({ onPick }: { onPick: (template: Template) => void }) => {
  const toast = useToast()
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [open, setOpen] = useState(false)

  // Fetched when the picker is first opened, not on every step on page load: a
  // sequence with six steps would otherwise ask six times for the same list.
  const load = () => {
    setOpen(true)
    if (templates) return
    void api.sequences.templates.list
      .query()
      .then((rows) => setTemplates(rows.map((row) => ({ id: row.id, name: row.name, subject: row.subject, bodyText: row.bodyText }))))
      .catch((cause) => {
        toast('error', errorMessage(cause))
        setOpen(false)
      })
  }

  if (!open) {
    return (
      <div>
        <Button variant="tertiary" onClick={load}>
          Use a template
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Combobox
          label="Template"
          hint="Replaces what is written below."
          value={null}
          onChange={(id) => {
            const found = templates?.find((row) => row.id === id)
            if (found) {
              onPick(found)
              setOpen(false)
            }
          }}
          options={(templates ?? []).map((row) => ({ value: row.id, label: row.name, hint: row.subject || undefined }))}
        />
        <Button variant="tertiary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {templates?.length === 0 ? (
        <p className="text-small text-secondary">
          Nothing saved yet. Write one under Templates and it appears here.
        </p>
      ) : null}
    </div>
  )
}

/** How the two subjects did against each other.
 *
 *  Shown as counts beside a rate, because "50% opened" out of two sends is not a
 *  finding, and a reader who cannot see the denominator cannot tell. No winner is
 *  declared: with the numbers a sequence produces, that would be arithmetic
 *  dressed up as significance. */
const VariantResults = ({ results }: { results: VariantResult[] }) => {
  if (results.length === 0) return null
  const rate = (part: number, whole: number) => (whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`)

  return (
    <div className="rounded-hs border border-line bg-fill px-3 py-2">
      <table className="w-full text-small tabular-nums">
        <thead>
          <tr className="text-secondary">
            <th className="text-left font-normal">Subject</th>
            <th className="text-right font-normal">Sent</th>
            <th className="text-right font-normal">Opened</th>
            <th className="text-right font-normal">Replied</th>
          </tr>
        </thead>
        <tbody>
          {['a', 'b'].map((letter) => {
            const found = results.find((each) => each.variant === letter)
            return (
              <tr key={letter}>
                <td className="text-left">{letter.toUpperCase()}</td>
                <td className="text-right">{found?.sent ?? 0}</td>
                <td className="text-right">
                  {rate(found?.opened ?? 0, found?.sent ?? 0)} ({found?.opened ?? 0})
                </td>
                <td className="text-right">
                  {rate(found?.replied ?? 0, found?.sent ?? 0)} ({found?.replied ?? 0})
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
