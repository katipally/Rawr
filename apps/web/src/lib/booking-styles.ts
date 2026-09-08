/** Styles for the public booking widget, its hosted page and the manage page.
 *
 *  Same rules as the form embed: it renders inside somebody else's design, so every
 *  value is a custom property with a fallback and marketing re-themes it by setting
 *  --rawr-embed-* on any ancestor. No deploy, no stylesheet of ours overriding
 *  theirs.
 *
 *  Not one media query. The widget does not know how wide the viewport is and does
 *  not care; it only cares how wide its own container is, which is what container
 *  queries answer. That is what makes the same markup work in a 320px phone column
 *  and a 1200px desktop slot on the same page.
 *
 *  The narrow layout is CSS, not JavaScript: the widget always renders both panes
 *  and carries the step it is on, and the container query decides whether that step
 *  hides the other pane. One implementation, no resize listener, and a widget that
 *  is correct before its script has measured anything. */

export const BOOKING_STYLES = `
[data-rawr-booking-widget] {
  --_font: var(--rawr-embed-font, inherit);
  --_text: var(--rawr-embed-text, #171b26);
  --_muted: var(--rawr-embed-muted, #525a70);
  --_faint: var(--rawr-embed-faint, #858da3);
  --_border: var(--rawr-embed-border, #dee2ec);
  --_border-strong: var(--rawr-embed-border-strong, #bfc7d8);
  --_accent: var(--rawr-embed-accent, #2a43d0);
  --_accent-soft: var(--rawr-embed-accent-soft, #e9ecfd);
  --_accent-ink: var(--rawr-embed-accent-ink, #1c2fa6);
  --_focus: var(--rawr-embed-focus, var(--_accent));
  --_cta: var(--rawr-embed-cta, var(--_accent));
  --_cta-hover: var(--rawr-embed-cta-hover, var(--_accent-ink));
  --_cta-text: var(--rawr-embed-cta-text, #ffffff);
  --_error: var(--rawr-embed-error, #c0392f);
  --_error-soft: var(--rawr-embed-error-soft, #fbeae8);
  --_ok: var(--rawr-embed-success, #0f8a6c);
  --_ok-soft: var(--rawr-embed-success-soft, #e2f4ef);
  --_hold: var(--rawr-embed-hold, #a4650b);
  --_hold-soft: var(--rawr-embed-hold-soft, #fbf0db);
  --_radius: var(--rawr-embed-radius, 10px);
  --_gap: var(--rawr-embed-gap, 1rem);
  --_surface: var(--rawr-embed-banner-bg, #ffffff);
  --_fill: var(--rawr-embed-fill, #eef1f7);
  --_fill-hover: var(--rawr-embed-fill-hover, #e5e9f2);
  --_field-bg: var(--rawr-embed-field-bg, #ffffff);
  --_shadow: var(--rawr-embed-shadow, 0 10px 34px rgb(18 22 34 / .12), 0 2px 6px rgb(18 22 34 / .06));
  --_mono: var(--rawr-embed-mono, ui-monospace, SFMono-Regular, Menlo, monospace);

  font-family: var(--_font);
  color: var(--_text);
  font-weight: 400;
  line-height: 1.5;
  container-type: inline-size;
  display: block;
  max-width: 100%;
}

[data-rawr-booking-widget] * { box-sizing: border-box; }
[data-rawr-booking-widget] h1,
[data-rawr-booking-widget] h2,
[data-rawr-booking-widget] h3 { margin: 0; font-size: inherit; font-weight: 600; }
[data-rawr-booking-widget] p { margin: 0; }
[data-rawr-booking-widget] button { font: inherit; }

.rawr-b-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

.rawr-b {
  background: var(--_surface);
  border: 1px solid var(--_border);
  border-radius: calc(var(--_radius) + 4px);
  box-shadow: var(--_shadow);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ------------------------------------------------------------------ header */
.rawr-b-head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  gap: 0.75rem;
  padding: 0.95rem 1.05rem;
  border-bottom: 1px solid var(--_border);
}
.rawr-b-id { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.rawr-b-org {
  font-family: var(--_mono); font-size: 0.63rem; letter-spacing: 0.13em;
  text-transform: uppercase; color: var(--_faint);
}
.rawr-b-title { font-size: 1.2rem; font-weight: 600; letter-spacing: -0.025em; line-height: 1.15; text-wrap: balance; }
.rawr-b-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.65rem;
  font-size: 0.78rem; color: var(--_muted);
}
.rawr-b-meta > span { display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap; }
.rawr-b-sep { width: 3px; height: 3px; border-radius: 50%; background: var(--_border-strong); flex: none; }
.rawr-b-icn {
  width: 0.8rem; height: 0.8rem; flex: none; stroke: currentColor; fill: none;
  stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: 0.75;
}
.rawr-b-hosts { display: flex; flex: none; }
.rawr-b-hosts span {
  width: 1.35rem; height: 1.35rem; border-radius: 50%; display: grid; place-items: center;
  font-family: var(--_mono); font-size: 0.55rem; font-weight: 600; letter-spacing: 0.02em;
  background: var(--_accent-soft); color: var(--_accent-ink);
  box-shadow: 0 0 0 1.5px var(--_surface); margin-left: -0.35rem;
}
.rawr-b-hosts span:first-child { margin-left: 0; }

/* --------------------------------------------------------------- timezone */
.rawr-b-tzwrap { position: relative; justify-self: end; }
.rawr-b-tz {
  display: inline-flex; align-items: center; gap: 0.4rem; max-width: 100%;
  font-size: 0.75rem; color: var(--_muted); background: var(--_fill);
  border: 1px solid var(--_border); border-radius: 999px; padding: 0.35rem 0.65rem;
  cursor: pointer;
  transition: border-color 0.16s, color 0.16s, background 0.16s, transform 0.1s;
}
.rawr-b-tz:hover { border-color: var(--_border-strong); color: var(--_text); background: var(--_fill-hover); }
.rawr-b-tz:active { transform: scale(0.97); }
.rawr-b-tz span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rawr-b-tz em { font-style: normal; font-family: var(--_mono); font-size: 0.68rem; color: var(--_faint); flex: none; }
.rawr-b-pulse { animation: rawr-b-pulse 1.1s ease-out 1; }
@keyframes rawr-b-pulse {
  0% { box-shadow: 0 0 0 0 var(--_accent-soft); }
  40% { box-shadow: 0 0 0 6px transparent; border-color: var(--_accent); }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.rawr-b-tzpop {
  position: absolute; right: 0; top: calc(100% + 0.45rem); z-index: 30;
  width: min(280px, 78cqw);
  background: var(--_surface); border: 1px solid var(--_border);
  border-radius: var(--_radius); box-shadow: var(--_shadow);
  padding: 0.55rem; display: flex; flex-direction: column; gap: 0.5rem;
  transform-origin: top right; animation: rawr-b-pop 0.16s cubic-bezier(0.2, 0.9, 0.3, 1);
}
@keyframes rawr-b-pop {
  from { opacity: 0; scale: 0.96; translate: 0 -4px; }
  to { opacity: 1; scale: 1; translate: 0 0; }
}
.rawr-b-tzpop input {
  font: inherit; font-size: 0.82rem; color: var(--_text); background: var(--_fill);
  border: 1px solid var(--_border); border-radius: calc(var(--_radius) - 3px);
  padding: 0.4rem 0.6rem; width: 100%;
}
.rawr-b-tzlist {
  list-style: none; margin: 0; padding: 0; max-height: 13rem; overflow-y: auto;
  display: flex; flex-direction: column; gap: 1px;
}
.rawr-b-tzlist button {
  color: var(--_text);
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
  font-size: 0.82rem; background: none; border: 0; border-radius: calc(var(--_radius) - 4px);
  padding: 0.4rem 0.55rem; cursor: pointer; text-align: left;
  transition: background 0.13s, color 0.13s;
}
.rawr-b-tzlist button:hover { background: var(--_accent-soft); color: var(--_accent-ink); }
.rawr-b-tzlist button[aria-pressed='true'] { background: var(--_accent); color: var(--_cta-text); }
.rawr-b-tzlist button[aria-pressed='true'] em { color: var(--_cta-text); opacity: 0.8; }
.rawr-b-tzlist em { font-style: normal; font-family: var(--_mono); font-size: 0.68rem; color: var(--_faint); flex: none; }
.rawr-b-tzempty { font-size: 0.78rem; color: var(--_faint); padding: 0.5rem 0.55rem; }

/* -------------------------------------------------------------- body/split */
.rawr-b-body { padding: 0.9rem 1.05rem 1.05rem; min-height: 0; }
.rawr-b-split { display: grid; gap: var(--_gap); align-items: stretch; grid-template-columns: minmax(0, 1fr); }
.rawr-b-pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; }

/* ---------------------------------------------------------------- calendar */
.rawr-b-monthbar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.7rem; }
.rawr-b-month { font-size: 0.9rem; font-weight: 600; letter-spacing: -0.015em; }
.rawr-b-nav { display: flex; gap: 0.25rem; }
.rawr-b-navb {
  width: 1.8rem; height: 1.8rem; border-radius: calc(var(--_radius) - 3px);
  border: 1px solid var(--_border); background: var(--_surface); color: var(--_muted);
  cursor: pointer; display: grid; place-items: center;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.12s;
}
.rawr-b-navb:hover:not([aria-disabled='true']) { background: var(--_fill); color: var(--_text); border-color: var(--_border-strong); }
.rawr-b-navb:active:not([aria-disabled='true']) { transform: scale(0.9); }
.rawr-b-navb[aria-disabled='true'] { opacity: 0.32; cursor: not-allowed; }
.rawr-b-navb svg { width: 0.85rem; height: 0.85rem; stroke: currentColor; fill: none; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }

.rawr-b-cal { width: 100%; max-width: 27rem; margin-inline: auto; }
.rawr-b-dow {
  display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; margin-bottom: 0.3rem;
  font-family: var(--_mono); font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--_faint); text-align: center;
}
.rawr-b-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
.rawr-b-day {
  position: relative; aspect-ratio: 1; min-height: 2.1rem; max-height: 3.1rem; padding: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  border: 1px solid transparent; border-radius: calc(var(--_radius) - 2px); background: transparent;
  font-family: var(--_mono); font-size: 0.82rem; font-variant-numeric: tabular-nums;
  color: var(--_faint); cursor: default;
  transition: background 0.16s, color 0.16s, border-color 0.16s, transform 0.13s cubic-bezier(0.3, 1.5, 0.5, 1);
}
.rawr-b-day[data-open='1'] { background: var(--_fill); color: var(--_text); cursor: pointer; font-weight: 500; }
.rawr-b-day[data-open='1']:hover { background: var(--_accent-soft); color: var(--_accent-ink); transform: translateY(-1px); }
.rawr-b-day[data-open='1']:active { transform: scale(0.92); }
/* After the hover rule and not before it: a day that is chosen stays chosen while
   the pointer is still on it, which is exactly when somebody is looking at it. */
.rawr-b-day[aria-pressed='true'],
.rawr-b-day[aria-pressed='true']:hover { background: var(--_accent); color: var(--_cta-text); transform: none; font-weight: 600; }
.rawr-b-day[aria-pressed='true'] .rawr-b-dot { background: var(--_cta-text); opacity: 0.9; }
/* An outline rather than an underline: the underline sat where the open-times dot
   sits, and on a narrow cell the two ran into each other. */
.rawr-b-day[data-today='1'] { border-color: var(--_border-strong); }
.rawr-b-day[data-today='1'][aria-pressed='true'] { border-color: var(--_accent); }
.rawr-b-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--_ok); transition: background 0.16s; }
.rawr-b-dot[data-empty] { background: transparent; }
.rawr-b-grid[data-loading] .rawr-b-day { color: transparent; pointer-events: none; }
.rawr-b-grid[data-loading] .rawr-b-day[data-open='1'] { animation: rawr-b-shim 1.1s linear infinite; }
.rawr-b-grid[data-loading] .rawr-b-dot { background: transparent; }
@keyframes rawr-b-shim { 0% { opacity: 1; } 50% { opacity: 0.45; } 100% { opacity: 1; } }

.rawr-b-legend {
  display: flex; align-items: center; gap: 0.75rem; margin-top: 0.7rem;
  font-size: 0.72rem; color: var(--_faint); flex-wrap: wrap;
}
.rawr-b-legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
.rawr-b-legend i {
  display: block; width: 0.7rem; height: 0.7rem; border-radius: 3px;
  border: 1px solid var(--_border-strong);
}

/* ------------------------------------------------------------- right pane */
.rawr-b-rhead {
  display: flex; align-items: center; gap: 0.6rem; justify-content: space-between;
  padding-bottom: 0.55rem; margin-bottom: 0.6rem; border-bottom: 1px solid var(--_border);
  min-height: 2rem;
}
.rawr-b-rhead h2 { font-size: 0.88rem; font-weight: 600; letter-spacing: -0.015em; text-wrap: balance; }
.rawr-b-count { font-family: var(--_mono); font-size: 0.68rem; color: var(--_faint); white-space: nowrap; flex: none; }
.rawr-b-back {
  display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; font-weight: 500;
  color: var(--_accent); background: none; border: 0; padding: 0.25rem 0.4rem;
  border-radius: calc(var(--_radius) - 4px); cursor: pointer; flex: none;
  transition: background 0.14s;
}
.rawr-b-back:hover { background: var(--_accent-soft); }
.rawr-b-back[data-narrow] { display: none; }
.rawr-b-back svg { width: 0.75rem; height: 0.75rem; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.rawr-b-seg { display: inline-flex; border: 1px solid var(--_border); border-radius: calc(var(--_radius) - 3px); overflow: hidden; flex: none; }
.rawr-b-seg button {
  font-family: var(--_mono); font-size: 0.65rem; font-weight: 500; border: 0;
  background: var(--_surface); color: var(--_faint); padding: 0.25rem 0.45rem; cursor: pointer;
  transition: background 0.14s, color 0.14s;
}
.rawr-b-seg button[aria-pressed='true'] { background: var(--_accent-soft); color: var(--_accent-ink); }
.rawr-b-seg button:hover { color: var(--_text); }

.rawr-b-times { display: flex; flex-direction: column; gap: 0.4rem; overflow-y: auto; min-height: 0; flex: 1; padding-right: 3px; }
.rawr-b-band {
  font-family: var(--_mono); font-size: 0.6rem; letter-spacing: 0.11em; text-transform: uppercase;
  color: var(--_faint); margin: 0.55rem 0 1px; display: flex; align-items: center; gap: 0.5rem;
}
.rawr-b-band::after { content: ''; flex: 1; height: 1px; background: var(--_border); }
.rawr-b-band:first-child { margin-top: 0; }
.rawr-b-bandname { font-family: inherit; font-size: inherit; letter-spacing: inherit; text-transform: inherit; font-weight: inherit; color: inherit; }
.rawr-b-slot {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  width: 100%; text-align: left;
  font-family: var(--_mono); font-size: 0.85rem; font-variant-numeric: tabular-nums; font-weight: 500;
  color: var(--_text); background: var(--_field-bg); border: 1px solid var(--_border);
  border-radius: calc(var(--_radius) - 1px); padding: 0.62rem 0.75rem; cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s, transform 0.1s;
}
.rawr-b-slot:hover { border-color: var(--_accent); background: var(--_accent-soft); color: var(--_accent-ink); }
.rawr-b-slot:active { transform: scale(0.985); }
.rawr-b-slot em {
  font-style: normal; font-family: var(--_font); font-size: 0.72rem; font-weight: 500;
  opacity: 0; translate: 7px 0; transition: opacity 0.16s, translate 0.19s;
}
.rawr-b-slot:hover em, .rawr-b-slot:focus-visible em { opacity: 1; translate: 0 0; }
.rawr-b-slot[aria-pressed='true'],
.rawr-b-slot[aria-pressed='true']:hover { background: var(--_accent); border-color: var(--_accent); color: var(--_cta-text); }
.rawr-b-slot[aria-pressed='true'] em { opacity: 1; translate: 0; }
.rawr-b-slot[data-gone] { opacity: 0.45; text-decoration: line-through; pointer-events: none; }

.rawr-b-stagger > * { animation: rawr-b-rise 0.3s cubic-bezier(0.22, 0.75, 0.25, 1) backwards; }
@keyframes rawr-b-rise { from { opacity: 0; translate: 0 8px; } to { opacity: 1; translate: 0 0; } }
.rawr-b-fade { animation: rawr-b-fade 0.22s ease-out backwards; }
@keyframes rawr-b-fade { from { opacity: 0; } to { opacity: 1; } }

.rawr-b-skel { display: flex; flex-direction: column; gap: 0.4rem; }
.rawr-b-skel i {
  display: block; height: 2.4rem; border-radius: calc(var(--_radius) - 1px);
  background: linear-gradient(90deg, var(--_fill), var(--_fill-hover), var(--_fill));
  background-size: 220% 100%; animation: rawr-b-sh 1.2s linear infinite;
}
@keyframes rawr-b-sh { to { background-position: -220% 0; } }

.rawr-b-blank {
  display: flex; flex-direction: column; align-items: flex-start; gap: 0.6rem;
  padding: 0.5rem 0.15rem; color: var(--_muted); font-size: 0.85rem; flex: 1; justify-content: center;
}
.rawr-b-blank b { font-weight: 600; color: var(--_text); font-size: 0.9rem; }
.rawr-b-blank p { max-width: 34ch; }
.rawr-b-ghost {
  font-size: 0.78rem; font-weight: 500; color: var(--_accent); background: var(--_accent-soft);
  border: 0; border-radius: calc(var(--_radius) - 2px); padding: 0.5rem 0.75rem; cursor: pointer;
  transition: filter 0.15s, transform 0.1s;
}
.rawr-b-ghost:hover { filter: brightness(0.96); }
.rawr-b-ghost:active { transform: scale(0.97); }

/* ------------------------------------------------------- selection + form */
.rawr-b-summary {
  display: flex; align-items: center; gap: 0.6rem; justify-content: space-between;
  background: var(--_accent-soft); border: 1px solid var(--_accent-soft);
  border-radius: calc(var(--_radius) - 1px); padding: 0.6rem 0.75rem; margin-bottom: 0.6rem;
}
.rawr-b-summary > span { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rawr-b-summary b { font-family: var(--_mono); font-size: 0.85rem; font-weight: 500; color: var(--_accent-ink); }
.rawr-b-summary span { font-size: 0.72rem; color: var(--_muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.rawr-b-hold {
  display: flex; align-items: center; gap: 0.55rem; font-size: 0.72rem; color: var(--_hold);
  background: var(--_hold-soft); border-radius: calc(var(--_radius) - 2px);
  padding: 0.45rem 0.6rem; margin-bottom: 0.7rem;
}
.rawr-b-hold b { font-family: var(--_mono); font-weight: 500; font-variant-numeric: tabular-nums; flex: none; }
.rawr-b-hold i { flex: 1; min-width: 2rem; height: 3px; border-radius: 2px; background: color-mix(in srgb, currentColor 24%, transparent); overflow: hidden; display: block; }
.rawr-b-hold i > i { display: block; height: 100%; background: currentColor; transform-origin: left; transition: scale 1s linear; min-width: 0; }
.rawr-b-hold[data-urgent] { color: var(--_error); background: var(--_error-soft); }

.rawr-b-form { display: flex; flex-direction: column; gap: 0.7rem; }
.rawr-b-field { display: flex; flex-direction: column; gap: 0.3rem; }
.rawr-b-field label { font-size: 0.75rem; font-weight: 500; color: var(--_muted); }
.rawr-b-field input,
.rawr-b-field textarea,
.rawr-b-field select {
  font: inherit; font-size: 0.88rem; color: var(--_text); width: 100%;
  background: var(--_field-bg); border: 1px solid var(--_border);
  border-radius: calc(var(--_radius) - 1px); padding: 0.55rem 0.65rem;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.rawr-b-field input[type='checkbox'] { width: auto; }
.rawr-b-field textarea { resize: vertical; min-height: 4rem; }
.rawr-b-field input:hover, .rawr-b-field textarea:hover, .rawr-b-field select:hover { border-color: var(--_border-strong); }
.rawr-b-field [aria-invalid='true'] { border-color: var(--_error); }
.rawr-b-err { font-size: 0.72rem; color: var(--_error); display: flex; align-items: center; gap: 0.3rem; }
.rawr-b-err svg { width: 0.75rem; height: 0.75rem; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; flex: none; }
.rawr-b-hint { font-size: 0.72rem; color: var(--_faint); line-height: 1.45; }

.rawr-b-cta {
  font-size: 0.88rem; font-weight: 600; letter-spacing: -0.005em;
  background: var(--_cta); color: var(--_cta-text); border: 0;
  border-radius: calc(var(--_radius) - 1px); padding: 0.7rem 1rem; cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 0.5rem; width: 100%;
  transition: background 0.16s, transform 0.1s, opacity 0.16s;
}
.rawr-b-cta:hover { background: var(--_cta-hover); }
.rawr-b-cta:active { transform: scale(0.985); }
.rawr-b-cta[data-busy] { pointer-events: none; opacity: 0.8; }
.rawr-b-spin {
  width: 0.85rem; height: 0.85rem; border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%; animation: rawr-b-sp 0.65s linear infinite; flex: none;
}
@keyframes rawr-b-sp { to { rotate: 360deg; } }

.rawr-b-note {
  display: flex; gap: 0.55rem; align-items: flex-start; font-size: 0.8rem; line-height: 1.45;
  border-radius: calc(var(--_radius) - 2px); padding: 0.6rem 0.7rem; margin-bottom: 0.75rem;
  background: var(--_fill); color: var(--_muted);
}
.rawr-b-note[data-bad] { background: var(--_error-soft); color: var(--_error); }
.rawr-b-note[data-good] { background: var(--_ok-soft); color: var(--_ok); }
/* A joining link that has not arrived yet is not a failed booking, and colouring
   it like one is what makes people book a second time. */
.rawr-b-note[data-warn] { background: var(--_hold-soft); color: var(--_hold); }
.rawr-b-note svg { width: 0.9rem; height: 0.9rem; flex: none; margin-top: 2px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; }

/* ------------------------------------------------------------------ done */
.rawr-b-done {
  display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0.8rem;
  padding: clamp(1.25rem, 5cqw, 2.5rem) 0.75rem; animation: rawr-b-fade 0.3s ease-out;
}
.rawr-b-tick { width: 3.1rem; height: 3.1rem; border-radius: 50%; background: var(--_ok-soft); display: grid; place-items: center; flex: none; }
.rawr-b-tick svg { width: 1.5rem; height: 1.5rem; stroke: var(--_ok); stroke-width: 2.5; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.rawr-b-tick path { stroke-dasharray: 26; stroke-dashoffset: 26; animation: rawr-b-draw 0.5s 0.12s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
@keyframes rawr-b-draw { to { stroke-dashoffset: 0; } }
.rawr-b-done h2 { font-size: 1.2rem; font-weight: 600; letter-spacing: -0.02em; }
.rawr-b-card {
  display: flex; flex-direction: column; gap: 0.45rem; width: min(100%, 22rem); text-align: left;
  border: 1px solid var(--_border); border-radius: var(--_radius); padding: 0.8rem; background: var(--_fill);
}
.rawr-b-card > div { display: flex; gap: 0.6rem; align-items: flex-start; font-size: 0.82rem; }
.rawr-b-card b { font-weight: 500; color: var(--_text); font-family: var(--_mono); font-size: 0.78rem; line-height: 1.5; }
.rawr-b-card i {
  font-style: normal; font-size: 0.65rem; color: var(--_faint); width: 4.2rem; flex: none;
  padding-top: 2px; font-family: var(--_mono); letter-spacing: 0.05em; text-transform: uppercase;
}
.rawr-b-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
.rawr-b-link {
  font-size: 0.78rem; font-weight: 500; color: var(--_accent); background: none;
  border: 1px solid var(--_border); border-radius: calc(var(--_radius) - 2px);
  padding: 0.5rem 0.75rem; cursor: pointer; text-decoration: none; display: inline-block;
  transition: border-color 0.15s, background 0.15s, transform 0.1s;
}
.rawr-b-link:hover { border-color: var(--_accent); background: var(--_accent-soft); }
.rawr-b-link:active { transform: scale(0.97); }

.rawr-b-foot {
  border-top: 1px solid var(--_border); padding: 0.6rem 1.05rem; display: flex; flex-wrap: wrap;
  gap: 0.35rem 0.85rem; align-items: center; justify-content: space-between;
  font-size: 0.72rem; color: var(--_faint); background: var(--_fill);
}
.rawr-b-foot span { font-family: var(--_mono); }

/* The manage page reuses the panel, the times and the form. */
.rawr-b-panel { display: flex; flex-direction: column; gap: 0.6rem; }

/* ------------------------------------------------------------- focus ring */
[data-rawr-booking-widget] :is(button, input, textarea, select, a):focus-visible {
  outline: 2px solid var(--_focus);
  outline-offset: 2px;
}

/* -------------------------------------------------------- container sizes */
@container (max-width: 559px) {
   [data-step='day'] .rawr-b-pane[data-side='right'] { display: none; }
  [data-step]:not([data-step='day']) .rawr-b-pane[data-side='left'] { display: none; }
  .rawr-b-back[data-narrow] { display: inline-flex; }
  .rawr-b-head { grid-template-columns: minmax(0, 1fr); }
  .rawr-b-tzwrap { justify-self: start; }
  .rawr-b-tzpop { right: auto; left: 0; transform-origin: top left; }
  .rawr-b-title { font-size: 1.05rem; }
  .rawr-b-slot em { opacity: 1; translate: 0; color: var(--_faint); }
  /* The separators read as an orphan dot at the end of a wrapped line. */
  .rawr-b-meta > .rawr-b-sep { display: none; }
  /* The way back gets its own line rather than squeezing the date into two. */
  .rawr-b-rhead { flex-wrap: wrap; }
  .rawr-b-back[data-narrow] { flex-basis: 100%; margin-inline-start: -0.4rem; }
  .rawr-b-meta { gap: 0.2rem 0.75rem; }
}
@container (min-width: 560px) {
  .rawr-b-split { grid-template-columns: minmax(0, 1fr) 14.5rem; }
  .rawr-b-pane[data-side='right'] { border-left: 1px solid var(--_border); padding-left: var(--_gap); }
  .rawr-b-times { max-height: 21.5rem; }
}
@container (min-width: 780px) {
  .rawr-b-split { grid-template-columns: minmax(0, 1fr) 18.25rem; gap: 1.25rem; }
  .rawr-b-pane[data-side='right'] { padding-left: 1.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  [data-rawr-booking-widget] *,
  [data-rawr-booking-widget] *::before,
  [data-rawr-booking-widget] *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`

