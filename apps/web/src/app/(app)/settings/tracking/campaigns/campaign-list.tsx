'use client'

import { Button, Card, DataTable, Field, Modal, Pagination, TextInput, useToast } from '@rawr/ui'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { formatCurrency } from '~/components/crm/value.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

export type CampaignView = {
  id: string
  name: string
  source: string | null
  medium: string | null
  utmCampaign: string
  spend: number
  currency: string
  startsOn: string | null
  endsOn: string | null
  updatedAt: string
}

type Page = { rows: CampaignView[]; total: number }

const PER_PAGE = 25

const BLANK: CampaignView = {
  id: '',
  name: '',
  source: null,
  medium: null,
  utmCampaign: '',
  spend: 0,
  currency: 'USD',
  startsOn: null,
  endsOn: null,
  updatedAt: '',
}

export const CampaignList = ({ initial, search: initialSearch }: { initial: Page; search: string }) => {
  const toast = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const [page, setPage] = useState<Page>(initial)
  const [search, setSearch] = useState(initialSearch)
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<CampaignView | null>(null)

  const load = useCallback(
    (nextOffset: number, needle: string) => {
      api.reporting.campaigns.list
        .query({ search: needle || null, limit: PER_PAGE, offset: nextOffset })
        .then((result) =>
          setPage({
            rows: result.rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
            total: result.total,
          }),
        )
        .catch((cause) => toast('error', errorMessage(cause)))
    },
    [toast],
  )

  // One request after the typing stops, and the address follows it so a search
  // can be linked to or reloaded. The query is read at the moment the timer
  // fires rather than tracked as a dependency, which would run this again on the
  // replace it just made.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const needle = search.trim()
      setOffset(0)
      load(0, needle)
      const query = new URLSearchParams(window.location.search)
      if (needle) query.set('q', needle)
      else query.delete('q')
      const next = query.toString()
      if (next !== window.location.search.replace(/^\?/, '')) {
        router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false })
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search, load, pathname, router])

  const move = (next: number) => {
    setOffset(next)
    load(next, search.trim())
  }

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Field label="Search" id="campaign-search">
              <TextInput
                id="campaign-search"
                type="search"
                placeholder="Name or utm_campaign"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
          </div>
          <Button variant="secondary" onClick={() => setEditing(BLANK)}>
            New campaign
          </Button>
        </div>

        <DataTable
          caption="Campaigns"
          storageKey="tracking-campaigns"
          rows={page.rows}
          rowKey={(row) => row.id}
          onRowClick={(row) => setEditing(row)}
          empty={
            <p className="text-secondary">
              {search.trim()
                ? 'No campaign matches that.'
                : 'No traffic has arrived carrying a utm_campaign yet. Add one here and it will pick up the visits as they come.'}
            </p>
          }
          columns={[
            {
              key: 'name',
              header: 'Campaign',
              render: (row) => (
                <span className="block truncate font-medium" title={row.name}>
                  {row.name}
                </span>
              ),
            },
            {
              key: 'utm',
              header: 'utm_campaign',
              render: (row) => (
                <span className="block truncate text-secondary" title={row.utmCampaign}>
                  {row.utmCampaign}
                </span>
              ),
            },
            {
              key: 'source',
              header: 'Source and medium',
              render: (row) => (
                <span className="block truncate text-secondary">
                  {[row.source, row.medium].filter(Boolean).join(' / ') || 'Not set'}
                </span>
              ),
            },
            {
              key: 'spend',
              header: 'Spend',
              width: 130,
              align: 'right',
              render: (row) => (
                <span className="tabular-nums">{formatCurrency(row.spend, row.currency)}</span>
              ),
            },
            {
              key: 'dates',
              header: 'Running',
              width: 200,
              render: (row) => (
                <span className="text-secondary">
                  {row.startsOn || row.endsOn ? `${row.startsOn ?? '…'} to ${row.endsOn ?? '…'}` : 'No dates set'}
                </span>
              ),
            },
          ]}
        />

        <Pagination
          count={page.rows.length}
          offset={offset}
          total={page.total}
          perPage={PER_PAGE}
          noun="campaigns"
          onPrevious={() => move(Math.max(offset - PER_PAGE, 0))}
          onNext={() => move(offset + PER_PAGE)}
        />
      </div>

      {editing ? (
        <CampaignEditor
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load(offset, search.trim())
          }}
        />
      ) : null}
    </Card>
  )
}

const CampaignEditor = ({
  row,
  onClose,
  onSaved,
}: {
  row: CampaignView
  onClose: () => void
  onSaved: () => void
}) => {
  const toast = useToast()
  const [draft, setDraft] = useState(row)
  const [spend, setSpend] = useState(String(row.spend))
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<CampaignView>) => setDraft((current) => ({ ...current, ...patch }))

  const amount = Number(spend)
  const valid = draft.name.trim() && draft.utmCampaign.trim() && Number.isFinite(amount) && amount >= 0

  const save = () => {
    setSaving(true)
    api.reporting.campaigns.save
      .mutate({
        id: draft.id || null,
        name: draft.name.trim(),
        source: draft.source?.trim() || null,
        medium: draft.medium?.trim() || null,
        utmCampaign: draft.utmCampaign.trim(),
        spend: amount,
        currency: draft.currency.trim().toUpperCase(),
        startsOn: draft.startsOn || null,
        endsOn: draft.endsOn || null,
      })
      .then(() => {
        toast('success', 'Saved. Contacts already carrying that utm_campaign are attached to it.')
        onSaved()
      })
      .catch((cause) => toast('error', errorMessage(cause)))
      .finally(() => setSaving(false))
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={draft.id ? draft.name : 'New campaign'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} disabled={!valid} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" id="campaign-name" hint="What your team calls it.">
          <TextInput id="campaign-name" value={draft.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>

        <Field
          label="utm_campaign"
          id="campaign-utm"
          hint="Exactly the value the ad links carry. This is what visits, submissions and contacts are matched on, so it has to match character for character apart from case."
        >
          <TextInput
            id="campaign-utm"
            value={draft.utmCampaign}
            onChange={(event) => set({ utmCampaign: event.target.value })}
          />
        </Field>

        <div className="flex flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <Field label="Source" id="campaign-source" hint="google, linkedin, newsletter.">
              <TextInput
                id="campaign-source"
                value={draft.source ?? ''}
                onChange={(event) => set({ source: event.target.value })}
              />
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Medium" id="campaign-medium" hint="cpc, email, social.">
              <TextInput
                id="campaign-medium"
                value={draft.medium ?? ''}
                onChange={(event) => set({ medium: event.target.value })}
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <Field label="Spend" id="campaign-spend" hint="Total, over the whole campaign.">
              <TextInput
                id="campaign-spend"
                inputMode="decimal"
                value={spend}
                onChange={(event) => setSpend(event.target.value)}
              />
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Currency" id="campaign-currency" hint="Three letters, e.g. USD.">
              <TextInput
                id="campaign-currency"
                maxLength={3}
                value={draft.currency}
                onChange={(event) => set({ currency: event.target.value.toUpperCase() })}
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <Field label="Starts" id="campaign-starts">
              <TextInput
                id="campaign-starts"
                type="date"
                value={draft.startsOn ?? ''}
                onChange={(event) => set({ startsOn: event.target.value || null })}
              />
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Ends" id="campaign-ends">
              <TextInput
                id="campaign-ends"
                type="date"
                value={draft.endsOn ?? ''}
                onChange={(event) => set({ endsOn: event.target.value || null })}
              />
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  )
}
