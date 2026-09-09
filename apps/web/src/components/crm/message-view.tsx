'use client'

import type { ThreadMessage } from '@rawr/db'
import { Badge, Button } from '@rawr/ui'
import { Paperclip } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatDateTime } from './value.tsx'

/** One message, with its stored body.
 *
 *  Sender HTML is rendered inside an iframe with an empty sandbox: no scripts, no
 *  forms, no navigation, no access to this page. It is also sanitised before it is
 *  stored, so this is the second of two defences rather than the only one. Remote
 *  images stay blocked until asked for, because loading one tells the sender the
 *  mail was opened and by whom. */
export const MessageView = ({ message }: { message: ThreadMessage }) => {
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

  // The frame has no layout of its own, so it is measured after it paints and
  // again when its content settles. Capped: a marketing mail is not a page.
  useEffect(() => {
    if (!document_ || !showHtml) return
    const measure = () => {
      const body = frame.current?.contentDocument?.body
      if (body) setHeight(Math.min(Math.max(body.scrollHeight + 16, 60), 900))
    }
    const timer = window.setTimeout(measure, 60)
    return () => window.clearTimeout(timer)
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
          {formatDateTime(message.sentAt)}
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
          sandbox=""
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
