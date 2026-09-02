'use client'

// Values come from the browser-safe subpath, not the barrel: importing a runtime
// value from '@rawr/db' here pulls the Postgres driver into the client bundle.
import { FORM_FIELD_TYPES, type FormField, type FormFieldType } from '@rawr/db/forms'
import type { FormDetail } from '@rawr/db'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button, Field, Select, TextArea, TextInput, useToast } from '@rawr/ui'
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
  baseUrl,
  canEdit,
}: {
  workspace: string
  form: FormDetail
  targets: Target[]
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
      await api.forms.save.mutate({ id: form.id, name, slug, isActive, fields, settings })
      setSaved({ name, slug, isActive, fields, settings })
      toast('success', 'Saved. The embed picks this up within a minute.')
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
        <h1 className="text-lg font-medium">{form.name}</h1>
        <Link
          href={submissionsPath(workspace, { form: form.id, state: 'clean' })}
          className="text-sm text-link"
        >
          Submissions
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!canEdit ? (
            <span className="text-xs text-secondary">Your role can view this but not change it.</span>
          ) : (
            <>
              {dirty ? <span className="text-xs text-secondary">Unsaved changes</span> : null}
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
