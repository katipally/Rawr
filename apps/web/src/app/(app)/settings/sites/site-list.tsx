'use client'

import { Button, Field, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDateTime } from '~/components/crm/value.tsx'

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
  const router = useRouter()
  const toast = useToast()
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [siteKey, setSiteKey] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      await api.analytics.sites.create.mutate({ name, host, siteKey })
      setName('')
      setHost('')
      setSiteKey('')
      toast('success', 'Site added. Paste its snippet into the page template.')
      router.refresh()
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

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-panel border border-line bg-surface p-3">
        <h2 className="mb-2 font-medium">Add a site</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="site-name" label="Name">
            <TextInput
              id="site-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Marketing site"
            />
          </Field>
          <Field id="site-host" label="Host">
            <TextInput
              id="site-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="datasaur.ai"
            />
          </Field>
          <Field
            id="site-key"
            label="Site key"
            hint="Goes in the snippet, so it is public. It names the workspace and nothing else."
          >
            <TextInput
              id="site-key"
              value={siteKey}
              onChange={(event) => setSiteKey(event.target.value)}
              placeholder="datasaur-www"
            />
          </Field>
        </div>
        <div className="mt-3">
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim() || !host.trim() || !siteKey.trim()}
            onClick={() => void create()}
          >
            Add site
          </Button>
        </div>
      </section>

      {rows.length === 0 ? (
        <p className="text-secondary">
          No sites yet. Nothing is collected until one exists, because the collector resolves this
          workspace from the site key and refuses anything it cannot place.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-panel border border-line bg-surface p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 break-words font-medium">
                  {row.name} <span className="text-secondary">· {row.host}</span>
                </p>
                <p className="text-small text-secondary">
                  {row.pageViews.toLocaleString()} page views
                  {row.lastEventAt ? ` · last ${formatDateTime(row.lastEventAt)}` : ' · nothing yet'}
                </p>
              </div>

              <pre className="mt-2 overflow-x-auto rounded-hs bg-fill px-2 py-1 text-small">
                {snippet(baseUrl, row.siteKey)}
              </pre>

              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => void copy(snippet(baseUrl, row.siteKey))}>Copy snippet</Button>
                <Button variant="tertiary" onClick={() => void toggle(row)}>
                  {row.isActive ? 'Stop collecting' : 'Start collecting'}
                </Button>
                {row.isActive ? null : <span className="text-secondary">Off. Beacons are refused.</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
