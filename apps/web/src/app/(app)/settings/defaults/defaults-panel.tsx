'use client'

import { Button, Combobox, Field, Switch, Tabs, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { SaveBar } from '~/components/save-bar.tsx'
import { defaultsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { pushParams, useUrlParam } from '~/lib/url-params.ts'
import { HUBS, type Hub } from '~/lib/hubs.ts'

type Account = {
  id: string
  name: string
  slug: string
  hostedDomain: string
  autoJoinHostedDomain: boolean
  defaultViewHubs: Hub[]
  seatLimit: number | null
  seatsUsed: number
  activityRetentionMonths: number
  timezone: string
  currency: string
}

type Tab = 'general' | 'user-defaults' | 'currency'
const TABS: { key: Tab; label: string; lead: string }[] = [
  { key: 'general', label: 'General', lead: 'These defaults will be applied to the entire account.' },
  { key: 'user-defaults', label: 'User Defaults', lead: 'What somebody who joins on their own arrives holding.' },
  { key: 'currency', label: 'Currency', lead: 'The currency amounts are written in across the account.' },
]

const FORM_ID = 'account-defaults'

/** HubSpot's Account Defaults: General, User Defaults and Currency as folder
 *  tabs over one form, so a change on one tab is still there on another, and the
 *  save bar at the window's foot whenever anything differs from what is saved. */
export const DefaultsPanel = ({
  account,
  canWrite,
  zones,
  currencies,
}: {
  account: Account
  canWrite: boolean
  zones: string[]
  currencies: string[]
}) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(account.name)
  const [seatLimit, setSeatLimit] = useState(account.seatLimit === null ? '' : String(account.seatLimit))
  const [autoJoin, setAutoJoin] = useState(account.autoJoinHostedDomain)
  const [defaultHubs, setDefaultHubs] = useState<Hub[]>(account.defaultViewHubs)
  const [retention, setRetention] = useState(String(account.activityRetentionMonths))
  const [timezone, setTimezone] = useState(account.timezone)
  const [currency, setCurrency] = useState(account.currency)
  const [tabParam] = useUrlParam('tab')
  const tab = TABS.find((entry) => entry.key === tabParam) ?? TABS[0]!
  // Only the browser knows it, so it is read after mount: reading it during render
  // would put the server's zone in the markup and the reader's in the hydrated page.
  const [browserZone, setBrowserZone] = useState<string | null>(null)
  useEffect(() => setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone || null), [])

  const save = async () => {
    setBusy(true)
    try {
      await api.account.save.mutate({
        name: name.trim(),
        autoJoinHostedDomain: autoJoin,
        defaultViewHubs: defaultHubs,
        seatLimit: seatLimit.trim() === '' ? null : Number(seatLimit),
        activityRetentionMonths: Number(retention),
        timezone,
        currency,
      })
      toast('success', 'Saved.')
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const seats = seatLimit.trim() === '' ? null : Number(seatLimit)
  const changes = [
    name !== account.name,
    autoJoin !== account.autoJoinHostedDomain,
    retention !== String(account.activityRetentionMonths),
    timezone !== account.timezone,
    currency !== account.currency,
    seats !== account.seatLimit,
    defaultHubs.join() !== account.defaultViewHubs.join(),
  ].filter(Boolean).length

  const reset = () => {
    setName(account.name)
    setSeatLimit(account.seatLimit === null ? '' : String(account.seatLimit))
    setAutoJoin(account.autoJoinHostedDomain)
    setDefaultHubs(account.defaultViewHubs)
    setRetention(String(account.activityRetentionMonths))
    setTimezone(account.timezone)
    setCurrency(account.currency)
  }

  return (
    <form
      id={FORM_ID}
      className="flex min-w-0 flex-col gap-4 pb-24"
      onSubmit={(event) => {
        event.preventDefault()
        if (canWrite && changes > 0) void save()
      }}
    >
      <Tabs
        label="Account defaults"
        items={TABS.map((entry) => ({
          key: entry.key,
          label: entry.label,
          href: entry.key === 'general' ? defaultsPath() : `${defaultsPath()}?tab=${entry.key}`,
          current: entry.key === tab.key,
        }))}
        onSelect={(key) => pushParams({ tab: key === 'general' ? null : key })}
      />
      <p className="border-b border-line pb-4">{tab.lead}</p>
      {canWrite ? null : <p className="text-secondary">You need to be a super admin to change these.</p>}

      <div className="flex max-w-[28.125rem] flex-col gap-6">
        {tab.key === 'general' ? (
          <>
            <Field id="account-name" label="Account name">
              <TextInput id="account-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} />
            </Field>

            {/* The domain is what Google asserts about a sign-in, so it is shown and
                never edited: changing it here would not change who Google lets in. */}
            <Field id="account-domain" label="Google hosted domain">
              <TextInput id="account-domain" value={account.hostedDomain} readOnly disabled />
            </Field>

            <div className="flex flex-col gap-1">
              <Combobox
                id="account-timezone"
                label="Time zone"
                hint="Reports, calendars and today count their days in this zone, for everyone in the account."
                value={timezone}
                onChange={(value) => value && setTimezone(value)}
                options={zones.map((zone) => ({ value: zone, label: zone, keywords: [zone.replaceAll('_', ' ')] }))}
                disabled={!canWrite}
              />
              {canWrite && browserZone && browserZone !== timezone && zones.includes(browserZone) ? (
                <Button type="button" variant="secondary" className="self-start" onClick={() => setTimezone(browserZone)}>
                  Use {browserZone}, where this browser is
                </Button>
              ) : null}
            </div>

            <Field id="account-seats" label="Seats" hint={`${account.seatsUsed} in use. Leave empty for no cap.`}>
              <TextInput
                id="account-seats"
                value={seatLimit}
                onChange={(e) => setSeatLimit(e.target.value)}
                inputMode="numeric"
                disabled={!canWrite}
              />
            </Field>

            <Field
              id="account-retention"
              label="Activity retention"
              hint="Months of raw page views kept before they are rolled up."
            >
              <TextInput
                id="account-retention"
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                inputMode="numeric"
                disabled={!canWrite}
              />
            </Field>
          </>
        ) : tab.key === 'user-defaults' ? (
          <>
            <Switch
              label={`Anyone with a verified ${account.hostedDomain} account can join`}
              checked={autoJoin}
              onChange={(e) => setAutoJoin(e.target.checked)}
              disabled={!canWrite}
            />

            {/* What a domain joiner arrives holding. Empty is the safe reading of a
                domain nobody vetted: they get a seat and nothing to look at. */}
            <fieldset className="flex flex-col gap-2" disabled={!canWrite || !autoJoin}>
              <legend className="pb-2 font-semibold">They arrive able to read</legend>
              <div className="flex flex-wrap gap-2">
                {HUBS.map((hub) => (
                  <Button
                    key={hub}
                    type="button"
                    variant={defaultHubs.includes(hub) ? 'primary' : 'secondary'}
                    onClick={() =>
                      setDefaultHubs(
                        defaultHubs.includes(hub) ? defaultHubs.filter((h) => h !== hub) : [...defaultHubs, hub],
                      )
                    }
                  >
                    <span className="capitalize">{hub}</span>
                  </Button>
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <Combobox
            id="account-currency"
            label="Company currency"
            hint="What an amount is written in when its own record does not say. A deal keeps the currency it was made in."
            value={currency}
            onChange={(value) => value && setCurrency(value)}
            options={currencies.map((code) => ({ value: code, label: code }))}
            disabled={!canWrite}
          />
        )}
      </div>

      {canWrite ? <SaveBar form={FORM_ID} changes={changes} busy={busy} onCancel={reset} /> : null}
    </form>
  )
}
