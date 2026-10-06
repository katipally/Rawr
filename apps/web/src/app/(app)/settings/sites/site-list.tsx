'use client'

import { Button, DataTable, EmptyState, Field, Modal, TextInput, useToast, type Column } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { RowActions, StatusDot, rowPill } from '~/components/row-actions.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'

export type SiteListRow = {
  id: string
  name: string
  host: string
  siteKey: string
  isActive: boolean
  pageViews: number
  lastEventAt: string | null
}

export type SiteListProps = {
  rows: SiteListRow[]
  baseUrl: string
}

/** The snippet marketing pastes into Webflow. One script, carrying the consent
 *  banner, the forms and the collector, so the site loads one file rather than
 *  three. `data-rawr-consent` is what turns the banner on: without it nothing is
 *  collected, which is the safe direction for a page that forgot it. */
const snippet = (baseUrl: string, siteKey: string): string =>
  `<script async src="${baseUrl}/embed.js" data-rawr-site="${siteKey}" data-rawr-consent></script>`

export const SiteList = ({ rows, baseUrl }: SiteListProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [siteKey, setSiteKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [showing, setShowing] = useState<SiteListRow | null>(null)

  const create = async () => {
    setBusy(true)
    try {
      await api.analytics.sites.create.mutate({ name, host, siteKey })
      setName('')
      setHost('')
      setSiteKey('')
      toast('success', 'Site added. Paste its snippet into the page template.')
      router.refresh()
      setAdding(false)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (row: SiteListRow) => {
    try {
      await api.analytics.sites.setActive.mutate({ id: row.id, isActive: !row.isActive })
      toast(
        'success',
        row.isActive
          ? `${row.host} is off. Its beacons are refused from now on.`
          : `${row.host} is collecting again.`,
      )
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast('success', 'Snippet copied.')
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The snippet
      // is on screen and selectable, so this is a convenience, not the only path.
      toast('error', 'Copying was refused by the browser. Select the snippet and copy it by hand.')
    }
  }

  const columns: Column<SiteListRow>[] = [
    {
      key: 'name',
      header: 'Site',
      width: 360,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-1 flex-col">
            <span title={row.name} className="truncate font-semibold">{row.name}</span>
            <span title={row.host} className="truncate text-small font-light text-secondary">{row.host}</span>
          </span>
          <RowActions>
            <button type="button" className={rowPill} onClick={() => setShowing(row)}>
              Tracking code
            </button>
            <button type="button" className={rowPill} onClick={() => void toggle(row)}>
              {row.isActive ? 'Stop collecting' : 'Start collecting'}
            </button>
          </RowActions>
        </span>
      ),
    },
    { key: 'key', header: 'Site key', width: 200, render: (row) => <code title={row.siteKey} className="block truncate text-secondary">{row.siteKey}</code> },
    { key: 'status', header: 'Status', width: 140, render: (row) => <StatusDot tone={row.isActive ? 'live' : 'off'}>{row.isActive ? 'Collecting' : 'Off'}</StatusDot> },
    { key: 'views', header: 'Page views', width: 140, align: 'right', render: (row) => <span className="font-light tabular-nums">{fmt.number(row.pageViews)}</span> },
    { key: 'last', header: 'Last event', width: 200, render: (row) => <span className="font-light">{row.lastEventAt ? fmt.dateTime(row.lastEventAt) : EMPTY_VALUE}</span> },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0">Paste a site's tracking code into its page template. Nothing is collected from anyone who has not accepted analytics cookies.</p>
        <Button onClick={() => setAdding(true)}>Add site</Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No sites yet"
          description="Nothing is collected until one exists, because the collector resolves this account from the site key and refuses anything it cannot place."
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Tracked sites" storageKey="settings.sites" />
      )}

      <Modal
        open={adding}
        title="Add site"
        onClose={() => setAdding(false)}
        dirty={name !== '' || host !== '' || siteKey !== ''}
        onSubmit={() => void create()}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !host.trim() || !siteKey.trim()}>
              Add site
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="site-name" label="Name">
            <TextInput id="site-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Marketing site" />
          </Field>
          <Field id="site-host" label="Host">
            <TextInput id="site-host" value={host} onChange={(event) => setHost(event.target.value)} placeholder="example.com" />
          </Field>
          <Field id="site-key" label="Site key" hint="Goes in the snippet, so it is public. It names the account and nothing else.">
            <TextInput id="site-key" value={siteKey} onChange={(event) => setSiteKey(event.target.value)} placeholder="example-www" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={showing !== null}
        title={`Tracking code for ${showing?.host ?? ''}`}
        onClose={() => setShowing(null)}
        footer={
          showing ? (
            <Button variant="primary" onClick={() => void copy(snippet(baseUrl, showing.siteKey))}>
              Copy
            </Button>
          ) : null
        }
      >
        {showing ? (
          <div className="flex flex-col gap-3">
            <p>Set up tracking by embedding this code before the closing body tag of every page on {showing.host}.</p>
            <pre className="overflow-x-auto rounded-hs border border-line bg-fill px-3 py-2 text-small whitespace-pre-wrap break-all">{snippet(baseUrl, showing.siteKey)}</pre>
            {showing.isActive ? null : <p className="text-secondary">Off. Beacons from it are refused until it is collecting again.</p>}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
