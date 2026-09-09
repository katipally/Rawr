'use client'

import { Button, Field, PageHeader, Select, cn, useToast } from '@rawr/ui'
import Link from 'next/link'
import { LinkButton } from '~/components/link-button.tsx'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { formatDate } from '~/components/crm/value.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

type Service = {
  /** Null when nothing is connected. Otherwise the provider's own health word. */
  state: string | null
  detail: string | null
  canConnect: boolean
  href: string
  managePath: string
}

export type AccountPanelProps = {
  me: { email: string; displayName: string; avatarUrl: string | null; userId: string }
  accounts: { slug: string; name: string; joinedAt: string }[]
  admins: { name: string; email: string }[]
  timezone: string
  weekly: unknown
  gmail: Service
  calendar: Service
  tokens: number
  links: { agent: string; availability: string }
}

/** Node and the browser ship different ICU data, so this list is not the same on
 *  both sides of a render. Read on the client only, after mount. */
const zones = (): string[] => {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    if (supported) return supported('timeZone')
  } catch {
    // Older engines cannot enumerate zones; the current one is still offered.
  }
  return []
}

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="rounded-panel border border-line bg-surface shadow-panel">
    <h3 className="px-6 pt-6 pb-4 text-base font-semibold">{title}</h3>
    <div className="flex flex-col gap-3 px-6 pb-6">{children}</div>
  </section>
)

const ServiceRow = ({ name, service, what }: { name: string; service: Service; what: string }) => {
  const connected = service.state !== null
  const healthy = service.state === 'connected' || service.state === 'active'
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{name}</span>
          <span
            className={cn(
              'rounded-hs px-1.5 py-0.5 text-small',
              !connected && 'bg-fill text-secondary',
              connected && healthy && 'bg-success-subtle text-success',
              connected && !healthy && 'bg-warning-subtle text-warning',
            )}
          >
            {connected ? (service.state ?? 'Connected') : 'Not connected'}
          </span>
        </p>
        <p className="text-small text-secondary">{service.detail ?? what}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {service.canConnect ? (
          <a href={service.href} className="inline-flex min-h-8 items-center rounded-hs bg-cta px-3 font-semibold text-white no-underline hover:bg-cta-hover">
            {connected ? 'Reconnect' : 'Connect'}
          </a>
        ) : (
          <span className="text-small text-secondary">Needs a Google Cloud project with Gmail enabled.</span>
        )}
        <Link href={service.managePath} className="inline-flex min-h-8 items-center">
          Manage
        </Link>
      </div>
    </div>
  )
}

export const AccountPanel = ({ me, accounts, admins, timezone: initialTimezone, weekly, gmail, calendar, tokens, links }: AccountPanelProps) => {
  const router = useRouter()
  const toast = useToast()
  const [timezone, setTimezone] = useState(initialTimezone)
  const [savingZone, setSavingZone] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  // The server renders the saved zone alone and the full list arrives after mount,
  // because enumerating zones on both sides produced two different lists and React
  // threw out the whole tree over the mismatch.
  const [supportedZones, setSupportedZones] = useState<string[]>([])
  useEffect(() => setSupportedZones(zones()), [])
  const allZones = useMemo(
    () => (supportedZones.includes(timezone) ? supportedZones : [timezone, ...supportedZones]),
    [supportedZones, timezone],
  )
  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return null
    }
  }, [])

  const saveZone = async () => {
    setSavingZone(true)
    try {
      await api.booking.saveSchedule.mutate({ timezone, weekly: weekly as never })
      toast('success', `Times are now shown to you in ${timezone}.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setSavingZone(false)
    }
  }

  const signOutEverywhere = async () => {
    setSigningOut(true)
    try {
      await api.session.signOutEverywhere.mutate()
      // This session is one of the ones just revoked; the redirect makes that
      // visible instead of leaving a page that will fail on its next click.
      window.location.assign('/sign-in?error=' + encodeURIComponent('Signed out everywhere. Sign in again to continue.'))
    } catch (cause) {
      toast('error', errorMessage(cause))
      setSigningOut(false)
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <PageHeader
        as="h2"
        title="Your account"
        lead="What Rawr knows about you, and the things only you control."
        why={<p>Your name and picture come from Google each time you sign in.</p>}
      />

      <Panel title="Who you are">
        <div className="flex items-center gap-3">
          {me.avatarUrl ? (
            <img src={me.avatarUrl} alt="" width={40} height={40} className="size-10 shrink-0 rounded-full" />
          ) : (
            <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle font-medium text-link">
              {me.displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-medium">{me.displayName}</p>
            <p className="truncate text-secondary">{me.email}</p>
          </div>
        </div>
      </Panel>

      <Panel title="Your account">
        <ul className="flex flex-col divide-y divide-divider">
          {accounts.map((w) => (
            <li key={w.slug} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-medium">{w.name}</p>
                <p className="text-small text-secondary">
                  What you may do here is under Settings, Users &amp; Teams.
                </p>
              </div>
              <p className="shrink-0 text-small text-secondary">Joined {formatDate(w.joinedAt)}</p>
            </li>
          ))}
        </ul>
        {admins.length > 0 ? (
          <p className="text-small text-secondary">
            What you may do is set by a super admin under Settings, Users &amp; Teams.{' '}
            {admins.length > 0 ? (
              <>
                Ask{' '}
                {admins.map((a, i) => (
                  <span key={a.email}>
                    {i > 0 ? (i === admins.length - 1 ? ' or ' : ', ') : ''}
                    <a href={`mailto:${a.email}?subject=${encodeURIComponent('Rawr role')}`}>{a.name}</a>
                  </span>
                ))}
                .
              </>
            ) : null}
          </p>
        ) : null}
      </Panel>

      <Panel title="Your timezone">
        <Field
          id="account-timezone"
          label="Times are shown to you, and your working hours are read, in"
          hint={detected && detected !== timezone ? `Your browser says ${detected}.` : 'Working hours themselves are under Meetings, My hours.'}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select id="account-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} className="max-w-xs">
              {allZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
            <Button variant="primary" busy={savingZone} disabled={timezone === initialTimezone} onClick={() => void saveZone()}>
              Save
            </Button>
            {detected && detected !== timezone ? (
              <Button variant="tertiary" onClick={() => setTimezone(detected)}>
                Use {detected}
              </Button>
            ) : null}
            <LinkButton variant="tertiary" href={links.availability}>
              Working hours
            </LinkButton>
          </div>
        </Field>
      </Panel>

      <Panel title="Connected Google services">
        <ServiceRow name="Gmail" service={gmail} what="Read only. Threads with people in this CRM appear on their records, so a successor can read the history." />
        <ServiceRow name="Google Calendar" service={calendar} what="Free-busy for your booking pages, and the event a booking creates. Without it you are unavailable on every page." />
      </Panel>

      <Panel title="Assistants and sessions">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p>
            <span className="font-medium">{tokens}</span> active agent token{tokens === 1 ? '' : 's'} act as you.
          </p>
          <Link href={links.agent}>Manage agent access</Link>
        </div>
        <div className="flex flex-col gap-2 border-t border-divider pt-3">
          <p className="text-secondary">
            Signing out everywhere ends every Rawr session you hold on every device, this one
            included. Agent tokens are separate and keep working until revoked.
          </p>
          {confirming ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" busy={signingOut} onClick={() => void signOutEverywhere()}>
                Yes, sign me out everywhere
              </Button>
              <Button variant="tertiary" onClick={() => setConfirming(false)}>
                Keep my sessions
              </Button>
            </div>
          ) : (
            <div>
              <Button onClick={() => setConfirming(true)}>Sign out everywhere</Button>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
