'use client'

import type { BookingPageConfig, FormField, PageHostRow } from '@rawr/db'
import { Button, Field, IconButton, Select, TextArea, TextInput, useToast } from '@rawr/ui'
import { useMemo, useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { BookingLinkSnippet } from '../snippet.tsx'
import { QuestionList, type MappingTarget } from './questions.tsx'
import { TemplatePreview } from './template-preview.tsx'

/** Everything about a page, editable in one form with one save. Nothing here is a
 *  wizard: a person changing the buffer should not have to walk four steps to do it.
 *
 *  The client checks nothing that matters. Every rule is enforced again in the data
 *  access layer, so a refusal arrives as a sentence rather than the save silently
 *  doing something else. */

type Member = { id: string; label: string }

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

const numeric = (value: string, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

export const PageEditor = ({
  account,
  accountSlug,
  baseUrl,
  page,
  hosts,
  members,
  targets,
  working,
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
  editable: boolean
  canPublishShared: boolean
}) => {
  const show = useToast()
  const [form, setForm] = useState(page)
  const [questions, setQuestions] = useState<FormField[]>(page.questions)
  const [hostRows, setHostRows] = useState(
    hosts
      .filter((host) => host.isActive)
      .map((host) => ({ userId: host.userId, weight: host.weight, isRequired: host.isRequired })),
  )
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof BookingPageConfig>(key: K, value: BookingPageConfig[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const hostsById = useMemo(() => new Map(hosts.map((host) => [host.userId, host])), [hosts])
  const collective = form.kind === 'collective'
  const totalWeight = hostRows.reduce((sum, row) => sum + Math.max(1, row.weight), 0)
  const unhealthy = hostRows
    .map((row) => hostsById.get(row.userId))
    .filter((host) => host && host.grantState !== 'connected')

  const available = members.filter(
    (member) => !hostRows.some((row) => row.userId === member.id),
  )

  const save = async () => {
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
        ...(form.kind === 'one_on_one' ? {} : { hosts: hostRows }),
      })
      show('success', 'Saved.')
    } catch (cause) {
      show('error', errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-medium">
            {form.kind === 'one_on_one'
              ? 'Personal link'
              : form.kind === 'collective'
                ? 'Shared collective'
                : 'Shared round robin'}
          </h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isActive}
              disabled={!editable || (form.kind !== 'one_on_one' && !canPublishShared)}
              onChange={(event) => set('isActive', event.target.checked)}
            />
            Taking bookings
          </label>
          {form.isActive && hostRows.length === 0 ? (
            <span className="text-sm text-error">
              A page with no hosts cannot be published. Add a host below.
            </span>
          ) : null}
          <Button
            variant="primary"
            type="button"
            className="ml-auto"
            busy={saving}
            disabled={!editable}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="page-name" label="Name" required>
            <TextInput
              id="page-name"
              value={form.name}
              disabled={!editable}
              onChange={(event) => set('name', event.target.value)}
            />
          </Field>

          <Field
            id="page-slug"
            label="Public link"
            required
            hint={`${baseUrl}/b/${accountSlug}/${form.slug}`}
          >
            <TextInput
              id="page-slug"
              value={form.slug}
              disabled={!editable}
              onChange={(event) => set('slug', event.target.value)}
            />
          </Field>

          <Field id="page-duration" label="Length" hint="Minutes the meeting runs for">
            <TextInput
              id="page-duration"
              type="number"
              min={5}
              max={1440}
              value={form.durationMinutes}
              disabled={!editable}
              onChange={(event) => set('durationMinutes', numeric(event.target.value, 30))}
            />
          </Field>

          <Field
            id="page-granularity"
            label="Offer times every"
            hint="Minutes between offered start times, measured from the host's own midnight"
          >
            <TextInput
              id="page-granularity"
              type="number"
              min={5}
              max={1440}
              value={form.granularityMinutes}
              disabled={!editable}
              onChange={(event) => set('granularityMinutes', numeric(event.target.value, 30))}
            />
          </Field>

          <Field id="page-buffer-before" label="Clear time before" hint="Minutes kept free ahead of a meeting">
            <TextInput
              id="page-buffer-before"
              type="number"
              min={0}
              max={480}
              value={form.bufferBeforeMinutes}
              disabled={!editable}
              onChange={(event) => set('bufferBeforeMinutes', numeric(event.target.value, 0))}
            />
          </Field>

          <Field id="page-buffer-after" label="Clear time after" hint="Minutes kept free after a meeting">
            <TextInput
              id="page-buffer-after"
              type="number"
              min={0}
              max={480}
              value={form.bufferAfterMinutes}
              disabled={!editable}
              onChange={(event) => set('bufferAfterMinutes', numeric(event.target.value, 0))}
            />
          </Field>

          <Field
            id="page-notice"
            label="Shortest notice"
            hint="Minutes from now before the first offered slot. 240 is four hours."
          >
            <TextInput
              id="page-notice"
              type="number"
              min={0}
              max={43200}
              value={form.minNoticeMinutes}
              disabled={!editable}
              onChange={(event) => set('minNoticeMinutes', numeric(event.target.value, 240))}
            />
          </Field>

          <Field id="page-horizon" label="Book up to" hint="Days ahead">
            <TextInput
              id="page-horizon"
              type="number"
              min={1}
              max={365}
              value={form.maxHorizonDays}
              disabled={!editable}
              onChange={(event) => set('maxHorizonDays', numeric(event.target.value, 60))}
            />
          </Field>

          <Field
            id="page-location"
            label="Where"
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
              onChange={(event) =>
                set('location', event.target.value as BookingPageConfig['location'])
              }
            >
              {LOCATIONS.map((option) => {
                const dark = working[option.value as keyof WorkingLocations] === false
                return (
                  <option key={option.value} value={option.value}>
                    {option.label}
                    {dark ? ' — not set up' : ''}
                  </option>
                )
              })}
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
        </div>
      </section>

      {form.kind !== 'one_on_one' ? (
        <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">Hosts</h2>
            {editable ? (
              <Select
                id="page-kind"
                aria-label="How hosts are combined"
                value={form.kind}
                className="w-36"
                onChange={(event) => set('kind', event.target.value as BookingPageConfig['kind'])}
              >
                <option value="round_robin">Round robin</option>
                <option value="collective">Collective</option>
              </Select>
            ) : null}
          </div>

          <p className="mb-3 text-xs text-secondary">
            {collective
              ? 'Every required host has to be free, and all of them are on the invitation. Adding one makes this page harder to book, not easier.'
              : 'A meeting goes to whoever is furthest behind their share, among the hosts actually free for that time. Weight 2 takes twice as many meetings as weight 1.'}
          </p>

          {hostRows.length === 0 ? (
            <p className="text-sm text-secondary">Nobody hosts this page yet.</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-2">
              {hostRows.map((row) => {
                const host = hostsById.get(row.userId)
                const label =
                  host?.name ?? members.find((member) => member.id === row.userId)?.label ?? row.userId
                const share = totalWeight > 0 ? Math.round((row.weight / totalWeight) * 100) : 0
                return (
                  <li key={row.userId} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                    {host && host.grantState !== 'connected' ? (
                      <span className="rounded-hs bg-error-subtle px-1.5 py-0.5 text-xs text-error">
                        {host.grantState === 'unconfigured' ? 'no calendar' : host.grantState}
                      </span>
                    ) : (
                      <span className="text-xs text-secondary">{host?.timezone ?? 'no hours set'}</span>
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
                        <label className="flex items-center gap-1 text-xs">
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
                      onClick={() =>
                        setHostRows((current) =>
                          current.filter((existing) => existing.userId !== row.userId),
                        )
                      }
                    />
                  </li>
                )
              })}
            </ul>
          )}

          {editable && available.length > 0 ? (
            <Select
              id="page-add-host"
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
            <p className="mt-3 text-sm text-error">
              A collective page needs at least one required host, or there is nothing to intersect
              and it offers no times at all.
            </p>
          ) : null}

          {unhealthy.length > 0 ? (
            <p className="mt-3 text-sm text-error">
              {unhealthy.length === 1
                ? 'One host has no working calendar, so no times are offered for them. A host with no calendar is treated as unavailable, never as free.'
                : `${unhealthy.length} hosts have no working calendar, so no times are offered for them.`}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
        <h2 className="mb-1 font-medium">What lands on the calendar</h2>
        <p className="mb-3 text-xs text-secondary">
          A variable that resolves to nothing is left out, and a title never ends with a dangling
          separator.
        </p>

        <div className="grid gap-3">
          <Field id="page-title-tpl" label="Event title" required>
            <TextInput
              id="page-title-tpl"
              value={form.titleTpl}
              disabled={!editable}
              onChange={(event) => set('titleTpl', event.target.value)}
            />
          </Field>

          <Field id="page-description-tpl" label="Event description">
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

        <TemplatePreview
          titleTpl={form.titleTpl}
          descriptionTpl={form.descriptionTpl}
          companyFallback={form.companyFallback}
          pageName={form.name}
          durationMinutes={form.durationMinutes}
        />
      </section>

      <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
        <h2 className="mb-1 font-medium">Questions</h2>
        <p className="mb-3 text-xs text-secondary">
          Name and work email are always asked. Anything here is asked as well, and an answer mapped
          to a field lands on the contact or the company.
        </p>
        <QuestionList
          questions={questions}
          onChange={setQuestions}
          editable={editable}
          targets={targets}
        />
      </section>

      <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
        <h2 className="mb-1 font-medium">After booking</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="page-confirmation"
            label="Confirmation message"
            hint="Shown on the page once the meeting is booked"
          >
            <TextArea
              id="page-confirmation"
              rows={2}
              value={form.confirmationCopy ?? ''}
              disabled={!editable}
              onChange={(event) => set('confirmationCopy', event.target.value)}
            />
          </Field>

          <Field
            id="page-redirect"
            label="Or send them to"
            hint="A full URL. Left empty, the confirmation is shown in place."
          >
            <TextInput
              id="page-redirect"
              value={form.redirectUrl ?? ''}
              disabled={!editable}
              onChange={(event) => set('redirectUrl', event.target.value)}
            />
          </Field>
        </div>

        <div className="mt-3">
          <BookingLinkSnippet baseUrl={baseUrl} account={accountSlug} slug={form.slug} />
        </div>
      </section>

      <div className="flex justify-end">
        <Button
          variant="primary"
          type="button"
          busy={saving}
          disabled={!editable}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <p className="text-xs text-secondary">
        Working hours are per person, not per page. Set yours under{' '}
        <a href={`/meetings/${account}/availability`}>My hours</a>.
      </p>
    </div>
  )
}
