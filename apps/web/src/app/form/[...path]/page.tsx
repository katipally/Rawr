import { ATTRIBUTION_FIELDS, countFormView } from '@rawr/db'
import type { Metadata } from 'next'
import { cookies, headers } from 'next/headers'
import { inBackground } from '~/server/background.ts'
import { FORM_COPY } from '~/lib/edge-copy.ts'
import { EMBED_STYLES } from '~/lib/embed-styles.ts'
import { presetOf, themeCss } from '~/lib/embed-themes.ts'
import { decodeEcho, echoCookieName } from '~/server/form-echo.ts'
import { hopHref } from '~/server/redirect-hop.ts'
import { submitHostedForm } from './actions.ts'
import { activeForm, resolve } from './lookup.ts'
import { HostedForm } from './hosted-form.tsx'

/** The hosted form page. Two jobs:
 *
 *  1. Where the embed script is blocked or fails, this is what it degrades to.
 *  2. It is the JavaScript-disabled path. It is a plain <form> that POSTs and
 *     re-renders with per-field errors. The honeypot and the timing token are
 *     hidden inputs here too, so a submission scores like one from the embed.
 *     Steps and conditions need script; without it every step shows stacked and
 *     the server does the checking.
 *
 *  Addressed two ways, because the two callers know different things:
 *    /form/<account>/<slug>   a person following a link a marketer wrote
 *    /form/<formId>             the embed's own fallback, which has only an id */

export const dynamic = 'force-dynamic'

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
  const form = await activeForm(path)

  const single = (key: string): string | null => {
    const value = query[key]
    return typeof value === 'string' ? value : null
  }

  // Errors come back through the URL, because a no-JS round trip has nowhere
  // else to put them and a redirect is what keeps the back button honest. The
  // answers typed travel in a cookie instead (form-echo.ts), and are only read
  // when there are errors to fix: a fresh visit starts blank.
  const rawErrors = single('e')
  const errors = parseErrors(rawErrors)
  const previous = rawErrors
    ? decodeEcho(form.fields, (await cookies()).get(echoCookieName(form.formId))?.value)
    : {}
  const sent = single('sent') === '1'
  const held = single('held') === '1'
  // A page reached from the form's own error redirect has the form as its
  // Referer, so the visitor's real referrer is carried in the URL instead.
  const referrer = single(ATTRIBUTION_FIELDS.referrer) ?? (await headers()).get('referer') ?? ''
  const hop = single('go') === '1' && form.settings.successMode === 'redirect' ? hopHref(form.settings.successValue) : null

  // The collector never runs here, so this is the only place a load of the
  // hosted page can be counted. Both steps at once: the page is the form, so
  // there is no gap between loading one and seeing the other. Not awaited, and
  // never allowed to fail the page: a counter is not worth a blank form.
  if (!sent) {
    inBackground(`form view ${form.formId}`, () =>
      countFormView({
        accountId: form.accountId,
        formId: form.formId,
        pagePath: `/form/${path.join('/')}`,
        kinds: ['view', 'render'],
      }),
    )
  }

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

          {sent && hop ? (
            <div className="rawr-done" role="status">
              <meta httpEquiv="refresh" content={`0;url=${hop}`} />
              <p className="rawr-done-title">{FORM_COPY.sent}</p>
              <a className="rawr-done-link" href={hop}>
                Go there now
              </a>
            </div>
          ) : sent ? (
            <div className="rawr-done" role="status">
              {held ? FORM_COPY.held : form.settings.successValue}
            </div>
          ) : (
            <>
              <HostedForm
                action={submitHostedForm}
                formId={form.formId}
                path={path.join('/')}
                referrer={referrer.slice(0, 2048)}
                timing={String(Date.now())}
                fields={form.fields}
                stepLabels={form.settings.steps ?? []}
                submitLabel={form.settings.submitLabel}
                errors={errors}
                previous={previous}
              />
              <script dangerouslySetInnerHTML={{ __html: KEEP_TYPING }} />
            </>
          )}
      </main>
    </>
  )
}

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
  .rawr-step[hidden] { display: none; }
  .rawr-step-title { grid-column: 1 / -1; margin: 0.5rem 0 0; font-weight: 500; }

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
