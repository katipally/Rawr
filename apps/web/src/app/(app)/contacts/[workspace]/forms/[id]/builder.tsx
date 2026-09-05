'use client'

// Values come from the browser-safe subpath, not the barrel: importing a runtime
// value from '@rawr/db' here pulls the Postgres driver into the client bundle.
import { FORM_FIELD_TYPES, type FormField, type FormFieldType } from '@rawr/db/forms'
import type { FormDetail } from '@rawr/db'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button, Field, Modal, Select, TextArea, TextInput, useToast } from '@rawr/ui'
import { formsPath, submissionsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { FormPreview } from './preview.tsx'

/** Edit the questions, the mapping and what happens on submit.
 *
 *  The preview beside it renders the real embed markup rather than an
 *  approximation, so what a marketer signs off is what a visitor gets. */

type Target = { value: string; label: string }

const TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'Single line text',
  long_text: 'Paragraph',
  email: 'Email',
  phone: 'Phone',
  url: 'Web address',
  select: 'Choose one',
  multi_select: 'Choose several',
  boolean: 'Checkbox',
  number: 'Number',
  date: 'Date',
  hidden: 'Hidden value',
}

export const FormBuilder = ({
  workspace,
  form,
  targets,
  members,
  baseUrl,
  canEdit,
}: {
  workspace: string
  form: FormDetail
  targets: Target[]
  /** Who a lead can be handed to: every admin and sales member. */
  members: { id: string; name: string; role: string }[]
  baseUrl: string
  canEdit: boolean
}) => {
  const router = useRouter()
  const toast = useToast()

  const [name, setName] = useState(form.name)
  const [slug, setSlug] = useState(form.slug)
  const [isActive, setIsActive] = useState(form.isActive)
  const [fields, setFields] = useState<FormField[]>(form.fields)
  const [settings, setSettings] = useState(form.settings)
  const [saving, setSaving] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  const remove = async () => {
    setDeleting(true)
    try {
      await api.forms.remove.mutate({ id: form.id })
      toast('success', `"${form.name}" is deleted.`)
      router.push(formsPath(workspace))
    } catch (cause) {
      // Refused with the reason when the form has submissions: those are leads.
      toast('error', errorMessage(cause))
      setDeleting(false)
      setShowDelete(false)
    }
  }
  /** The last state the server confirmed. Everything on this screen is local
   *  until Save, and the header has a link straight back to the list, so leaving
   *  used to discard a rebuilt form without a word. */
  const [saved, setSaved] = useState({
    name: form.name,
    slug: form.slug,
    isActive: form.isActive,
    fields: form.fields,
    settings: form.settings,
  })

  const dirty =
    JSON.stringify({ name, slug, isActive, fields, settings }) !== JSON.stringify(saved)

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const patch = (index: number, change: Partial<FormField>) =>
    setFields((all) => all.map((field, i) => (i === index ? { ...field, ...change } : field)))

  const move = (index: number, by: number) =>
    setFields((all) => {
      const next = [...all]
      const target = index + by
      if (target < 0 || target >= next.length) return all
      const [moved] = next.splice(index, 1)
      if (moved) next.splice(target, 0, moved)
      return next
    })

  const addField = () =>
    setFields((all) => {
      // Numbered off the highest key in use, not off the count. Adding three,
      // deleting the second and adding again produced a second "field_3", which
      // the schema then refused on save with a message about a key the person
      // never typed.
      const used = new Set(all.map((field) => field.key))
      let n = all.length + 1
      while (used.has(`field_${n}`)) n += 1
      return [
        ...all,
        {
          key: `field_${n}`,
          type: 'text',
          label: `Question ${n}`,
          required: false,
          mapsTo: null,
          step: 0,
        },
      ]
    })

  const save = async () => {
    setSaving(true)
    try {
      const id = await api.forms.save.mutate({ id: form.id || null, name, slug, isActive, fields, settings })
      setSaved({ name, slug, isActive, fields, settings })
      toast('success', 'Saved. The embed picks this up within a minute.')
      if (!form.id) {
        router.push(formsPath(workspace, id))
        return
      }
      router.refresh()
    } catch (cause) {
      // The schema rules refuse things a person can fix, and the message says
      // which one, so it is shown as-is rather than as "invalid form".
      toast('error', errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const stepCount = Math.max(1, ...fields.map((field) => (field.step ?? 0) + 1))

  return (
    <div className="w-full max-w-7xl">
      <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={formsPath(workspace)} className="text-sm text-link">
          Forms
        </Link>
        <span className="text-secondary">/</span>
        <h1 className="text-lg font-medium">{form.id ? form.name : 'New form'}</h1>
        {form.id ? (
          <Link
            href={submissionsPath(workspace, { form: form.id, state: 'clean' })}
            className="text-sm text-link"
          >
            Submissions
          </Link>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!canEdit ? (
            <span className="text-xs text-secondary">Your role can view this but not change it.</span>
          ) : (
            <>
              {dirty ? <span className="text-xs text-secondary">Unsaved changes</span> : null}
              {form.id ? (
                <Button type="button" variant="destructive" onClick={() => setShowDelete(true)}>
                  Delete
                </Button>
              ) : null}
              <Button
                type="button"
                variant="primary"
                busy={saving}
                disabled={!dirty}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save form'}
              </Button>
            </>
          )}
        </div>
      </header>

      <Modal open={showDelete} size="sm" title={`Delete ${form.name}`} onClose={() => setShowDelete(false)}>
        <div className="flex flex-col gap-3">
          <p>
            The embed and the hosted page stop working the moment it is gone. A form that has taken
            submissions is refused here, because those are leads; turn it off instead.
          </p>
          <p className="text-secondary">Type the name to confirm.</p>
          <TextInput
            aria-label={`Type ${form.name} to confirm`}
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={deleting}
              disabled={confirmText.trim() !== form.name}
              onClick={() => void remove()}
            >
              Delete form
            </Button>
            <Button variant="tertiary" onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Editor and preview sit side by side only when there is room for both.
          Below that the preview follows the editor rather than being hidden. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-panel border border-line bg-surface p-3">
            <h2 className="mb-3 font-medium">Basics</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="form-name" label="Name">
                <TextInput
                  id="form-name"
                  value={name}
                  disabled={!canEdit}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field id="form-slug" label="Address" hint={`${baseUrl}/form/${workspace}/${slug}`}>
                <TextInput
                  id="form-slug"
                  value={slug}
                  disabled={!canEdit}
                  onChange={(event) => setSlug(event.target.value)}
                />
              </Field>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                disabled={!canEdit}
                onChange={(event) => setIsActive(event.target.checked)}
              />
              Accepting submissions
            </label>
          </section>

          <section className="rounded-panel border border-line bg-surface p-3">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
              <h2 className="font-medium">Questions</h2>
              <span className="text-xs text-secondary">
                {fields.length} {fields.length === 1 ? 'field' : 'fields'} · {stepCount}{' '}
                {stepCount === 1 ? 'step' : 'steps'}
              </span>
              {canEdit ? (
                <Button type="button" className="ml-auto" onClick={addField}>
                  Add question
                </Button>
              ) : null}
            </div>

            <ol className="flex flex-col gap-3">
              {fields.map((field, index) => (
                <li key={`${field.key}-${index}`} className="rounded-hs border border-divider p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id={`label-${index}`} label="Label">
                      <TextInput
                        id={`label-${index}`}
                        value={field.label}
                        disabled={!canEdit}
                        onChange={(event) => patch(index, { label: event.target.value })}
                      />
                    </Field>
                    <Field id={`key-${index}`} label="Key" hint="Stored under this name. Renaming loses history.">
                      <TextInput
                        id={`key-${index}`}
                        value={field.key}
                        disabled={!canEdit}
                        onChange={(event) => patch(index, { key: event.target.value })}
                      />
                    </Field>
                    <Field id={`type-${index}`} label="Type">
                      <Select
                        id={`type-${index}`}
                        value={field.type}
                        disabled={!canEdit}
                        onChange={(event) => patch(index, { type: event.target.value as FormFieldType })}
                      >
                        {FORM_FIELD_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {TYPE_LABELS[type]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field
                      id={`maps-${index}`}
                      label="Saves to"
                      hint="Unmapped answers are still stored on the submission."
                    >
                      <Select
                        id={`maps-${index}`}
                        value={field.mapsTo ?? ''}
                        disabled={!canEdit}
                        onChange={(event) =>
                          patch(index, {
                            mapsTo: (event.target.value || null) as FormField['mapsTo'],
                          })
                        }
                      >
                        <option value="">Nothing</option>
                        {targets.map((target) => (
                          <option key={target.value} value={target.value}>
                            {target.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field id={`step-${index}`} label="Step">
                      <TextInput
                        id={`step-${index}`}
                        type="number"
                        min={0}
                        value={field.step ?? 0}
                        disabled={!canEdit}
                        onChange={(event) =>
                          patch(index, { step: Math.max(0, Number(event.target.value) || 0) })
                        }
                      />
                    </Field>
                    {field.type === 'select' || field.type === 'multi_select' ? (
                      <Field
                        id={`options-${index}`}
                        label="Choices"
                        hint="One per line."
                      >
                        <TextArea
                          id={`options-${index}`}
                          value={(field.options ?? []).map((o) => o.label).join('\n')}
                          disabled={!canEdit}
                          onChange={(event) =>
                            patch(index, {
                              options: event.target.value
                                .split('\n')
                                .map((line) => line.trim())
                                .filter(Boolean)
                                .map((line) => ({ value: line, label: line })),
                            })
                          }
                        />
                      </Field>
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={field.required}
                        disabled={!canEdit}
                        onChange={(event) => patch(index, { required: event.target.checked })}
                      />
                      Required
                    </label>
                    {canEdit ? (
                      <>
                        <Button type="button" variant="tertiary" onClick={() => move(index, -1)}>
                          Move up
                        </Button>
                        <Button type="button" variant="tertiary" onClick={() => move(index, 1)}>
                          Move down
                        </Button>
                        <Button
                          type="button"
                          variant="tertiary"
                          className="text-error"
                          onClick={() => setFields((all) => all.filter((_, i) => i !== index))}
                        >
                          Remove
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-panel border border-line bg-surface p-3">
            <h2 className="mb-3 font-medium">After submit</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="submit-label" label="Button label">
                <TextInput
                  id="submit-label"
                  value={settings.submitLabel}
                  disabled={!canEdit}
                  onChange={(event) => setSettings({ ...settings, submitLabel: event.target.value })}
                />
              </Field>
              <Field id="success-mode" label="Then">
                <Select
                  id="success-mode"
                  value={settings.successMode}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      successMode: event.target.value === 'redirect' ? 'redirect' : 'message',
                    })
                  }
                >
                  <option value="message">Show a message</option>
                  <option value="redirect">Send them to a page</option>
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Field
                  id="success-value"
                  label={settings.successMode === 'redirect' ? 'Redirect to' : 'Message'}
                >
                  <TextArea
                    id="success-value"
                    value={settings.successValue}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setSettings({ ...settings, successValue: event.target.value })
                    }
                  />
                </Field>
              </div>
              <Field id="lifecycle" label="Set lifecycle stage to" hint="Leave blank to change nothing.">
                <TextInput
                  id="lifecycle"
                  value={settings.lifecycleStageOnSubmit ?? ''}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setSettings({ ...settings, lifecycleStageOnSubmit: event.target.value || null })
                  }
                />
              </Field>
              <Field id="slack-channel" label="Slack channel" hint="Blank uses the workspace default.">
                <TextInput
                  id="slack-channel"
                  value={settings.slackChannel ?? ''}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setSettings({ ...settings, slackChannel: event.target.value || null })
                  }
                />
              </Field>
            </div>
            <fieldset className="mt-3 flex flex-col gap-2">
              <legend className="font-medium">Assign new contacts to</legend>
              <Select
                aria-label="Assignment"
                value={settings.assignOwner?.mode ?? 'none'}
                disabled={!canEdit}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    assignOwner: { ...(settings.assignOwner ?? { userId: null, pool: [] }), mode: event.target.value as 'none' | 'user' | 'round_robin' },
                  })
                }
                className="max-w-xs"
              >
                <option value="none">Nobody, leave them unassigned</option>
                <option value="user">One person</option>
                <option value="round_robin">Round robin across the team</option>
              </Select>
              {settings.assignOwner?.mode === 'user' ? (
                <Select
                  aria-label="Owner"
                  value={settings.assignOwner.userId ?? ''}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setSettings({ ...settings, assignOwner: { ...settings.assignOwner, mode: 'user', userId: event.target.value || null } })
                  }
                  className="max-w-xs"
                >
                  <option value="">Pick a member</option>
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} · {member.role}
                    </option>
                  ))}
                </Select>
              ) : null}
              {settings.assignOwner?.mode === 'round_robin' ? (
                <div className="flex flex-col gap-1">
                  <p className="text-small text-secondary">
                    Each lead goes to whoever in the pool owns the fewest contacts. Nobody ticked means every admin and sales member.
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {members.map((member) => {
                      const pool = settings.assignOwner?.pool ?? []
                      const on = pool.includes(member.id)
                      return (
                        <label key={member.id} className="flex items-center gap-1.5 text-sm">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!canEdit}
                            onChange={(event) =>
                              setSettings({
                                ...settings,
                                assignOwner: {
                                  ...settings.assignOwner,
                                  mode: 'round_robin',
                                  pool: event.target.checked ? [...pool, member.id] : pool.filter((id) => id !== member.id),
                                },
                              })
                            }
                          />
                          {member.name}
                        </label>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </fieldset>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.notifySlack}
                disabled={!canEdit}
                onChange={(event) => setSettings({ ...settings, notifySlack: event.target.checked })}
              />
              Post accepted leads to Slack
            </label>
          </section>
        </div>

        <FormPreview fields={fields} settings={settings} />
      </div>
    </div>
  )
}
