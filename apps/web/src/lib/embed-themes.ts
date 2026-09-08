import { FORM_THEME_TOKENS, type FormTheme, type FormThemeToken } from '@rawr/db/forms'

/** What a form looks like, as values for the custom properties embed-styles.ts
 *  already reads.
 *
 *  This exists because of what is live on datasaur.ai today: the HubSpot embed
 *  ships its own stylesheet, so every form on that site carries a block of
 *  overrides fighting it, several with `!important`, one of which hides the
 *  validation errors outright. Nothing here is `!important` and nothing here is
 *  a rule — a preset is a set of values, so a marketer picks a look instead of
 *  writing CSS, and a designer who wants something else sets the same properties
 *  on any ancestor and wins on the cascade.
 *
 *  The names are stored in the database; the values live here beside the
 *  stylesheet that consumes them. A renamed colour is a deploy, not a migration. */

export type Preset = {
  label: string
  /** What the preview should sit on, since a light form on a light card and a
   *  dark form on a light card are not both honest. */
  canvas: string
  tokens: Partial<Record<FormThemeToken, string>>
}

export const EMBED_PRESETS: Record<string, Preset> = {
  /** HubSpot's palette on a light host page. Spelled out rather than left to the
   *  stylesheet's own fallbacks, because a builder swatch has to show the colour
   *  a form is actually using; an empty token renders as black and says nothing.
   *  These must stay in step with the fallbacks in embed-styles.ts. */
  neutral: {
    label: 'Neutral',
    canvas: '#ffffff',
    tokens: {
      text: '#33475b',
      muted: '#516f90',
      border: '#cbd6e2',
      focus: '#00a4bd',
      cta: '#ff7a59',
      'cta-text': '#ffffff',
      error: '#f2545b',
      radius: '3px',
      gap: '1rem',
      'field-bg': '#ffffff',
      'field-border-width': '1px',
    },
  },

  /** Datasaur's own: bare underlined inputs on a dark hero, Inter, a text-only
   *  submit. Reproduces what the footer and hero forms are hand-styled into. */
  underline: {
    label: 'Underline on dark',
    canvas: '#1b2738',
    tokens: {
      font: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
      text: '#ffffff',
      muted: '#8896a8',
      border: '#ffffff',
      focus: '#ffffff',
      cta: '#ff7a59',
      'cta-text': '#ffffff',
      error: '#ff8a8a',
      radius: '0px',
      gap: '1.25rem',
      'field-bg': 'transparent',
      'field-border-width': '0 0 1px',
    },
  },

  /** Boxed fields on a dark surface, for a form inside a dark card rather than
   *  over a photograph. */
  dark: {
    label: 'Boxed on dark',
    canvas: '#1b2738',
    tokens: {
      text: '#dfe3eb',
      muted: '#99acc2',
      border: '#33475b',
      focus: '#00a4bd',
      cta: '#ff7a59',
      'cta-text': '#ffffff',
      error: '#ff8a8a',
      radius: '6px',
      'field-bg': '#22304a',
      'field-border-width': '1px',
    },
  },
}

export const presetOf = (theme: FormTheme | undefined): Preset =>
  EMBED_PRESETS[theme?.preset ?? 'neutral'] ?? EMBED_PRESETS.neutral!

/** The resolved value of every token: the preset, then whatever was changed on
 *  top of it. A token neither sets is absent, so the stylesheet's own fallback
 *  applies and the declaration is never emitted at all. */
export const resolveTheme = (
  theme: FormTheme | undefined,
): Partial<Record<FormThemeToken, string>> => ({
  ...presetOf(theme).tokens,
  ...(theme?.tokens ?? {}),
})

/** The tokens as inline style properties, for React. */
export const themeStyle = (theme: FormTheme | undefined): Record<string, string> => {
  const resolved = resolveTheme(theme)
  const style: Record<string, string> = {}
  for (const name of FORM_THEME_TOKENS) {
    const value = resolved[name]
    if (value) style[`--rawr-embed-${name}`] = value
  }
  return style
}

/** The tokens as a stylesheet, for the embed and the hosted page, both of which
 *  inject CSS rather than render React. Scoped to the form's own attribute so a
 *  page with two differently themed forms renders both correctly. */
export const themeCss = (theme: FormTheme | undefined, selector = '[data-rawr-form]'): string => {
  const style = themeStyle(theme)
  const declarations = Object.entries(style)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')
  return declarations ? `${selector} {\n${declarations}\n}` : ''
}
