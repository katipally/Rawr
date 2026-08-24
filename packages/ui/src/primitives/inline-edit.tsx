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
          'w-full min-w-0 rounded-hs border border-transparent px-2 py-1 text-left',
          'hover:border-line hover:bg-fill',
          !value && 'text-secondary',
        )}
      >
        <span className="break-words">{value || placeholder}</span>
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
