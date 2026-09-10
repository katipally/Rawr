import {
  HONEYPOT_FIELD,
  publicFormById,
  publicFormBySlug,
  TIMING_FIELD,
  type FormField,
  type PublicForm,
} from '@rawr/db'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { PendingButton } from '~/components/pending-button.tsx'
import { FORM_COPY } from '~/lib/edge-copy.ts'
import { EMBED_STYLES } from '~/lib/embed-styles.ts'
import { presetOf, themeCss } from '~/lib/embed-themes.ts'
import { submitHostedForm } from './actions.ts'

/** The hosted form page. Two jobs:
 *
 *  1. Where the embed script is blocked or fails, this is what it degrades to.
 *  2. It is the JavaScript-disabled path. It is a plain server-rendered <form>
 *     that POSTs and re-renders with per-field errors. No script runs here at
 *     all, which is why the honeypot and the timing token are absent and the
 *     spam score reflects that rather than blocking a real person.
 *
 *  Addressed two ways, because the two callers know different things:
 *    /form/<account>/<slug>   a person following a link a marketer wrote
 *    /form/<formId>             the embed's own fallback, which has only an id */

export const dynamic = 'force-dynamic'

/** Keyed on the path parts rather than the array, so the metadata pass and the
 *  render below it share one lookup instead of querying the same form twice. */
const lookup = cache(
  async (first: string, second?: string): Promise<PublicForm | null> =>
    second === undefined ? publicFormById(first) : publicFormBySlug(first, second),
)

const resolve = async (path: string[]): Promise<PublicForm | null> => {
  if (path.length === 1 && path[0]) return lookup(path[0])
  if (path.length === 2 && path[0] && path[1]) return lookup(path[0], path[1])
  return null
}

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ path: string[] }>
}): Promise<Metadata> => {
  const { path } = await params
  // Metadata runs outside every error boundary, so a database that is down here
  // takes the whole response down with it. The page below re-awaits the same
  // cached lookup and throws into the boundary, where the failure is visible.
  const form = await resolve(path).catch(() => null)
  return { title: form?.name ?? 'Form', robots: { index: false } }
}

const HostedFormPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const { path } = await params
  const query = await searchParams
  const form = await resolve(path)
  if (!form || !form.isActive) notFound()

  const single = (key: string): string | null => {
    const value = query[key]
    return typeof value === 'string' ? value : null
  }

  // Errors and the resubmitted answers come back through the URL, because a
  // no-JS round trip has nowhere else to put them and a redirect is what keeps
  // the back button honest.
  const errors = parseErrors(single('e'))
  const sent = single('sent') === '1'
  const held = single('held') === '1'

  // Rendered inside the app's root layout, which already provides the document
  // and the font. Only the page's own styles are injected here.
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html:
            `${PAGE_STYLES}\n${EMBED_STYLES}\n${themeCss(form.settings.theme, '.rawr-hosted')}\n` +
            // The page behind the form, not the form. A dark-hero theme on a
            // pale page is a rectangle of white text nobody can read.
            `body { --rawr-page-bg: ${presetOf(form.settings.theme).canvas}; }`,
        }}
      />
      <main
        data-rawr-form
        className="rawr-hosted"
        data-theme={form.settings.theme?.preset ?? 'neutral'}
      >
          <h1>{form.name}</h1>

          {sent ? (
            <div className="rawr-done" role="status">
              {held
                ? 'Thanks. This has been received and is being reviewed, so it may take a little longer than usual.'
                : form.settings.successValue}
            </div>
          ) : (
            <>
            <form className="rawr-form" action={submitHostedForm}>
              <input type="hidden" name="rawr_form_id" value={form.formId} />
              <input type="hidden" name="rawr_path" value={path.join('/')} />
              {/* Present so the two paths score identically when script does run;
                  on a no-JS load it stays at the render time, which the server
                  reads as a slow, human fill rather than a bot. */}
              <input type="hidden" name={TIMING_FIELD} value={String(Date.now())} />
              <div className="rawr-hp" aria-hidden="true">
                <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
              </div>

              {errors.form ? (
                <div className="rawr-status" role="alert">
                  {errors.form}
                </div>
              ) : null}

              <div className="rawr-step">
                {form.fields.map((field) => (
                  <Field key={field.key} field={field} error={errors.byKey[field.key]} previous={single(`v_${field.key}`)} />
                ))}
              </div>

              <div className="rawr-actions">
                <PendingButton className="rawr-submit" pendingLabel={FORM_COPY.sending}>
                  {form.settings.submitLabel}
                </PendingButton>
              </div>
            </form>
            <script dangerouslySetInnerHTML={{ __html: KEEP_TYPING }} />
            </>
        )}
      </main>
    </>
  )
}

