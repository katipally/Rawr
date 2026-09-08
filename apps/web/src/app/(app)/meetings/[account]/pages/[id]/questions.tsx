'use client'

// Values come from the browser-safe subpath, not the barrel: importing a runtime
// value from '@rawr/db' here pulls the Postgres driver into the client bundle.
import { FORM_FIELD_TYPES, type FormField } from '@rawr/db/forms'
import { Button, Field, Select, TextInput } from '@rawr/ui'

/** The extra questions a booking page asks.
 *
 *  Deliberately the same `FormField` shape a form uses, validated by the same
 *  parser on save, so a booking question cannot be something a form would have
 *  refused. Mapping targets come from the registry, which is why a custom field
 *  marketing added is available here without a deploy. */

export type MappingTarget = { value: string; label: string }

const KEY = /^[a-z][a-z0-9_]{0,58}$/

/** Blank is not an answer. Left as '' the parser would store an empty
 *  placeholder and the page would render one. */
const blank = (value: string): string | undefined => (value.trim() === '' ? undefined : value)

/** A condition on a choice question picks from that question's own choices; on
 *  anything else it is whatever the visitor might type. */
const AnswerControl = ({
  id,
  value,
  options,
  editable,
  onChange,
}: {
  id: string
  value: string
  options: { value: string; label: string }[]
  editable: boolean
  onChange: (value: string) => void
}) =>
  options.length > 0 ? (
    <Select id={id} value={value} disabled={!editable} onChange={(event) => onChange(event.target.value)}>
      <option value="">Pick an answer</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  ) : (
    <TextInput id={id} value={value} disabled={!editable} onChange={(event) => onChange(event.target.value)} />
  )

const toKey = (label: string, taken: Set<string>): string => {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 58) || 'question'
  const start = KEY.test(base) ? base : `q_${base}`.slice(0, 58)
  let key = start
  let n = 2
  while (taken.has(key)) key = `${start}_${n++}`.slice(0, 58)
  return key
}

