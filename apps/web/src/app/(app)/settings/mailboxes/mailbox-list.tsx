'use client'

import { Alert, Badge, Button, Checkbox, Field, IconButton, Select, Switch, TextInput, cn, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { BlocklistRow, MailboxState, SendWindow } from '@rawr/db'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'

export type MailboxSummary = {
  id: string
  userId: string
  userName: string
  email: string
  state: MailboxState
  backfillDone: boolean
  lastSyncAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  threadCount: number
  standIn: boolean
  visibility: 'team' | 'private'
  canSend: boolean
  dailyCap: number
  minGapSeconds: number
  sendWindow: SendWindow | null
  alertOnOpen: boolean
  /** How much of what this mailbox read has had its body stored. */
  pendingBodies: number
  storedBodies: number
}

export type MailboxListProps = {
  rows: MailboxSummary[]
  blocklist: BlocklistRow[]
  currentUserId: string
  isAdmin: boolean
  internalDomain: string
  googleReady: boolean
  devReady: boolean
}

/** What each state means to a person, rather than what it means to the sync. A
 *  revoked mailbox is the one that needs a sentence: it looks like a failure and
 *  is actually somebody withdrawing consent, which is their right and not a bug. */
/** The stand-in says so wherever a real mailbox would say "Connected". Its state
 *  column is genuinely `connected`, so without this the page reports a working
 *  sync over five fixtures. */
const STAND_IN_COPY = {
  label: 'Development mailbox',
  tone: 'warn' as const,
  hint: 'A stand-in: it reads five fixtures and sends nowhere. Disconnect it and connect with Google to sync real mail.',
}

const STATE_COPY: Record<MailboxState, { label: string; tone: 'ok' | 'warn' | 'error'; hint: string }> = {
  connected: { label: 'Connected', tone: 'ok', hint: 'New mail appears on the right records within the hour.' },
  backfilling: {
    label: 'Reading history',
    tone: 'warn',
    hint: 'Working through the archive oldest first. It can be interrupted and resumes where it stopped.',
  },
  revoked: {
    label: 'Access withdrawn',
    tone: 'error',
    hint: 'Rawr was removed from this Google account, so reading has stopped. Nothing is retried until it is connected again.',
  },
  error: { label: 'Not syncing', tone: 'error', hint: 'The last pass failed. The reason is below.' },
  paused: { label: 'Paused', tone: 'warn', hint: 'Reading is stopped on purpose. Existing history stays.' },
}

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
]

const DEFAULT_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'UTC' }

/** Every zone this runtime knows, with the saved one guaranteed to be among them:
 *  `supportedValuesOf` omits UTC in several runtimes, and a select whose value
 *  matches no option silently displays the first, so Save would move the window
 *  to a zone nobody chose. */
const timezones = (current: string): string[] => {
  const known = Intl.supportedValuesOf?.('timeZone') ?? []
  const all = known.length > 0 ? known : ['UTC']
  return all.includes(current) ? all : [current, ...all]
}

/** The three columns the sender actually reads: the day's allowance, the pause
 *  between two sends, and a window that overrides whatever window the sequence
 *  carries. Until this existed the page reported the column defaults as though
 *  somebody had chosen them. */
const SendingLimits = ({
  row,
  busy,
  onSave,
}: {
  row: MailboxSummary
  busy: boolean
  onSave: (input: { dailyCap: number; minGapSeconds: number; sendWindow: SendWindow | null }) => Promise<boolean>
}) => {
  const [cap, setCap] = useState(String(row.dailyCap))
  const [gap, setGap] = useState(String(row.minGapSeconds))
  const [hours, setWindow] = useState<SendWindow | null>(row.sendWindow)

  const capNumber = Number(cap)
  const gapNumber = Number(gap)
  const valid =
    Number.isInteger(capNumber) &&
    capNumber >= 1 &&
    capNumber <= 2000 &&
    Number.isInteger(gapNumber) &&
    gapNumber >= 0 &&
    (hours === null || (hours.days.length > 0 && hours.start < hours.end))

  return (
    <details className="w-full max-w-md">
      <summary className="cursor-pointer text-small">Sending limits</summary>
      <form
        className="mt-2 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void onSave({ dailyCap: capNumber, minGapSeconds: gapNumber, sendWindow: hours })
        }}
      >
        <div className="flex flex-wrap gap-3">
          <Field id={`cap-${row.id}`} label="Most a day" hint="Sequence sends only. A mail written by hand never spends it.">
            <TextInput
              id={`cap-${row.id}`}
              type="number"
              min={1}
              max={2000}
              value={cap}
              disabled={busy}
              onChange={(event) => setCap(event.target.value)}
            />
          </Field>
          <Field id={`gap-${row.id}`} label="Seconds between sends" hint="The pause that keeps a run looking like a person typing.">
            <TextInput
              id={`gap-${row.id}`}
              type="number"
              min={0}
              max={86400}
              value={gap}
              disabled={busy}
              onChange={(event) => setGap(event.target.value)}
            />
          </Field>
        </div>

        <Switch
          label="Only send inside my own hours"
          hint={
            hours
              ? 'These hours win over the window each sequence carries.'
              : 'Each sequence keeps its own window.'
          }
          checked={hours !== null}
          disabled={busy}
          onChange={(event) => setWindow(event.target.checked ? (row.sendWindow ?? DEFAULT_WINDOW) : null)}
        />

        {hours ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small font-medium">When this mailbox may send</legend>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((day) => (
                <Checkbox
                  key={day.value}
                  label={day.label}
                  disabled={busy}
                  checked={hours.days.includes(day.value)}
                  onChange={(event) =>
                    setWindow({
                      ...hours,
                      days: event.target.checked
                        ? [...hours.days, day.value].sort()
                        : hours.days.filter((value) => value !== day.value),
                    })
                  }
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <Field id={`from-${row.id}`} label="From">
                <TextInput
                  id={`from-${row.id}`}
                  type="time"
                  value={hours.start}
                  disabled={busy}
                  onChange={(event) => setWindow({ ...hours, start: event.target.value })}
                />
              </Field>
              <Field id={`to-${row.id}`} label="To">
                <TextInput
                  id={`to-${row.id}`}
                  type="time"
                  value={hours.end}
                  disabled={busy}
                  onChange={(event) => setWindow({ ...hours, end: event.target.value })}
                />
              </Field>
              <Field id={`zone-${row.id}`} label="Timezone">
                <Select
                  id={`zone-${row.id}`}
                  value={hours.timezone}
                  disabled={busy}
                  onChange={(event) => setWindow({ ...hours, timezone: event.target.value })}
                >
                  {timezones(hours.timezone).map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </fieldset>
        ) : null}

        <Button type="submit" variant="primary" busy={busy} disabled={!valid}>
          Save sending limits
        </Button>
      </form>
    </details>
  )
}

