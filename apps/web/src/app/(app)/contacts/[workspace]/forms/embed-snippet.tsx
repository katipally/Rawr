'use client'

import { useState } from 'react'
import { Button } from '@rawr/ui'

/** The two lines marketing pastes into Webflow, and the address of the hosted
 *  page for anywhere a script tag is not welcome.
 *
 *  Shown rather than hidden behind a modal, because copying this is the single
 *  most common thing anyone does on this screen. */

export const EmbedSnippet = ({
  baseUrl,
  formId,
  workspace,
  slug,
  open = false,
}: {
  baseUrl: string
  formId: string
  workspace: string
  slug: string
  /** Already unfolded, for a dialog that exists only to show it. */
  open?: boolean
}) => {
  const [copied, setCopied] = useState<string | null>(null)

  const snippet = `<div data-rawr-form="${formId}"></div>\n<script src="${baseUrl}/embed.js" data-rawr-site="${workspace}" data-rawr-consent defer></script>`
  const hosted = `${baseUrl}/form/${workspace}/${slug}`

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
      <summary className="cursor-pointer text-secondary">Embed code</summary>

      <div className="mt-2 flex flex-col gap-2">
        <pre className="overflow-x-auto rounded-hs bg-fill p-2 font-mono text-[11px] leading-relaxed">
          {snippet}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void copy('snippet', snippet)}>
            Copy embed
          </Button>
          <Button type="button" onClick={() => void copy('hosted', hosted)}>
            Copy hosted link
          </Button>
          {copied === 'failed' ? (
            <span className="text-error">
              The browser refused clipboard access. Select the text above instead.
            </span>
          ) : copied ? (
            <span className="text-success">Copied.</span>
          ) : null}
        </div>
        <p className="break-all text-secondary">
          Works without JavaScript at <span className="font-mono">{hosted}</span>
        </p>
      </div>
    </details>
  )
}