export const QuestionList = ({
  questions,
  onChange,
  editable,
  targets = [],
}: {
  questions: FormField[]
  onChange: (next: FormField[]) => void
  editable: boolean
  targets?: MappingTarget[]
}) => {
  const patch = (index: number, changes: Partial<FormField>) =>
    onChange(questions.map((question, at) => (at === index ? { ...question, ...changes } : question)))

  const add = () => {
    const taken = new Set(questions.map((question) => question.key))
    onChange([
      ...questions,
      {
        key: toKey(`question ${questions.length + 1}`, taken),
        type: 'text',
        label: `Question ${questions.length + 1}`,
        required: false,
        mapsTo: null,
      },
    ])
  }

  const move = (index: number, by: number) => {
    const to = index + by
    if (to < 0 || to >= questions.length) return
    const next = [...questions]
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(to, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {questions.length === 0 ? (
        <p className="text-sm text-secondary">
          No extra questions. The page asks for a name and a work email.
        </p>
      ) : null}

      {questions.map((question, index) => (
        <div
          key={question.key}
          className="grid gap-2 rounded-hs border border-divider p-2 sm:grid-cols-2"
        >
          <Field id={`q-label-${index}`} label="Question" required>
            <TextInput
              id={`q-label-${index}`}
              value={question.label}
              disabled={!editable}
              onChange={(event) => patch(index, { label: event.target.value })}
            />
          </Field>

          <Field
            id={`q-key-${index}`}
            label="Stored as"
            hint="Lowercase letters, numbers and underscores. Renaming this loses past answers."
          >
            <TextInput
              id={`q-key-${index}`}
              value={question.key}
              disabled={!editable}
              onChange={(event) => patch(index, { key: event.target.value })}
            />
          </Field>

          <Field id={`q-type-${index}`} label="Kind">
            <Select
              id={`q-type-${index}`}
              value={question.type}
              disabled={!editable}
              onChange={(event) =>
                patch(index, { type: event.target.value as FormField['type'] })
              }
            >
              {FORM_FIELD_TYPES.filter((type) => type !== 'hidden').map((type) => (
                <option key={type} value={type}>
                  {type.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id={`q-maps-${index}`}
            label="Files onto"
            hint="An unmapped answer is still stored on the booking."
          >
            <Select
              id={`q-maps-${index}`}
              value={question.mapsTo ?? ''}
              disabled={!editable}
              onChange={(event) =>
                patch(index, { mapsTo: (event.target.value || null) as FormField['mapsTo'] })
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

          {question.type === 'select' || question.type === 'multi_select' ? (
            <Field
              id={`q-options-${index}`}
              label="Choices"
              hint="One per line. A choice the page does not offer is refused on submit."
            >
              <TextInput
                id={`q-options-${index}`}
                value={(question.options ?? []).map((option) => option.label).join(', ')}
                disabled={!editable}
                onChange={(event) =>
                  patch(index, {
                    options: event.target.value
                      .split(',')
                      .map((label) => label.trim())
                      .filter(Boolean)
                      .map((label) => ({ value: label, label })),
                  })
                }
              />
            </Field>
          ) : null}

          {/* Accepted by the router, rendered by the public page and the embed,
              and until now settable nowhere. Behind a disclosure so a page with
              six questions stays readable. */}
          <details className="sm:col-span-2">
            <summary className="cursor-pointer text-xs text-secondary">
              Placeholder, help and conditions
            </summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field id={`q-placeholder-${index}`} label="Placeholder">
                <TextInput
                  id={`q-placeholder-${index}`}
                  value={question.placeholder ?? ''}
                  disabled={!editable}
                  onChange={(event) => patch(index, { placeholder: blank(event.target.value) })}
                />
              </Field>
              <Field id={`q-help-${index}`} label="Help text" hint="Shown under the question.">
                <TextInput
                  id={`q-help-${index}`}
                  value={question.help ?? ''}
                  disabled={!editable}
                  onChange={(event) => patch(index, { help: blank(event.target.value) })}
                />
              </Field>
              <Field id={`q-when-${index}`} label="Only ask this when">
                <Select
                  id={`q-when-${index}`}
                  value={question.visibleIf?.field ?? ''}
                  disabled={!editable}
                  onChange={(event) =>
                    patch(index, {
                      visibleIf: event.target.value
                        ? { field: event.target.value, equals: question.visibleIf?.equals ?? '' }
                        : undefined,
                    })
                  }
                >
                  <option value="">Always ask it</option>
                  {questions
                    .filter((other) => other.key !== question.key)
                    .map((other) => (
                      <option key={other.key} value={other.key}>
                        {other.label}
                      </option>
                    ))}
                </Select>
              </Field>
              {question.visibleIf ? (
                <Field id={`q-equals-${index}`} label="…answers">
                  <AnswerControl
                    id={`q-equals-${index}`}
                    editable={editable}
                    value={question.visibleIf.equals}
                    options={
                      questions.find((other) => other.key === question.visibleIf?.field)?.options ?? []
                    }
                    onChange={(equals) =>
                      patch(index, { visibleIf: { field: question.visibleIf?.field ?? '', equals } })
                    }
                  />
                </Field>
              ) : null}
            </div>
          </details>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={question.required}
                disabled={!editable}
                onChange={(event) => patch(index, { required: event.target.checked })}
              />
              Required
            </label>
            <Button type="button" disabled={!editable || index === 0} onClick={() => move(index, -1)}>
              Up
            </Button>
            <Button
              type="button"
              disabled={!editable || index === questions.length - 1}
              onClick={() => move(index, 1)}
            >
              Down
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!editable}
              onClick={() => onChange(questions.filter((_, at) => at !== index))}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}

      {editable ? (
        <Button type="button" onClick={add} className="self-start">
          Add a question
        </Button>
      ) : null}
    </div>
  )
}
