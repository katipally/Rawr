'use client'

import { Button, Modal, cn, useToast } from '@rawr/ui'
import { rowPill } from '~/components/row-actions.tsx'

/** The line marketing pastes into Webflow, and the hosted address for an email
 *  signature. The script embed and the hosted page are the same route, so if the
 *  script is blocked the link still works. F2 §7. */

export const hostedBookingUrl = (baseUrl: string, account: string, slug: string): string =>
  `${baseUrl}/b/${account}/${slug}`

/** Copies a page's public address or its code and says so. A refused clipboard
 *  is said too, since the text is on screen to select by hand. */
export const useCopy = () => {
  const toast = useToast()
  return async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast('success', `${what} copied.`)
    } catch {
      toast('error', 'The browser refused clipboard access. Select the text instead.')
    }
  }
}

/** HubSpot's Embed Widget dialog: the page's name and address, the code in a
 *  box, Copy code joined to Copy link, and Close. */
export const EmbedDialog = ({
  baseUrl,
  account,
  page,
  onClose,
}: {
  baseUrl: string
  account: string
  page: { name: string; slug: string } | null
  onClose: () => void
}) => {
  const copy = useCopy()
  const hosted = page ? hostedBookingUrl(baseUrl, account, page.slug) : ''
  const snippet = page
    ? `<div data-rawr-booking="${account}/${page.slug}"></div>\n<script src="${baseUrl}/booking.js" defer></script>\n<noscript><a href="${hosted}">Book a meeting</a></noscript>`
    : ''

  return (
    <Modal
      open={page !== null}
      title="Embed Widget"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {page ? (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="min-w-0">
            <p className="text-base font-semibold">{page.name}</p>
            <p className="break-all">{hosted}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="font-semibold">Embed code</h3>
            <p className="text-small">Puts the booking widget on your website, sized to the column it sits in.</p>
            <pre className="max-h-40 overflow-auto rounded-hs border border-line-strong bg-fill p-3 font-mono text-small break-all whitespace-pre-wrap">
              {snippet}
            </pre>
          </div>
          <div className="flex">
            <button type="button" className={cn(rowPill, 'rounded-r-none')} onClick={() => void copy(snippet, 'Embed code')}>
              Copy code
            </button>
            <button type="button" className={cn(rowPill, '-ml-px rounded-l-none')} onClick={() => void copy(hosted, 'Link')}>
              Copy link
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
