'use client'

import type { GrantSummary } from '@rawr/db'
import { Button, TextInput, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

/** One person's calendar connection, with the real reason when it is not working.
 *
 *  Connecting is not normally done here any more: signing in with Google asks for
 *  the calendar in the same consent, so a host who has signed in is already
 *  connected. This screen is where somebody comes when that did not happen --
 *  access declined, revoked later, or a connection that has started failing -- so
 *  the button says Reconnect far more often than it says Connect.
 *  "Degraded" on its own tells nobody anything, so the recorded error is printed. */

const STATES: Record<string, { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'bg-success-subtle text-success' },
  degraded: { label: 'Failing', className: 'bg-error-subtle text-error' },
  revoked: { label: 'Revoked', className: 'bg-error-subtle text-error' },
  unconfigured: { label: 'Not connected', className: 'bg-disabled text-secondary' },
}

export const CalendarRow = ({
  userId,
  name,
  grant,
  isSelf,
  canConnectGoogle,
  canConnectDev,
  editable,
  availabilityHref,
}: {
  userId: string
  name: string
  grant: GrantSummary | null
  isSelf: boolean
  canConnectGoogle: boolean
  canConnectDev: boolean
  editable: boolean
  availabilityHref: string
}) => {
  const show = useToast()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [editingCalendar, setEditingCalendar] = useState(false)
  const [calendarId, setCalendarId] = useState(grant?.calendarId ?? 'primary')

  const state = grant?.state ?? 'unconfigured'
  const badge = STATES[state] ?? STATES.unconfigured
  const working = state === 'connected'

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      show('success', done)
      router.refresh()
    } catch (cause) {
      show('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <span className={`rounded-hs px-1.5 py-0.5 text-xs ${badge?.className ?? ''}`}>
          {badge?.label}
        </span>
        {grant?.provider === 'dev' ? (
          <span className="rounded-hs bg-warning-subtle px-1.5 py-0.5 text-xs">development</span>
        ) : null}
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary">
        <div className="flex items-center gap-2">
          <dt className="inline">Calendar </dt>
          {editingCalendar ? (
            <dd className="flex items-center gap-2">
              <TextInput
                aria-label={`Which calendar ${name}’s meetings are written to`}
                value={calendarId}
                className="w-auto"
                onChange={(event) => setCalendarId(event.target.value)}
              />
              <Button
                type="button"
                busy={busy}
                disabled={calendarId.trim() === ''}
                onClick={() =>
                  void run(
                    () =>
                      api.booking.setCalendar
                        .mutate({ ...(isSelf ? {} : { userId }), calendarId: calendarId.trim() })
                        .then(() => setEditingCalendar(false)),
                    'Meetings will be written to that calendar from now on.',
                  )
                }
              >
                Save
              </Button>
              <Button
                type="button"
                variant="tertiary"
                onClick={() => {
                  setCalendarId(grant?.calendarId ?? 'primary')
                  setEditingCalendar(false)
                }}
              >
                Cancel
              </Button>
            </dd>
          ) : (
            <dd className="inline font-medium text-body">
              {grant?.calendarId ?? '—'}
              {grant && editable ? (
                <button
                  type="button"
                  className="ml-2 text-link"
                  onClick={() => setEditingCalendar(true)}
                >
                  Change
                </button>
              ) : null}
            </dd>
          )}
        </div>
        <div>
          <dt className="inline">Last worked </dt>
          <dd className="inline font-medium text-body">
            {grant?.lastOkAt ? grant.lastOkAt.toLocaleString() : 'never'}
          </dd>
        </div>
        {grant && !grant.hasRefreshToken && grant.provider === 'google' ? (
          <div>
            <dt className="inline">Refresh token </dt>
            <dd className="inline font-medium text-error">missing, so this will stop working</dd>
          </div>
        ) : null}
      </dl>

      {grant?.lastError ? (
        <p className="text-xs text-error">
          {grant.lastError}
          {grant.lastErrorAt ? ` (${grant.lastErrorAt.toLocaleString()})` : ''}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {isSelf && canConnectGoogle ? (
          <Button
            type="button"
            variant={working ? 'secondary' : 'primary'}
            disabled={!editable}
            onClick={() => {
              window.location.href = `/api/auth/google/calendar?return=${encodeURIComponent(window.location.pathname)}`
            }}
          >
            {working ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
          </Button>
        ) : null}

        {isSelf && !canConnectGoogle && canConnectDev ? (
          <Button
            type="button"
            variant={working ? 'secondary' : 'primary'}
            busy={busy}
            disabled={!editable}
            onClick={() =>
              void run(
                () => api.booking.connectDevCalendar.mutate({}),
                'Connected the development calendar. Times are offered except where Rawr already holds a booking.',
              )
            }
          >
            {working ? 'Reconnect development calendar' : 'Use development calendar'}
          </Button>
        ) : null}

        {!isSelf && canConnectDev && !canConnectGoogle ? (
          <Button
            type="button"
            busy={busy}
            disabled={!editable}
            onClick={() =>
              void run(
                () => api.booking.connectDevCalendar.mutate({ userId }),
                `Connected the development calendar for ${name}.`,
              )
            }
          >
            Connect development calendar
          </Button>
        ) : null}

        {grant && state !== 'unconfigured' ? (
          <Button
            type="button"
            variant="destructive"
            busy={busy}
            disabled={!editable}
            onClick={() =>
              void run(
                () => api.booking.disconnectCalendar.mutate(isSelf ? {} : { userId }),
                `Disconnected. No times will be offered for ${isSelf ? 'you' : name}.`,
              )
            }
          >
            Disconnect
          </Button>
        ) : null}

        <Link href={availabilityHref} className="text-sm text-link">
          Working hours
        </Link>
      </div>

      {!isSelf && canConnectGoogle ? (
        <p className="text-xs text-secondary">
          Only {name} can grant access to their own calendar. Send them this screen.
        </p>
      ) : null}
    </li>
  )
}
