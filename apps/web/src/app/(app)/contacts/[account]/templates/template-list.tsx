'use client'

import { Button, Card, EmptyState, Field, Modal, PageHeader, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Markdown } from '~/components/crm/markdown.tsx'
import { MergeFieldPicker } from '~/components/crm/merge-fields.tsx'
import { RichTextInput } from '~/components/crm/rich-text-input.tsx'
import { formatDateTime } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useZone } from '~/components/zone.tsx'

export type TemplateRow = {
  id: string
  name: string
  subject: string
  bodyText: string
  authorName: string | null
  updatedAt: string
}

type Draft = { id: string | null; name: string; subject: string; bodyText: string }

const BLANK: Draft = { id: null, name: '', subject: '', bodyText: '' }

export const TemplateList = ({ rows, canWrite }: { rows: TemplateRow[]; canWrite: boolean }) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const { page, pager } = usePagedRows(rows, 'templates')

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await api.sequences.templates.save.mutate({
        id: draft.id,
        name: draft.name,
        subject: draft.subject,
        bodyText: draft.bodyText,
      })
      toast('success', draft.id ? 'Saved.' : 'Template added.')
      setDraft(null)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await api.sequences.templates.remove.mutate({ id })
      toast('success', 'Removed. Steps written from it keep their words.')
      setRemoving(null)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PageHeader
        title="Templates"
        lead="Emails worth sending more than once."
        why={
          <p>
            Drop one into a sequence step and it becomes that step's own copy. Editing the template
            afterwards leaves live sequences alone, so nobody's outreach changes under them.
          </p>
        }
        action={
          canWrite ? (
            <Button variant="primary" onClick={() => setDraft(BLANK)}>
              Create template
            </Button>
          ) : undefined
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No templates yet"
          description="Write the email you keep retyping once, and it is one click from then on."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {page.map((row) => (
            <Card key={row.id} title={row.name}>
              <div className="flex min-w-0 flex-col gap-2">
                <p className="break-words font-medium">{row.subject || '(no subject)'}</p>
                <div className="max-h-40 overflow-y-auto rounded-hs border border-line bg-fill p-3">
                  {row.bodyText.trim() ? (
                    <Markdown source={row.bodyText} />
                  ) : (
                    <p className="text-secondary">Nothing written yet.</p>
                  )}
                </div>
                <p className="text-small text-secondary">
                  {row.authorName ? `${row.authorName} · ` : ''}
                  last edited {formatDateTime(row.updatedAt, zone)}
                </p>
                {canWrite ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="tertiary"
                      onClick={() =>
                        setDraft({ id: row.id, name: row.name, subject: row.subject, bodyText: row.bodyText })
                      }
                    >
                      Edit
                    </Button>
                    {removing === row.id ? (
                      <>
                        <span className="text-small text-secondary">Remove “{row.name}”?</span>
                        <Button variant="destructive" busy={busy} onClick={() => void remove(row.id)}>
                          Remove
                        </Button>
                        <Button variant="tertiary" onClick={() => setRemoving(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button variant="tertiary" onClick={() => setRemoving(row.id)}>
                        Delete
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            </Card>
          ))}
          {pager}
        </div>
      )}

      {draft ? (
        <Modal open title={draft.id ? 'Edit template' : 'Create template'} onClose={() => setDraft(null)}>
          <div className="flex flex-col gap-3">
            <Field label="Name" id="template-name" required hint="What it is called in the picker.">
              <TextInput
                id="template-name"
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label="Subject" id="template-subject">
              <TextInput
                id="template-subject"
                value={draft.subject}
                onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
              />
            </Field>
            <Field
              label="Message"
              id="template-body"
              hint="Merge fields go in double braces. Give one a fallback, like {{first_name|there}}."
            >
              <RichTextInput
                id="template-body"
                label="Message"
                className="min-h-48"
                value={draft.bodyText}
                onChange={(next) => setDraft({ ...draft, bodyText: next })}
              />
            </Field>
            <MergeFieldPicker
              onInsert={(token) => setDraft({ ...draft, bodyText: `${draft.bodyText}${token}` })}
            />
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} disabled={!draft.name.trim()} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