const Field = ({
  field,
  error,
  previous,
}: {
  field: FormField
  error: string | undefined
  previous: string | null
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
      <div className="rawr-field" data-field={field.key} data-wide>
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
      <div className="rawr-field" data-field={field.key} data-wide>
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
      <div className="rawr-field" data-field={field.key} data-wide>
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
    <div className="rawr-field" data-field={field.key}>
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

const parseErrors = (raw: string | null): { form: string | null; byKey: Record<string, string> } => {
  if (!raw) return { form: null, byKey: {} }
  try {
    const parsed = JSON.parse(raw) as { form?: string; byKey?: Record<string, string> }
    return { form: parsed.form ?? null, byKey: parsed.byKey ?? {} }
  } catch {
    return { form: null, byKey: {} }
  }
}

/** Only what the hosted page needs on top of the shared embed styles: this is a
 *  standalone document rather than something dropped into Webflow's page. */
/** Typing survives hydration.
 *
 *  This page is server-rendered HTML, so somebody on a slow connection can fill
 *  it in before React's bundle arrives. When the bundle does arrive it commits
 *  the markup's own defaults over what they typed, and the form empties under
 *  their hands with nothing on screen to explain it.
 *
 *  Inline rather than a component, because it has to be running before the
 *  bundle it is repairing. It records every keystroke, then puts back anything
 *  that went empty without the person emptying it. Session storage, so a back
 *  button returns to a filled form and a new tab starts clean; cleared on
 *  submit, so the next visitor to a shared machine sees nothing.
 *
 *  Written as a plain string: this never goes through the bundler, and nothing
 *  in it may depend on anything that does. */
const KEEP_TYPING = `
(function () {
  var form = document.querySelector('form.rawr-form')
  if (!form || !window.sessionStorage) return
  var key = 'rawr:draft:' + (form.elements['rawr_form_id'] || {}).value
  var skip = { rawr_form_id: 1, rawr_path: 1 }
  var saved = {}
  try { saved = JSON.parse(sessionStorage.getItem(key) || '{}') } catch (e) { saved = {} }

  var fields = function () {
    return Array.prototype.filter.call(form.elements, function (el) {
      return el.name && !skip[el.name] && el.type !== 'hidden' && el.type !== 'submit'
    })
  }

  var save = function () {
    var next = {}
    fields().forEach(function (el) {
      next[el.name] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value
    })
    saved = next
    try { sessionStorage.setItem(key, JSON.stringify(next)) } catch (e) {}
  }

  // Only ever fills a blank. Overwriting something the person has since retyped
  // would be the same bug from the other direction.
  var restore = function () {
    fields().forEach(function (el) {
      var was = saved[el.name]
      if (was === undefined) return
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (was && !el.checked) el.checked = true
      } else if (was !== '' && el.value === '') {
        el.value = was
      }
    })
  }

  form.addEventListener('input', save)
  form.addEventListener('change', save)
  form.addEventListener('submit', function () {
    try { sessionStorage.removeItem(key) } catch (e) {}
  })

  restore()
  // Hydration lands after this script and can land more than once while the page
  // streams, so the repair watches for a while rather than running once. Two
  // seconds covers a slow bundle; after that the form is React's and stays put.
  var until = Date.now() + 2000
  var tick = function () {
    restore()
    if (Date.now() < until) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  window.addEventListener('pageshow', restore)
})()
`

const PAGE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--rawr-page-bg, #f5f8fa);
    color: #33475b;
    font-family: 'Lexend Deca', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-weight: 300;
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .rawr-hosted {
    max-inline-size: 44rem;
    margin-inline: auto;
    padding: clamp(1rem, 4vw, 3rem) clamp(1rem, 4vw, 2rem);
  }
  .rawr-hosted h1 { font-size: 1.25rem; font-weight: 500; margin: 0 0 1.5rem; }

  /* Only where the form has no look of its own. A form themed for a dark hero
     already says what it wants, and following the reader's system setting on top
     of that would repaint a chosen design out from under whoever chose it. */
  @media (prefers-color-scheme: dark) {
    body:has(.rawr-hosted[data-theme="neutral"]) { background: #1b2738; color: #dfe3eb; }
    .rawr-hosted[data-theme="neutral"] {
      --rawr-embed-text: #dfe3eb;
      --rawr-embed-muted: #99acc2;
      --rawr-embed-border: #33475b;
      --rawr-embed-field-bg: #22304a;
    }
  }
`

export default HostedFormPage
