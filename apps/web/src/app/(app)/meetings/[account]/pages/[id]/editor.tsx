'use client'

import type { BookingPageConfig, BookingPageStats, FormField, PageHostRow, ReminderUnit } from '@rawr/db'
import {
  Badge,
  Button,
  DiscardConfirm,
  DropdownMenu,
  Field,
  IconButton,
  Select,
  Switch,
  TextArea,
  TextInput,
  buttonClass,
  cn,
  useToast,
} from '@rawr/ui'
import { ChevronDown, ChevronLeft, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, type ReactNode } from 'react'
import {
  BOOKING_MAIL_TOKENS,
  DEFAULT_CONFIRMATION_BODY,
  DEFAULT_CONFIRMATION_SUBJECT,
  DEFAULT_REMINDER_BODY,
  DEFAULT_REMINDER_SUBJECT,
  REMINDER_UNITS,
} from '~/lib/booking-tokens.ts'
import { ACTION_ICONS } from '~/components/icons.ts'
import { SaveBar } from '~/components/save-bar.tsx'
import { useFormat } from '~/components/zone.tsx'
import { availabilityPath, bookedPath, bookingPagesPath, calendarsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'
import { KINDS } from '../pages-table.tsx'
import { EmbedDialog, hostedBookingUrl, useCopy } from '../snippet.tsx'
import { QuestionList, type MappingTarget } from './questions.tsx'
import { TemplatePreview } from './template-preview.tsx'

/** HubSpot's scheduling page editor: back to meetings, the name, Actions and
 *  the public page, then Overview, Scheduling and Automation as tabs over one
 *  form with one save. Nothing here is a wizard: a person changing the buffer
 *  should not have to walk four steps to do it. Which tab is open lives in the
 *  address, so a reload or a pasted link lands on it.
 *
 *  The client checks nothing that matters. Every rule is enforced again in the data
 *  access layer, so a refusal arrives as a sentence rather than the save silently
 *  doing something else. */

type Member = { id: string; label: string }
type HostDraft = { userId: string; weight: number; isRequired: boolean }
type ReminderDraft = { key: string; amount: number; unit: ReminderUnit }
type Draft = { form: BookingPageConfig; questions: FormField[]; hosts: HostDraft[]; reminders: ReminderDraft[] }

const FORM_ID = 'booking-page-editor'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'scheduling', label: 'Scheduling' },
  { key: 'automation', label: 'Automation' },
] as const
type Tab = (typeof TABS)[number]['key']

const LOCATIONS: { value: BookingPageConfig['location']; label: string; hint: string }[] = [
  { value: 'zoom', label: 'Zoom', hint: 'A Zoom meeting is created under the assigned host.' },
  { value: 'google_meet', label: 'Google Meet', hint: 'Google adds a Meet link to the event.' },
  { value: 'phone', label: 'Phone', hint: 'The number below goes on the invitation.' },
  { value: 'custom', label: 'Custom', hint: 'The instructions below go on the invitation.' },
]

/** Which of those can actually produce a link here. A deployment with no Zoom
 *  app and no Google project still offers both, and the booking then confirms
 *  with nowhere to join: the meeting is real and the link is silently absent. */
export type WorkingLocations = { zoom: boolean; google_meet: boolean }

const DARK = 'Not set up here, so a meeting booked this way has no link.'

const DUPLICATE_REMINDER =
  'Two reminders at the same moment would send the same mail twice. Change one of them.'

const numeric = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

const draftOf = (page: BookingPageConfig, hosts: PageHostRow[]): Draft => ({
  form: page,
  questions: page.questions,
  hosts: hosts
    .filter((host) => host.isActive)
    .map((host) => ({ userId: host.userId, weight: host.weight, isRequired: host.isRequired })),
  // Keyed on the stored id rather than on the pair a person is editing: keying
  // on "1 day" makes the row remount the moment the 1 becomes a 2, and the
  // field loses focus mid-keystroke.
  reminders: page.reminders.map((row) => ({ key: row.id, amount: row.amount, unit: row.unit })),
})

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** How many settings differ from what was saved: each field of the page, and
 *  the questions, hosts and reminders as one each. O(fields) per render. */
