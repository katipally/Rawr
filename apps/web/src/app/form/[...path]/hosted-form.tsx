'use client'

import { ATTRIBUTION_FIELDS, HONEYPOT_FIELD, isVisible, TIMING_FIELD, type FormField } from '@rawr/db/forms'
import { useEffect, useRef, useState } from 'react'
import { PendingButton } from '~/components/pending-button.tsx'
import { FORM_COPY, formStep } from '~/lib/edge-copy.ts'

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

export type HostedErrors = { form: string | null; byKey: Record<string, string> }

/** The hosted form, paged and conditional once script runs.
 *
 *  Server-rendered it is every step stacked with its label and Submit at the end,
 *  which is the whole no-JavaScript form: the server checks every answer and
 *  ignores the fields a condition hides. Once mounted it shows one step at a time,
 *  hides the fields whose condition is not met, and checks only what is on screen.
 *  Hidden fields stay in the DOM and keep their values, so an earlier step's
 *  answers still post. */
export const HostedForm = ({
  action,
  formId,
  path,
  referrer,
  timing,
  fields,
  stepLabels,
  submitLabel,
  errors,
  previous,
}: {
  action: (data: FormData) => Promise<void>
  formId: string
  path: string
  referrer: string
  timing: string
  fields: FormField[]
  stepLabels: string[]
  submitLabel: string
  errors: HostedErrors
  previous: Record<string, string>
}) => {
  const formRef = useRef<HTMLFormElement>(null)
  const steps = Math.max(1, ...fields.map((field) => (field.step ?? 0) + 1))
  // A failed submit lands on the first step that has an error, not on step one.
  const errorSteps = fields.filter((field) => errors.byKey[field.key]).map((field) => field.step ?? 0)
  const [current, setCurrent] = useState(errorSteps.length > 0 ? Math.min(...errorSteps) : 0)
  const [live, setLive] = useState(false)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})

  useEffect(() => {
    if (formRef.current) setAnswers(answersOf(formRef.current))
    setLive(true)
  }, [])

  const readAnswers = () => {
    if (formRef.current) setAnswers(answersOf(formRef.current))
  }

  // The first control on screen that fails its own rules. Hidden ancestors are
  // skipped so a field that is out of view can never block the submit.
  const firstInvalid = (scope: Element): Control | undefined =>
    Array.from(scope.querySelectorAll<Control>('input, select, textarea')).find(
      (control) => !control.closest('[hidden]') && !control.checkValidity(),
    )

  const next = () => {
    const group = formRef.current?.querySelector(`[data-step="${current}"]`)
    const invalid = group ? firstInvalid(group) : undefined
    if (invalid) {
      invalid.reportValidity()
      return
    }
    setCurrent((step) => Math.min(step + 1, steps - 1))
  }

  // Enter in a field on a step that is not the last must not post the form.
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    if (!live) return
    if (current < steps - 1) {
      event.preventDefault()
      next()
      return
    }
    const invalid = firstInvalid(event.currentTarget)
    if (invalid) {
      event.preventDefault()
      invalid.reportValidity()
    }
  }

  return (
    <form
      ref={formRef}
      className="rawr-form"
      action={action}
      // Native validation would stop on a required field the step or condition
      // has hidden. Once mounted, firstInvalid checks what is on screen instead.
      noValidate={live}
      onChange={readAnswers}
      onSubmit={onSubmit}
    >
      <input type="hidden" name="rawr_form_id" value={formId} />
      <input type="hidden" name="rawr_path" value={path} />
      <input type="hidden" name={ATTRIBUTION_FIELDS.referrer} value={referrer} />
      {/* Rendered at page load, so the server reads the time from here to the
          submit. A bot that posts without loading the page has no such value. */}
      <input type="hidden" name={TIMING_FIELD} value={timing} />
      <div className="rawr-hp" aria-hidden="true">
        <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      {errors.form ? (
        <div className="rawr-status" role="alert">
          {errors.form}
        </div>
      ) : null}

      {live && steps > 1 ? (
        <div className="rawr-progress">
          <span className="rawr-progress-label">{formStep(current + 1, steps, stepLabels[current])}</span>
          <div className="rawr-progress-track">
            <div className="rawr-progress-fill" style={{ width: `${((current + 1) / steps) * 100}%` }} />
          </div>
        </div>
      ) : null}

      {Array.from({ length: steps }, (_, step) => (
        <div key={step} className="rawr-step" data-step={step} hidden={live && step !== current}>
          {steps > 1 && !live ? (
            <p className="rawr-step-title">{formStep(step + 1, steps, stepLabels[step])}</p>
          ) : null}
          {fields
            .filter((field) => (field.step ?? 0) === step)
            .map((field) => (
              <Field
                key={field.key}
                field={field}
                error={errors.byKey[field.key]}
                previous={previous[field.key] ?? null}
                hidden={live && !isVisible(field, answers)}
              />
            ))}
        </div>
      ))}

      <div className="rawr-actions">
        {live && current > 0 ? (
          <button type="button" onClick={() => setCurrent((step) => step - 1)}>
            Back
          </button>
        ) : null}
        {live && current < steps - 1 ? (
          <button type="button" className="rawr-next" onClick={next}>
            Next
          </button>
        ) : (
          <PendingButton className="rawr-submit" pendingLabel={FORM_COPY.sending}>
            {submitLabel}
          </PendingButton>
        )}
      </div>
    </form>
  )
}

