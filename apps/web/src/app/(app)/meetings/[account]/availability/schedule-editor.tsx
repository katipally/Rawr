'use client'

import type { Schedule } from '@rawr/db'
import { Button, Field, IconButton, Select, TextInput, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { bookingPagesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

/** Weekly hours plus one-off overrides.
 *
 *  Times here are wall-clock rules in the named timezone, not instants, which is
 *  what keeps nine in the morning at nine through a daylight-saving change. The
 *  timezone is chosen from the browser's own list rather than a curated one, so
 *  nobody is missing from it. */

const DAYS: { key: string; label: string; short: string }[] = [
  { key: '1', label: 'Monday', short: 'Mon' },
  { key: '2', label: 'Tuesday', short: 'Tue' },
  { key: '3', label: 'Wednesday', short: 'Wed' },
  { key: '4', label: 'Thursday', short: 'Thu' },
  { key: '5', label: 'Friday', short: 'Fri' },
  { key: '6', label: 'Saturday', short: 'Sat' },
  { key: '7', label: 'Sunday', short: 'Sun' },
]

type Ranges = Record<string, [string, string][]>

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

const today = (): string => new Date().toISOString().slice(0, 10)

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
  const [timezone, setTimezone] = useState(schedule.timezone)
  const [weekly, setWeekly] = useState<Ranges>(schedule.weekly as Ranges)
  const [saving, setSaving] = useState(false)

  const [overrideDay, setOverrideDay] = useState(today())
  const [overrideKind, setOverrideKind] = useState<'off' | 'hours'>('off')
  // A list, not a pair: the column is a jsonb array and the reader below already
  // renders every block, so a morning and an afternoon with a gap between them
  // was storable and displayable but not enterable.
  const [overrideBlocks, setOverrideBlocks] = useState<[string, string][]>([['09:00', '13:00']])
  const [overrideNote, setOverrideNote] = useState('')

  // Empty on the server: enumerating zones there produced a different list from
  // the browser's, and React discards the tree over the mismatch. The stored value
  // is rendered on its own below, so the select is correct before this arrives.
  const [zoneList, setZoneList] = useState<string[]>([])
  useEffect(() => setZoneList(zones()), [])
  const totalHours = useMemo(() => {
    let minutes = 0
    for (const ranges of Object.values(weekly)) {
      for (const [from, to] of ranges) {
        const [fh = 0, fm = 0] = from.split(':').map(Number)
        const [th = 0, tm = 0] = to.split(':').map(Number)
        minutes += Math.max(0, th * 60 + tm - (fh * 60 + fm))
      }
    }
    return Math.round((minutes / 60) * 10) / 10
  }, [weekly])

  const setRange = (day: string, index: number, which: 0 | 1, value: string) =>
    setWeekly((current) => {
      const ranges = [...(current[day] ?? [])]
      const range = ranges[index]
      if (!range) return current
      ranges[index] = which === 0 ? [value, range[1]] : [range[0], value]
      return { ...current, [day]: ranges }
    })

  const addRange = (day: string) =>
    setWeekly((current) => ({
      ...current,
      [day]: [...(current[day] ?? []), ['09:00', '17:00'] as [string, string]],
    }))

  const removeRange = (day: string, index: number) =>
    setWeekly((current) => ({
      ...current,
      [day]: (current[day] ?? []).filter((_, at) => at !== index),
    }))

  const save = async () => {
    setSaving(true)
    try {
      await api.booking.saveSchedule.mutate({
        ...(isSelf ? {} : { userId: schedule.userId }),
        timezone,
        // Empty days are dropped rather than stored as an empty list: a day with no
        // windows and a day that is not in the object mean the same thing.
        weekly: Object.fromEntries(
          Object.entries(weekly).filter(([, ranges]) => ranges.length > 0),
        ) as Ranges,
      })
      show('success', 'Saved. New times are offered from the next page load.')
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const addOverride = async () => {
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
    <div className="flex flex-col gap-4">
      <section className="rounded-panel border border-line bg-surface p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field
            id="schedule-timezone"
            label="Timezone"
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
          <p className="text-sm text-secondary">
            {totalHours === 0 ? 'No hours set, so nothing is offered.' : `${totalHours} hours a week`}
          </p>
          <Button
            variant="primary"
            type="button"
            className="ml-auto"
            busy={saving}
            disabled={!editable}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save hours'}
          </Button>
        </div>

        <ul className="flex flex-col gap-2">
          {DAYS.map((day) => {
            const ranges = weekly[day.key] ?? []
            return (
              <li key={day.key} className="flex flex-wrap items-center gap-2 border-t border-divider pt-2">
                <span className="w-20 shrink-0 font-medium">{day.short}</span>
                {ranges.length === 0 ? (
                  <span className="text-secondary">Not working</span>
                ) : (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {ranges.map((range, index) => (
                      <span key={index} className="flex items-center gap-1">
                        <TextInput
                          type="time"
                          aria-label={`${day.label} start`}
                          value={range[0]}
                          disabled={!editable}
                          className="w-auto"
                          onChange={(event) => setRange(day.key, index, 0, event.target.value)}
                        />
                        <span className="text-secondary">to</span>
                        <TextInput
                          type="time"
                          aria-label={`${day.label} end`}
                          value={range[1]}
                          disabled={!editable}
                          className="w-auto"
                          onChange={(event) => setRange(day.key, index, 1, event.target.value)}
                        />
                        <Button
                          type="button"
                          disabled={!editable}
                          onClick={() => removeRange(day.key, index)}
                        >
                          ✕
                        </Button>
                      </span>
                    ))}
                  </div>
                )}
                <Button
                  type="button"
                  className="ml-auto"
                  disabled={!editable}
                  onClick={() => addRange(day.key)}
                >
                  Add hours
                </Button>
              </li>
            )
          })}
        </ul>
      </section>

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
                <span className="w-28 font-medium">{override.day}</span>
                <span className="text-secondary">
                  {override.isUnavailable
                    ? 'Unavailable all day'
                    : override.blocks.map(([from, to]) => `${from}–${to}`).join(', ')}
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
                      <TextInput
                        id={`override-from-${index}`}
                        type="time"
                        value={from}
                        className="w-auto"
                        onChange={(event) =>
                          setOverrideBlocks((all) =>
                            all.map((block, at) => (at === index ? [event.target.value, block[1]] : block)),
                          )
                        }
                      />
                    </Field>
                    <Field id={`override-to-${index}`} label={index === 0 ? 'To' : ''}>
                      <TextInput
                        id={`override-to-${index}`}
                        type="time"
                        value={to}
                        className="w-auto"
                        onChange={(event) =>
                          setOverrideBlocks((all) =>
                            all.map((block, at) => (at === index ? [block[0], event.target.value] : block)),
                          )
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
