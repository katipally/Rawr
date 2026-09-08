'use client'

import type { SequenceRow, SequenceStep, StepKind, VariantResult } from '@rawr/db'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  Combobox,
  Field,
  IconButton,
  Select,
  SidePanel,
  Switch,
  TextArea,
  TextInput,
  cn,
  useToast,
} from '@rawr/ui'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { enrollmentsPath, sequencesPath } from '~/lib/links.ts'
import { RichTextInput } from '~/components/crm/rich-text-input.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

type Draft = SequenceStep & { key: string }

type Template = { id: string; name: string; subject: string; bodyText: string }

const KIND_LABEL: Record<StepKind, string> = {
  email: 'Send an email',
  call: 'Make a call',
  linkedin: 'Message on LinkedIn',
  task: 'Do something else',
}

/** Every merge field a template may use. Deliberately short: a template that could
 *  read any field would be a way to put anything in the CRM into a stranger's
 *  inbox. */
const MERGE_FIELDS = [
  { value: '{{first_name|there}}', label: 'First name, or “there”' },
  { value: '{{last_name}}', label: 'Last name' },
  { value: '{{full_name}}', label: 'Full name' },
  { value: '{{company}}', label: 'Company' },
  { value: '{{email}}', label: 'Their email' },
  { value: '{{sender_email}}', label: 'Your email' },
]

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
]

/** A stable key for a step that has no id yet, so React does not remount the row
 *  a person is typing into every time the list re-renders. */
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

let keyCounter = 0
const newKey = (): string => {
  keyCounter += 1
  return `step-${keyCounter}`
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
  const [steps, setSteps] = useState<Draft[]>(initial.map((step) => ({ ...step, key: newKey() })))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState(sequence.settings)
  const [sender, setSender] = useState(sequence.sender)
  const [campaigns, setCampaigns] = useState<{ id: number; name: string; status: string }[] | null>(null)
  const [busy, setBusy] = useState(false)

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

  const addStep = (kind: StepKind) =>
    setSteps((current) => [
      ...current,
      {
        key: newKey(),
        id: '',
        position: current.length,
        kind,
        // A first step goes as soon as the window allows; a later one waits two
        // days, which is the gap most people want and nobody wants to type.
        delayDays: current.length === 0 ? 0 : 2,
        delayHours: 0,
        subject: kind === 'email' ? '' : null,
        subjectB: null,
        bodyHtml: null,
        bodyText: kind === 'email' ? '' : null,
        taskTitle: kind === 'email' ? null : KIND_LABEL[kind],
        taskBody: null,
      },
    ])

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
      <Breadcrumb items={[{ label: 'Sequences', href: sequencesPath(account) }, { label: sequence.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-medium">
            {sequence.name}
            <Badge tone={sequence.state === 'active' ? 'ok' : sequence.state === 'paused' ? 'warn' : 'neutral'} dot>
              {sequence.state}
            </Badge>
          </h1>
          {sequence.description ? <p className="text-secondary">{sequence.description}</p> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={enrollmentsPath(account, sequence.id)} className="font-medium">
            {sequence.stats.active} in flight
          </Link>
          {canWrite ? (
            <>
              <Button onClick={() => setSettingsOpen(true)}>Settings</Button>
              {sequence.state === 'active' ? (
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
            </>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          { label: 'Sent', value: sequence.stats.sent },
          { label: 'Opened', value: sequence.stats.opened },
          { label: 'Clicked', value: sequence.stats.clicked },
          { label: 'Replied', value: sequence.stats.replied },
          { label: 'Bounced', value: sequence.stats.bounced },
        ].map((tile) => (
          <Card key={tile.label}>
            <p className="text-small text-secondary">{tile.label}</p>
            <p className="text-lg tabular-nums">{tile.value}</p>
          </Card>
        ))}
      </div>

      {sender === 'woodpecker' ? (
        <Card title="Woodpecker owns the steps">
          <p className="text-secondary">
            This sequence hands each contact to Woodpecker campaign{' '}
            {settings.woodpeckerCampaignId ?? 'nobody has picked yet'}, once. The steps, the delays
            and the sending accounts are Woodpecker's; what comes back here are its events, on the
            contact's timeline. Pick the campaign in settings.
          </p>
        </Card>
      ) : null}

      <div className={cn('flex flex-col gap-3', sender === 'woodpecker' && 'hidden')}>
        {steps.map((step, index) => (
          <Card
            key={step.key}
            title={`${index + 1}. ${KIND_LABEL[step.kind]}`}
            action={
              canWrite ? (
                <>
                  <IconButton
                    label="Move up"
                    icon={<ArrowUp className="size-4" />}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <IconButton
                    label="Move down"
                    icon={<ArrowDown className="size-4" />}
                    disabled={index === steps.length - 1}
                    onClick={() => move(index, 1)}
                  />
                  <IconButton
                    label="Remove this step"
                    tone="destructive"
                    icon={<Trash2 className="size-4" />}
                    onClick={() => setSteps((current) => current.filter((row) => row.key !== step.key))}
                  />
                </>
              ) : null
            }
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Wait" id={`${step.key}-days`} hint={index === 0 ? 'Before the first one goes out.' : 'After the step above.'}>
                  <div className="flex items-center gap-2">
                    <TextInput
                      id={`${step.key}-days`}
                      inputMode="numeric"
                      className="w-16"
                      disabled={!canWrite}
                      value={String(step.delayDays)}
                      onChange={(event) => patch(step.key, { delayDays: Number(event.target.value.replaceAll(/\D/g, '') || 0) })}
                    />
                    <span className="text-secondary">days</span>
                    <TextInput
                      aria-label="Hours"
                      inputMode="numeric"
                      className="w-16"
                      disabled={!canWrite}
                      value={String(step.delayHours)}
                      onChange={(event) =>
                        patch(step.key, { delayHours: Math.min(23, Number(event.target.value.replaceAll(/\D/g, '') || 0)) })
                      }
                    />
                    <span className="text-secondary">hours</span>
                  </div>
                </Field>
              </div>

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
                    <div className="flex flex-wrap gap-1">
                      {MERGE_FIELDS.map((field) => (
                        <Button
                          key={field.value}
                          variant="tertiary"
                          onClick={() => patch(step.key, { bodyText: `${step.bodyText ?? ''}${field.value}` })}
                        >
                          {field.label}
                        </Button>
                      ))}
                    </div>
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
          </Card>
        ))}

        {steps.length === 0 ? (
          <Card>
            <p className="text-secondary">No steps yet. The first one is usually an email.</p>
          </Card>
        ) : null}

        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => addStep('email')}>Add an email</Button>
            <Button onClick={() => addStep('call')}>Add a call</Button>
            <Button onClick={() => addStep('linkedin')}>Add a LinkedIn step</Button>
            <Button onClick={() => addStep('task')}>Add something else</Button>
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
            <Button onClick={() => setSettingsOpen(false)}>Close</Button>
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
              Wall-clock time in the timezone below, so it does not drift when the clocks change.
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
              label="Stop when they unsubscribe"
              disabled={!canWrite}
              checked={settings.stopOnUnsubscribe}
              onChange={(event) => setSettings({ ...settings, stopOnUnsubscribe: event.target.checked })}
            />
            <Combobox
              label="Which opt-out this counts as"
              value={settings.subscriptionTypeId}
              disabled={!canWrite}
              onChange={(subscriptionTypeId) => setSettings({ ...settings, subscriptionTypeId })}
              hint="Somebody who has opted out of this is never enrolled, and unsubscribing here opts them out of it."
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
