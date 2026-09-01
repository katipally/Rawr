/** Styles for the public booking page and its embed.
 *
 *  Same rules as the form embed: it renders inside Webflow's design, not ours, so
 *  every value is a custom property with a fallback and marketing re-themes it by
 *  setting --rawr-embed-* on any ancestor. No deploy, no stylesheet of ours
 *  overriding theirs.
 *
 *  Not one media query. The widget does not know how wide the viewport is and does
 *  not care; it only cares how wide its own container is, which is what container
 *  queries answer. That is what makes the same markup work in a 320px phone column
 *  and a 1200px desktop slot on the same page. */

export const BOOKING_STYLES = `
[data-rawr-booking-widget] {
  --_font: var(--rawr-embed-font, inherit);
  --_text: var(--rawr-embed-text, #33475b);
  --_muted: var(--rawr-embed-muted, #516f90);
  --_border: var(--rawr-embed-border, #cbd6e2);
  --_focus: var(--rawr-embed-focus, #00a4bd);
  --_cta: var(--rawr-embed-cta, #ff7a59);
  --_cta-text: var(--rawr-embed-cta-text, #ffffff);
  --_error: var(--rawr-embed-error, #f2545b);
  --_ok: var(--rawr-embed-success, #00bda5);
  --_radius: var(--rawr-embed-radius, 3px);
  --_gap: var(--rawr-embed-gap, 1rem);
  --_field-bg: var(--rawr-embed-field-bg, #ffffff);
  --_surface: var(--rawr-embed-banner-bg, #ffffff);

  font-family: var(--_font);
  color: var(--_text);
  font-weight: 300;
  line-height: 1.5;
  container-type: inline-size;
  display: block;
  max-width: 100%;
}

[data-rawr-booking-widget] * { box-sizing: border-box; }
[data-rawr-booking-widget] h1,
[data-rawr-booking-widget] h2,
[data-rawr-booking-widget] h3 { margin: 0; font-size: 1rem; font-weight: 500; }
[data-rawr-booking-widget] p { margin: 0; }

.rawr-b { display: flex; flex-direction: column; gap: var(--_gap); }
.rawr-b-head { display: flex; flex-direction: column; gap: 0.25rem; }
.rawr-b-title { font-size: 1.125rem; font-weight: 500; }
.rawr-b-meta { color: var(--_muted); font-size: 0.8125rem; display: flex; flex-wrap: wrap; gap: 0.75rem; }

/* One column until the container has room for two. */
.rawr-b-body { display: grid; gap: var(--_gap); grid-template-columns: minmax(0, 1fr); }
@container (min-width: 34rem) {
  .rawr-b-body[data-two] { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); }
}

.rawr-b-panel {
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
  background: var(--_surface);
  padding: 0.75rem;
  min-width: 0;
}

.rawr-b-monthbar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-block-end: 0.5rem; }
.rawr-b-month { font-weight: 500; }

.rawr-b-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
.rawr-b-dow { text-align: center; font-size: 0.6875rem; color: var(--_muted); padding-block: 0.25rem; }

.rawr-b-day {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px;
  /* Height comes from the type, not from the column width. aspect-ratio here made
     every cell as tall as it was wide, so on a 1400px container one month ran
     1200px down the page. A day cell only ever holds a number and a dot. */
  min-block-size: 2.75rem;
  padding-block: 0.25rem;
  border: 1px solid transparent;
  border-radius: var(--_radius);
  background: none;
  color: inherit;
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}
.rawr-b-day[data-open] { border-color: var(--_border); font-weight: 500; }
.rawr-b-day[data-open]:hover { border-color: var(--_focus); }
.rawr-b-day[data-closed] { color: var(--_muted); opacity: 0.5; cursor: default; }
.rawr-b-day[aria-current='date'] { background: var(--_focus); color: #fff; border-color: var(--_focus); }
.rawr-b-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--_focus); }
.rawr-b-day[aria-current='date'] .rawr-b-dot { background: #fff; }

/* Times: as many columns as fit, never a fixed count. */
.rawr-b-times { display: grid; gap: 0.375rem; grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr)); }
.rawr-b-slot {
  display: block; text-align: center; padding: 0.5rem 0.25rem;
  border: 1px solid var(--_border); border-radius: var(--_radius);
  text-decoration: none; color: inherit; font: inherit; background: var(--_field-bg);
  overflow-wrap: anywhere;
}
.rawr-b-slot:hover { border-color: var(--_focus); }
.rawr-b-slot[aria-current='true'] { background: var(--_focus); border-color: var(--_focus); color: #fff; }

.rawr-b-form { display: flex; flex-direction: column; gap: 0.75rem; }
.rawr-b-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.rawr-b-field label { font-weight: 500; font-size: 0.8125rem; }
.rawr-b-field input, .rawr-b-field select, .rawr-b-field textarea {
  width: 100%; min-width: 0; font: inherit; color: inherit;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--_border); border-radius: var(--_radius);
  background: var(--_field-bg);
}
.rawr-b-field input:focus-visible, .rawr-b-field select:focus-visible, .rawr-b-field textarea:focus-visible {
  outline: 2px solid var(--_focus); outline-offset: 1px;
}
.rawr-b-field textarea { min-height: 4.5rem; resize: vertical; }
.rawr-b-hint { color: var(--_muted); font-size: 0.75rem; }
.rawr-b-err { color: var(--_error); font-size: 0.75rem; }

.rawr-b-cta {
  align-self: flex-start;
  font: inherit; font-weight: 500;
  padding: 0.5rem 1rem;
  border: 1px solid var(--_cta); border-radius: var(--_radius);
  background: var(--_cta); color: var(--_cta-text);
  cursor: pointer;
}
.rawr-b-cta:hover { filter: brightness(1.05); }

.rawr-b-note {
  border: 1px solid var(--_border); border-left-width: 3px; border-left-color: var(--_focus);
  border-radius: var(--_radius); padding: 0.625rem 0.75rem; color: var(--_muted); font-size: 0.8125rem;
}
.rawr-b-note[data-bad] { border-left-color: var(--_error); color: var(--_error); }
.rawr-b-note[data-good] { border-left-color: var(--_ok); }

.rawr-b-tz { display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; font-size: 0.8125rem; }
.rawr-b-tz select { font: inherit; max-width: 100%; padding: 0.25rem; border: 1px solid var(--_border); border-radius: var(--_radius); background: var(--_field-bg); color: inherit; }

/* Long unbroken strings are the normal case: 500-character names, pasted URLs.
   Nothing may push the widget sideways. */
[data-rawr-booking-widget] p,
[data-rawr-booking-widget] li,
[data-rawr-booking-widget] label,
[data-rawr-booking-widget] .rawr-b-title { overflow-wrap: anywhere; }
`

/** The hosted page at /b is ours, not somebody's Webflow site, so it answers to
 *  Rawr's own theme instead of inheriting a stranger's. Only the widget's inputs
 *  are bound; the widget itself is untouched, which is what keeps the embed
 *  themeable from outside and the hosted page readable in dark mode.
 *
 *  The CTA's own text stays white, because the button is orange in both themes
 *  and an inverse token would turn it dark on dark exactly when it matters. */
export const HOSTED_BOOKING_STYLES = `
[data-rawr-booking-hosted] {
  --rawr-embed-font: var(--rawr-font-sans);
  --rawr-embed-text: var(--rawr-text);
  --rawr-embed-muted: var(--rawr-text-secondary);
  --rawr-embed-border: var(--rawr-border);
  --rawr-embed-focus: var(--rawr-accent);
  --rawr-embed-cta: var(--rawr-cta);
  --rawr-embed-error: var(--rawr-error);
  --rawr-embed-success: var(--rawr-success);
  --rawr-embed-field-bg: var(--rawr-surface);
  --rawr-embed-banner-bg: var(--rawr-surface);
  --rawr-embed-radius: var(--rawr-radius);
}
`
