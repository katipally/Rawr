import { ATTRIBUTION_FIELDS, HONEYPOT_FIELD, TIMING_FIELD } from '@rawr/db'

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
  // to govern anything. 00-context.md section 6.
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
      .then(function (form) { paint(mount, formId, form); })
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

  function paint(mount, formId, form) {
    mount.innerHTML = '';
    var node = el('form', { class: 'rawr-form', novalidate: 'novalidate' });
    var steps = [];
    var current = 0;

    form.fields.forEach(function (field) {
      var step = field.step || 0;
      if (!steps[step]) {
        steps[step] = el('div', { class: 'rawr-step', 'data-step': String(step) });
        node.appendChild(steps[step]);
      }
      steps[step].appendChild(fieldNode(field));
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

    var progress = el('div', { class: 'rawr-progress' });
    if (steps.length > 1) node.insertBefore(progress, node.firstChild);
    node.appendChild(status);
    node.appendChild(actions);

    function showStep(index) {
      current = Math.max(0, Math.min(index, steps.length - 1));
      steps.forEach(function (s, i) { s.hidden = i !== current; });
      back.hidden = current === 0;
      next.hidden = current >= steps.length - 1;
      submit.hidden = current < steps.length - 1;
      progress.textContent = steps.length > 1
        ? 'Step ' + (current + 1) + ' of ' + steps.length
        : '';
      applyConditions();
    }

    function applyConditions() {
      var answers = collect(node);
      form.fields.forEach(function (field) {
        if (!field.visibleIf) return;
        var wrapper = node.querySelector('[data-field="' + field.key + '"]');
        if (!wrapper) return;
        var actual = answers[field.visibleIf.field];
        var shown = Array.isArray(actual)
          ? actual.indexOf(field.visibleIf.equals) !== -1
          : String(actual == null ? '' : actual) === field.visibleIf.equals;
        wrapper.hidden = !shown;
      });
    }

    node.addEventListener('input', applyConditions);
    node.addEventListener('change', applyConditions);
    back.addEventListener('click', function () { showStep(current - 1); });
    next.addEventListener('click', function () {
      // Client-side validation gates the step only. The server revalidates
      // everything, so a person who defeats this gains nothing.
      if (validateStep(node, steps[current])) showStep(current + 1);
    });

    node.addEventListener('submit', function (event) {
      event.preventDefault();
      send(node, formId, form, status, submit, mount);
    });

    mount.appendChild(node);
    showStep(0);
  }

  function fieldNode(field) {
    var wrap = el('div', { class: 'rawr-field', 'data-field': field.key });
    if (field.type === 'hidden') {
      wrap.hidden = true;
      wrap.appendChild(el('input', {
        type: 'hidden', name: field.key, value: field.defaultValue || ''
      }));
      return wrap;
    }

    var id = 'rawr-' + field.key;
    var label = el('label', { for: id }, field.label + (field.required ? ' *' : ''));
    wrap.appendChild(label);

    var input;
    if (field.type === 'long_text') {
      input = el('textarea', { id: id, name: field.key, rows: '4' });
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
    wrap.appendChild(input);
    if (field.help) wrap.appendChild(el('small', { class: 'rawr-help' }, field.help));
    wrap.appendChild(el('div', { class: 'rawr-error', 'data-error': field.key }));
    return wrap;
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

      if (input.type === 'checkbox') {
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

  function validateStep(node, step) {
    var ok = true;
    var inputs = step.querySelectorAll('input, textarea, select');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var wrapper = input.closest('[data-field]');
      if (!wrapper || wrapper.hidden) continue;
      var slot = wrapper.querySelector('.rawr-error');
      var required = input.getAttribute('aria-required') === 'true';
      if (required && !String(input.value || '').trim()) {
        if (slot) slot.textContent = 'This is required.';
        ok = false;
      } else if (slot) slot.textContent = '';
    }
    return ok;
  }

  function send(node, formId, form, status, submit, mount) {
    submit.disabled = true;
    status.textContent = '';
    node.querySelectorAll('.rawr-error').forEach(function (s) { s.textContent = ''; });

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
        submit.disabled = false;
        var body = result.body;

        if (body.errors) {
          body.errors.forEach(function (e) {
            var slot = node.querySelector('[data-error="' + e.key + '"]');
            if (slot) slot.textContent = e.message;
          });
          status.textContent = 'Check the highlighted fields.';
          return;
        }
        if (body.challenge) {
          mountChallenge(node, body.challenge, function () { send(node, formId, form, status, submit, mount); });
          status.textContent = 'One quick check before we can send this.';
          return;
        }
        if (!body.ok) {
          status.textContent = body.error || 'That could not be sent. Try again in a moment.';
          return;
        }

        if (body.success && body.success.mode === 'redirect') {
          location.href = body.success.value;
          return;
        }
        mount.innerHTML = '';
        mount.appendChild(el('div', { class: 'rawr-done', role: 'status' },
          (body.success && body.success.value) || 'Thanks.'));
      })
      .catch(function () {
        submit.disabled = false;
        status.textContent = 'That could not be sent. Check your connection and try again.';
      });
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
