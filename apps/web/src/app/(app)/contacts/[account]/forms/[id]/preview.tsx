'use client'

import { isVisible, type FormField, type FormSettings } from '@rawr/db/forms'
import { Button } from '@rawr/ui'
import { useState } from 'react'
import { FORM_COPY, formStep } from '~/lib/edge-copy.ts'
import { EMBED_STYLES } from '~/lib/embed-styles.ts'
import { presetOf, themeStyle } from '~/lib/embed-themes.ts'

type PreviewState = 'form' | 'sending' | 'sent' | 'failed'

const STATES: [PreviewState, string][] = [
  ['form', 'Form'],
  ['sending', 'Sending'],
  ['sent', 'Sent'],
  ['failed', 'Could not send'],
]

/** The preview renders the real embed markup and the real embed stylesheet, not
 *  an approximation built out of the app's own primitives. What a marketer signs
 *  off here is what a visitor gets, including the conditional fields and the
 *  step split.
 *
 *  It never submits: there is no action and no endpoint. A preview that could
 *  create a contact would fill the CRM with test leads. */

export const FormPreview = ({
  fields,
  settings,
}: {
  fields: FormField[]
  settings: FormSettings
}) => {
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [step, setStep] = useState(0)
  const [narrow, setNarrow] = useState(false)
  const [shown, setShown] = useState<PreviewState>('form')

  const steps = Math.max(1, ...fields.map((field) => (field.step ?? 0) + 1))
  const current = Math.min(step, steps - 1)
  const onThisStep = fields.filter((field) => (field.step ?? 0) === current)
  const stepLabel = settings.steps?.[current]

  return (
    // Sticky, because the questions being edited are below the fold long before
    // the form they build is, and a preview you have to scroll back up to see is
    // one nobody looks at. top is the app header's own height plus its padding.
    <aside className="flex min-w-0 flex-col gap-2 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-medium">Preview</h2>
        <button
          type="button"
          onClick={() => setNarrow((value) => !value)}
          className="text-xs text-link"
        >
          {narrow ? 'Show wide' : 'Show at 320px'}
        </button>
        {steps > 1 ? (
          <span className="ml-auto text-xs text-secondary">
            {formStep(current + 1, steps, stepLabel)}
            <button
              type="button"
              className="ml-2 text-link"
              onClick={() => setStep((value) => (value + 1) % steps)}
            >
              next
            </button>
          </span>
        ) : null}
      </div>

      {/* The three moments a visitor sees that a marketer otherwise never does,
          because the preview deliberately cannot submit. Signing off the form
          without ever seeing what its failure says is how bad failure copy ships. */}
      <div className="flex flex-wrap gap-1">
        {STATES.map(([value, label]) => (
          <Button
            key={value}
            variant={shown === value ? 'secondary' : 'tertiary'}
            aria-pressed={shown === value}
            onClick={() => setShown(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      <style dangerouslySetInnerHTML={{ __html: EMBED_STYLES }} />

      <div
        className="rounded-panel border border-line p-3"
        // The embed is sized by its container, so the preview proves that by
        // being a container of a chosen width rather than a whole viewport.
        //
        // Painted with the theme's own canvas rather than the app's surface, in
        // both app themes. The app's dark panel under the embed's light defaults
        // put #33475b text at about 1.8:1 and showed a preview no visitor would
        // ever see; the theme's canvas is what the form will actually sit on.
        style={{
          background: presetOf(settings.theme).canvas,
          ...themeStyle(settings.theme),
          ...(narrow ? { maxWidth: '320px' } : {}),
        }}
      >
        <div data-rawr-form>
          {shown === 'sent' ? (
            <div className="rawr-done" role="status">
              <p className="rawr-done-title">{settings.successValue}</p>
            </div>
          ) : (
            <div className="rawr-form">
              {steps > 1 ? (
                <div className="rawr-progress">
                  <span className="rawr-progress-label">{formStep(current + 1, steps, stepLabel)}</span>
                  <div className="rawr-progress-track">
                    <div
                      className="rawr-progress-fill"
                      style={{ width: `${((current + 1) / steps) * 100}%` }}
                    />
                  </div>
                </div>
              ) : null}
              <div className="rawr-step">
                {onThisStep.map((field) => (
                  <PreviewField
                    key={field.key}
                    field={field}
                    hidden={!isVisible(field, answers)}
                    onChange={(value) => setAnswers((all) => ({ ...all, [field.key]: value }))}
                  />
                ))}
              </div>
              {shown === 'failed' ? <div className="rawr-status">{FORM_COPY.failed}</div> : null}
              {/* Not disabled. A disabled button renders at 0.6 opacity, which
                  made the preview lie about the one colour a marketer is here to
                  choose. It does nothing when clicked because it has no action:
                  the whole preview is outside a form element. */}
              <div className="rawr-actions">
                <button type="button" className="rawr-submit" aria-busy={shown === 'sending'}>
                  {shown === 'sending' ? FORM_COPY.sending : settings.submitLabel}
                </button>
                {shown === 'failed' ? (
                  <button type="button" className="rawr-retry">
                    {FORM_COPY.retry}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-secondary">
        The preview never submits. Conditional fields appear and disappear here exactly as they
        will on the site.
      </p>
    </aside>
  )
}

const PreviewField = ({
  field,
  hidden,
  onChange,
}: {
  field: FormField
  hidden: boolean
  onChange: (value: unknown) => void
}) => {
  if (field.type === 'hidden') return null
  const id = `preview-f-${field.key}`

  if (field.type === 'heading') {
    return (
      <div className="rawr-field" data-field={field.key} data-wide hidden={hidden}>
        <p className="rawr-heading">{field.label}</p>
        {field.help ? <small className="rawr-help">{field.help}</small> : null}
      </div>
    )
  }

  if (field.type === 'consent') {
    return (
      <div className="rawr-field" data-field={field.key} data-wide hidden={hidden}>
        <label className="rawr-consent" htmlFor={id}>
          <input type="checkbox" id={id} onChange={(e) => onChange(String(e.target.checked))} />
          <span>
            {field.label}
            {field.required ? ' *' : ''}
          </span>
        </label>
        {field.help ? <small className="rawr-help">{field.help}</small> : null}
      </div>
    )
  }

  return (
    <div className="rawr-field" data-field={field.key} hidden={hidden}>
      <label htmlFor={id}>
        {field.label}
        {field.required ? ' *' : ''}
      </label>

      {field.type === 'file' ? (
        // A real picker, so the marketer sees the height it takes and how a long
        // filename wraps. It uploads nothing: the preview reaches no endpoint.
        <div className="rawr-file">
          <input type="file" id={id} disabled />
        </div>
      ) : field.type === 'radio' ? (
        <div className="rawr-choices" role="radiogroup">
          {(field.options ?? []).map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={id}
                value={option.value}
                onChange={() => onChange(option.value)}
              />{' '}
              {option.label}
            </label>
          ))}
        </div>
      ) : field.type === 'long_text' ? (
        <textarea id={id} rows={4} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : field.type === 'select' ? (
        <select id={id} onChange={(e) => onChange(e.target.value)} defaultValue="">
          <option value="">{field.placeholder ?? 'Choose one'}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'multi_select' ? (
        // The preview renders the public form's own stylesheet, where a <fieldset>
        // would need its own reset to look the same. role="group" names the set.
        // biome-ignore lint/a11y/useSemanticElements: see above
        <div className="rawr-choices" role="group">
          {(field.options ?? []).map((option) => (
            <label key={option.value}>
              <input type="checkbox" value={option.value} /> {option.label}
            </label>
          ))}
        </div>
      ) : field.type === 'boolean' ? (
        <input type="checkbox" id={id} onChange={(e) => onChange(String(e.target.checked))} />
      ) : (
        <input
          id={id}
          type={
            field.type === 'email' ? 'email'
              : field.type === 'phone' ? 'tel'
                : field.type === 'number' ? 'number'
                  : field.type === 'date' ? 'date'
                    : field.type === 'url' ? 'url'
                      : 'text'
          }
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.help ? <small className="rawr-help">{field.help}</small> : null}
    </div>
  )
}