const countChanges = (draft: Draft, saved: Draft): number => {
  const keys = Object.keys(draft.form) as (keyof BookingPageConfig)[]
  const fields = keys.filter(
    (key) => key !== 'questions' && key !== 'reminders' && !same(draft.form[key], saved.form[key]),
  ).length
  const timings = (rows: ReminderDraft[]) => rows.map(({ amount, unit }) => [amount, unit])
  return (
    fields +
    Number(!same(draft.questions, saved.questions)) +
    Number(!same(draft.hosts, saved.hosts)) +
    Number(!same(timings(draft.reminders), timings(saved.reminders)))
  )
}

const Heading = ({ children }: { children: ReactNode }) => <h2 className="text-xl font-medium">{children}</h2>

/** A switch beside its title and line, in a 16-radius card, as HubSpot's
 *  Automation tab draws Confirmation email and Pre-meeting reminder. */
const SwitchCard = ({
  title,
  line,
  checked,
  disabled,
  onChange,
  children,
}: {
  title: string
  line: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}) => (
  <section className="flex min-w-0 flex-col gap-4 rounded-panel border border-line bg-surface p-5">
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-base font-semibold">{title}</h3>
        <p>{line}</p>
      </div>
      <Switch label={title} hideLabel checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </div>
    {checked ? <div className="flex min-w-0 flex-col gap-3">{children}</div> : null}
  </section>
)

type NumberKey =
  | 'durationMinutes'
  | 'granularityMinutes'
  | 'bufferBeforeMinutes'
  | 'bufferAfterMinutes'
  | 'minNoticeMinutes'
  | 'maxHorizonDays'

