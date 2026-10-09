'use client'

import type { Schedule } from '@rawr/db'
import { scheduleProblem, windowProblem } from '@rawr/db/slots'
import { Button, clockLabel, Field, IconButton, Select, TextInput, TimeField, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useMemo, useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { SaveBar } from '~/components/save-bar.tsx'
import { todayIn } from '~/lib/format.ts'
import { useFormat, useZone } from '~/components/zone.tsx'
import { bookingPagesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { LeaveGuard } from '~/components/leave-guard.tsx'
import { DAY_GROUPS, toWeekly, toWindows, weeklyHours, windowsChanged, type DayGroup, type Ranges, type Window } from './windows.ts'

/** Weekly hours as HubSpot's availability window rows, plus one-off overrides.
 *
 *  Times here are wall-clock rules in the named timezone, not instants, which is
 *  what keeps nine in the morning at nine through a daylight-saving change. The
 *  timezone is chosen from the browser's own list rather than a curated one, so
 *  nobody is missing from it. */

const FORM_ID = 'weekly-hours'

const newKey = () => crypto.randomUUID()

/** Node and the browser ship different ICU data, so this list differs between the
 *  two sides of a render. Read on the client only, after mount. */
const zones = (): string[] => {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    if (supported) return supported('timeZone')
  } catch {
    // Older engines do not expose the list. The stored value is still shown and
    // still saved, so nobody is locked out of their own setting.
  }
  return []
}

export const ScheduleEditor = ({
  schedule,
  editable,
  isSelf,
  hostedPages,
  account,
}: {
  schedule: Schedule
  editable: boolean
  isSelf: boolean
  hostedPages: { id: string; name: string; isActive: boolean }[]
  account: string
}) => {
  const show = useToast()
  const router = useRouter()
  const fmt = useFormat()
  const zone = useZone()
  /** Row ids come from the list position, not the row key: the keys are random, so
   *  the server and the first client render would disagree on every time field's id. */
  const rowIds = useId()
  /** The last hours the server confirmed. Windows keep their keys across edits, so
   *  a change is counted per window rather than per day. */
  const [saved, setSaved] = useState(() => ({
    timezone: schedule.timezone,
    rows: toWindows(schedule.weekly as Ranges, newKey),
  }))
  const [timezone, setTimezone] = useState(saved.timezone)
  const [rows, setRows] = useState<Window[]>(saved.rows)
  const [saving, setSaving] = useState(false)
  const weekly = useMemo(() => toWeekly(rows), [rows])
  const problem = useMemo(() => scheduleProblem(weekly), [weekly])
  const changes = Number(timezone !== saved.timezone) + windowsChanged(rows, saved.rows)

  const [overrideDay, setOverrideDay] = useState(() => todayIn(zone))
  const [overrideKind, setOverrideKind] = useState<'off' | 'hours'>('off')
  // A list, not a pair: the column is a jsonb array and the reader below already
  // renders every block, so a morning and an afternoon with a gap between them
  // was storable and displayable but not enterable.
  const [overrideBlocks, setOverrideBlocks] = useState<[string, string][]>([['09:00', '13:00']])
  const [overrideNote, setOverrideNote] = useState('')
  const overrideProblem =
    overrideKind === 'hours' ? windowProblem(`The override for ${overrideDay}`, overrideBlocks) : null

  // Empty on the server: enumerating zones there produced a different list from
  // the browser's, and React discards the tree over the mismatch. The stored value
  // is rendered on its own below, so the select is correct before this arrives.
  const [zoneList, setZoneList] = useState<string[]>([])
  useEffect(() => setZoneList(zones()), [])
  const totalHours = useMemo(() => weeklyHours(weekly), [weekly])

  const setRow = (key: string, change: Partial<Window>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)))

  const save = async () => {
    if (problem) return
    setSaving(true)
    try {
      await api.booking.saveSchedule.mutate({
        ...(isSelf ? {} : { userId: schedule.userId }),
        timezone,
        // A day with no rows is left out of the map rather than stored as an
        // empty list: the two mean the same thing.
        weekly,
      })
      show('success', 'Saved. New times are offered from the next page load.')
      setSaved({ timezone, rows })
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const addOverride = async () => {
    if (overrideProblem) return
    try {
      await api.booking.saveOverride.mutate({
        ...(isSelf ? {} : { userId: schedule.userId }),
        day: overrideDay,
        isUnavailable: overrideKind === 'off',
        blocks: overrideKind === 'off' ? [] : overrideBlocks,
        note: overrideNote.trim() || null,
      })
      show('success', 'Saved.')
      setOverrideNote('')
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    }
  }

  const clearOverride = async (day: string) => {
    try {
      await api.booking.clearOverride.mutate({ ...(isSelf ? {} : { userId: schedule.userId }), day })
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-28">
      <form
        id={FORM_ID}
        className="flex max-w-[35rem] min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (editable && !saving) void save()
        }}
      >
        <Field
          id="schedule-timezone"
          label="Time zone"
          required
          hint="Hours are kept in this zone, so nine in the morning stays nine when the clocks change."
        >
          <Select
            id="schedule-timezone"
            value={timezone}
            disabled={!editable}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {/* The stored value first, so it is never dropped from the list on an
                engine that cannot enumerate zones. */}
            <option value={timezone}>{timezone}</option>
            {zoneList
              .filter((zone) => zone !== timezone)
              .map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
          </Select>
        </Field>

        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="font-semibold">Availability window</h2>
          {rows.length === 0 ? <p className="text-secondary">Not working any day, so nothing is offered.</p> : null}
          <ul className="flex min-w-0 flex-col gap-2">
            {rows.map((row, index) => {
              const label = DAY_GROUPS.find((group) => group.value === row.days)?.label ?? ''
              return (
                <li key={row.key} className="flex min-w-0 flex-wrap items-center gap-2">
                  <Select
                    aria-label="Days"
                    value={row.days}
                    disabled={!editable}
                    className="w-36"
                    onChange={(event) => setRow(row.key, { days: event.target.value as DayGroup })}
                  >
                    {DAY_GROUPS.map((group) => (
                      <option key={group.value} value={group.value}>
                        {group.label}
                      </option>
                    ))}
                  </Select>
                  <span>from</span>
                  <TimeField
                    id={`${rowIds}-${index}-from`}
                    aria-label={`${label} start`}
                    locale={fmt.locale}
                    value={row.from}
                    disabled={!editable}
                    className="w-auto"
                    onChange={(value) => setRow(row.key, { from: value })}
                  />
                  <span>to</span>
                  <TimeField
                    id={`${rowIds}-${index}-to`}
                    aria-label={`${label} end`}
                    locale={fmt.locale}
                    value={row.to}
                    disabled={!editable}
                    className="w-auto"
                    onChange={(value) => setRow(row.key, { to: value })}
                  />
                  <IconButton
                    label={`Remove ${label} ${row.from} to ${row.to}`}
                    tone="destructive"
                    icon={<ACTION_ICONS.delete size={16} />}
                    disabled={!editable}
                    onClick={() => setRows((current) => current.filter((each) => each.key !== row.key))}
                  />
                </li>
              )
            })}
          </ul>
          {editable ? (
            <Button
              type="button"
              variant="tertiary"
              className="self-start px-0 font-semibold"
              onClick={() => setRows((current) => [...current, { key: newKey(), days: 'weekdays', from: '09:00', to: '17:00' }])}
            >
              + Add hours
            </Button>
          ) : null}
          <p className="text-small text-secondary">
            {totalHours === 0 ? 'No hours set, so nothing is offered.' : `${totalHours} hours a week`}
          </p>
          {problem ? <p role="alert" className="text-small text-error">{problem}</p> : null}
        </div>
        <SaveBar form={FORM_ID} changes={editable ? changes : 0} busy={saving} onCancel={() => {
          setTimezone(saved.timezone)
          setRows(saved.rows)
        }} />
      </form>

      <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
        <h2 className="mb-1 font-medium">One-off days</h2>
        <p className="mb-3 text-xs text-secondary">
          A holiday, or a day with different hours. An override replaces the weekly rule for that
          date rather than adding to it.
        </p>

        {schedule.overrides.length === 0 ? (
          <p className="mb-3 text-sm text-secondary">Nothing coming up.</p>
        ) : (
          <ul className="mb-3 flex flex-col gap-1 text-sm">
            {schedule.overrides.map((override) => (
              <li key={override.day} className="flex flex-wrap items-center gap-2">
                <span className="w-28 font-medium">{fmt.date(override.day)}</span>
                <span className="text-secondary">
                  {override.isUnavailable
                    ? 'Unavailable all day'
                    : override.blocks.map(([from, to]) => `${clockLabel(from, fmt.locale)} to ${clockLabel(to, fmt.locale)}`).join(', ')}
                  {override.note ? ` · ${override.note}` : ''}
                </span>
                <IconButton
                  className="ml-auto"
                  label={`Remove the override for ${override.day}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  disabled={!editable}
                  onClick={() => void clearOverride(override.day)}
                />
              </li>
            ))}
          </ul>
        )}

        {editable ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field id="override-day" label="Date">
              <TextInput
                id="override-day"
                type="date"
                value={overrideDay}
                onChange={(event) => setOverrideDay(event.target.value)}
              />
            </Field>
            <Field id="override-kind" label="That day">
              <Select
                id="override-kind"
                value={overrideKind}
                onChange={(event) => setOverrideKind(event.target.value as 'off' | 'hours')}
              >
                <option value="off">I am unavailable</option>
                <option value="hours">Different hours</option>
              </Select>
            </Field>
            {overrideKind === 'hours'
              ? overrideBlocks.map(([from, to], index) => (
                  // Position is the identity here: the times themselves change as
                  // they are typed, and two identical blocks are a thing a person
                  // can briefly have on screen.
                  <div key={index} className="flex items-end gap-2">
                    <Field id={`override-from-${index}`} label={index === 0 ? 'From' : ''}>
                      <TimeField
                        id={`override-from-${index}`}
                        locale={fmt.locale}
                        value={from}
                        className="w-auto"
                        onChange={(value) =>
                          setOverrideBlocks((all) => all.map((block, at) => (at === index ? [value, block[1]] : block)))
                        }
                      />
                    </Field>
                    <Field id={`override-to-${index}`} label={index === 0 ? 'To' : ''}>
                      <TimeField
                        id={`override-to-${index}`}
                        locale={fmt.locale}
                        value={to}
                        className="w-auto"
                        onChange={(value) =>
                          setOverrideBlocks((all) => all.map((block, at) => (at === index ? [block[0], value] : block)))
                        }
                      />
                    </Field>
                    {overrideBlocks.length > 1 ? (
                      <IconButton
                        label={`Remove ${from}–${to}`}
                        tone="destructive"
                        icon={<ACTION_ICONS.delete size={16} />}
                        onClick={() => setOverrideBlocks((all) => all.filter((_, at) => at !== index))}
                      />
                    ) : null}
                  </div>
                ))
              : null}
            {overrideKind === 'hours' ? (
              <Button
                type="button"
                variant="tertiary"
                onClick={() => setOverrideBlocks((all) => [...all, ['14:00', '17:00']])}
              >
                Add another window
              </Button>
            ) : null}
            {overrideProblem ? <p role="alert" className="w-full text-small text-error">{overrideProblem}</p> : null}
            <Field id="override-note" label="Note" hint="For your own team. Nobody booking sees it.">
              <TextInput
                id="override-note"
                value={overrideNote}
                maxLength={200}
                onChange={(event) => setOverrideNote(event.target.value)}
              />
            </Field>
            <Button type="button" onClick={() => void addOverride()}>
              Add
            </Button>
          </div>
        ) : null}
      </section>

      <LeaveGuard dirty={changes > 0} />

      {hostedPages.length > 0 ? (
        <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
          <h2 className="mb-2 font-medium">These hours drive</h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            {hostedPages.map((page) => (
              <li key={page.id}>
                <Link href={bookingPagesPath(account, page.id)}>{page.name}</Link>
                {!page.isActive ? <span className="text-secondary"> (off)</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
