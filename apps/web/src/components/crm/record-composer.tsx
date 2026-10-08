'use client'

import {
  Button,
  DiscardConfirm,
  IconButton,
  POP_EXIT_MS,
  TextArea,
  TextInput,
  cn,
  useDismiss,
  useMounted,
  usePresence,
  useToast,
} from '@rawr/ui'
import { ChevronDown, ChevronUp, Maximize2, Minimize2, X } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { announceChange } from '~/lib/record-events.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { replaceParams } from '~/lib/url-params.ts'
import { TaskForm } from './task-form.tsx'
import { LOGGABLE, type Loggable } from './timeline.tsx'
import { ACTIVITY_LABELS as TYPE_LABELS } from './value.tsx'

export type RecordComposerProps = {
  account: string
  /** An object key, core or invented. */
  object: string
  recordId: string
  canWrite: boolean
  assignees: { id: string; label: string }[]
  queues: { id: string; name: string }[]
}

type Interaction = Loggable | 'task'

/** Opens the composer on this page. `?interaction=` is HubSpot's own parameter;
 *  `log` and `task` are what older Rawr links carry, cleared so the two never
 *  disagree about which is open. */
export const openInteraction = (kind: Interaction | null): void =>
  replaceParams({ interaction: kind, log: null, task: null })

const interactionOf = (params: URLSearchParams): Interaction | null => {
  const asked = params.get('interaction') ?? params.get('log')
  if (asked === 'task' || params.get('task') === 'new') return 'task'
  return LOGGABLE.find((entry) => entry.type === asked)?.type ?? null
}

/** HubSpot's composer: a 580 by 436 window floating at the bottom right of the
 *  middle column, over the page rather than in it, so the record stays usable
 *  under it and the box is never five screens of properties away.
 *
 *  Which one is open is the address, so "log a call on this deal" is still a link
 *  somebody can be sent. It is changed with the History API rather than a
 *  navigation, because a navigation renders the whole record page again just to
 *  show a text box. */