/** The hosted page and the manage page are ours, so the widget's inputs are bound
 *  to Rawr's own theme instead of inheriting a stranger's. Only the inputs are
 *  bound; the widget itself is untouched, which is what keeps the embed themeable
 *  from outside and the hosted page consistent with the app. */
export const HOSTED_BOOKING_STYLES = `
[data-rawr-booking-hosted] {
  --rawr-embed-font: var(--rawr-font-sans);
  --rawr-embed-text: var(--rawr-text);
  --rawr-embed-muted: var(--rawr-text-secondary);
  --rawr-embed-faint: var(--rawr-text-muted);
  --rawr-embed-border: var(--rawr-divider);
  --rawr-embed-border-strong: var(--rawr-border);
  --rawr-embed-accent: var(--rawr-accent);
  --rawr-embed-accent-soft: var(--rawr-accent-subtle);
  --rawr-embed-accent-ink: var(--rawr-cta-hover);
  --rawr-embed-focus: var(--rawr-accent);
  --rawr-embed-cta: var(--rawr-cta);
  --rawr-embed-cta-hover: var(--rawr-cta-hover);
  --rawr-embed-error: var(--rawr-error);
  --rawr-embed-error-soft: var(--rawr-error-subtle);
  --rawr-embed-success: var(--rawr-success);
  --rawr-embed-success-soft: var(--rawr-success-subtle);
  --rawr-embed-hold: var(--rawr-warning);
  --rawr-embed-hold-soft: var(--rawr-warning-subtle);
  --rawr-embed-fill: var(--rawr-fill);
  --rawr-embed-fill-hover: var(--rawr-fill-hover);
  --rawr-embed-field-bg: var(--rawr-surface);
  --rawr-embed-banner-bg: var(--rawr-surface);
  --rawr-embed-shadow: var(--rawr-shadow-panel);
}
`
