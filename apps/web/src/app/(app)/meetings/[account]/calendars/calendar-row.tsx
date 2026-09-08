'use client'

import type { GrantSummary } from '@rawr/db'
import { Badge, type BadgeTone, Button, TextInput, useToast } from '@rawr/ui'
import { Clock, Pencil } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { LinkButton } from '~/components/link-button.tsx'
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

const STATES: Record<string, { label: string; tone: BadgeTone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  degraded: { label: 'Failing', tone: 'error' },
  revoked: { label: 'Revoked', tone: 'error' },
  unconfigured: { label: 'Not connected', tone: 'neutral' },
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
        <Badge tone={badge?.tone ?? 'neutral'} dot>
          {badge?.label}
        </Badge>
        {grant?.provider === 'dev' ? <Badge tone="warn">development</Badge> : null}
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
                <Button
                  type="button"
                  variant="tertiary"
                  className="ml-1 px-1 py-0"
                  icon={<Pencil aria-hidden="true" className="size-3.5" />}
                  onClick={() => setEditingCalendar(true)}
                >
                  Change
                </Button>
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

        <LinkButton href={availabilityHref} icon={<Clock aria-hidden="true" className="size-4" />}>
          Working hours
        </LinkButton>
      </div>

      {!isSelf && canConnectGoogle ? (
        <p className="text-xs text-secondary">
          Only {name} can grant access to their own calendar. Send them this screen.
        </p>
      ) : null}
    </li>
  )
}
