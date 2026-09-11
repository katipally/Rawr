'use client'

// Values come from the browser-safe subpath, not the barrel: importing a runtime
// value from '@rawr/db' here pulls the Postgres driver into the client bundle.
import {
  CHOICE_TYPES,
  FORM_FIELD_TYPES,
  formBlockers,
  toFormSlug,
  type FormField,
  type FormFieldType,
  type FormTheme,
  type FormThemeToken,
} from '@rawr/db/forms'
import type { FormDetail } from '@rawr/db'
import { Code2, Inbox, TrendingUp } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { LinkButton } from '~/components/link-button.tsx'
import { useEffect, useState } from 'react'
import { Alert, Breadcrumb, Button, Field, Modal, Select, TextArea, TextInput, useToast } from '@rawr/ui'
import { formPerformancePath, formsPath, submissionsPath } from '~/lib/links.ts'
import { EMBED_PRESETS, resolveTheme } from '~/lib/embed-themes.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useRowIds } from '~/lib/row-ids.ts'
import { EmbedSnippet } from '../embed-snippet.tsx'
import { FormPreview } from './preview.tsx'
import { sameWords } from '~/lib/same-words.ts'

/** Edit the questions, the mapping and what happens on submit.
 *
 *  The preview beside it renders the real embed markup rather than an
 *  approximation, so what a marketer signs off is what a visitor gets. */

type Target = {
  value: string
  label: string
  /** The property carries conditional logic, so the question is only asked when
   *  the rule matches. Worth saying here: otherwise a field that never appears on
   *  the live form looks like a bug in the form rather than a rule in settings. */
  conditional: boolean
}

const TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'Single line text',
  long_text: 'Paragraph',
  email: 'Email',
  phone: 'Phone',
  url: 'Web address',
  select: 'Choose one, dropdown',
  radio: 'Choose one, buttons',
  multi_select: 'Choose several',
  boolean: 'Checkbox',
  consent: 'Consent checkbox',
  number: 'Number',
  date: 'Date',
  file: 'File upload',
  heading: 'Heading',
  hidden: 'Hidden value',
}

