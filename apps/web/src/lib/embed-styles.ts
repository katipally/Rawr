/** Styles for the form embed and the consent banner.
 *
 *  These render inside Webflow's page, not ours, so every value is a CSS custom
 *  property with a fallback. Marketing restyles the form by setting
 *  --rawr-embed-* on any ancestor; nothing here needs a deploy to re-theme.
 *
 *  Everything is sized in relative units and laid out with flex and grid, so the
 *  same markup works in a 320px column and a 1200px one on the same page. There
 *  is not a single media query, deliberately: the embed does not know how wide
 *  its container is, only the container does. */

export const EMBED_STYLES = `
[data-rawr-form] {
  --_font: var(--rawr-embed-font, inherit);
  --_text: var(--rawr-embed-text, #33475b);
  --_muted: var(--rawr-embed-muted, #516f90);
  --_border: var(--rawr-embed-border, #cbd6e2);
  --_focus: var(--rawr-embed-focus, #00a4bd);
  --_cta: var(--rawr-embed-cta, #ff7a59);
  --_cta-text: var(--rawr-embed-cta-text, #ffffff);
  --_error: var(--rawr-embed-error, #f2545b);
  --_radius: var(--rawr-embed-radius, 3px);
  --_gap: var(--rawr-embed-gap, 1rem);
  --_field-bg: var(--rawr-embed-field-bg, #ffffff);

  font-family: var(--_font);
  color: var(--_text);
  font-weight: 300;
  container-type: inline-size;
}

.rawr-form { display: flex; flex-direction: column; gap: var(--_gap); }
.rawr-step { display: grid; gap: var(--_gap); grid-template-columns: 1fr; }

/* Two columns only when the container itself is wide enough, which is a property
   of the slot the embed was dropped into, not of the viewport. */
@container (min-width: 30rem) {
  .rawr-step { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rawr-field[data-wide], .rawr-field:has(textarea), .rawr-field:has(.rawr-choices) {
    grid-column: 1 / -1;
  }
}

.rawr-field { display: flex; flex-direction: column; gap: 0.375rem; min-width: 0; }
.rawr-field[hidden] { display: none; }
.rawr-field > label { font-size: 0.8125rem; font-weight: 500; }

.rawr-field input[type="text"], .rawr-field input[type="email"], .rawr-field input[type="tel"],
.rawr-field input[type="url"], .rawr-field input[type="number"], .rawr-field input[type="date"],
.rawr-field textarea, .rawr-field select {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-weight: 300;
  color: inherit;
  background: var(--_field-bg);
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
  padding: 0.5rem 0.625rem;
  min-height: 2.25rem;
}
.rawr-field textarea { resize: vertical; min-height: 5rem; }

.rawr-field :is(input, textarea, select):focus-visible {
  outline: 2px solid var(--_focus);
  outline-offset: 1px;
  border-color: var(--_focus);
}

.rawr-choices { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
.rawr-choices label { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.875rem; }

.rawr-help { color: var(--_muted); font-size: 0.75rem; }
.rawr-error { color: var(--_error); font-size: 0.75rem; min-height: 0; }
.rawr-error:empty { display: none; }

.rawr-progress { display: flex; flex-direction: column; gap: 0.375rem; }
.rawr-progress-label { color: var(--_muted); font-size: 0.75rem; font-weight: 500; }
.rawr-progress-track { height: 3px; border-radius: 999px; background: var(--_border); overflow: hidden; }
.rawr-progress-fill {
  height: 100%; width: 0; border-radius: 999px; background: var(--_cta);
  transition: width 200ms ease-out;
}
@media (prefers-reduced-motion: reduce) { .rawr-progress-fill { transition: none; } }
.rawr-status { font-size: 0.8125rem; color: var(--_error); }
.rawr-status:empty { display: none; }

.rawr-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.rawr-actions button {
  font: inherit;
  font-weight: 500;
  border-radius: var(--_radius);
  padding: 0.5rem 1rem;
  min-height: 2.25rem;
  cursor: pointer;
  border: 1px solid var(--_border);
  background: transparent;
  color: inherit;
}
.rawr-actions button[hidden] { display: none; }
/* Scoped through .rawr-actions so this outweighs the neutral rule above it.
   A bare .rawr-submit loses the specificity contest and renders transparent. */
.rawr-actions .rawr-submit, .rawr-actions .rawr-next {
  background: var(--_cta);
  border-color: var(--_cta);
  color: var(--_cta-text);
}
.rawr-actions button:disabled { opacity: 0.6; cursor: progress; }

/* Off-screen rather than display:none, with tabindex -1 and autocomplete off, so
   a person tabbing through never lands in it and no password manager fills it.
   A display:none input is skipped by some bots that fill everything visible. */
.rawr-hp {
  position: absolute;
  left: -9999px;
  width: 1px;
  height: 1px;
  overflow: hidden;
}

.rawr-done { font-size: 0.9375rem; line-height: 1.5; display: flex; flex-direction: column; gap: 0.375rem; }
.rawr-done-title { font-weight: 500; margin: 0; }
.rawr-done-note { color: var(--_muted); font-size: 0.8125rem; margin: 0; }
.rawr-done-link { font-size: 0.8125rem; }
/* The retry sits in the actions row beside the submit it is replacing. */
.rawr-actions .rawr-retry { border-color: var(--_cta); color: var(--_cta); }
/* A field the server or the browser refused. The message says what is wrong; the
   border is what makes it findable in a long form. */
.rawr-field :is(input, textarea, select)[aria-invalid="true"] { border-color: var(--_error); }
.rawr-fallback { color: var(--_focus); font-weight: 600; }
.rawr-challenge { min-height: 4.25rem; }

/* ---------------------------------------------------------- consent banner */

#rawr-consent {
  position: fixed;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: 2147483000;
  background: var(--rawr-embed-banner-bg, #ffffff);
  color: var(--rawr-embed-text, #33475b);
  border-block-start: 1px solid var(--rawr-embed-border, #cbd6e2);
  box-shadow: 0 -2px 12px rgb(51 71 91 / 0.16);
  font-family: var(--rawr-embed-font, inherit);
  font-weight: 300;
  font-size: 0.875rem;
  /* Respects a phone's home indicator and a desktop's zero inset alike. */
  padding: 1rem max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom))
           max(1rem, env(safe-area-inset-left));
  max-block-size: 80dvh;
  overflow-y: auto;
}

.rawr-c-inner {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
  max-inline-size: 78rem;
  margin-inline: auto;
}
.rawr-c-copy { flex: 1 1 20rem; min-inline-size: 0; }
.rawr-c-copy strong { display: block; font-weight: 500; margin-block-end: 0.25rem; }
.rawr-c-copy p { margin: 0; color: var(--rawr-embed-muted, #516f90); line-height: 1.5; }

.rawr-c-choices { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; flex: 0 1 auto; }
.rawr-c-choices label { display: inline-flex; align-items: center; gap: 0.375rem; white-space: nowrap; }

.rawr-c-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; flex: 0 1 auto; }
.rawr-c-actions button {
  font: inherit;
  font-weight: 500;
  border-radius: var(--rawr-embed-radius, 3px);
  padding: 0.5rem 1rem;
  min-height: 2.25rem;
  cursor: pointer;
  border: 1px solid var(--rawr-embed-border, #cbd6e2);
  background: transparent;
  color: inherit;
  flex: 1 1 auto;
}
/* Accept and reject carry the same visual weight. A reject styled as an
   afterthought is a dark pattern and is not lawful consent. */
#rawr-c-accept, #rawr-c-reject {
  background: var(--rawr-embed-cta, #ff7a59);
  border-color: var(--rawr-embed-cta, #ff7a59);
  color: var(--rawr-embed-cta-text, #ffffff);
}

#rawr-c-settings {
  position: fixed;
  inset-block-end: max(1rem, env(safe-area-inset-bottom));
  inset-inline-start: max(1rem, env(safe-area-inset-left));
  z-index: 2147482000;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 0.375rem 0.75rem;
  border-radius: 999px;
  border: 1px solid var(--rawr-embed-border, #cbd6e2);
  background: var(--rawr-embed-banner-bg, #ffffff);
  color: var(--rawr-embed-muted, #516f90);
  cursor: pointer;
}

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`
