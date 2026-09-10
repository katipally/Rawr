import { ATTRIBUTION_FIELDS, HONEYPOT_FIELD, TIMING_FIELD } from '@rawr/db'
import { FORM_COPY, formatterSource } from '~/lib/edge-copy.ts'
import { clientFieldErrorSource, clientRuleMatchesSource } from '~/lib/form-rules.ts'

/** The browser half of F3, served as one file from /embed.js.
 *
 *  No framework, no bundler, no dependencies. It runs on datasaur.ai inside
 *  Webflow's page, so every byte and every global it touches is somebody else's
 *  budget. Everything is scoped inside one IIFE and the only global it defines is
 *  window.rawr.
 *
 *  Written as a template string rather than a separate .js file because the
 *  reserved key names have to match the server's exactly, and importing them here
 *  makes a rename a compile error instead of a silent capture failure. */

export type EmbedConfig = {
  baseUrl: string
  policyVersion: string
  consentCookie: string
  /** Injected by the script rather than linked, so the embed is one request and
   *  cannot render unstyled while a second file is still in flight. */
  styles: string
}

export const buildEmbedScript = (config: EmbedConfig): string => `/* Rawr embed. Forms, consent, and the Google Consent Mode relay. */
(function () {
  'use strict';
  if (window.rawr && window.rawr.loaded) return;

  var BASE = ${JSON.stringify(config.baseUrl)};
  var POLICY = ${JSON.stringify(config.policyVersion)};
  var COOKIE = ${JSON.stringify(config.consentCookie)};
  var HONEYPOT = ${JSON.stringify(HONEYPOT_FIELD)};
  var TIMING = ${JSON.stringify(TIMING_FIELD)};
  var ATTR = ${JSON.stringify(ATTRIBUTION_FIELDS)};
  var COPY = ${JSON.stringify(FORM_COPY)};

  // The very functions the tests ran, not copies of them. Inlined from
  // ~/lib/form-rules.ts and ~/lib/edge-copy.ts so the browser cannot drift from
  // the server's rules or from the other three surfaces' wording.
  ${clientFieldErrorSource()}

  ${clientRuleMatchesSource()}

  ${formatterSource()}

  /** How long a success message stays up before a redirect takes over, so
   *  somebody sees that it worked rather than a flash and a new page. */
  var REDIRECT_SECONDS = 3;

  // ---------------------------------------------------------------- utilities

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }

  function readCookie(name) {
    var parts = ('; ' + document.cookie).split('; ' + name + '=');
    return parts.length === 2 ? decodeURIComponent(parts.pop().split(';').shift()) : null;
  }

  function writeCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    // SameSite=Lax so the choice survives a normal navigation from an ad click.
    document.cookie =
      name + '=' + encodeURIComponent(value) + ';expires=' + expires +
      ';path=/;SameSite=Lax' + (location.protocol === 'https:' ? ';Secure' : '');
  }

  function deleteCookie(name) {
    document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
  }

  // ------------------------------------------------------------------ consent

  // The default state has to be pushed before GTM fires, or it arrives too late
  // to govern anything.
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  function storedConsent() {
    var raw = readCookie(COOKIE);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      // A policy change re-prompts only the people whose choice predates it.
      if (parsed.v !== POLICY) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function grants(consent) {
    var analytics = !!(consent && consent.analytics);
    var ads = !!(consent && consent.advertisement);
    return {
      analytics_storage: analytics ? 'granted' : 'denied',
      ad_storage: ads ? 'granted' : 'denied',
      ad_user_data: ads ? 'granted' : 'denied',
      ad_personalization: ads ? 'granted' : 'denied'
    };
  }

  var existing = storedConsent();

  // A returning visitor's stored choice applies on load, before GTM fires, which
  // is the behaviour the HubSpot relay has today. Reproducing it matters: without
  // it every returning consenting visitor starts denied and is upgraded late.
  gtag('consent', 'default', Object.assign(
    {
      functionality_storage: 'granted',
      security_storage: 'granted',
      wait_for_update: 500
    },
    grants(existing)
  ));

  function applyConsent(consent, isFirstChoice) {
    gtag('consent', 'update', grants(consent));

    if (consent.analytics) {
      // Fired by the relay, not by GTM. Today's HubSpot relay does exactly this,
      // and a replacement that only swaps the banner loses the first page view of
      // every consenting session.
      gtag('event', 'page_view');
      ensureVisitorId();
      startTracking();
    } else {
      // Declining means nothing was collected, not that something was collected
      // and hidden. The visitor id is removed and collection stops here.
      stopTracking();
      deleteCookie('rawr_vid');
    }

    if (isFirstChoice) recordConsent(consent);
  }

  function ensureVisitorId() {
    if (readCookie('rawr_vid')) return;
    var id = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(36).slice(2);
    writeCookie('rawr_vid', id, 395);
  }

  function recordConsent(consent) {
    try {
      var payload = JSON.stringify({
        visitorId: readCookie('rawr_vid'),
        categories: {
          necessary: true,
          analytics: !!consent.analytics,
          advertisement: !!consent.advertisement
        },
        policyVersion: POLICY,
        site: currentSite()
      });
      // keepalive so the record survives the navigation a consent click often
      // precedes. Failure is silent by design: a banner that errors at a visitor
      // is worse than a consent row we can re-derive from the cookie.
      fetch(BASE + '/c', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
        mode: 'cors'
      }).catch(function () {});
    } catch (e) {}
  }

  function save(consent) {
    writeCookie(COOKIE, JSON.stringify({
      v: POLICY,
      analytics: !!consent.analytics,
      advertisement: !!consent.advertisement,
      at: new Date().toISOString()
    }), 395);
  }

  function currentSite() {
    var tag = document.querySelector('script[data-rawr-site]');
    return tag ? tag.getAttribute('data-rawr-site') : null;
  }

  // ------------------------------------------------------------ consent banner

  function banner() {
    if (storedConsent()) return;
    if (document.getElementById('rawr-consent')) return;

    var root = el('div', { id: 'rawr-consent', role: 'dialog', 'aria-live': 'polite',
      'aria-label': 'Cookie preferences' });
    root.innerHTML =
      '<div class="rawr-c-inner">' +
        '<div class="rawr-c-copy">' +
          '<strong>Cookies</strong>' +
          '<p>We use cookies that are necessary to run this site, and with your ' +
          'permission, cookies that help us understand how it is used and measure ' +
          'our advertising.</p>' +
        '</div>' +
        '<div class="rawr-c-choices">' +
          '<label><input type="checkbox" checked disabled> Necessary</label>' +
          '<label><input type="checkbox" id="rawr-c-analytics"> Analytics</label>' +
          '<label><input type="checkbox" id="rawr-c-ads"> Advertising</label>' +
        '</div>' +
        '<div class="rawr-c-actions">' +
          '<button type="button" id="rawr-c-reject">Reject all</button>' +
          '<button type="button" id="rawr-c-save">Save choices</button>' +
          '<button type="button" id="rawr-c-accept">Accept all</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(root);

    function choose(consent) {
      save(consent);
      applyConsent(consent, true);
      root.remove();
      settingsLink();
    }

    root.querySelector('#rawr-c-accept').addEventListener('click', function () {
      choose({ analytics: true, advertisement: true });
    });
    root.querySelector('#rawr-c-reject').addEventListener('click', function () {
      choose({ analytics: false, advertisement: false });
    });
    root.querySelector('#rawr-c-save').addEventListener('click', function () {
      choose({
        analytics: root.querySelector('#rawr-c-analytics').checked,
        advertisement: root.querySelector('#rawr-c-ads').checked
      });
    });
  }

  function settingsLink() {
    if (document.getElementById('rawr-c-settings')) return;
    var button = el('button', { id: 'rawr-c-settings', type: 'button' }, 'Cookie settings');
    button.addEventListener('click', function () {
      // Withdrawing has to be as easy as granting. Clearing the stored choice
      // re-opens the banner in its default denied state.
      deleteCookie(COOKIE);
      button.remove();
      banner();
    });
    document.body.appendChild(button);
  }

  // ----------------------------------------------------------------- tracking

  // F4. Collection is gated at the source, not at display: with no analytics
  // consent nothing here ever runs, no beacon is sent, and no visitor id exists.

  var tracking = false;
  var lastPath = null;
  var lastSentAt = 0;

  // A path change with no navigation is debounced, so a router that fires three
  // times for one screen sends one page view.
  var SPA_DEBOUNCE_MS = 800;

  function beacon(payload) {
    var site = currentSite();
    if (!site) return;
    var vid = readCookie('rawr_vid');
    if (!vid) return;

    payload.site = site;
    payload.vid = vid;
    payload.t = Date.now();
    payload.url = location.href;
    payload.ref = document.referrer || '';
    deliver(payload);
  }

  // The collector's transport, shared by the page-view beacon above and the form
  // counters below. The two differ in what they may send, not in how it travels.
  function deliver(payload) {
    var body = JSON.stringify(payload);
    var url = BASE + '/e';

    // sendBeacon survives the page unloading, which is exactly when the last page
    // view of a visit is sent. The two fallbacks exist for browsers that do not
    // have it and for a blob type it refuses.
    try {
      if (navigator.sendBeacon &&
          navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) {
        return;
      }
    } catch (e) {}

    try {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true,
        mode: 'cors'
      }).catch(function () { image(url, payload); });
      return;
    } catch (e) {}

    image(url, payload);
  }

  function image(url, payload) {
    var query = [];
    for (var key in payload) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
      var value = payload[key];
      if (value == null) continue;
      query.push(encodeURIComponent(key) + '=' +
        encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : value));
    }
    new Image().src = url + '?' + query.join('&');
  }

  function pageView() {
    if (!tracking) return;
    var now = Date.now();
    if (location.pathname === lastPath && now - lastSentAt < SPA_DEBOUNCE_MS) return;
    lastPath = location.pathname;
    lastSentAt = now;
    beacon({ title: document.title || '' });
  }

  function onHistory() {
    // Both are patched once, and both are restored by nothing: a page that
    // navigates away discards them with the document.
    ['pushState', 'replaceState'].forEach(function (method) {
      var original = history[method];
      if (original.rawrPatched) return;
      var patched = function () {
        var result = original.apply(this, arguments);
        pageView();
        return result;
      };
      patched.rawrPatched = true;
      history[method] = patched;
    });
    window.addEventListener('popstate', pageView);
  }

  function startTracking() {
    if (tracking) return;
    tracking = true;
    onHistory();
    pageView();
  }

  function stopTracking() {
    tracking = false;
  }

  function trackEvent(name, props) {
    if (!tracking || !name) return;
    beacon({ name: String(name).slice(0, 120), props: props || {} });
  }

  // The form counters, and the one thing here that is not consent gated: a
  // count of a page carries no visitor, no id and nothing that can be joined to
  // a person. Gating it would make every conversion rate quietly exclude the
  // people who declined, which reads as a form nobody fills in rather than as a
  // measurement we chose not to take.
  function countForm(formId, kind) {
    deliver({ form: formId, kind: kind, page: location.pathname });
  }

  // -------------------------------------------------------------------- forms

  function attribution() {
    var landing = null;
    try { landing = sessionStorage.getItem('rawr_landing'); } catch (e) {}
    if (!landing) {
      landing = location.href;
      try { sessionStorage.setItem('rawr_landing', landing); } catch (e) {}
    }
    var out = {};
    out[ATTR.rawQuery] = location.search || '';
    out[ATTR.referrer] = document.referrer || '';
    out[ATTR.landingPage] = landing;
    out[ATTR.pagePath] = location.pathname;
    out[ATTR.visitorId] = readCookie('rawr_vid') || '';
    return out;
  }

  function renderForm(mount, formId) {
    if (mount.getAttribute('data-rawr-ready')) return;
    mount.setAttribute('data-rawr-ready', '1');

    fetch(BASE + '/f/' + encodeURIComponent(formId) + '/schema', { mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('unavailable');
        return r.json();
      })
      .then(function (form) {
        paint(mount, formId, form);
        // B11. One view per painted form, through the collector rather than
        // through the schema route: that route is cached for a minute, so a
        // second visitor to the same page never reaches the server and would
        // never be counted. This goes through the same consent gate every other
        // event does, which means a visitor who declined analytics is not
        // counted. The conversion rate says so rather than pretending otherwise.
        trackEvent('form_view', { form_id: formId, page: location.pathname });
        countForm(formId, 'render');
      })
      .catch(function () {
        // Degrade to the hosted page rather than leaving a dead container. The
        // form still works there, and works without JavaScript at all; it just
        // is not inline any more.
        mount.innerHTML = '';
        mount.appendChild(el('a', {
          href: BASE + '/form/' + encodeURIComponent(formId),
          class: 'rawr-fallback'
        }, 'Open the form'));
      });
  }

  /** The form's own theme, as one <style> per form.
   *
   *  Scoped to this container rather than the document, so two differently themed
   *  forms on one page both render correctly, and so nothing here can reach the
   *  host site's own elements. Custom properties only: this sets the values the
   *  stylesheet already reads and adds no rules of its own, which is why a
   *  designer's stylesheet still wins by setting the same properties higher up. */
  function applyTheme(mount, formId, css) {
    if (!css) return;
    var scoped = el('style');
    scoped.textContent = css.replace('[data-rawr-form]', '[data-rawr-form="' + formId + '"]');
    mount.appendChild(scoped);
  }

  function paint(mount, formId, form) {
    mount.innerHTML = '';
    applyTheme(mount, formId, form.theme);
    var node = el('form', { class: 'rawr-form', novalidate: 'novalidate' });
    var steps = [];
    var current = 0;

    form.fields.forEach(function (field) {
      var step = field.step || 0;
      if (!steps[step]) {
        steps[step] = el('div', { class: 'rawr-step', 'data-step': String(step) });
        node.appendChild(steps[step]);
      }
      steps[step].appendChild(fieldNode(field, formId));
    });

    // The honeypot is positioned off-screen rather than display:none, and carries
    // autocomplete=off and tabindex=-1, so a person tabbing through never lands
    // in it and a password manager never fills it.
    var trap = el('div', { class: 'rawr-hp', 'aria-hidden': 'true' });
    trap.appendChild(el('input', {
      type: 'text', name: HONEYPOT, tabindex: '-1', autocomplete: 'off', value: ''
    }));
    node.appendChild(trap);

    var timing = el('input', { type: 'hidden', name: TIMING, value: String(Date.now()) });
    node.appendChild(timing);

    var status = el('div', { class: 'rawr-status', role: 'status', 'aria-live': 'polite' });
    var actions = el('div', { class: 'rawr-actions' });
    var back = el('button', { type: 'button', class: 'rawr-back' }, 'Back');
    var next = el('button', { type: 'button', class: 'rawr-next' }, 'Next');
    var submit = el('button', { type: 'submit', class: 'rawr-submit' }, form.settings.submitLabel);
    actions.appendChild(back);
    actions.appendChild(next);
    actions.appendChild(submit);

    // A bar as well as the words: "step 2 of 5" tells somebody where they are,
    // the bar tells them how much is left without reading anything.
    var progress = el('div', { class: 'rawr-progress' });
    var progressLabel = el('span', { class: 'rawr-progress-label' });
    var progressTrack = el('div', { class: 'rawr-progress-track', 'aria-hidden': 'true' });
    var progressFill = el('div', { class: 'rawr-progress-fill' });
    progressTrack.appendChild(progressFill);
    progress.appendChild(progressLabel);
    progress.appendChild(progressTrack);
    if (steps.length > 1) node.insertBefore(progress, node.firstChild);
    node.appendChild(status);
    node.appendChild(actions);

    function showStep(index) {
      current = Math.max(0, Math.min(index, steps.length - 1));
      steps.forEach(function (s, i) { s.hidden = i !== current; });
      back.hidden = current === 0;
      next.hidden = current >= steps.length - 1;
      submit.hidden = current < steps.length - 1;
      if (steps.length > 1) {
        progressLabel.textContent = formStep(current + 1, steps.length, (form.settings.steps || [])[current]);
        progressFill.style.width = Math.round(((current + 1) / steps.length) * 100) + '%';
      }
      applyConditions();
    }

    // A property rule names sibling properties, not form fields, so the answers
    // are re-keyed per object before it can be read. Rebuilt on each pass rather
    // than cached: the answers are what changed.
    function byProperty(answers) {
      var objects = {};
      form.fields.forEach(function (field) {
        var target = field.mapsTo ? String(field.mapsTo).split('.') : null;
        if (!target || target.length !== 2) return;
        if (!objects[target[0]]) objects[target[0]] = {};
        objects[target[0]][target[1]] = answers[field.key];
      });
      return objects;
    }

    function applyConditions() {
      var answers = collect(node);
      var rules = form.rules || {};
      var mapped = byProperty(answers);
      form.fields.forEach(function (field) {
        var rule = field.mapsTo ? rules[field.mapsTo] : null;
        if (!field.visibleIf && !rule) return;
        var wrapper = node.querySelector('[data-field="' + field.key + '"]');
        if (!wrapper) return;

        var shown = true;
        if (field.visibleIf) {
          var actual = answers[field.visibleIf.field];
          shown = Array.isArray(actual)
            ? actual.indexOf(field.visibleIf.equals) !== -1
            : String(actual == null ? '' : actual) === field.visibleIf.equals;
        }
        if (shown && rule) {
          shown = clientRuleMatches(rule, mapped[String(field.mapsTo).split('.')[0]] || {});
        }
        wrapper.hidden = !shown;
      });
    }

    node.addEventListener('input', applyConditions);
    node.addEventListener('change', applyConditions);

    // Once per painted form, on the first event only. The funnel step is intent,
    // and counting keystrokes would make a long answer look like engagement a
    // short one did not have.
    var touched = false;
    function firstTouch() {
      if (touched) return;
      touched = true;
      countForm(formId, 'interaction');
    }
    node.addEventListener('input', firstTouch);
    node.addEventListener('change', firstTouch);
    back.addEventListener('click', function () { showStep(current - 1); });
    next.addEventListener('click', function () {
      if (validateStep(node, form, steps[current])) showStep(current + 1);
    });

    // Checked when a field is left rather than on every keystroke: telling
    // somebody their email is wrong while they are still typing it is nagging,
    // and telling them after they have moved on is help. Once a field has a
    // message it re-checks as they type, so the message clears as soon as it is
    // fixed rather than waiting for another blur.
    node.addEventListener(
      'blur',
      function (event) {
        var wrapper = event.target.closest && event.target.closest('[data-field]');
        if (!wrapper) return;
        var field = fieldByKey(form, wrapper.getAttribute('data-field'));
        if (field) checkOne(node, field);
      },
      true
    );
    node.addEventListener('input', function (event) {
      var wrapper = event.target.closest && event.target.closest('[data-field]');
      if (!wrapper) return;
      var slot = wrapper.querySelector('.rawr-error');
      if (!slot || !slot.textContent) return;
      var field = fieldByKey(form, wrapper.getAttribute('data-field'));
      if (field) checkOne(node, field);
    });

    node.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!validateStep(node, form, steps[current])) {
        status.textContent = COPY.invalid;
        return;
      }
      send(node, formId, form, status, submit, mount);
    });

    // Reachable from the send path: a server error on an earlier step is invisible
    // that step is showing, so the step moves before focus does.
    form.onStep = showStep;

    mount.appendChild(node);
    showStep(0);
  }

  function fieldByKey(form, key) {
    for (var i = 0; i < form.fields.length; i++) if (form.fields[i].key === key) return form.fields[i];
    return null;
  }

  function fieldNode(field, formId) {
    var wrap = el('div', { class: 'rawr-field', 'data-field': field.key });
    if (field.type === 'hidden') {
      wrap.hidden = true;
      wrap.appendChild(el('input', {
        type: 'hidden', name: field.key, value: field.defaultValue || ''
      }));
      return wrap;
    }

    // Prefixed so a field key can never collide with the chrome above: a field
    // keyed "consent" rendered as id="rawr-consent", which the consent banner's
    // own rule then positioned fixed across the bottom of the page.
    var id = 'rawr-f-' + field.key;

    // A heading asks nothing. No label, no input, no error slot: it is the only
    // field that exists to be read rather than answered.
    if (field.type === 'heading') {
      wrap.setAttribute('data-wide', '');
      wrap.appendChild(el('p', { class: 'rawr-heading' }, field.label));
      if (field.help) wrap.appendChild(el('small', { class: 'rawr-help' }, field.help));
      return wrap;
    }

    // Consent reads as one sentence with a box in front of it. A label above a
    // lone checkbox splits the statement from the thing being agreed to, which
    // is exactly what makes a consent record hard to defend.
    if (field.type === 'consent') {
      wrap.setAttribute('data-wide', '');
      var consent = el('label', { class: 'rawr-consent', for: id });
      consent.appendChild(el('input', {
        type: 'checkbox', id: id, name: field.key, value: 'true',
        'aria-describedby': 'rawr-e-' + field.key
      }));
      consent.appendChild(el('span', {}, field.label + (field.required ? ' *' : '')));
      wrap.appendChild(consent);
      if (field.help) wrap.appendChild(el('small', { class: 'rawr-help' }, field.help));
      wrap.appendChild(el('div', {
        class: 'rawr-error', id: 'rawr-e-' + field.key, 'data-error': field.key, role: 'alert'
      }));
      return wrap;
    }

    var label = el('label', { for: id }, field.label + (field.required ? ' *' : ''));
    wrap.appendChild(label);

    var input;
    if (field.type === 'long_text') {
      input = el('textarea', { id: id, name: field.key, rows: '4' });
    } else if (field.type === 'radio') {
      input = el('div', { class: 'rawr-choices', id: id, role: 'radiogroup' });
      (field.options || []).forEach(function (o) {
        var choice = el('label');
        choice.appendChild(el('input', { type: 'radio', name: field.key, value: o.value }));
        choice.appendChild(document.createTextNode(' ' + o.label));
        input.appendChild(choice);
      });
    } else if (field.type === 'file') {
      input = fileInput(field, id, formId);
    } else if (field.type === 'select') {
      input = el('select', { id: id, name: field.key });
      input.appendChild(el('option', { value: '' }, field.placeholder || 'Choose one'));
      (field.options || []).forEach(function (o) {
        input.appendChild(el('option', { value: o.value }, o.label));
      });
    } else if (field.type === 'multi_select') {
      input = el('div', { class: 'rawr-choices', id: id, role: 'group' });
      (field.options || []).forEach(function (o) {
        var choice = el('label');
        choice.appendChild(el('input', { type: 'checkbox', name: field.key, value: o.value }));
        choice.appendChild(document.createTextNode(' ' + o.label));
        input.appendChild(choice);
      });
    } else if (field.type === 'boolean') {
      input = el('input', { type: 'checkbox', id: id, name: field.key, value: 'true' });
    } else {
      var htmlType = field.type === 'email' ? 'email'
        : field.type === 'phone' ? 'tel'
        : field.type === 'number' ? 'number'
        : field.type === 'date' ? 'date'
        : field.type === 'url' ? 'url' : 'text';
      input = el('input', { type: htmlType, id: id, name: field.key,
        placeholder: field.placeholder || null });
    }

    if (field.required && input.tagName !== 'DIV') input.setAttribute('aria-required', 'true');

    var errorId = 'rawr-e-' + field.key;
    if (input.tagName !== 'DIV') input.setAttribute('aria-describedby', errorId);
    wrap.appendChild(input);
    if (field.help) wrap.appendChild(el('small', { class: 'rawr-help' }, field.help));
    // role=alert so the message is announced when it appears, not only when the
    // field is next focused.
    wrap.appendChild(el('div', { class: 'rawr-error', id: errorId, 'data-error': field.key, role: 'alert' }));
    return wrap;
  }

  /** A file picker and the hidden input that carries what it produced.
   *
   *  The bytes never touch the form's own POST. On pick, the endpoint issues an
   *  id, the file is PUT under that id, and the id is what the submission posts.
   *  So the answer to a file field is a claim ticket, and the server decides
   *  whether it is honoured.
   *
   *  The picker itself is left unnamed on purpose: only the hidden input carries
   *  a name, so collect never sees a File object it cannot serialise. */
  function fileInput(field, id, formId) {
    var box = el('div', { class: 'rawr-file', id: id });
    var picker = el('input', { type: 'file', id: id + '-pick', 'aria-describedby': 'rawr-e-' + field.key });
    var token = el('input', { type: 'hidden', name: field.key, value: '' });
    var note = el('small', { class: 'rawr-file-note' });
    box.appendChild(picker);
    box.appendChild(token);
    box.appendChild(note);

    picker.addEventListener('change', function () {
      var file = picker.files && picker.files[0];
      token.value = '';
      if (!file) { note.textContent = ''; return; }
      note.textContent = COPY.uploading;
      picker.disabled = true;

      fetch(BASE + '/f/' + encodeURIComponent(formId) + '/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mime: file.type, bytes: file.size }),
        mode: 'cors'
      })
        .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
        .then(function (issued) {
          if (!issued.body || !issued.body.id) throw new Error(issued.body && issued.body.error);
          var to = BASE + '/f/' + encodeURIComponent(formId) + '/upload?id=' + encodeURIComponent(issued.body.id);
          return fetch(to, { method: 'PUT', body: file, mode: 'cors' }).then(function (put) {
            if (!put.ok) throw new Error('');
            token.value = issued.body.id;
            note.textContent = file.name;
          });
        })
        .catch(function (e) {
          picker.value = '';
          // The endpoint's own message when there is one: "larger than 10 MB" is
          // actionable and "that did not work" is not.
          note.textContent = (e && e.message) || COPY.uploadFailed;
        })
        .then(function () { picker.disabled = false; });
    });

    return box;
  }

  /** Shows or clears one field's message, and keeps aria-invalid in step with it.
   *  Every path that writes an error goes through here, so a message can never
   *  appear without the field being announced as invalid. */
  function setFieldError(node, key, message) {
    var slot = node.querySelector('[data-error="' + key + '"]');
    if (slot) slot.textContent = message || '';
    var wrapper = node.querySelector('[data-field="' + key + '"]');
    if (!wrapper) return;
    var inputs = wrapper.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i++) {
      if (message) inputs[i].setAttribute('aria-invalid', 'true');
      else inputs[i].removeAttribute('aria-invalid');
    }
  }

  function clearErrors(node) {
    var slots = node.querySelectorAll('.rawr-error');
    for (var i = 0; i < slots.length; i++) setFieldError(node, slots[i].getAttribute('data-error'), '');
  }

  /** The answer to one field, in the shape the checker expects: a list for a
   *  multi-select, a string for everything else. */
  function answerFor(node, field) {
    var answers = collect(node);
    var value = answers[field.key];
    if (field.type === 'multi_select') return Array.isArray(value) ? value : value ? [value] : [];
    return value == null ? '' : value;
  }

  /** Checks one field and paints the result. Returns true when it passes. */
  function checkOne(node, field) {
    if (field.type === 'heading') return true;
    var wrapper = node.querySelector('[data-field="' + field.key + '"]');
    // A hidden field is not being asked, so it is not being answered wrongly.
    if (!wrapper || wrapper.hidden) {
      setFieldError(node, field.key, '');
      return true;
    }
    var message = clientFieldError(field, answerFor(node, field));
    setFieldError(node, field.key, message);
    return !message;
  }

  function collect(node) {
    var data = {};
    var inputs = node.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      if (!input.name) continue;
      var wrapper = input.closest('[data-field]');
      // An answer to a field that is not on screen is not an answer. The server
      // discards these too; dropping them here keeps the payload honest.
      if (wrapper && wrapper.hidden && input.type !== 'hidden') continue;

      if (input.type === 'radio') {
        // Every radio in a group shares a name, so the unchecked ones must not
        // overwrite the chosen one on their way past.
        if (input.checked) data[input.name] = input.value;
        else if (!(input.name in data)) data[input.name] = '';
      } else if (input.type === 'checkbox') {
        if (input.value === 'true') { data[input.name] = input.checked ? 'true' : ''; continue; }
        if (!input.checked) continue;
        if (!data[input.name]) data[input.name] = [];
        data[input.name].push(input.value);
      } else {
        data[input.name] = input.value;
      }
    }
    return data;
  }

  /** Every field on one step, checked against the same rules the server applies.
   *  Client-side validation gates the step and nothing more: the server checks
   *  everything again, so somebody who defeats this gains nothing. */
  function validateStep(node, form, step) {
    var ok = true;
    var first = null;
    for (var i = 0; i < form.fields.length; i++) {
      var field = form.fields[i];
      var wrapper = step.querySelector('[data-field="' + field.key + '"]');
      if (!wrapper) continue;
      if (!checkOne(node, field)) {
        ok = false;
        if (!first) first = wrapper;
      }
    }
    // The first thing wrong, not the last: somebody looking at the bottom of a
    // long form has no idea the problem is three fields above them.
    if (first) focusField(first);
    return ok;
  }

  function focusField(wrapper) {
    var input = wrapper.querySelector('input, textarea, select');
    if (!input) return;
    if (input.scrollIntoView) input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  }

  /** Puts the button into its waiting state and hands back the undo, so every
   *  path out of the send restores it exactly once. */
  function busy(submit, on) {
    if (on) {
      if (!submit.getAttribute('data-label')) submit.setAttribute('data-label', submit.textContent);
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      submit.textContent = COPY.sending;
    } else {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      var label = submit.getAttribute('data-label');
      if (label) submit.textContent = label;
    }
  }

  /** The failure card: what went wrong, and a way to try again that keeps every
   *  answer. Nothing is cleared, because a person who has just filled in eight
   *  fields will not fill them in twice. */
  function showFailure(node, status, submit, message, retry) {
    status.textContent = message;
    var actions = node.querySelector('.rawr-actions');
    var existingRetry = node.querySelector('.rawr-retry');
    if (existingRetry) existingRetry.parentNode.removeChild(existingRetry);
    var again = el('button', { type: 'button', class: 'rawr-retry' }, COPY.retry);
    again.addEventListener('click', function () {
      again.parentNode.removeChild(again);
      status.textContent = '';
      retry();
    });
    if (actions) actions.appendChild(again);
  }

  function send(node, formId, form, status, submit, mount) {
    // Asked before the request rather than inferred from its failure: "you are
    // offline" is a different instruction from "try again", and the browser
    // already knows which one applies.
    if (navigator.onLine === false) {
      showFailure(node, status, submit, COPY.offline, function () {
        send(node, formId, form, status, submit, mount);
      });
      return;
    }

    busy(submit, true);
    status.textContent = '';
    clearErrors(node);
    var stale = node.querySelector('.rawr-retry');
    if (stale) stale.parentNode.removeChild(stale);

    var payload = collect(node);
    var attr = attribution();
    for (var k in attr) payload[k] = attr[k];
    var challenge = node.querySelector('[name="cf-turnstile-response"]');
    if (challenge) payload['cf-turnstile-response'] = challenge.value;

    fetch(BASE + '/f/' + encodeURIComponent(formId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      mode: 'cors'
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (result) {
        busy(submit, false);
        var body = result.body;

        if (body.errors) {
          var firstWrapper = null;
          body.errors.forEach(function (e) {
            setFieldError(node, e.key, e.message);
            if (!firstWrapper) firstWrapper = node.querySelector('[data-field="' + e.key + '"]');
          });
          status.textContent = COPY.invalid;
          // A message on a field two steps back is invisible until the step it
          // lives on is showing, so the step moves before focus does.
          if (firstWrapper) {
            var step = firstWrapper.closest('.rawr-step');
            if (step && step.hidden && form.onStep) form.onStep(Number(step.getAttribute('data-step')));
            focusField(firstWrapper);
          }
          return;
        }
        if (body.challenge) {
          mountChallenge(node, body.challenge, function () { send(node, formId, form, status, submit, mount); });
          status.textContent = COPY.challenge;
          return;
        }
        if (!body.ok) {
          showFailure(node, status, submit, body.error || COPY.failed, function () {
            send(node, formId, form, status, submit, mount);
          });
          return;
        }

        succeed(mount, body);
      })
      .catch(function () {
        busy(submit, false);
        showFailure(
          node,
          status,
          submit,
          navigator.onLine === false ? COPY.offline : COPY.failed,
          function () { send(node, formId, form, status, submit, mount); }
        );
      });
  }

  /** The success card. A redirect counts down in view rather than replacing the
   *  page instantly: somebody who never sees a confirmation does not know whether
   *  it worked, and browsers give a same-tab navigation no time to be read. */
  function succeed(mount, body) {
    var success = body.success || {};
    var done = el('div', { class: 'rawr-done', role: 'status' });
    done.appendChild(el('p', { class: 'rawr-done-title' },
      success.mode === 'redirect' ? COPY.sent : (success.value || COPY.sent)));

    if (success.mode !== 'redirect') {
      mount.innerHTML = '';
      mount.appendChild(done);
      return;
    }

    var note = el('p', { class: 'rawr-done-note' }, formRedirecting(REDIRECT_SECONDS));
    done.appendChild(note);
    var link = el('a', { href: success.value, class: 'rawr-done-link' }, 'Go there now');
    done.appendChild(link);
    mount.innerHTML = '';
    mount.appendChild(done);

    var left = REDIRECT_SECONDS;
    var tick = setInterval(function () {
      left -= 1;
      note.textContent = formRedirecting(left);
      if (left <= 0) {
        clearInterval(tick);
        location.href = success.value;
      }
    }, 1000);
  }

  function mountChallenge(node, challenge, onReady) {
    if (node.querySelector('.rawr-challenge')) return;
    var holder = el('div', { class: 'rawr-challenge' });
    node.insertBefore(holder, node.querySelector('.rawr-actions'));

    window.rawrChallengeDone = function (token) {
      var field = el('input', { type: 'hidden', name: 'cf-turnstile-response', value: token });
      node.appendChild(field);
      onReady();
    };

    var script = el('script', {
      src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      async: 'async', defer: 'defer'
    });
    script.onload = function () {
      if (window.turnstile) {
        window.turnstile.render(holder, { sitekey: challenge.siteKey, callback: window.rawrChallengeDone });
      }
    };
    document.head.appendChild(script);
  }

  // -------------------------------------------------------------------- start

  function injectStyles() {
    if (document.getElementById('rawr-embed-styles')) return;
    var style = el('style', { id: 'rawr-embed-styles' });
    style.textContent = ${JSON.stringify(config.styles)};
    document.head.appendChild(style);
  }

  function start() {
    injectStyles();
    var mounts = document.querySelectorAll('[data-rawr-form]');
    for (var i = 0; i < mounts.length; i++) {
      renderForm(mounts[i], mounts[i].getAttribute('data-rawr-form'));
    }
    if (document.querySelector('script[data-rawr-consent]')) {
      if (existing) { applyConsent(existing, false); settingsLink(); }
      else banner();
    }
  }

  window.rawr = {
    loaded: true,
    consent: function () { return storedConsent(); },
    openConsent: function () { deleteCookie(COOKIE); banner(); },
    mount: renderForm,
    // The product app's hook. A no-op without analytics consent, deliberately:
    // the caller should not have to check, and must not be able to opt around it.
    track: trackEvent
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`