/** Every answer on the form as the server would read it: one value as a string,
 *  a repeated key (a multi_select) as an array. An unchecked box is absent. */
const answersOf = (form: HTMLFormElement): Record<string, unknown> => {
  const data = new FormData(form)
  const out: Record<string, unknown> = {}
  for (const key of new Set(data.keys())) {
    const all = data.getAll(key).map(String)
    out[key] = all.length > 1 ? all : all[0]
  }
  return out
}

const Field = ({
  field,
  error,
  previous,
  hidden,
}: {
  field: FormField
  error: string | undefined
  previous: string | null
  hidden: boolean
}) => {
  if (field.type === 'hidden') {
    return <input type="hidden" name={field.key} defaultValue={field.defaultValue ?? ''} />
  }

  // Prefixed so a field key can never collide with the embed's own chrome. A
  // field keyed "consent" used to render as id="rawr-consent", which the consent
  // banner's own rule then positioned fixed across the bottom of the page.
  const id = `rawr-f-${field.key}`
  const describedBy = error ? `${id}-error` : field.help ? `${id}-help` : undefined

  if (field.type === 'heading') {
    return (
      <div className="rawr-field" data-field={field.key} data-wide hidden={hidden}>
        <p className="rawr-heading">{field.label}</p>
        {field.help ? <small className="rawr-help">{field.help}</small> : null}
      </div>
    )
  }

  // A file field cannot work without script: the upload is a signed PUT the
  // browser makes. Said plainly rather than rendered as a picker that does
  // nothing, and the rest of the form still submits without it.
  if (field.type === 'file') {
    return (
      <div className="rawr-field" data-field={field.key} data-wide hidden={hidden}>
        <label htmlFor={id}>{field.label}</label>
        <small className="rawr-help" id={`${id}-help`}>
          Attaching a file needs JavaScript. Send this form without it and we will ask for the file
          in our reply.
        </small>
      </div>
    )
  }

  if (field.type === 'consent') {
    return (
      <div className="rawr-field" data-field={field.key} data-wide hidden={hidden}>
        <label className="rawr-consent" htmlFor={id}>
          <input
            type="checkbox"
            id={id}
            name={field.key}
            value="true"
            required={field.required}
            aria-describedby={describedBy}
          />
          <span>
            {field.label}
            {field.required ? ' *' : ''}
          </span>
        </label>
        {field.help && !error ? (
          <small className="rawr-help" id={`${id}-help`}>
            {field.help}
          </small>
        ) : null}
        {error ? (
          <div className="rawr-error" id={`${id}-error`}>
            {error}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="rawr-field" data-field={field.key} hidden={hidden}>
      <label htmlFor={id}>
        {field.label}
        {field.required ? ' *' : ''}
      </label>

      {field.type === 'long_text' ? (
        <textarea
          id={id}
          name={field.key}
          rows={4}
          required={field.required}
          placeholder={field.placeholder}
          defaultValue={previous ?? ''}
          aria-describedby={describedBy}
        />
      ) : field.type === 'select' ? (
        <select id={id} name={field.key} required={field.required} defaultValue={previous ?? ''} aria-describedby={describedBy}>
          <option value="">{field.placeholder ?? 'Choose one'}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'radio' ? (
        <div className="rawr-choices" role="radiogroup" aria-labelledby={id}>
          {(field.options ?? []).map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={field.key}
                value={option.value}
                required={field.required}
                defaultChecked={previous === option.value}
              />{' '}
              {option.label}
            </label>
          ))}
        </div>
      ) : field.type === 'multi_select' ? (
        // The hosted page ships its own stylesheet, where a <fieldset> would need
        // its own reset to look the same. role="group" plus aria-labelledby names
        // the set and is announced.
        // biome-ignore lint/a11y/useSemanticElements: see above
        <div className="rawr-choices" role="group" aria-labelledby={id}>
          {(field.options ?? []).map((option) => (
            <label key={option.value}>
              <input type="checkbox" name={field.key} value={option.value} /> {option.label}
            </label>
          ))}
        </div>
      ) : field.type === 'boolean' ? (
        <input type="checkbox" id={id} name={field.key} value="true" aria-describedby={describedBy} />
      ) : (
        <input
          id={id}
          name={field.key}
          type={htmlType(field.type)}
          required={field.required}
          placeholder={field.placeholder}
          defaultValue={previous ?? ''}
          aria-describedby={describedBy}
        />
      )}

      {field.help && !error ? (
        <small className="rawr-help" id={`${id}-help`}>
          {field.help}
        </small>
      ) : null}
      {error ? (
        <div className="rawr-error" id={`${id}-error`}>
          {error}
        </div>
      ) : null}
    </div>
  )
}

const htmlType = (type: FormField['type']): string =>
  type === 'email' ? 'email'
    : type === 'phone' ? 'tel'
      : type === 'number' ? 'number'
        : type === 'date' ? 'date'
          : type === 'url' ? 'url'
            : 'text'
