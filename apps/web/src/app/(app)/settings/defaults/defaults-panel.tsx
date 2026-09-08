'use client'

import { Button, Card, Field, Switch, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
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
}

export const DefaultsPanel = ({ account, canWrite }: { account: Account; canWrite: boolean }) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(account.name)
  const [seatLimit, setSeatLimit] = useState(account.seatLimit === null ? '' : String(account.seatLimit))
  const [autoJoin, setAutoJoin] = useState(account.autoJoinHostedDomain)
  const [defaultHubs, setDefaultHubs] = useState<Hub[]>(account.defaultViewHubs)
  const [retention, setRetention] = useState(String(account.activityRetentionMonths))

  const save = async () => {
    setBusy(true)
    try {
      await api.account.save.mutate({
        name: name.trim(),
        autoJoinHostedDomain: autoJoin,
        defaultViewHubs: defaultHubs,
        seatLimit: seatLimit.trim() === '' ? null : Number(seatLimit),
        activityRetentionMonths: Number(retention),
      })
      toast('success', 'Saved.')
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const unchanged =
    name === account.name &&
    autoJoin === account.autoJoinHostedDomain &&
    retention === String(account.activityRetentionMonths) &&
    (seatLimit.trim() === '' ? null : Number(seatLimit)) === account.seatLimit &&
    defaultHubs.join() === account.defaultViewHubs.join()

  return (
    <div className="flex flex-col gap-4">
      <Card title="Account">
        <div className="flex flex-col gap-4 p-4">
          <Field id="account-name" label="Account name">
            <TextInput id="account-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canWrite} />
          </Field>

          {/* The domain is what Google asserts about a sign-in, so it is shown and
              never edited: changing it here would not change who Google lets in. */}
          <Field id="account-domain" label="Google hosted domain">
            <TextInput id="account-domain" value={account.hostedDomain} readOnly disabled />
          </Field>

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
        </div>
      </Card>

      <Card title="Joining">
        <div className="flex flex-col gap-4 p-4">
          <Switch
            label={`Anyone with a verified ${account.hostedDomain} account can join`}
            checked={autoJoin}
            onChange={(e) => setAutoJoin(e.target.checked)}
            disabled={!canWrite}
          />

          {/* What a domain joiner arrives holding. Empty is the safe reading of a
              domain nobody vetted: they get a seat and nothing to look at. */}
          <fieldset className="flex flex-col gap-2" disabled={!canWrite || !autoJoin}>
            <legend className="text-small text-secondary">They arrive able to read</legend>
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
        </div>
      </Card>

      {canWrite ? (
        <div className="flex justify-end">
          <Button disabled={busy || unchanged} onClick={save}>
            Save
          </Button>
        </div>
      ) : (
        <p className="text-secondary">You need to be a super admin to change this.</p>
      )}
    </div>
  )
}
