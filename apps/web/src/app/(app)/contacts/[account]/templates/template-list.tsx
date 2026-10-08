'use client'

import { Button, ConfirmDialog, DataTable, DropdownMenu, EmptyState, Modal, NOTHING_MATCHED, PageHeader, useMounted, useToast, type Column } from '@rawr/ui'
import { ChevronDown, Eye, EyeOff, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Markdown } from '~/components/crm/markdown.tsx'
import { MergeFieldPicker } from '~/components/crm/merge-fields.tsx'
import { RichTextInput } from '~/components/crm/rich-text-input.tsx'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'
import { useFormat } from '~/components/zone.tsx'

export type TemplateRow = {
  id: string
  name: string
  subject: string
  bodyText: string
  authorName: string | null
  createdAt: string
  updatedAt: string
}

type Draft = { id: string | null; name: string; subject: string; bodyText: string }

const BLANK: Draft = { id: null, name: '', subject: '', bodyText: '' }

/** The owner filter's value for templates whose author has left the account. */
const NO_OWNER = ''

const ghost =
  'inline-flex min-h-[2.4375rem] items-center gap-1 rounded-hs px-3 font-semibold text-body transition-all duration-150 ease-out hover:bg-fill'

const inlineInput = 'h-10 min-w-0 flex-1 bg-transparent px-2 text-body outline-none placeholder:text-muted'

/** HubSpot's message templates: a table of names with owner and dates, Actions
 *  on the hovered row, and the editor as a wide dialog with the email composed
 *  on the left and how it reads on the right. Which template is open lives in
 *  the address, so a HubSpot edit link, a reload or a pasted link opens it. */