export const PageEditor = ({
  account,
  accountSlug,
  baseUrl,
  page,
  hosts,
  members,
  targets,
  working,
  stats,
  editable,
  canPublishShared,
}: {
  account: string
  accountSlug: string
  baseUrl: string
  page: BookingPageConfig
  hosts: PageHostRow[]
  members: Member[]
  targets: MappingTarget[]
  working: WorkingLocations
  stats: BookingPageStats
  editable: boolean
  canPublishShared: boolean
}) => {
  const show = useToast()
  const fmt = useFormat()
  const router = useRouter()
  const copy = useCopy()
  const [tabParam, setTabParam] = useUrlParam('tab')
  const [subParam, setSubParam] = useUrlParam('sub')
  const tab: Tab = TABS.find((each) => each.key === tabParam)?.key ?? 'overview'
  const sub = subParam === 'form' ? 'form' : 'schedule'

  /** The last state the server confirmed. Everything on this screen is local
   *  until Save, so Cancel and the change count are both measured against it. */
  const [saved, setSaved] = useState(() => draftOf(page, hosts))
  const [form, setForm] = useState(saved.form)
  const [questions, setQuestions] = useState(saved.questions)
  const [hostRows, setHostRows] = useState(saved.hosts)
  const [reminders, setReminders] = useState(saved.reminders)
  const [saving, setSaving] = useState(false)
  const [embedding, setEmbedding] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const draft: Draft = { form, questions, hosts: hostRows, reminders }
  const changes = countChanges(draft, saved)

  const set = <K extends keyof BookingPageConfig>(key: K, value: BookingPageConfig[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const reset = () => {
    setForm(saved.form)
    setQuestions(saved.questions)
    setHostRows(saved.hosts)
    setReminders(saved.reminders)
  }

  const hostsById = useMemo(() => new Map(hosts.map((host) => [host.userId, host])), [hosts])
  const collective = form.kind === 'collective'
  const totalWeight = hostRows.reduce((sum, row) => sum + Math.max(1, row.weight), 0)
  const unhealthy = hostRows
    .map((row) => hostsById.get(row.userId))
    .filter((host) => host && host.grantState !== 'connected')

  const available = members.filter((member) => !hostRows.some((row) => row.userId === member.id))

  const duplicateReminder =
    new Set(reminders.map((row) => `${row.unit}:${row.amount}`)).size !== reminders.length

  const hosted = hostedBookingUrl(baseUrl, accountSlug, saved.form.slug)

  const save = async () => {
    // Refused rather than quietly deduplicated: the person asked for two, and a
    // save that silently drops one is a setting that reads back wrong.
    if (duplicateReminder) {
      show('error', DUPLICATE_REMINDER)
      return
    }
    setSaving(true)
    try {
      await api.booking.savePage.mutate({
        id: form.bookingPageId,
        slug: form.slug,
        name: form.name,
        kind: form.kind,
        ownerId: form.ownerId,
        durationMinutes: form.durationMinutes,
        bufferBeforeMinutes: form.bufferBeforeMinutes,
        bufferAfterMinutes: form.bufferAfterMinutes,
        minNoticeMinutes: form.minNoticeMinutes,
        maxHorizonDays: form.maxHorizonDays,
        granularityMinutes: form.granularityMinutes,
        location: form.location,
        locationDetail: form.locationDetail,
        titleTpl: form.titleTpl,
        descriptionTpl: form.descriptionTpl,
        companyFallback: form.companyFallback,
        questions,
        isActive: form.isActive,
        redirectUrl: form.redirectUrl,
        confirmationCopy: form.confirmationCopy,
        confirmationEnabled: form.confirmationEnabled,
        confirmationSubject: form.confirmationSubject,
        confirmationBody: form.confirmationBody,
        reminderSubject: form.reminderSubject,
        reminderBody: form.reminderBody,
        reminders: reminders.map((row) => ({ amount: row.amount, unit: row.unit })),
        ...(form.kind === 'one_on_one' ? {} : { hosts: hostRows }),
      })
      show('success', 'Saved.')
      setSaved(draft)
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const leave = () => router.push(bookingPagesPath(account))

  const numberField = (id: string, label: string, hint: string, key: NumberKey, bounds: { min: number; max: number; fallback: number }) => (
    <Field id={id} label={label} hint={hint}>
      <TextInput
        id={id}
        type="number"
        min={bounds.min}
        max={bounds.max}
        value={form[key]}
        disabled={!editable}
        onChange={(event) => set(key, numeric(event.target.value, bounds.fallback))}
      />
    </Field>
  )

  const overview = (
    <div className="flex min-w-0 flex-col gap-4">
      <Heading>Overview</Heading>
      <Field id="page-kind" label="Meeting type">
        <Select
          id="page-kind"
          value={form.kind}
          disabled={!editable || !canPublishShared}
          onChange={(event) => {
            const kind = event.target.value as BookingPageConfig['kind']
            setForm((current) => ({
              ...current,
              kind,
              // A personal link has exactly one host and that host is its owner,
              // so the two move together rather than leaving a page owned by one
              // person and hosted by another.
              ownerId: kind === 'one_on_one' ? (current.ownerId ?? hostRows[0]?.userId ?? null) : null,
            }))
          }}
        >
          {(Object.keys(KINDS) as BookingPageConfig['kind'][]).map((kind) => (
            <option key={kind} value={kind}>
              {KINDS[kind]}
            </option>
          ))}
        </Select>
      </Field>

      <Field id="page-name" label="Internal name" required>
        <TextInput id="page-name" value={form.name} disabled={!editable} onChange={(event) => set('name', event.target.value)} />
      </Field>

      {form.kind === 'one_on_one' ? (
        <Field
          id="page-owner"
          label="Organizer"
          hint="A personal link has one host, and that host is its owner. Only they and an admin can see or change it."
        >
          <Select
            id="page-owner"
            value={form.ownerId ?? ''}
            disabled={!editable || !canPublishShared}
            onChange={(event) => set('ownerId', event.target.value || null)}
          >
            <option value="">Whoever saves this</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="font-semibold">Team members</h3>
          <p className="text-small">
            {collective
              ? 'Every required host has to be free, and all of them are on the invitation. Adding one makes this page harder to book, not easier.'
              : 'A meeting goes to whoever is furthest behind their share, among the hosts actually free for that time. Weight 2 takes twice as many meetings as weight 1.'}
          </p>

          {hostRows.length === 0 ? (
            <p className="text-secondary">Nobody hosts this page yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {hostRows.map((row) => {
                const host = hostsById.get(row.userId)
                const label =
                  host?.name ?? members.find((member) => member.id === row.userId)?.label ?? row.userId
                const share = totalWeight > 0 ? Math.round((row.weight / totalWeight) * 100) : 0
                return (
                  <li key={row.userId} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                    {host && host.grantState !== 'connected' ? (
                      <Badge tone="error" dot>
                        {host.grantState === 'unconfigured' ? 'no calendar' : host.grantState}
                      </Badge>
                    ) : (
                      <span className="text-small text-secondary">{host?.timezone ?? 'no hours set'}</span>
                    )}

                    {collective ? (
                      <Select
                        id={`page-host-required-${row.userId}`}
                        aria-label={`Whether ${label} has to be free`}
                        value={row.isRequired ? 'required' : 'optional'}
                        className="w-28"
                        disabled={!editable}
                        onChange={(event) =>
                          setHostRows((current) =>
                            current.map((existing) =>
                              existing.userId === row.userId
                                ? { ...existing, isRequired: event.target.value === 'required' }
                                : existing,
                            ),
                          )
                        }
                      >
                        <option value="required">Required</option>
                        <option value="optional">Optional</option>
                      </Select>
                    ) : (
                      <>
                        {/* What the number means, next to the number. A bare
                            weight of 2 tells nobody what share it buys. */}
                        <span
                          className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-fill"
                          role="img"
                          aria-label={`${share}% of meetings`}
                          title={`${share}% of meetings`}
                        >
                          <span className="block h-full bg-cta" style={{ width: `${share}%` }} />
                        </span>
                        <label className="flex items-center gap-1 text-small">
                          Weight
                          <TextInput
                            type="number"
                            min={1}
                            max={100}
                            value={row.weight}
                            disabled={!editable}
                            className="w-16"
                            onChange={(event) =>
                              setHostRows((current) =>
                                current.map((existing) =>
                                  existing.userId === row.userId
                                    ? { ...existing, weight: numeric(event.target.value, 1) }
                                    : existing,
                                ),
                              )
                            }
                          />
                        </label>
                      </>
                    )}

                    <IconButton
                      label={`Remove ${label} as a host`}
                      tone="destructive"
                      icon={<ACTION_ICONS.delete size={16} />}
                      disabled={!editable}
                      onClick={() => setHostRows((current) => current.filter((existing) => existing.userId !== row.userId))}
                    />
                  </li>
                )
              })}
            </ul>
          )}

          {editable && available.length > 0 ? (
            <Select
              id="page-add-host"
              aria-label="Add a host"
              value=""
              onChange={(event) => {
                const userId = event.target.value
                if (!userId) return
                setHostRows((current) => [...current, { userId, weight: 1, isRequired: true }])
              }}
            >
              <option value="">Add a host…</option>
              {available.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.label}
                </option>
              ))}
            </Select>
          ) : null}

          {collective && hostRows.length > 0 && !hostRows.some((row) => row.isRequired) ? (
            <p className="text-error">
              A group page needs at least one required host, or there is nothing to intersect and it
              offers no times at all.
            </p>
          ) : null}

          {unhealthy.length > 0 ? (
            <p className="text-error">
              {unhealthy.length === 1
                ? 'One host has no working calendar, so no times are offered for them. A host with no calendar is treated as unavailable, never as free.'
                : `${unhealthy.length} hosts have no working calendar, so no times are offered for them.`}
            </p>
          ) : null}
        </div>
      )}

      <Field
        id="page-title-tpl"
        label="Event title"
        required
        hint="A variable that resolves to nothing is left out, and a title never ends with a dangling separator."
      >
        <TextInput id="page-title-tpl" value={form.titleTpl} disabled={!editable} onChange={(event) => set('titleTpl', event.target.value)} />
      </Field>

      <Field
        id="page-location"
        label="Location"
        hint={
          working[form.location as keyof WorkingLocations] === false
            ? DARK
            : (LOCATIONS.find((option) => option.value === form.location)?.hint ?? '')
        }
      >
        <Select
          id="page-location"
          value={form.location}
          disabled={!editable}
          onChange={(event) => set('location', event.target.value as BookingPageConfig['location'])}
        >
          {LOCATIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
              {working[option.value as keyof WorkingLocations] === false ? ' (not set up)' : ''}
            </option>
          ))}
        </Select>
      </Field>

      {form.location === 'phone' || form.location === 'custom' ? (
        <Field
          id="page-location-detail"
          label={form.location === 'phone' ? 'Number to call' : 'Joining instructions'}
          required
        >
          <TextInput
            id="page-location-detail"
            value={form.locationDetail ?? ''}
            disabled={!editable}
            onChange={(event) => set('locationDetail', event.target.value)}
          />
        </Field>
      ) : null}

      <Field id="page-description-tpl" label="Description">
        <TextArea
          id="page-description-tpl"
          rows={4}
          value={form.descriptionTpl}
          disabled={!editable}
          onChange={(event) => set('descriptionTpl', event.target.value)}
        />
      </Field>

      <Field
        id="page-company-fallback"
        label="When the company is unknown, call it"
        required
        hint="Used in place of the company name so a title is never left half-finished"
      >
        <TextInput
          id="page-company-fallback"
          value={form.companyFallback}
          disabled={!editable}
          onChange={(event) => set('companyFallback', event.target.value)}
        />
      </Field>
    </div>
  )

  const scheduling = (
    <div className="flex min-w-0 flex-col gap-4">
      <Heading>Scheduling</Heading>
      <Field id="page-slug" label="Scheduling page link" required hint={hostedBookingUrl(baseUrl, accountSlug, form.slug)}>
        <TextInput id="page-slug" value={form.slug} disabled={!editable} onChange={(event) => set('slug', event.target.value)} />
      </Field>

      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-semibold">Taking bookings</h3>
          <p>While this is off the page offers no times and its link says so.</p>
          {form.isActive && hostRows.length === 0 ? (
            <p className="text-error">A page with no hosts cannot be published. Add a host on Overview.</p>
          ) : null}
        </div>
        <Switch
          label="Taking bookings"
          hideLabel
          checked={form.isActive}
          disabled={!editable || (form.kind !== 'one_on_one' && !canPublishShared)}
          onChange={(event) => set('isActive', event.target.checked)}
        />
      </div>

      <div role="tablist" aria-label="Scheduling" className="flex min-w-0 border-b border-line">
        {(['schedule', 'form'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={sub === key}
            onClick={() => setSubParam(key === 'schedule' ? null : key)}
            className={cn(
              'flex min-h-12 items-center px-7 text-body transition-colors duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] first:rounded-tl-hs last:rounded-tr-hs',
              sub === key ? 'bg-surface font-medium' : 'bg-fill font-normal hover:bg-fill-hover',
            )}
          >
            {key === 'schedule' ? 'Schedule' : 'Form'}
          </button>
        ))}
      </div>

      {sub === 'schedule' ? (
        <div className="flex min-w-0 flex-col gap-4">
          {numberField('page-duration', 'Duration', 'Minutes the meeting runs for', 'durationMinutes', { min: 5, max: 1440, fallback: 30 })}
          <div className="min-w-0">
            <h3 className="font-semibold">Availability</h3>
            <p>
              Times come from each host&apos;s own working hours, set once for every page they host, under{' '}
              <Link href={availabilityPath(account)}>My hours</Link>.
            </p>
          </div>
          <details className="group min-w-0 border-t border-line pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold">
              <ChevronDown aria-hidden="true" className="size-4 -rotate-90 transition-transform duration-150 group-open:rotate-0" />
              Additional settings
            </summary>
            <div className="mt-4 flex min-w-0 flex-col gap-4">
              {numberField('page-horizon', 'When a meeting can be scheduled', 'Days ahead a visitor can book', 'maxHorizonDays', { min: 1, max: 365, fallback: 60 })}
              {numberField('page-notice', 'Minimum notice time', 'Minutes from now before the first offered slot. 240 is four hours.', 'minNoticeMinutes', { min: 0, max: 43200, fallback: 240 })}
              <div className="grid min-w-0 gap-4 @lg:grid-cols-2">
                {numberField('page-buffer-before', 'Buffer time before', 'Minutes kept free ahead of a meeting', 'bufferBeforeMinutes', { min: 0, max: 480, fallback: 0 })}
                {numberField('page-buffer-after', 'Buffer time after', 'Minutes kept free after a meeting', 'bufferAfterMinutes', { min: 0, max: 480, fallback: 0 })}
              </div>
              {numberField('page-granularity', 'Start time increment', "Minutes between offered start times, measured from the host's own midnight", 'granularityMinutes', { min: 5, max: 1440, fallback: 30 })}
            </div>
          </details>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold">Questions</h3>
            <p className="text-small">
              Name and work email are always asked. Anything here is asked as well, and an answer mapped
              to a field lands on the contact or the company.
            </p>
          </div>
          <QuestionList questions={questions} onChange={setQuestions} editable={editable} targets={targets} />
          <div className="flex min-w-0 flex-col gap-4 border-t border-line pt-4">
            <h3 className="text-base font-semibold">After booking</h3>
            <Field id="page-confirmation" label="Confirmation message" hint="Shown on the page once the meeting is booked">
              <TextArea
                id="page-confirmation"
                rows={2}
                value={form.confirmationCopy ?? ''}
                disabled={!editable}
                onChange={(event) => set('confirmationCopy', event.target.value)}
              />
            </Field>
            <Field id="page-redirect" label="Or send them to" hint="A full URL. Left empty, the confirmation is shown in place.">
              <TextInput
                id="page-redirect"
                type="url"
                placeholder="https://"
                value={form.redirectUrl ?? ''}
                disabled={!editable}
                onChange={(event) => set('redirectUrl', event.target.value)}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  )

  const automation = (
    <div className="flex min-w-0 flex-col gap-4">
      <Heading>Automation</Heading>
      <p className="text-small">
        Sent from the host&apos;s own connected mailbox, never a colleague&apos;s. With none that can send,
        nothing goes out and the host is told. The calendar invitation is separate and always goes.
      </p>

      <SwitchCard
        title="Confirmation email"
        line="Send a confirmation email to attendees as soon as they book."
        checked={form.confirmationEnabled}
        disabled={!editable}
        onChange={(checked) => set('confirmationEnabled', checked)}
      >
        <Field id="page-confirmation-subject" label="Subject">
          <TextInput
            id="page-confirmation-subject"
            value={form.confirmationSubject ?? ''}
            placeholder={DEFAULT_CONFIRMATION_SUBJECT}
            disabled={!editable}
            onChange={(event) => set('confirmationSubject', event.target.value)}
          />
        </Field>
        <Field id="page-confirmation-body" label="Email" hint="Left empty, the wording below the fields is used.">
          <TextArea
            id="page-confirmation-body"
            rows={8}
            value={form.confirmationBody ?? ''}
            placeholder={DEFAULT_CONFIRMATION_BODY}
            disabled={!editable}
            onChange={(event) => set('confirmationBody', event.target.value)}
          />
        </Field>
      </SwitchCard>

      <SwitchCard
        title="Pre-meeting reminder"
        line="Send an email reminder to attendees before a meeting starts."
        checked={reminders.length > 0}
        disabled={!editable}
        onChange={(checked) => setReminders(checked ? [{ key: crypto.randomUUID(), amount: 1, unit: 'day' }] : [])}
      >
        <p className="text-small">
          Each one is sent once per meeting. A reminder added after somebody booked still reaches them, as
          long as the meeting has not started.
        </p>
        <ul className="flex flex-col gap-2">
          {reminders.map((row) => (
            <li key={row.key} className="flex flex-wrap items-center gap-2">
              <TextInput
                type="number"
                min={1}
                max={365}
                aria-label="How many"
                className="w-20"
                value={row.amount}
                disabled={!editable}
                onChange={(event) =>
                  setReminders((current) =>
                    current.map((each) => (each.key === row.key ? { ...each, amount: numeric(event.target.value, 1) } : each)),
                  )
                }
              />
              <Select
                aria-label="Unit"
                className="w-36"
                value={row.unit}
                disabled={!editable}
                onChange={(event) =>
                  setReminders((current) =>
                    current.map((each) => (each.key === row.key ? { ...each, unit: event.target.value as ReminderUnit } : each)),
                  )
                }
              >
                {REMINDER_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                    {row.amount === 1 ? '' : 's'} before
                  </option>
                ))}
              </Select>
              <IconButton
                label={`Remove the ${row.amount} ${row.unit} reminder`}
                tone="destructive"
                icon={<ACTION_ICONS.delete size={16} />}
                disabled={!editable}
                onClick={() => setReminders((current) => current.filter((each) => each.key !== row.key))}
              />
            </li>
          ))}
        </ul>
        {editable ? (
          <Button
            type="button"
            className="self-start"
            onClick={() => setReminders((current) => [...current, { key: crypto.randomUUID(), amount: 1, unit: 'day' }])}
          >
            + Add reminder
          </Button>
        ) : null}
        {duplicateReminder ? <p className="text-error">{DUPLICATE_REMINDER}</p> : null}
        <Field id="page-reminder-subject" label="Subject">
          <TextInput
            id="page-reminder-subject"
            value={form.reminderSubject ?? ''}
            placeholder={DEFAULT_REMINDER_SUBJECT}
            disabled={!editable}
            onChange={(event) => set('reminderSubject', event.target.value)}
          />
        </Field>
        <Field id="page-reminder-body" label="Email" hint="Left empty, the wording below the fields is used.">
          <TextArea
            id="page-reminder-body"
            rows={8}
            value={form.reminderBody ?? ''}
            placeholder={DEFAULT_REMINDER_BODY}
            disabled={!editable}
            onChange={(event) => set('reminderBody', event.target.value)}
          />
        </Field>
      </SwitchCard>

      <p className="text-small text-secondary">
        Anything that resolves to nothing is left out rather than printed. Available:{' '}
        {BOOKING_MAIL_TOKENS.map((token) => `{{ ${token} }}`).join(' · ')}
      </p>
    </div>
  )

  return (
    <form
      id={FORM_ID}
      className="mx-auto flex w-full max-w-[80rem] min-w-0 flex-col gap-6 pb-28"
      onSubmit={(event) => {
        event.preventDefault()
        if (editable && !saving) void save()
      }}
    >
      <header className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <button
              type="button"
              onClick={() => (changes > 0 ? setLeaving(true) : leave())}
              className="inline-flex items-center gap-0.5 self-start text-small font-semibold text-body hover:underline"
            >
              <ChevronLeft aria-hidden="true" className="size-3.5" />
              Back to meetings
            </button>
            <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-xl font-medium">
              <span className="min-w-0 break-words">{saved.form.name}</span>
              <Badge tone="neutral">{KINDS[saved.form.kind]}</Badge>
              {saved.form.isActive ? null : <Badge tone="neutral">Off</Badge>}
            </h1>
            <p className="text-small text-secondary">
              Last {stats.sinceDays} days: {fmt.number(stats.views)} {stats.views === 1 ? 'view' : 'views'},{' '}
              {fmt.number(stats.booked)} booked
              {/* Nought per cent and "nobody has opened it yet" are different answers. */}
              {stats.conversion === null ? '' : `, ${stats.conversion}% of views`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu
              label="Actions"
              align="end"
              groups={[
                {
                  key: 'share',
                  items: [
                    { key: 'copy', label: 'Copy link', onSelect: () => void copy(hosted, 'Link') },
                    { key: 'embed', label: 'Embed', onSelect: () => setEmbedding(true) },
                  ],
                },
                {
                  key: 'go',
                  items: [
                    { key: 'booked', label: 'Booked meetings', href: bookedPath(account, { page: page.bookingPageId }) },
                    { key: 'hours', label: 'My hours', href: availabilityPath(account) },
                    { key: 'calendars', label: 'Calendar connections', href: calendarsPath(account) },
                  ],
                },
              ]}
              trigger={(props) => (
                <button {...props} type="button" className={buttonClass('secondary', 'gap-1')}>
                  Actions
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </button>
              )}
            />
            <a href={hosted} target="_blank" rel="noreferrer" className={buttonClass('primary', 'no-underline')}>
              Open page
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </div>
        </div>
        <div role="tablist" aria-label="Scheduling page" className="scroll-fade-x flex min-w-0 overflow-x-auto border-b border-line">
          {TABS.map((each) => (
            <button
              key={each.key}
              type="button"
              role="tab"
              aria-selected={tab === each.key}
              onClick={() => setTabParam(each.key === 'overview' ? null : each.key)}
              className={cn(
                'relative flex h-12 shrink-0 items-center rounded-hs px-7 whitespace-nowrap text-body transition-colors duration-150 ease-out hover:bg-fill',
                tab === each.key
                  ? 'font-medium after:absolute after:inset-x-3 after:bottom-0 after:h-1 after:rounded-[24px] after:bg-body'
                  : 'font-normal',
              )}
            >
              {each.label}
            </button>
          ))}
        </div>
      </header>

      <div className="grid min-w-0 gap-10 @4xl:grid-cols-[minmax(0,35rem)_minmax(0,1fr)]">
        <div className="min-w-0">{tab === 'overview' ? overview : tab === 'scheduling' ? scheduling : automation}</div>
        {tab === 'overview' ? (
          <aside className="min-w-0 @4xl:sticky @4xl:top-4 @4xl:self-start">
            <TemplatePreview
              titleTpl={form.titleTpl}
              descriptionTpl={form.descriptionTpl}
              companyFallback={form.companyFallback}
              pageName={form.name}
              durationMinutes={form.durationMinutes}
            />
          </aside>
        ) : null}
      </div>

      <SaveBar form={FORM_ID} changes={editable ? changes : 0} busy={saving} onCancel={reset} />
      <EmbedDialog
        baseUrl={baseUrl}
        account={accountSlug}
        page={embedding ? { name: saved.form.name, slug: saved.form.slug } : null}
        onClose={() => setEmbedding(false)}
      />
      {leaving ? <DiscardConfirm onKeep={() => setLeaving(false)} onDiscard={leave} /> : null}
    </form>
  )
}
