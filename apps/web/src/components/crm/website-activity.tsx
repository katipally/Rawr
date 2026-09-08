'use client'

import { Button, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { recordPath } from '~/lib/links.ts'
import { formatDateTime } from './value.tsx'

export type WebsiteActivityProps = {
  account: string
  contactId: string
  contactName: string
  siteVisits: number
  pagesViewed: number
  lastSeenAt: string | null
  /** How many browsers this person has been identified on. Phone plus laptop is
   *  two, and saying so is what makes an otherwise puzzling count readable. */
  devices: number
  isAdmin: boolean
}

/** The panel HubSpot shows on a contact: N SITE VISITS, N PAGES VIEWED, and the
 *  most recent visit. Numbers come from the maintained counter, so this renders in
 *  the same time for a contact with three views and one with twenty thousand.
 *
 *  The two data-subject buttons live here because this is the panel that makes the
 *  obligation visible, and both are refused in the data access layer for anybody
 *  but an admin regardless of whether they are on screen. */
export const WebsiteActivity = ({
  account,
  contactId,
  contactName,
  siteVisits,
  pagesViewed,
  lastSeenAt,
  devices,
  isAdmin,
}: WebsiteActivityProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState<'export' | 'erase' | null>(null)
  const [confirming, setConfirming] = useState(false)

  const nothingYet = siteVisits === 0 && pagesViewed === 0

  const download = async () => {
    setBusy('export')
    try {
      const data = await api.analytics.exportContact.mutate({ contactId })
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `rawr-activity-${contactId}.json`
      link.click()
      URL.revokeObjectURL(url)
      toast('success', 'Export downloaded.')
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const erase = async () => {
    setBusy('erase')
    try {
      const result = await api.analytics.eraseContact.mutate({ contactId })
      toast(
        'success',
        `Erased ${result.pageViews} page view${result.pageViews === 1 ? '' : 's'} and ${result.events} event${result.events === 1 ? '' : 's'}.`,
      )
      setConfirming(false)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-panel border border-line bg-surface shadow-panel">
      <h3 className="px-6 pt-6 pb-4 text-base font-semibold">Website activity</h3>

      {nothingYet ? (
        <p className="px-6 py-2 text-secondary">
          Nothing yet. Page views appear here once {contactName} has browsed the site with
          analytics cookies accepted.
        </p>
      ) : (
        <>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 px-6 py-2">
            <div>
              <dt className="text-small text-secondary uppercase">Site visits</dt>
              <dd className="text-lg">{siteVisits.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-small text-secondary uppercase">Pages viewed</dt>
              <dd className="text-lg">{pagesViewed.toLocaleString()}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-small text-secondary uppercase">Most recent visit</dt>
              <dd className="break-words">{lastSeenAt ? formatDateTime(lastSeenAt) : '—'}</dd>
            </div>
          </dl>

          <p className="px-6 pb-2">
            <Link
              className="text-link"
              href={recordPath(account, 'contact', contactId, { type: 'page_view' })}
            >
              See every page view on the timeline
            </Link>
            {devices > 1 ? (
              <span className="text-secondary"> · identified on {devices} browsers</span>
            ) : null}
          </p>
        </>
      )}

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider px-6 py-2">
          <Button busy={busy === 'export'} onClick={() => void download()}>
            Export activity
          </Button>
          {confirming ? (
            <>
              <span className="text-error">
                Erasing removes every page view, event and consent record. It cannot be undone.
              </span>
              <Button variant="primary" busy={busy === 'erase'} onClick={() => void erase()}>
                Erase permanently
              </Button>
              <Button variant="tertiary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="tertiary" onClick={() => setConfirming(true)}>
              Erase activity
            </Button>
          )}
        </div>
      ) : null}
    </section>
  )
}
