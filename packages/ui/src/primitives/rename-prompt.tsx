'use client'

import { useId, useState } from 'react'
import { Button } from './button.tsx'
import { Field, TextInput } from './field.tsx'
import { Modal } from './modal.tsx'

export type RenamePromptProps = {
  /** The current name, or null when nothing is being renamed. Holding the subject
   *  rather than a boolean is what lets the field open already filled in. */
  value: string | null
  label: string
  title: string
  busy?: boolean
  onCancel: () => void
  onRename: (name: string) => void
}

/** Rename, asked properly.
 *
 *  These three screens used window.prompt, which is unstyled, untranslatable,
 *  unreadable on a phone, cannot say why a name was refused, and blocks the whole
 *  tab while it is open. This is the same question inside the dialog primitive the
 *  rest of the app already uses: Escape and the scrim close it, Enter submits, and
 *  the field opens focused with the current name selected, so the common case is
 *  type-over-and-return. */
export const RenamePrompt = ({
  value,
  label,
  title,
  busy = false,
  onCancel,
  onRename,
}: RenamePromptProps) => {
  const id = useId()
  const [draft, setDraft] = useState('')
  const [opened, setOpened] = useState<string | null>(null)

  // Adjusted during render rather than in an effect, because the dialog focuses
  // this field on the same commit and selects what it finds there. An effect runs
  // after that focus, so the field was focused while still empty, the selection
  // covered nothing, and the name then appeared with the caret in front of it.
  if (value !== opened) {
    setOpened(value)
    setDraft(value ?? '')
  }

  const trimmed = draft.trim()
  const unchanged = trimmed === (value ?? '').trim()
  const submit = () => {
    if (!trimmed || unchanged || busy) return
    onRename(trimmed)
  }

  return (
    <Modal
      open={value !== null}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="tertiary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={!trimmed || unchanged}>
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Field id={id} label={label}>
          <TextInput
            id={id}
            value={draft}
            // The dialog focuses its close button otherwise, and this exists to be
            // typed into. onFocus selects, so the common case is type and return.
            data-autofocus
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
        </Field>
        {/* Submits on Enter without giving the dialog a second visible button. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