export const RecordComposer = ({ account, object, recordId, canWrite, assignees, queues }: RecordComposerProps) => {
  const toast = useToast()
  const router = useRouter()
  const params = useSearchParams()
  const asked = interactionOf(params)
  // What was open, kept through the exit animation after the address lets go.
  const [last, setLast] = useState<Interaction | null>(asked)
  if (asked && asked !== last) setLast(asked)
  const { present, closing } = usePresence(canWrite && asked !== null, POP_EXIT_MS)
  const mode = asked ?? last
  const kind = LOGGABLE.find((entry) => entry.type === asked)?.type
  const [note, setNote] = useState('')
  const [happenedOn, setHappenedOn] = useState('')
  const [posting, setPosting] = useState(false)
  // The mode it was folded away on, so asking for another one unfolds it without
  // an effect to say so.
  const [foldedOn, setFoldedOn] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const mounted = useMounted()
  const logging = LOGGABLE.find((entry) => entry.type === mode)

  const close = () => {
    setFoldedOn(null)
    setExpanded(false)
    setNote('')
    setHappenedOn('')
    openInteraction(null)
  }
  // A task keeps its own draft, so only a typed note or a chosen date can be lost.
  const { asking, dismiss, keep, discard } = useDismiss(
    asked !== null,
    logging !== undefined && (note.trim() !== '' || happenedOn !== ''),
    close,
  )

  // A person who asked for a note wants the cursor in the box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` is the trigger, for a box that only exists once it is true
  useEffect(() => {
    if (kind) field.current?.focus()
  }, [kind, mounted])

  if (!present || mode === null || !mounted) return null

  // The question needs the room, so a folded composer opens to ask it.
  const folded = foldedOn === mode && !asking
  const title = mode === 'task' ? 'Task' : TYPE_LABELS[mode]

  const log = async () => {
    if (!logging) return
    setPosting(true)
    try {
      await api.crm.timeline.log.mutate({
        entity: { entityType: object, entityId: recordId },
        type: logging.type,
        body: note,
        // A bare date means midday local, so a call logged for yesterday does not
        // land on the day before in a zone behind the browser.
        ...(logging.dated && happenedOn ? { occurredAt: new Date(`${happenedOn}T12:00`) } : {}),
      })
      setNote('')
      setHappenedOn('')
      toast('success', `${TYPE_LABELS[logging.type]} added.`)
      announceChange('timeline')
      close()
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setPosting(false)
    }
  }

  return createPortal(
    // Portalled to the body: the app shell's content card is a containing block for
    // `position: fixed`, so in place this would float over the card, not the window.
    // Not modal. The page behind stays live, which is the point of it. Its right
    // edge clears the association column while the window has room for both,
    // and falls back to the window's edge when it does not.
    <section
      role="dialog"
      aria-label={title}
      data-closing={closing || undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        dismiss()
      }}
      className={cn(
        'fixed z-flyout flex origin-bottom-right animate-pop-in flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-panel transition-[height,width] duration-200 ease-out data-closing:animate-pop-out motion-reduce:animate-none',
        expanded
          ? 'top-[calc(var(--spacing-topbar)+1rem)] right-4 bottom-4 w-[min(64rem,calc(100vw-2rem))]'
          : cn(
              'right-[max(1rem,min(calc(var(--spacing-record-right)+2rem),calc(100vw-min(var(--spacing-composer-width),100vw-2rem)-1rem)))] bottom-4 w-[min(var(--spacing-composer-width),calc(100vw-2rem))]',
              folded ? 'h-12' : 'h-[min(var(--spacing-composer-height),calc(100dvh-var(--spacing-topbar)-2rem))]',
            ),
      )}
    >
      <div inert={asking} className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-3">
          <IconButton
            label={folded ? 'Open' : 'Collapse'}
            icon={folded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            onClick={() => setFoldedOn(folded ? null : mode)}
          />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
          <IconButton
            label={expanded ? 'Shrink' : 'Expand'}
            icon={expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            onClick={() => {
              setExpanded(!expanded)
              setFoldedOn(null)
            }}
          />
          <IconButton label="Close" icon={<X size={16} />} onClick={dismiss} />
        </header>

        {folded ? null : (
          <>
            <div className="flex shrink-0 flex-wrap gap-1 border-b border-divider px-2 py-1">
              {[...LOGGABLE.map((entry) => entry.type), 'task' as const].map((type) => (
                <Button
                  key={type}
                  variant={type === mode ? 'secondary' : 'tertiary'}
                  aria-pressed={type === mode}
                  onClick={() => openInteraction(type)}
                >
                  {type === 'task' ? 'Task' : TYPE_LABELS[type]}
                </Button>
              ))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {logging ? (
                <form
                  className="flex min-h-0 flex-1 flex-col"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (note.trim() !== '') void log()
                  }}
                >
                  <TextArea
                    ref={field}
                    value={note}
                    aria-label={logging.prompt}
                    placeholder={logging.prompt}
                    onChange={(event) => setNote(event.target.value)}
                    className="min-h-24 flex-1 resize-none rounded-none border-0 px-4 py-3 shadow-none"
                  />
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-3">
                    <Button type="submit" variant="primary" busy={posting} disabled={note.trim() === ''}>
                      {logging.verb}
                    </Button>
                    {logging.dated ? (
                      <label className="flex items-center gap-2 text-secondary">
                        When
                        <TextInput type="date" value={happenedOn} onChange={(event) => setHappenedOn(event.target.value)} />
                      </label>
                    ) : null}
                  </div>
                </form>
              ) : (
                <div className="p-3">
                  <TaskForm
                    autoFocus
                    account={account}
                    assignees={assignees}
                    queues={queues}
                    entity={{ entityType: object, entityId: recordId }}
                    onSaved={() => {
                      announceChange('tasks')
                      close()
                      router.refresh()
                    }}
                    className="flex flex-wrap items-end gap-2"
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {asking ? <DiscardConfirm onKeep={keep} onDiscard={discard} /> : null}
    </section>,
    document.body,
  )
}
