'use client'

import { Button, IconButton, TextInput, cn } from '@rawr/ui'
import { Bold, Italic, Link2, List, ListOrdered } from 'lucide-react'
import { type ClipboardEvent, type KeyboardEvent, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { boldPressed } from '~/lib/bold-mark.ts'
import { linkTarget } from '~/lib/mail-compose.ts'

/** The body of an email, written with the marks put in for you.
 *
 *  A contenteditable surface and a toolbar of the five things a message needs:
 *  bold, italic, a link, a bulleted list and a numbered list. The browser does the
 *  editing through `execCommand`, which is deprecated but is still the one editing
 *  API every browser keeps working for this. The HTML it produces is cleaned on the
 *  server before anything is sent, so this surface is not the line of defence.
 *
 *  Paste is taken as plain text. Pasting HTML from a web page brings its styles and
 *  its scripts along, and the cleaning would have to explain each one afterwards. */

const MARKS = ['bold', 'italic', 'insertUnorderedList', 'insertOrderedList'] as const
type Command = (typeof MARKS)[number]
type Marks = Record<Command, boolean>

const NO_MARKS: Marks = { bold: false, italic: false, insertUnorderedList: false, insertOrderedList: false }

export type RichEditorHandle = {
  /** Puts HTML in at the last place the caret was, or at the end when it never was. */
  insert: (html: string) => void
}

const selectionIn = (node: HTMLElement): Range | null => {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !node.contains(selection.anchorNode)) return null
  return selection.getRangeAt(0).cloneRange()
}

const boldAt = (root: HTMLElement, caret: Range | null): HTMLElement | null => {
  const node = caret?.startContainer
  const element = node instanceof Element ? node : node?.parentElement
  const bold = element?.closest<HTMLElement>('b, strong') ?? null
  return bold && root.contains(bold) ? bold : null
}

const endOf = (node: HTMLElement): Range => {
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(false)
  return range
}