export const FormBuilder = ({
  account,
  form,
  targets,
  members,
  subscriptions,
  baseUrl,
  siteKey,
  canEdit,
  slack,
}: {
  account: string
  form: FormDetail
  targets: Target[]
  /** Who a lead can be handed to: every admin and sales member. */
  members: { id: string; name: string }[]
  /** Every subscription type in the account, by name: what a form can opt a
   *  new contact into. Matched by name on submit, so the list is the names. */
  subscriptions: { name: string; isInternal: boolean }[]
  baseUrl: string
  /** The tracked site the embed snippet should name. Null when the account has
   *  none, which the snippet says out loud rather than printing a key that
   *  resolves to nothing. */
  siteKey: string | null
  canEdit: boolean
  /** What the account's Slack actually is. 'none' means nothing is connected, so
   *  naming a channel here changes nothing at all; 'webhook' means the channel is
   *  fixed by the URL and nothing this form asks for can change it. */
  slack: 'none' | 'webhook' | 'bot'
}) => {
  const router = useRouter()
  const toast = useToast()

  const [name, setName] = useState(form.name)
  const [slug, setSlug] = useState(form.slug)
  /** An address a person typed is theirs to keep. Until they do, it follows the
   *  name, because a new form used to open with an empty address and refuse to
   *  save until you guessed that it wanted one. A saved form never follows: the
   *  address is in the embed on somebody's site by then. */
  const [slugFollowsName, setSlugFollowsName] = useState(!form.id)
  const [isActive, setIsActive] = useState(form.isActive)
  const [fields, setFields] = useState<FormField[]>(form.fields)
  const rowIds = useRowIds(fields.length)
  const [settings, setSettings] = useState(form.settings)
  const [saving, setSaving] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showEmbed, setShowEmbed] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [stages, setStages] = useState<{ name: string }[]>([])

  useEffect(() => {
    // A seat that cannot read the list gets an empty one, and the Select still
    // offers what the form is already set to rather than losing it.
    api.admin.lifecycle.list.query().then(setStages).catch(() => {})
  }, [])

  const remove = async () => {
    setDeleting(true)
    try {
      await api.forms.remove.mutate({ id: form.id })
      toast('success', `"${form.name}" is deleted.`)
      router.push(formsPath(account))
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

  /** Every reason the server would refuse this, said before the click. The same
   *  function the data access layer runs, so the two can never drift. */
  const blockers = formBlockers({ name, slug, fields })

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const patch = (index: number, change: Partial<FormField>) =>
    setFields((all) => all.map((field, i) => (i === index ? { ...field, ...change } : field)))

  const move = (index: number, by: number) => {
    const target = index + by
    if (target < 0 || target >= fields.length) return
    rowIds.moved(index, by)
    setFields((all) => {
      const next = [...all]
      const [moved] = next.splice(index, 1)
      if (moved) next.splice(target, 0, moved)
      return next
    })
  }

  const removeField = (index: number) => {
    rowIds.removed(index)
    setFields((all) => all.filter((_, i) => i !== index))
  }

  const addField = () => {
    rowIds.added()
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
  }

  const save = async () => {
    setSaving(true)
    try {
      const id = await api.forms.save.mutate({ id: form.id || null, name, slug, isActive, fields, settings })
      setSaved({ name, slug, isActive, fields, settings })
      toast('success', 'Saved. The embed picks this up within a minute.')
      if (!form.id) {
        router.push(formsPath(account, id))
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

  // An internal type is how the company talks to itself, so it is never
  // something a stranger filling in a web form can be signed up to.
  const optInTypes = subscriptions.filter((type) => !type.isInternal)

  // A stage the account has since renamed or deleted is still what this form is
  // set to, so it is offered rather than silently dropped by opening the builder.
  const stageNames = stages.map((stage) => stage.name)
  const stageOptions =
    settings.lifecycleStageOnSubmit && !stageNames.includes(settings.lifecycleStageOnSubmit)
      ? [...stageNames, settings.lifecycleStageOnSubmit]
      : stageNames
  const askingConsent = fields.some((field) => field.type === 'consent')

  return (
    <div className="w-full max-w-7xl">
      <header className="mb-4 flex flex-col gap-2">
        <Breadcrumb
          items={[
            { label: 'Forms', href: formsPath(account) },
            { label: form.id ? form.name : 'New form' },
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-lg font-medium">{form.id ? form.name : 'New form'}</h1>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {form.id ? (
              <LinkButton
                href={formPerformancePath(account, form.id)}
                icon={<TrendingUp aria-hidden="true" className="size-4" />}
              >
                Performance
              </LinkButton>
            ) : null}
            {form.id ? (
              <LinkButton
                href={submissionsPath(account, { form: form.id, state: 'clean' })}
                icon={<Inbox aria-hidden="true" className="size-4" />}
              >
                Submissions
              </LinkButton>
            ) : null}
            {form.id ? (
              <Button
                type="button"
                icon={<Code2 aria-hidden="true" className="size-4" />}
                onClick={() => setShowEmbed(true)}
              >
                Embed code
              </Button>
            ) : null}
            {!canEdit ? (
              <span className="text-xs text-secondary">Your role can view this but not change it.</span>
            ) : (
              <>
                {blockers.length > 0 ? (
                  <span className="text-xs text-secondary">
                    {blockers.length === 1 ? blockers[0] : `${blockers.length} things to fix first`}
                  </span>
                ) : dirty ? (
                  <span className="text-xs text-secondary">Unsaved changes</span>
                ) : null}
                {form.id ? (
                  <Button type="button" variant="destructive" onClick={() => setShowDelete(true)}>
                    Delete
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="primary"
                  busy={saving}
                  disabled={!dirty || blockers.length > 0}
                  onClick={() => void save()}
                >
                  {saving ? 'Saving…' : 'Save form'}
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <Modal open={showEmbed} title={`Embed \u201c${form.name}\u201d`} onClose={() => setShowEmbed(false)}>
        <EmbedSnippet baseUrl={baseUrl} siteKey={siteKey} formId={form.id} account={account} slug={slug} />
      </Modal>

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
            <Button variant="tertiary" onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={deleting}
              disabled={!sameWords(confirmText, form.name)}
              onClick={() => void remove()}
            >
              Delete form
            </Button>
          </div>
        </div>
      </Modal>

      {canEdit && blockers.length > 1 ? (
        <div className="mb-4 rounded-panel border border-line bg-fill p-3 text-sm">
          <p className="mb-1 font-medium">Before this can be saved</p>
          <ul className="ml-4 list-disc text-secondary">
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Editor and preview sit side by side only when there is room for both.
          Below that the preview follows the editor rather than being hidden. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-panel border border-line bg-surface p-3">
            <h2 className="mb-3 font-medium">Basics</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="form-name" label="Name">
                <TextInput
                  id="form-name"
                  value={name}
                  disabled={!canEdit}
                  onChange={(event) => {
                    setName(event.target.value)
                    if (slugFollowsName) setSlug(toFormSlug(event.target.value))
                  }}
                />
              </Field>
              <Field id="form-slug" label="Address" hint={`${baseUrl}/form/${account}/${slug}`}>
                <TextInput
                  id="form-slug"
                  value={slug}
                  disabled={!canEdit}
                  onChange={(event) => {
                    setSlugFollowsName(false)
                    // Permissive rather than canonical: trimming the hyphen off
                    // "request-" on every keystroke makes the field unusable.
                    setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 63))
                  }}
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
            {/* A saved form that is turned off answers 404 at both addresses.
                Correct, and baffling if nobody said so before the click. */}
            {!isActive ? (
              <p className="mt-1 text-small text-secondary">
                Until this is ticked, the embed and the link above both answer &ldquo;not
                found&rdquo;.
              </p>
            ) : null}
          </section>

          <ThemePanel
            theme={settings.theme}
            canEdit={canEdit}
            onChange={(theme) => setSettings({ ...settings, theme })}
          />

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

            {stepCount > 1 ? (
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                {Array.from({ length: stepCount }, (_, step) => (
                  <Field key={step} id={`step-label-${step}`} label={`Step ${step + 1} name`}>
                    <TextInput
                      id={`step-label-${step}`}
                      value={settings.steps?.[step] ?? ''}
                      disabled={!canEdit}
                      placeholder={`Step ${step + 1}`}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          // Held as a dense array the length of the step count, so
                          // a blank middle step does not shift every later label.
                          steps: Array.from(
                            { length: stepCount },
                            (_, i) => (i === step ? event.target.value : (settings.steps?.[i] ?? '')),
                          ),
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            ) : null}

            <ol className="flex flex-col gap-3">
              {fields.map((field, index) => (
                <li key={rowIds.at(index)} className="rounded-hs border border-divider p-3">
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
                    {field.type === 'heading' ? null : (
                    <Field
                      id={`maps-${index}`}
                      label="Saves to"
                      hint={
                        targets.find((target) => target.value === field.mapsTo)?.conditional
                          ? 'This property has conditional logic, so the question is only asked when its rule matches the other answers.'
                          : 'Unmapped answers are still stored on the submission.'
                      }
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
                    )}
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
                    {CHOICE_TYPES.has(field.type) ? (
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

                  <FieldExtras
                    field={field}
                    index={index}
                    others={fields.filter((other, position) => position < index && other.type !== 'heading')}
                    canEdit={canEdit}
                    patch={patch}
                  />

                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {/* A heading asks nothing, so there is nothing to require. */}
                    {field.type === 'heading' ? null : (
                      <label className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={field.required}
                          disabled={!canEdit}
                          onChange={(event) => patch(index, { required: event.target.checked })}
                        />
                        Required
                      </label>
                    )}
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
                          onClick={() => removeField(index)}
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
              <Field id="lifecycle" label="Set lifecycle stage to">
                <Select
                  id="lifecycle"
                  value={settings.lifecycleStageOnSubmit ?? ''}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setSettings({ ...settings, lifecycleStageOnSubmit: event.target.value || null })
                  }
                >
                  <option value="">Leave unchanged</option>
                  {stageOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                id="slack-channel"
                label="Slack channel"
                hint={SLACK_CHANNEL_HINT[slack]}
              >
                <TextInput
                  id="slack-channel"
                  value={settings.slackChannel ?? ''}
                  disabled={!canEdit || slack !== 'bot'}
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
                      {member.name}
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
            <fieldset className="mt-3 flex flex-col gap-2">
              <legend className="font-medium">Subscribe new contacts to</legend>
              {askingConsent && (settings.subscriptionOptIns ?? []).length === 0 ? (
                <Alert tone="warning">
                  This form asks for consent but names nothing to subscribe to, so ticking
                  the box subscribes the person to nothing and the unsubscribe link they are
                  promised has nothing to act on.
                </Alert>
              ) : null}
              {optInTypes.length === 0 ? (
                <p className="text-small text-secondary">
                  This account has no customer-facing subscription types yet.
                </p>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {optInTypes.map((type) => {
                    const chosen = settings.subscriptionOptIns ?? []
                    const on = chosen.includes(type.name)
                    return (
                      <label key={type.name} className="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!canEdit}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              subscriptionOptIns: event.target.checked
                                ? [...chosen, type.name]
                                : chosen.filter((name) => name !== type.name),
                            })
                          }
                        />
                        {type.name}
                      </label>
                    )
                  })}
                </div>
              )}
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

/** Why the channel input is or is not usable. Said in the hint rather than left
 *  to be discovered: an enabled input that changes nothing is worse than a
 *  disabled one that says why. */
const SLACK_CHANNEL_HINT: Record<'none' | 'webhook' | 'bot', string> = {
  none: 'Slack is not connected, so nothing is posted anywhere yet. Connect it under Connected apps and this channel starts working.',
  webhook: 'This account connects Slack with an incoming webhook, and a webhook posts to the one channel it was created for.',
  bot: 'Blank uses the account default.',
}

/** Types whose answer is free text, so a length rule or a pattern means
 *  something. A choice field's answer is one of its own options, and a checkbox
 *  is two characters long: offering rules there is noise the submit path ignores. */
const TEXTUAL = new Set<FormFieldType>(['text', 'long_text', 'email', 'phone', 'url'])

/** Blank is not a rule. Kept out of the schema entirely rather than stored as ''
 *  or 0, both of which `form-validate.ts` would then read as a real bound. */
const trimmed = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim())
const counted = (value: string): number | undefined => {
  const n = Number(value)
  return value.trim() === '' || !Number.isFinite(n) ? undefined : n
}

/** Everything the submit path, the preview and the embed already honour but the
 *  builder never let anyone set. Behind a disclosure because most fields need
 *  none of it, and a form with twelve questions is unreadable if each one opens
 *  eight more inputs. */
const FieldExtras = ({
  field,
  index,
  others,
  canEdit,
  patch,
}: {
  field: FormField
  index: number
  others: FormField[]
  canEdit: boolean
  patch: (index: number, change: Partial<FormField>) => void
}) => {
  const rules = field.validation ?? {}
  type Rules = NonNullable<FormField['validation']>
  const setRule = (change: { [K in keyof Rules]?: Rules[K] | undefined }) => {
    const next = { ...rules, ...change }
    const kept = Object.entries(next).filter(([, value]) => value !== undefined)
    patch(index, { validation: kept.length === 0 ? undefined : (Object.fromEntries(kept) as FormField['validation']) })
  }

  const condition = field.visibleIf
  const source = others.find((other) => other.key === condition?.field)

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-secondary">
        Placeholder, help, rules and conditions
      </summary>

      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {field.type === 'boolean' || field.type === 'multi_select' || field.type === 'hidden' ? null : (
          <Field id={`placeholder-${index}`} label="Placeholder">
            <TextInput
              id={`placeholder-${index}`}
              value={field.placeholder ?? ''}
              disabled={!canEdit}
              onChange={(event) => patch(index, { placeholder: trimmed(event.target.value) })}
            />
          </Field>
        )}

        {field.type === 'hidden' ? (
          <Field
            id={`default-${index}`}
            label="Value"
            hint="Sent when the page embedding the form does not supply one."
          >
            <TextInput
              id={`default-${index}`}
              value={field.defaultValue ?? ''}
              disabled={!canEdit}
              onChange={(event) => patch(index, { defaultValue: trimmed(event.target.value) })}
            />
          </Field>
        ) : (
          <Field id={`help-${index}`} label="Help text" hint="Shown under the field.">
            <TextInput
              id={`help-${index}`}
              value={field.help ?? ''}
              disabled={!canEdit}
              onChange={(event) => patch(index, { help: trimmed(event.target.value) })}
            />
          </Field>
        )}

        {TEXTUAL.has(field.type) ? (
          <>
            <Field id={`minlen-${index}`} label="Shortest allowed">
              <TextInput
                id={`minlen-${index}`}
                type="number"
                min={0}
                value={rules.minLength ?? ''}
                disabled={!canEdit}
                onChange={(event) => setRule({ minLength: counted(event.target.value) })}
              />
            </Field>
            <Field id={`maxlen-${index}`} label="Longest allowed">
              <TextInput
                id={`maxlen-${index}`}
                type="number"
                min={0}
                value={rules.maxLength ?? ''}
                disabled={!canEdit}
                onChange={(event) => setRule({ maxLength: counted(event.target.value) })}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                id={`regex-${index}`}
                label="Must match"
                hint="A regular expression. Left blank, anything is accepted."
              >
                <TextInput
                  id={`regex-${index}`}
                  value={rules.regex ?? ''}
                  disabled={!canEdit}
                  onChange={(event) => setRule({ regex: trimmed(event.target.value) })}
                />
              </Field>
            </div>
          </>
        ) : null}

        {field.type === 'number' ? (
          <>
            <Field id={`min-${index}`} label="Smallest allowed">
              <TextInput
                id={`min-${index}`}
                type="number"
                value={rules.min ?? ''}
                disabled={!canEdit}
                onChange={(event) => setRule({ min: counted(event.target.value) })}
              />
            </Field>
            <Field id={`max-${index}`} label="Largest allowed">
              <TextInput
                id={`max-${index}`}
                type="number"
                value={rules.max ?? ''}
                disabled={!canEdit}
                onChange={(event) => setRule({ max: counted(event.target.value) })}
              />
            </Field>
          </>
        ) : null}

        <Field id={`when-${index}`} label="Only ask this when">
          <Select
            id={`when-${index}`}
            value={condition?.field ?? ''}
            disabled={!canEdit}
            onChange={(event) =>
              patch(index, {
                visibleIf: event.target.value
                  ? { field: event.target.value, equals: condition?.equals ?? '' }
                  : undefined,
              })
            }
          >
            <option value="">Always ask it</option>
            {others.map((other) => (
              <option key={other.key} value={other.key}>
                {other.label}
              </option>
            ))}
          </Select>
        </Field>

        {condition ? (
          <Field id={`equals-${index}`} label="…answers">
            {source?.options?.length ? (
              <Select
                id={`equals-${index}`}
                value={condition.equals}
                disabled={!canEdit}
                onChange={(event) => patch(index, { visibleIf: { ...condition, equals: event.target.value } })}
              >
                <option value="">Pick an answer</option>
                {source.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                id={`equals-${index}`}
                value={condition.equals}
                disabled={!canEdit}
                onChange={(event) => patch(index, { visibleIf: { ...condition, equals: event.target.value } })}
              />
            )}
          </Field>
        ) : null}
      </div>
    </details>
  )
}

/** How the form looks, as a choice rather than a stylesheet.
 *
 *  This exists because of what is live on datasaur.ai: every HubSpot form there
 *  carries hand-written override CSS fighting the embed's own, several rules with
 *  !important, and one that hides the validation errors outright. Nothing here
 *  writes a rule. A preset is a set of custom properties, the fields below change
 *  individual ones, and a designer who wants more sets the same properties on any
 *  ancestor and wins on the cascade without touching this. */
const ThemePanel = ({
  theme,
  canEdit,
  onChange,
}: {
  theme: FormTheme | undefined
  canEdit: boolean
  onChange: (theme: FormTheme) => void
}) => {
  const current: FormTheme = theme ?? { preset: 'neutral', tokens: {} }
  const resolved = resolveTheme(current)

  const set = (token: FormThemeToken, value: string) => {
    const tokens = { ...current.tokens }
    // Cleared rather than blanked: an absent token falls through to the preset,
    // and a preset with no value for it falls through to the stylesheet's own.
    if (value) tokens[token] = value
    else delete tokens[token]
    onChange({ ...current, tokens })
  }

  return (
    <section className="rounded-panel border border-line bg-surface p-3">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-medium">Look</h2>
        <span className="text-xs text-secondary">
          The preview shows this. Nothing here needs CSS on the site.
        </span>
        {canEdit && Object.keys(current.tokens).length > 0 ? (
          <Button
            type="button"
            variant="tertiary"
            className="ml-auto"
            onClick={() => onChange({ ...current, tokens: {} })}
          >
            Reset to {EMBED_PRESETS[current.preset]?.label ?? 'the preset'}
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="theme-preset" label="Starting point">
          <Select
            id="theme-preset"
            value={current.preset}
            disabled={!canEdit}
            onChange={(event) => onChange({ preset: event.target.value, tokens: current.tokens })}
          >
            {Object.entries(EMBED_PRESETS).map(([key, preset]) => (
              <option key={key} value={key}>
                {preset.label}
              </option>
            ))}
          </Select>
        </Field>

        {THEME_FIELDS.map(({ token, label, type, hint }) => (
          <Field key={token} id={`theme-${token}`} label={label} {...(hint ? { hint } : {})}>
            <div className="flex items-center gap-2">
              {type === 'color' ? (
                <input
                  type="color"
                  aria-label={`${label} colour picker`}
                  // A colour input only understands #rrggbb. A token set to
                  // "transparent" or a named colour is still typeable beside it;
                  // the swatch just shows black rather than lying about it.
                  value={/^#[0-9a-f]{6}$/i.test(resolved[token] ?? '') ? resolved[token]! : '#000000'}
                  disabled={!canEdit}
                  onChange={(event) => set(token, event.target.value)}
                  className="size-8 shrink-0 cursor-pointer rounded-hs border border-line bg-transparent p-0.5"
                />
              ) : null}
              <TextInput
                id={`theme-${token}`}
                value={current.tokens[token] ?? ''}
                placeholder={resolved[token] ?? 'default'}
                disabled={!canEdit}
                onChange={(event) => set(token, event.target.value)}
              />
            </div>
          </Field>
        ))}
      </div>
    </section>
  )
}

/** The tokens worth a control. The rest of FORM_THEME_TOKENS are reachable by
 *  setting the custom property on the site, which is the escape hatch; putting
 *  eleven inputs on this screen would bury the four that get used. */
const THEME_FIELDS: { token: FormThemeToken; label: string; type: 'color' | 'text'; hint?: string }[] = [
  { token: 'cta', label: 'Button', type: 'color' },
  { token: 'cta-text', label: 'Button text', type: 'color' },
  { token: 'text', label: 'Text', type: 'color' },
  { token: 'border', label: 'Field border', type: 'color' },
  { token: 'field-bg', label: 'Field background', type: 'color', hint: 'transparent for an underlined look.' },
  { token: 'radius', label: 'Corner radius', type: 'text', hint: 'A CSS length, e.g. 0px or 6px.' },
  { token: 'gap', label: 'Space between fields', type: 'text', hint: 'A CSS length, e.g. 1rem.' },
  { token: 'font', label: 'Font', type: 'text', hint: 'Blank inherits the page it sits on.' },
]
