'use client'

import { Button } from '@rawr/ui'
import { useState } from 'react'

/** The line marketing pastes into Webflow, and the hosted address for an email
 *  signature. Shown rather than hidden behind a modal, because copying one of
 *  these is the most common thing anyone does on this screen.
 *
 *  The script embed and the hosted page are the same route, so if the script is
 *  blocked the link still works. F2 §7. */

export const BookingLinkSnippet = ({
  baseUrl,
  account,
  slug,
  open,
}: {
  baseUrl: string
  account: string
  slug: string
  /** Expanded from the start, for a dialog that exists only to show it. */
  open?: boolean
}) => {
  const [copied, setCopied] = useState<string | null>(null)

  const hosted = `${baseUrl}/b/${account}/${slug}`
  const snippet = `<div data-rawr-booking="${account}/${slug}"></div>\n<script src="${baseUrl}/booking.js" defer></script>\n<noscript><a href="${hosted}">Book a meeting</a></noscript>`

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // Clipboard access is refused in some contexts. The text is on screen and
      // selectable, so there is still a way to get it.
      setCopied('failed')
    }
  }

  return (
    <details open={open} className="mt-1 text-xs">
      <summary className="cursor-pointer text-secondary">Link and embed code</summary>

      <div className="mt-2 flex flex-col gap-2">
        <p className="break-all font-mono text-[11px]">{hosted}</p>
        <pre className="overflow-x-auto rounded-hs bg-fill p-2 font-mono text-[11px] leading-relaxed">
          {snippet}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void copy('hosted', hosted)}>
            Copy link
          </Button>
          <Button type="button" onClick={() => void copy('snippet', snippet)}>
            Copy embed
          </Button>
          <a href={hosted} target="_blank" rel="noreferrer" className="font-semibold text-link">
            Open
          </a>
          {copied === 'failed' ? (
            <span className="text-error">
              The browser refused clipboard access. Select the text above instead.
            </span>
          ) : copied ? (
            <span className="text-success">Copied.</span>
          ) : null}
        </div>
      </div>
    </details>
  )
}