const placeCaret = (range: Range): void => {
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export const RichEditor = ({
  id,
  label,
  value,
  onChange,
  disabled = false,
  autoFocus = false,
  ref,
}: {
  id: string
  label: string
  /** The HTML to show. Set from outside (a draft, a template) and echoed back on every
   *  keystroke, which is why it is only written when it differs from what is on screen. */
  value: string
  onChange: (html: string) => void
  disabled?: boolean | undefined
  autoFocus?: boolean | undefined
  ref?: Ref<RichEditorHandle> | undefined
}) => {
  const surface = useRef<HTMLDivElement>(null)
  const lastCaret = useRef<Range | null>(null)
  const [marks, setMarks] = useState<Marks>(NO_MARKS)
  const [linking, setLinking] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)

  useEffect(() => {
    const node = surface.current
    if (node && node.innerHTML !== value) node.innerHTML = value
  }, [value])

  useEffect(() => {
    if (autoFocus) surface.current?.focus()
  }, [autoFocus])

  /** Reads the marks at the caret. selectionchange does not fire when a command changes
   *  the text but not the selection, so every command and edit reads them too. */
  const refreshMarks = useCallback(() => {
    const node = surface.current
    const caret = node && selectionIn(node)
    if (!node || !caret) return
    lastCaret.current = caret
    setMarks({
      bold: boldPressed(document.queryCommandState('bold'), boldAt(node, caret) !== null),
      italic: document.queryCommandState('italic'),
      insertUnorderedList: document.queryCommandState('insertUnorderedList'),
      insertOrderedList: document.queryCommandState('insertOrderedList'),
    })
  }, [])

  useEffect(() => {
    document.addEventListener('selectionchange', refreshMarks)
    return () => document.removeEventListener('selectionchange', refreshMarks)
  }, [refreshMarks])

  const emit = () => {
    if (!surface.current) return
    onChange(surface.current.innerHTML)
    refreshMarks()
  }

  /** Focus back in the surface, with the caret where it was. Needed when a toolbar
   *  button or the link field took the focus. */
  const returnTo = (): HTMLElement | null => {
    const node = surface.current
    if (!node) return null
    if (document.activeElement !== node) {
      node.focus()
      if (lastCaret.current && node.contains(lastCaret.current.startContainer)) placeCaret(lastCaret.current)
      else placeCaret(endOf(node))
    }
    return node
  }

  const run = (command: Command) => {
    const node = returnTo()
    if (!node) return
    const bold = command === 'bold' ? boldAt(node, selectionIn(node)) : null
    // A bold run the browser reports as not bold would be bolded again, so it is unwrapped.
    if (bold && !document.queryCommandState('bold')) bold.replaceWith(...bold.childNodes)
    else document.execCommand(command)
    emit()
  }

  useImperativeHandle(ref, () => ({
    insert: (html) => {
      const node = returnTo()
      if (!node) return
      document.execCommand('insertHTML', false, html)
      emit()
    },
  }))

  const openLink = () => {
    const caret = surface.current && selectionIn(surface.current)
    if (caret) lastCaret.current = caret
    setLinkError(null)
    setLinking('')
  }

  const closeLink = () => {
    setLinking(null)
    setLinkError(null)
    surface.current?.focus()
  }

  const applyLink = () => {
    const target = linkTarget(linking ?? '')
    if (!target) {
      setLinkError('That is not a web address or an email address.')
      return
    }
    const node = returnTo()
    if (!node) return
    const caret = lastCaret.current && node.contains(lastCaret.current.startContainer) ? lastCaret.current : endOf(node)
    if (caret.collapsed) {
      // Nothing selected: the address itself becomes the link text, so a link is never invisible.
      const anchor = document.createElement('a')
      anchor.href = target
      anchor.textContent = target
      caret.insertNode(anchor)
      const after = document.createRange()
      after.setStartAfter(anchor)
      after.collapse(true)
      placeCaret(after)
    } else {
      placeCaret(caret)
      document.execCommand('createLink', false, target)
    }
    setLinking(null)
    setLinkError(null)
    emit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 'b' || key === 'i') {
      event.preventDefault()
      run(key === 'b' ? 'bold' : 'italic')
    } else if (key === 'k') {
      event.preventDefault()
      openLink()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
    emit()
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="toolbar"
        aria-label={`${label} formatting`}
        // A press on a button must not take the focus or the selection away from the text.
        onMouseDown={(event) => event.preventDefault()}
        className="flex flex-wrap items-center gap-0.5"
      >
        <IconButton
          label="Bold (Ctrl or Cmd+B)"
          icon={<Bold aria-hidden="true" className="size-4" />}
          aria-pressed={marks.bold}
          tone={marks.bold ? 'accent' : 'default'}
          disabled={disabled}
          onClick={() => run('bold')}
        />
        <IconButton
          label="Italic (Ctrl or Cmd+I)"
          icon={<Italic aria-hidden="true" className="size-4" />}
          aria-pressed={marks.italic}
          tone={marks.italic ? 'accent' : 'default'}
          disabled={disabled}
          onClick={() => run('italic')}
        />
        <IconButton
          label="Link (Ctrl or Cmd+K)"
          icon={<Link2 aria-hidden="true" className="size-4" />}
          disabled={disabled}
          onClick={openLink}
        />
        <IconButton
          label="Bulleted list"
          icon={<List aria-hidden="true" className="size-4" />}
          aria-pressed={marks.insertUnorderedList}
          tone={marks.insertUnorderedList ? 'accent' : 'default'}
          disabled={disabled}
          onClick={() => run('insertUnorderedList')}
        />
        <IconButton
          label="Numbered list"
          icon={<ListOrdered aria-hidden="true" className="size-4" />}
          aria-pressed={marks.insertOrderedList}
          tone={marks.insertOrderedList ? 'accent' : 'default'}
          disabled={disabled}
          onClick={() => run('insertOrderedList')}
        />
      </div>

      {linking !== null ? (
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <TextInput
            aria-label="Link address"
            aria-invalid={linkError !== null}
            aria-describedby={linkError ? `${id}-link-error` : undefined}
            placeholder="https://"
            value={linking}
            className="min-w-0 flex-1"
            onChange={(event) => setLinking(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                // Enter here must not submit the whole message form.
                event.preventDefault()
                applyLink()
              } else if (event.key === 'Escape') {
                // Closes the link field, not the message.
                event.preventDefault()
                closeLink()
              }
            }}
          />
          <Button variant="secondary" onClick={applyLink}>
            Add link
          </Button>
          <Button variant="tertiary" onClick={closeLink}>
            Cancel
          </Button>
          {linkError ? (
            <p id={`${id}-link-error`} role="alert" className="w-full text-error">
              {linkError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold the formatting this surface exists for */}
      <div
        id={id}
        ref={surface}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        aria-disabled={disabled}
        contentEditable={!disabled}
        tabIndex={0}
        data-placeholder="Write your message"
        onInput={emit}
        onKeyUp={refreshMarks}
        onMouseUp={refreshMarks}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className={cn(
          'min-h-40 max-h-[50dvh] overflow-y-auto rounded-hs border border-line bg-fill px-3 py-2 text-body break-words outline-none',
          // Preflight sets b and strong to "bolder", which is 400 under the 300 body weight: Chrome reads that as not bold.
          '[&_b]:font-bold [&_strong]:font-bold',
          'focus:border-line-interactive focus:bg-surface empty:before:pointer-events-none empty:before:text-secondary empty:before:content-[attr(data-placeholder)]',
          disabled && 'cursor-not-allowed border-dashed bg-transparent text-secondary',
        )}
      />
    </div>
  )
}
