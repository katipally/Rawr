'use client'

import { Button, IconButton, TextArea, TextInput, cn, useMounted, useToast } from '@rawr/ui'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
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

/** The bottom-right panel for writing something onto the record in view: a note, a
 *  logged call, meeting or email, or a task. HubSpot's composer floats over the
 *  page for the same reason this one does, which is that the record stays usable
 *  under it and the box is never five screens of properties away.
 *
 *  Which one is open is the address (`?log=note`, `?task=new`), so "log a call on
 *  this deal" is still a link somebody can be sent. It is changed with the History
 *  API rather than a navigation, because a navigation renders the whole record
 *  page again just to show a text box. */
export const RecordComposer = ({ account, object, recordId, canWrite, assignees, queues }: RecordComposerProps) => {
  const toast = useToast()
  const params = useSearchParams()
  const kind = LOGGABLE.find((entry) => entry.type === params.get('log'))?.type
  const mode: Loggable | 'task' | null = kind ?? (params.get('task') === 'new' ? 'task' : null)
  const [note, setNote] = useState('')
  const [happenedOn, setHappenedOn] = useState('')
  const [posting, setPosting] = useState(false)
  // The mode it was folded away on, so asking for another one unfolds it without
  // an effect to say so.
  const [foldedOn, setFoldedOn] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const mounted = useMounted()

  // A person who asked for a note wants the cursor in the box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` is the trigger, for a box that only exists once it is true
  useEffect(() => {
    if (kind) field.current?.focus()
  }, [kind, mounted])

  if (!canWrite || mode === null || !mounted) return null

  const logging = LOGGABLE.find((entry) => entry.type === mode)
  const folded = foldedOn === mode
  const close = () => {
    setFoldedOn(null)
    replaceParams({ log: null, task: null })
  }

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
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setPosting(false)
    }
  }

  return createPortal(
    // Portalled to the body: the app shell's content card is a containing block for
    // `position: fixed`, so in place this would float over the card, not the window.
    // Not a dialog. The page behind stays live, which is the point of it.
    <section
      aria-label={logging ? logging.verb : 'New task'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close()
      }}
      className="fixed right-2 bottom-0 left-2 z-flyout flex max-h-[80dvh] flex-col rounded-t-panel border border-b-0 border-line bg-surface-raised shadow-overlay sm:left-auto sm:right-4 sm:w-[min(30rem,calc(100vw-2rem))]"
    >
      <header className="flex shrink-0 items-center gap-1 px-2 py-1">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {[...LOGGABLE.map((entry) => entry.type), 'task' as const].map((type) => (
            <Button
              key={type}
              variant={type === mode ? 'secondary' : 'tertiary'}
              aria-pressed={type === mode}
              onClick={() => replaceParams(type === 'task' ? { task: 'new', log: null } : { log: type, task: null })}
            >
              {type === 'task' ? 'Task' : TYPE_LABELS[type]}
            </Button>
          ))}
        </div>
        <IconButton
          label={folded ? 'Expand' : 'Collapse'}
          icon={folded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          onClick={() => setFoldedOn(folded ? null : mode)}
        />
        <IconButton label="Close" icon={<X size={16} />} onClick={close} />
      </header>

      <div className={cn('min-h-0 flex-1 overflow-y-auto border-t border-divider p-3', folded && 'hidden')}>
        {logging ? (
          <form
            className="flex flex-col gap-2"
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
            />
            <div className="flex flex-wrap items-center gap-2">
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
          <TaskForm
            autoFocus
            account={account}
            assignees={assignees}
            queues={queues}
            entity={{ entityType: object, entityId: recordId }}
            onSaved={() => {
              announceChange('tasks')
              close()
            }}
            className="flex flex-wrap items-end gap-2"
          />
        )}
      </div>
    </section>,
    document.body,
  )
}
