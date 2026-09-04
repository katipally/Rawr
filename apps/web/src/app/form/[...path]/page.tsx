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
 *    /form/<workspace>/<slug>   a person following a link a marketer wrote
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
      <style dangerouslySetInnerHTML={{ __html: `${PAGE_STYLES}\n${EMBED_STYLES}` }} />
      <main data-rawr-form className="rawr-hosted">
          <h1>{form.name}</h1>

          {sent ? (
            <div className="rawr-done" role="status">
              {held
                ? 'Thanks. This has been received and is being reviewed, so it may take a little longer than usual.'
                : form.settings.successValue}
            </div>
          ) : (
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

  const id = `rawr-${field.key}`
  const describedBy = error ? `${id}-error` : field.help ? `${id}-help` : undefined

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
const PAGE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f5f8fa;
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
  @media (prefers-color-scheme: dark) {
    body { background: #1b2738; color: #dfe3eb; }
    [data-rawr-form] {
      --rawr-embed-text: #dfe3eb;
      --rawr-embed-muted: #99acc2;
      --rawr-embed-border: #33475b;
      --rawr-embed-field-bg: #22304a;
    }
  }
`

export default HostedFormPage
