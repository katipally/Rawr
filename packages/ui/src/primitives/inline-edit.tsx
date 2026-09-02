'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '../cn.ts'

export type InlineEditProps = {
  label: string
  value: string | null
  placeholder?: string
  onCommit: (next: string) => Promise<void>
}

/** Click to edit, Enter to save, Escape to abandon. A failed save keeps the typed
 *  value on screen with the reason next to it, so nothing a person typed is lost. */
export const InlineEdit = ({ label, value, placeholder = 'Empty', onCommit }: InlineEditProps) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])

  useEffect(() => {
    if (!editing) setDraft(value ?? '')
  }, [value, editing])

  const commit = async () => {
    // Enter disables the input, the browser blurs it, and onBlur would commit a
    // second time. One guard covers both entry points.
    if (saving) return
    if (draft === (value ?? '')) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCommit(draft)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${label}`}
        className={cn(
          // A dashed underline at rest, because a value that only looks editable
          // on hover is a value nobody discovers they can edit.
          'group w-full min-w-0 rounded-hs border border-transparent px-2 py-1 text-left',
          'decoration-line decoration-dashed underline-offset-4 hover:border-line hover:bg-fill-hover',
          !value && 'text-secondary',
        )}
      >
        <span className="break-words underline decoration-inherit decoration-dashed">
          {value || placeholder}
        </span>
        <span aria-hidden="true" className="ml-1 text-secondary opacity-0 group-hover:opacity-100">
          ✎
        </span>
      </button>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <input
        ref={input}
        value={draft}
        disabled={saving}
        aria-label={label}
        aria-invalid={error !== null}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          if (event.key === 'Escape') {
            setDraft(value ?? '')
            setError(null)
            setEditing(false)
          }
        }}
        className="min-h-9 w-full min-w-0 rounded-hs border border-line-interactive bg-surface px-2 py-1 outline-none aria-[invalid=true]:border-error"
      />
      {error ? (
        <p role="alert" className="text-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