export const MailboxList = ({
  rows,
  blocklist,
  currentUserId,
  isAdmin,
  internalDomain,
  googleReady,
  devReady,
}: MailboxListProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [pattern, setPattern] = useState('')
  const [scope, setScope] = useState<'account' | 'mine'>('mine')

  const mine = rows.find((row) => row.userId === currentUserId)

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

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        {mine ? null : (
          <div className="flex flex-wrap gap-2">
            {googleReady ? (
              <Button variant="primary" onClick={() => { window.location.href = '/api/auth/google/gmail' }}>
                Connect my Gmail
              </Button>
            ) : null}
            {devReady ? (
              <Button
                busy={busy}
                onClick={() =>
                  void run(
                    () => api.mail.connectDev.mutate(),
                    'Development mailbox connected. Run a pass to read its history.',
                  )
                }
              >
                Connect the development mailbox
              </Button>
            ) : null}
            {!googleReady && !devReady ? (
              <Alert tone="warning">
                Gmail sync needs a Google client and an internal consent screen on the{' '}
                {internalDomain} Google Workspace. Until that exists, nothing here can
                connect.
              </Alert>
            ) : null}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-secondary">
            No mailbox is connected. Threads only appear on a record once somebody whose mail
            matters has connected their own.
          </p>
        ) : (
          <ul className="flex flex-col rounded-panel border border-line bg-surface">
            {rows.map((row) => {
              const copy = row.standIn ? STAND_IN_COPY : STATE_COPY[row.state]
              const isMine = row.userId === currentUserId
              return (
                <li key={row.id} className="flex flex-col gap-1 border-b border-divider px-3 py-2 last:border-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{row.userName}</span>
                        <span className="text-small text-secondary">{row.email}</span>
                        <span
                          className={cn(
                            'rounded-hs px-1.5 py-0.5 text-small',
                            copy.tone === 'ok' && 'bg-success-subtle text-success',
                            copy.tone === 'warn' && 'bg-warning-subtle text-warning',
                            copy.tone === 'error' && 'bg-error-subtle text-error',
                          )}
                        >
                          {copy.label}
                        </span>
                      </p>
                      <p className="text-small text-secondary">{copy.hint}</p>
                      <p className="text-small text-secondary">
                        {row.lastSyncAt ? `Last pass ${formatDateTime(row.lastSyncAt, zone)}` : 'Never run'} ·{' '}
                        {row.backfillDone ? 'History read in full' : 'History still being read'}
                      </p>
                      <p className="flex flex-wrap items-center gap-2 text-small text-secondary">
                        {row.canSend ? (
                          <Badge tone="ok">
                            Can send, up to {row.dailyCap.toLocaleString()} a day
                            {row.sendWindow ? `, ${row.sendWindow.start} to ${row.sendWindow.end}` : ''}
                          </Badge>
                        ) : (
                          <Badge>Reading only</Badge>
                        )}
                        {row.pendingBodies > 0 ? (
                          <Badge tone="warn">
                            {row.storedBodies.toLocaleString()} of{' '}
                            {(row.storedBodies + row.pendingBodies).toLocaleString()} bodies stored
                          </Badge>
                        ) : row.storedBodies > 0 ? (
                          <Badge tone="ok">{row.storedBodies.toLocaleString()} bodies stored</Badge>
                        ) : null}
                        {row.pendingBodies > 0
                          ? 'The rest arrive over the next few passes; a thread is readable in the meantime from its snippets.'
                          : null}
                      </p>
                      {row.lastError ? (
                        <p role="alert" className="break-words text-small text-error">
                          {row.lastError}
                          {row.lastErrorAt ? ` (${formatDateTime(row.lastErrorAt, zone)})` : ''}
                        </p>
                      ) : null}
                    </div>

                    {isMine || isAdmin ? (
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <Switch
                          label="Shared with the team"
                          hint={
                            row.visibility === 'team'
                              ? 'Everybody here can read these threads on a record.'
                              : 'Only you and an admin can read these threads.'
                          }
                          checked={row.visibility === 'team'}
                          disabled={busy}
                          onChange={(event) =>
                            void run(
                              () =>
                                api.mail.setVisibility.mutate({
                                  mailboxId: row.id,
                                  visibility: event.target.checked ? 'team' : 'private',
                                }),
                              event.target.checked
                                ? 'The team can read these threads.'
                                : 'These threads are yours and an admin’s to read.',
                            )
                          }
                        />
                        <Switch
                          label="Tell me when a mail I sent is opened"
                          hint="One notice per message, not per open: the pixel is fetched every time the mail is displayed, and Apple fetches it on the recipient's behalf, so a notice per fetch would be noise about one mail."
                          checked={row.alertOnOpen}
                          disabled={busy}
                          onChange={(event) =>
                            void run(
                              () =>
                                api.mail.setOpenAlert.mutate({
                                  mailboxId: row.id,
                                  alertOnOpen: event.target.checked,
                                }),
                              event.target.checked
                                ? 'You will hear when a mail from here is opened.'
                                : 'Opens no longer reach your bell.',
                            )
                          }
                        />
                        {row.canSend ? (
                          <SendingLimits
                            row={row}
                            busy={busy}
                            onSave={(input) =>
                              run(
                                () => api.mail.setSending.mutate({ mailboxId: row.id, ...input }),
                                'Saved. Anything already waiting has been moved into the new window.',
                              )
                            }
                          />
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                        {isMine && googleReady && !row.standIn && !row.canSend ? (
                          <Button
                            onClick={() => {
                              window.location.href = '/api/auth/google/gmail?send=1'
                            }}
                          >
                            Let Rawr send from here
                          </Button>
                        ) : null}
                        <Button
                          busy={busy}
                          disabled={row.state === 'revoked'}
                          onClick={() =>
                            void run(async () => {
                              const outcome = await api.mail.sync.mutate({ id: row.id })
                              toast(
                                'info',
                                `${outcome.read} read: ${outcome.stored} new, ${outcome.alreadyHad} already had, ${outcome.skipped} refused.${outcome.reason ? ` ${outcome.reason}` : ''}`,
                              )
                            }, 'Pass finished.')
                          }
                        >
                          Read now
                        </Button>
                        <Button
                          variant="destructive"
                          busy={busy}
                          onClick={() =>
                            void run(
                              () => api.mail.disconnect.mutate({ id: row.id }),
                              'Disconnected. The threads already read stay on their records.',
                            )
                          }
                        >
                          Disconnect
                        </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="max-w-2xl">
          <h3 className="text-base font-semibold">Never read these</h3>
          <p className="text-secondary">
            An address or a domain. Applied before anything is stored, so a match is never in the
            database at all. Threads where everybody is at {internalDomain} are already excluded
            without being listed here. Somebody writing from a personal address is a lead, not an
            exclusion, so put them here if you would rather they never arrived.
          </p>
        </div>

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void run(
              () => api.mail.blocklist.add.mutate({ pattern, scope, note: null }),
              'Added. It applies from the next pass.',
            ).then((ok) => ok && setPattern(''))
          }}
        >
          <Field id="block-pattern" label="Address or domain">
            <TextInput
              id="block-pattern"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder="recruiter@agency.example"
            />
          </Field>
          <Field id="block-scope" label="Applies to">
            <Select id="block-scope" value={scope} onChange={(event) => setScope(event.target.value as 'account' | 'mine')}>
              <option value="mine">Just my mailbox</option>
              <option value="account">Everybody</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary" busy={busy} disabled={pattern.trim().length < 3}>
            Add
          </Button>
        </form>

        {blocklist.length === 0 ? (
          <p className="text-secondary">Nothing excluded by hand yet.</p>
        ) : (
          <ul className="flex flex-col rounded-panel border border-line bg-surface">
            {blocklist.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-3 py-1.5 last:border-0"
              >
                <span className="min-w-0 break-words">
                  {entry.pattern}
                  <span className="ml-2 text-small text-secondary">
                    {entry.userId === null ? 'everybody' : entry.userId === currentUserId ? 'mine' : 'somebody else'}
                  </span>
                </span>
                <IconButton
                  label={`Stop excluding ${entry.pattern}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.mail.blocklist.remove.mutate({ id: entry.id }), 'Removed.')
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
