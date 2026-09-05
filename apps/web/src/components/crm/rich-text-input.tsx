'use client'

import { IconButton, TextArea } from '@rawr/ui'
import { Bold, Eye, Italic, Link2, List, ListOrdered, Pencil } from 'lucide-react'
import { useRef, useState } from 'react'
import { Markdown } from './markdown.tsx'

/** Writing Markdown, with the marks put in for you.
 *
 *  A textarea and a preview rather than a what-you-see editor, and that is a
 *  choice rather than a shortcut. A contenteditable editor means shipping a
 *  document model, keeping HTML in the column, and sanitising it forever after;
 *  this keeps the stored value as the characters somebody typed, which is why
 *  nothing in the render path has anything to sanitise.
 *
 *  The toolbar exists because nobody should have to know Markdown to write bold.
 *  Anybody who does know it can ignore the buttons and type. */

type Wrap = { before: string; after: string }

const MARKS: Record<'bold' | 'italic' | 'code' | 'link', Wrap> = {
  bold: { before: '**', after: '**' },
  italic: { before: '*', after: '*' },
  code: { before: '`', after: '`' },
  link: { before: '[', after: '](https://)' },
}

export const RichTextInput = ({
  id,
  label,
  value,
  onChange,
  autoFocus,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) => {
  const area = useRef<HTMLTextAreaElement>(null)
  const [previewing, setPreviewing] = useState(false)

  /** Wraps the selection, or drops the marks where the caret is and puts the
   *  caret between them, which is what every editor does and what a person
   *  expects when they press bold with nothing selected. */
  const wrap = (mark: Wrap) => {
    const node = area.current
    if (!node) return
    const { selectionStart: start, selectionEnd: end } = node
    const selected = value.slice(start, end)
    const next = `${value.slice(0, start)}${mark.before}${selected}${mark.after}${value.slice(end)}`
    onChange(next)
    // After React has written the new value, not before it.
    queueMicrotask(() => {
      node.focus()
      const caret = start + mark.before.length + selected.length
      node.setSelectionRange(caret, caret)
    })
  }

  /** Puts a marker at the start of each selected line, so turning three lines
   *  into a list is one press rather than three. */
  const prefix = (marker: (index: number) => string) => {
    const node = area.current
    if (!node) return
    const { selectionStart: start, selectionEnd: end } = node
    const from = value.lastIndexOf('\n', start - 1) + 1
    const to = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end)
    const lines = value.slice(from, to).split('\n')
    const marked = lines.map((line, index) => (line.trim() ? `${marker(index)}${line}` : line)).join('\n')
    onChange(`${value.slice(0, from)}${marked}${value.slice(to)}`)
    queueMicrotask(() => node.focus())
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-0.5">
        <IconButton label="Bold" icon={<Bold size={16} />} disabled={previewing} onClick={() => wrap(MARKS.bold)} />
        <IconButton label="Italic" icon={<Italic size={16} />} disabled={previewing} onClick={() => wrap(MARKS.italic)} />
        <IconButton label="Link" icon={<Link2 size={16} />} disabled={previewing} onClick={() => wrap(MARKS.link)} />
        <IconButton
          label="Bulleted list"
          icon={<List size={16} />}
          disabled={previewing}
          onClick={() => prefix(() => '- ')}
        />
        <IconButton
          label="Numbered list"
          icon={<ListOrdered size={16} />}
          disabled={previewing}
          onClick={() => prefix((index) => `${index + 1}. `)}
        />
        <span className="ml-auto">
          <IconButton
            label={previewing ? 'Back to editing' : 'Preview'}
            tone={previewing ? 'accent' : 'default'}
            icon={previewing ? <Pencil size={16} /> : <Eye size={16} />}
            onClick={() => setPreviewing((open) => !open)}
          />
        </span>
      </div>

      {previewing ? (
        // Min-height matching the textarea, so pressing preview does not make the
        // form jump under the pointer that pressed it.
        <div className="min-h-24 rounded-hs border border-line bg-fill p-3">
          {value.trim() ? (
            <Markdown source={value} />
          ) : (
            <p className="text-secondary">Nothing written yet.</p>
          )}
        </div>
      ) : (
        <TextArea
          id={id}
          ref={area}
          aria-label={label}
          autoFocus={autoFocus}
          className="min-h-24"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  )
}
