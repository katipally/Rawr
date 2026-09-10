'use client'

import type { MessageEngagement, ThreadMessage } from '@rawr/db'
import { Badge, Button } from '@rawr/ui'
import { Paperclip } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatDateTime } from './value.tsx'
import { useZone } from '~/components/zone.tsx'

/** Item 16. What this mail did after it left, for the ones that carried tracking.
 *
 *  Opens are counted every fetch and never deduplicated, which is deliberate and
 *  also why the sentence says what it says: Apple Mail Privacy Protection fetches
 *  the pixel on the recipient's behalf, so an open is weaker evidence than a
 *  click. The strip says both numbers and lets the reader weigh them rather than
 *  presenting one confident figure. */
const Engagement = ({ engagement, zone }: { engagement: MessageEngagement; zone: string }) => (
  <div className="mt-2 flex flex-col gap-1 rounded-hs bg-fill px-3 py-2 text-small">
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="font-medium">
        {engagement.opens === 0
          ? 'Not opened yet'
          : `Opened ${engagement.opens.toLocaleString()} time${engagement.opens === 1 ? '' : 's'}`}
      </span>
      {engagement.firstOpenedAt ? (
        <span className="text-secondary">First {formatDateTime(engagement.firstOpenedAt, zone)}</span>
      ) : null}
      {engagement.lastOpenedAt && engagement.opens > 1 ? (
        <span className="text-secondary">Last {formatDateTime(engagement.lastOpenedAt, zone)}</span>
      ) : null}
    </p>
    {engagement.links.length > 0 ? (
      <ul className="flex flex-col gap-0.5">
        {engagement.links.map((link) => (
          <li key={link.url} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="min-w-0 break-all text-secondary">{link.url}</span>
            <span className="shrink-0 tabular-nums">
              {link.clicks.toLocaleString()} click{link.clicks === 1 ? '' : 's'}
            </span>
          </li>
        ))}
      </ul>
    ) : null}
  </div>
)

/** One message, with its stored body.
 *
 *  Sender HTML is rendered inside a sandboxed iframe. The sandbox grants only
 *  `allow-same-origin`, and never `allow-scripts`, so nothing in the mail runs:
 *  script elements, event handlers and javascript: URLs are stripped before the
 *  body is stored, and the sandbox refuses to execute them even if one survived.
 *  Same-origin is what makes the frame measurable, and a frame nobody can measure
 *  is a mail cropped at an arbitrary height. Remote images stay blocked until
 *  asked for, because loading one tells the sender the mail was opened and by
 *  whom. */
export const MessageView = ({ message }: { message: ThreadMessage }) => {
  const zone = useZone()
  const [showHtml, setShowHtml] = useState(true)
  const [loadImages, setLoadImages] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)

  const html = message.html
  const hasImages = html !== null && /<img\b/i.test(html)

  // The frame carries no network permission for images until asked; stripping the
  // src is what actually stops the request, since a CSP inside a sandboxed
  // srcdoc frame is not something we can rely on across browsers.
  const document_ =
    html === null
      ? null
      : `<!doctype html><meta charset="utf-8"><base target="_blank">` +
        `<style>html,body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#33475b;word-break:break-word}` +
        `img{max-width:100%;height:auto}blockquote{margin:0 0 0 1em;padding-left:.75em;border-left:2px solid #cbd6e2;color:#516f90}` +
        `a{color:#007d96}table{max-width:100%}</style>` +
        (loadImages ? html : html.replace(/(<img\b[^>]*?)\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1'))

  // The frame has no layout of its own, so it is measured once its document
  // exists and then watched: a table reflowing on a resize, or an image arriving
  // late, changes the height after the first paint. Capped both ways, because a
  // marketing mail is not a page. Where the document cannot be read at all the
  // fallback height stands and the frame scrolls itself.
  useEffect(() => {
    const box = frame.current
    if (!document_ || !showHtml || !box) return
    let observer: ResizeObserver | null = null

    const measure = () => {
      const body = box.contentDocument?.body
      if (!body) return
      setHeight(Math.min(Math.max(body.scrollHeight + 16, 60), 900))
      if (observer) return
      observer = new ResizeObserver(measure)
      observer.observe(body)
    }

    // srcdoc may have parsed already, or may still be on its way.
    measure()
    box.addEventListener('load', measure)
    return () => {
      box.removeEventListener('load', measure)
      observer?.disconnect()
    }
  }, [document_, showHtml])

  return (
    <article className="rounded-hs border border-line bg-surface px-3 py-2">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-small">
        <span className="min-w-0 break-all font-medium">
          {message.direction === 'outbound' ? 'To ' : 'From '}
          {message.direction === 'outbound'
            ? message.toAddrs.join(', ') || '(nobody)'
            : (message.fromAddr ?? '(unknown)')}
        </span>
        <time className="text-secondary tabular-nums" dateTime={new Date(message.sentAt).toISOString()}>
          {formatDateTime(message.sentAt, zone)}
        </time>
      </header>
      {message.ccAddrs.length > 0 ? (
        <p className="break-all text-small text-secondary">cc {message.ccAddrs.join(', ')}</p>
      ) : null}

      {message.bodyState === 'pending' ? (
        <p className="mt-1 break-words text-secondary">
          {message.snippet ?? '(no preview)'}
          <span className="mt-1 block text-small">The rest of this message has not been fetched yet.</span>
        </p>
      ) : message.bodyState === 'failed' ? (
        <p className="mt-1 break-words text-secondary">
          {message.snippet ?? '(no preview)'}
          <span className="mt-1 block text-small text-warning">
            {message.bodyError ?? 'The body could not be fetched.'}
          </span>
        </p>
      ) : html !== null && showHtml ? (
        <iframe
          ref={frame}
          title={`Message from ${message.fromAddr ?? 'unknown sender'}`}
          sandbox="allow-same-origin"
          srcDoc={document_ ?? ''}
          style={{ height }}
          className="mt-2 w-full border-0"
        />
      ) : (
        <pre className="mt-2 max-h-[60vh] overflow-auto break-words font-[inherit] text-body whitespace-pre-wrap">
          {message.text ?? message.snippet ?? '(no readable text)'}
          {message.truncated
            ? '\n\n[This message was longer than is kept here. Open it in Gmail for the rest.]'
            : ''}
        </pre>
      )}

      {message.engagement ? <Engagement engagement={message.engagement} zone={zone} /> : null}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-small">
        {html !== null ? (
          <Button variant="tertiary" onClick={() => setShowHtml((value) => !value)}>
            {showHtml ? 'Show plain text' : 'Show formatted'}
          </Button>
        ) : null}
        {hasImages && showHtml && !loadImages ? (
          <Button variant="tertiary" onClick={() => setLoadImages(true)}>
            Load images
          </Button>
        ) : null}
        {hasImages && loadImages ? <span className="text-secondary">Images loaded from the sender.</span> : null}
        {message.attachments.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Paperclip aria-hidden="true" className="size-3.5 text-secondary" />
            {message.attachments.map((file) => (
              <Badge key={file.id}>
                {file.filename}
                {file.sizeBytes > 0 ? ` · ${Math.max(1, Math.round(file.sizeBytes / 1024))} KB` : ''}
              </Badge>
            ))}
          </span>
        ) : null}
      </div>
    </article>
  )
}
