'use client'

import { useState } from 'react'
import { Button } from '@rawr/ui'

/** What a marketer takes away from this screen: the two lines that go in Webflow,
 *  the address for anywhere a script tag is not welcome, and the properties to
 *  set if the site wants the form to look like something else.
 *
 *  That third one is the point. The HubSpot forms live on datasaur.ai today carry
 *  a block of hand-written override CSS each, several rules with !important, one
 *  of which hides the validation errors outright, because the HubSpot embed ships
 *  a stylesheet the page then has to fight. This embed ships custom properties
 *  instead, so restyling is setting values rather than winning a specificity
 *  argument, and this panel is where somebody finds out that is possible. */

type Copyable = { id: string; label: string; hint?: string; value: string; lang?: 'html' | 'css' }

export const EmbedSnippet = ({
  baseUrl,
  formId,
  account,
  slug,
}: {
  baseUrl: string
  formId: string
  account: string
  slug: string
}) => {
  const [copied, setCopied] = useState<string | null>(null)

  const blocks: Copyable[] = [
    {
      id: 'embed',
      label: 'Paste into Webflow',
      hint: 'An Embed element on the page, and the script once anywhere in the site footer.',
      lang: 'html',
      value:
        `<div data-rawr-form="${formId}"></div>\n` +
        `<script src="${baseUrl}/embed.js" data-rawr-site="${account}" data-rawr-consent defer></script>`,
    },
    {
      id: 'hosted',
      label: 'Or link to the hosted page',
      hint: 'Works with JavaScript blocked or turned off entirely.',
      value: `${baseUrl}/form/${account}/${slug}`,
    },
    {
      id: 'theme',
      label: 'Restyle it from the site',
      hint: 'Set any of these on the container or an ancestor. No !important, no overrides.',
      lang: 'css',
      value:
        `[data-rawr-form="${formId}"] {\n` +
        '  --rawr-embed-font: inherit;\n' +
        '  --rawr-embed-text: #33475b;\n' +
        '  --rawr-embed-border: #cbd6e2;\n' +
        '  --rawr-embed-field-bg: #ffffff;\n' +
        '  --rawr-embed-cta: #ff7a59;\n' +
        '  --rawr-embed-cta-text: #ffffff;\n' +
        '  --rawr-embed-radius: 3px;\n' +
        '  --rawr-embed-gap: 1rem;\n' +
        '}',
    },
  ]

  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(id)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // Clipboard access is refused in some contexts. The text is on screen and
      // selectable, so there is still a way to get it.
      setCopied('failed')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block) => (
        <div key={block.id} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-sm font-medium">{block.label}</span>
            <Button type="button" variant="tertiary" onClick={() => void copy(block.id, block.value)}>
              {copied === block.id ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {block.hint ? <p className="m-0 text-small text-secondary">{block.hint}</p> : null}
          {/* Scrolls inside itself. A long base URL or a wide selector must not
              make the dialog behind it scroll sideways. */}
          <pre className="m-0 overflow-x-auto rounded-hs bg-fill p-2 font-mono text-[11px] leading-relaxed">
            {block.value}
          </pre>
        </div>
      ))}

      {copied === 'failed' ? (
        <p className="m-0 text-small text-error">
          The browser refused clipboard access. Select the text above instead.
        </p>
      ) : null}
    </div>
  )
}