export const TemplateList = ({ rows, canWrite }: { rows: TemplateRow[]; canWrite: boolean }) => {
  const fmt = useFormat()
  const mounted = useMounted()
  const router = useRouter()
  const toast = useToast()
  const [opened, setOpened] = useUrlParam('template')
  const [edits, setEdits] = useState<{ for: string; draft: Draft } | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<TemplateRow | null>(null)
  const [needle, setNeedle] = useState('')
  const [owner, setOwner] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(true)

  const openedRow = rows.find((row) => row.id === opened) ?? null
  const base: Draft | null =
    opened === 'new' ? BLANK : openedRow ? { id: openedRow.id, name: openedRow.name, subject: openedRow.subject, bodyText: openedRow.bodyText } : null
  const draft = opened !== null && edits?.for === opened ? edits.draft : base
  const setDraft = (next: Draft) => {
    if (opened !== null) setEdits({ for: opened, draft: next })
  }
  const open = (id: string) => {
    setEdits(null)
    setOpened(id)
  }
  const close = () => {
    setEdits(null)
    setOpened(null)
  }
  const dirty =
    draft !== null && base !== null && (draft.name !== base.name || draft.subject !== base.subject || draft.bodyText !== base.bodyText)

  const owners = [...new Set(rows.map((row) => row.authorName ?? NO_OWNER))].sort()
  const wanted = needle.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (owner === null || (row.authorName ?? NO_OWNER) === owner) &&
      (wanted === '' || row.name.toLowerCase().includes(wanted) || row.subject.toLowerCase().includes(wanted)),
  )
  const { page, pager } = usePagedRows(shown, 'templates')

  const save = async (asNew: boolean) => {
    if (!draft) return
    setBusy(true)
    try {
      await api.sequences.templates.save.mutate({
        id: asNew ? null : draft.id,
        name: draft.name,
        subject: draft.subject,
        bodyText: draft.bodyText,
      })
      toast('success', draft.id && !asNew ? 'Saved.' : 'Template added.')
      close()
      // After close(): the address change dispatches a restore that discards a refresh queued before it.
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

  // "3 days ago" moves with the clock, so the server's copy and the browser's
  // can disagree by the time it hydrates; the server writes the date instead.
  const when = (value: string) => (mounted ? fmt.ago(value) : fmt.date(value))

  const columns: Column<TemplateRow>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 520,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-col items-start">
            <button
              type="button"
              title={row.name}
              onClick={() => open(row.id)}
              className="max-w-full truncate text-left font-semibold text-link hover:underline"
            >
              {row.name}
            </button>
            <span className="max-w-full truncate text-small text-secondary">{row.subject || '(no subject)'}</span>
          </span>
          {canWrite ? (
            <RowActions>
              <DropdownMenu
                label={`Actions for ${row.name}`}
                align="start"
                groups={[
                  { key: 'edit', items: [{ key: 'edit', label: 'Edit', onSelect: () => open(row.id) }] },
                  { key: 'remove', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setRemoving(row) }] },
                ]}
                trigger={(props) => (
                  <button {...props} type="button" className={rowPill}>
                    Actions
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </button>
                )}
              />
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'owner', header: 'Owner', width: 180, render: (row) => row.authorName ?? EMPTY_VALUE },
    {
      key: 'created',
      header: 'Date created',
      width: 160,
      render: (row) => <span title={fmt.dateTime(row.createdAt)}>{when(row.createdAt)}</span>,
    },
    {
      key: 'modified',
      header: 'Date modified',
      width: 160,
      render: (row) => <span title={fmt.dateTime(row.updatedAt)}>{when(row.updatedAt)}</span>,
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PageHeader
        title="Templates"
        lead={`${fmt.number(rows.length)} ${rows.length === 1 ? 'template' : 'templates'}. Emails worth sending more than once.`}
        why={
          <p>
            Drop one into a sequence step and it becomes that step's own copy. Editing the template
            afterwards leaves live sequences alone, so nobody's outreach changes under them.
          </p>
        }
        action={
          canWrite ? (
            <Button variant="primary" onClick={() => open('new')}>
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
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <label className="relative w-full min-w-0 @lg:w-60">
              <span className="sr-only">Search templates</span>
              <input
                type="search"
                value={needle}
                placeholder="Search templates"
                onChange={(event) => setNeedle(event.target.value)}
                className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
              />
              <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
            </label>
            <DropdownMenu
              label="Owner"
              align="start"
              groups={[
                {
                  key: 'owner',
                  items: [
                    { key: 'any', label: 'Any', checked: owner === null, onSelect: () => setOwner(null) },
                    ...owners.map((name) => ({
                      key: name || 'none',
                      label: name || 'No owner',
                      checked: owner === name,
                      onSelect: () => setOwner(name),
                    })),
                  ],
                },
              ]}
              trigger={(props) => (
                <button {...props} type="button" className={ghost}>
                  <span className="font-light">Owner:</span>
                  <span className="max-w-48 truncate">{owner === null ? 'Any' : owner || 'No owner'}</span>
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </button>
              )}
            />
          </div>
          <DataTable
            columns={columns}
            rows={page}
            rowKey={(row) => row.id}
            caption="Email templates"
            storageKey="templates.list"
            empty={<EmptyState {...NOTHING_MATCHED} />}
          />
          {pager}
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={`Delete “${removing?.name ?? 'this template'}”?`}
        confirm="Delete"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing.id)}
      >
        <p>Steps written from it keep their words.</p>
      </ConfirmDialog>

      {draft ? (
        <Modal
          open
          size="lg"
          title={draft.id ? 'Edit template' : 'Create template'}
          onClose={close}
          dirty={dirty}
          onSubmit={() => void save(false)}
          footer={
            <>
              <Button variant="tertiary" onClick={close}>
                Cancel
              </Button>
              {draft.id ? (
                <Button busy={busy} disabled={!draft.name.trim() || !canWrite} onClick={() => void save(true)}>
                  Save as new template
                </Button>
              ) : null}
              <Button type="submit" variant="primary" busy={busy} disabled={!draft.name.trim() || !canWrite}>
                {draft.id ? 'Update existing template' : 'Save'}
              </Button>
            </>
          }
        >
          <div className="@container">
          <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
            <section aria-labelledby="template-compose" className="flex min-w-0 flex-col gap-2">
              <h3 id="template-compose" className="text-base font-semibold">
                Compose email template
              </h3>
              <div className="flex min-w-0 flex-col divide-y divide-line rounded-hs border border-line">
                <label className="flex min-w-0 items-center pl-3">
                  <span className="shrink-0 font-semibold">Template name:</span>
                  <input
                    // biome-ignore lint/a11y/noAutofocus: the dialog opens to write a template
                    autoFocus
                    required
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    className={inlineInput}
                  />
                </label>
                <label className="flex min-w-0 items-center pl-3">
                  <span className="shrink-0 font-semibold">Subject:</span>
                  <input
                    value={draft.subject}
                    onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                    className={inlineInput}
                  />
                </label>
                <div className="flex min-w-0 flex-col gap-2 p-2">
                  <RichTextInput
                    id="template-body"
                    label="Message"
                    className="min-h-48"
                    value={draft.bodyText}
                    onChange={(next) => setDraft({ ...draft, bodyText: next })}
                  />
                  <MergeFieldPicker onInsert={(token) => setDraft({ ...draft, bodyText: `${draft.bodyText}${token}` })} />
                </div>
              </div>
              <p className="text-small text-secondary">
                Merge fields go in double braces. Give one a fallback, like {'{{first_name|there}}'}.
              </p>
            </section>

            <section aria-labelledby="template-preview" className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <h3 id="template-preview" className="text-base font-semibold">
                  Preview
                </h3>
                <button type="button" className={ghost} aria-pressed={!previewing} onClick={() => setPreviewing(!previewing)}>
                  {previewing ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
                  {previewing ? 'Hide preview' : 'Show preview'}
                </button>
              </div>
              {previewing ? (
                <div className="flex min-h-48 min-w-0 flex-col gap-2 rounded-hs border border-line p-4">
                  <p className="break-words font-semibold">{draft.subject || '(no subject)'}</p>
                  {draft.bodyText.trim() ? (
                    <Markdown source={draft.bodyText} />
                  ) : (
                    <p className="text-secondary">Write the email on the left to see how it reads.</p>
                  )}
                </div>
              ) : null}
            </section>
          </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
