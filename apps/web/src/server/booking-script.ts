/** The browser half of F2 §7, served as one file from /booking.js.
 *
 *  No framework, no bundler, no dependencies. It runs inside Webflow's page, so
 *  every byte and every global belongs to somebody else's budget. Everything is
 *  inside one IIFE and the only global is window.rawrBooking.
 *
 *  It renders inline rather than in an iframe. That is the whole reason the widget
 *  is themeable from Webflow: the markup inherits the page's custom properties, and
 *  marketing restyles it by setting --rawr-embed-* on any ancestor. An iframe would
 *  isolate the styles and take the theming away.
 *
 *  Three failure rules, in order of how often they bite:
 *    the script not loading at all leaves the <noscript> link to the hosted page,
 *    a fetch failing leaves a link to the hosted page in place of the widget,
 *    a slot going while somebody types reloads the list and says so.
 *
 *  Written as a template string rather than a .js file so the endpoint paths and the
 *  class names are shared with the server that defines them; a rename becomes a
 *  compile error instead of a silently broken embed. */

export type BookingScriptConfig = {
  baseUrl: string
  /** Injected rather than linked, so the widget cannot render unstyled while a
   *  second request is in flight. */
  styles: string
}

export const buildBookingScript = (config: BookingScriptConfig): string => `/* Rawr booking embed. */
(function () {
  'use strict';
  if (window.rawrBooking && window.rawrBooking.loaded) return;

  var BASE = ${JSON.stringify(config.baseUrl)};
  var STYLES = ${JSON.stringify(config.styles)};
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ---------------------------------------------------------------- utilities

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function injectStyles() {
    if (document.getElementById('rawr-booking-styles')) return;
    var style = el('style', { id: 'rawr-booking-styles' });
    style.appendChild(document.createTextNode(STYLES));
    document.head.appendChild(style);
  }

  function zone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch (e) { return 'UTC'; }
  }

  // Written by embed.js, and only when analytics consent was granted. Read here
  // rather than shared through a global, so the booking widget works on a page
  // that does not carry the embed at all.
  function visitorId() {
    var parts = ('; ' + document.cookie).split('; rawr_vid=');
    return parts.length === 2 ? decodeURIComponent(parts.pop().split(';').shift()) : null;
  }

  function monthKey(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  }

  function shiftMonth(key, by) {
    var parts = key.split('-');
    var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1 + by, 1));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  function monthLabel(key) {
    return new Date(key + '-01T12:00:00Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  /** The visitor's calendar date for an instant, in their own zone. Built from the
   *  formatted parts rather than the UTC date, because a 23:30 slot in Los Angeles
   *  belongs to the next day in Jakarta and the person in Jakarta is right. */
  function dayKey(date, tz) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    return parts.replace(/\\//g, '-');
  }

  function isoWeekday(key) {
    var d = new Date(key + 'T12:00:00Z').getUTCDay();
    return d === 0 ? 7 : d;
  }

  function timeLabel(date, tz) {
    return date.toLocaleTimeString(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  }

  function fallbackLink(mount, address, text) {
    clear(mount);
    mount.appendChild(el('p', { class: 'rawr-b-note' }));
    var link = el('a', { href: BASE + '/b/' + address }, text || 'Book a meeting');
    mount.firstChild.appendChild(link);
  }

  // ------------------------------------------------------------------- widget

  function mountWidget(mount) {
    var address = (mount.getAttribute('data-rawr-booking') || '').replace(/^\\/+|\\/+$/g, '');
    if (address.split('/').length !== 2) {
      fallbackLink(mount, address, 'Book a meeting');
      return;
    }

    var state = {
      tz: mount.getAttribute('data-rawr-tz') || zone(),
      month: monthKey(new Date()),
      day: null,
      slot: null,
      hold: null,
      /** What the visitor has typed, kept outside the DOM. Every render rebuilds
       *  the form, and a validation error that empties the answers is a worse
       *  outcome than the error it is reporting. */
      answers: {},
      data: null,
      busy: false,
      message: null,
      bad: false
    };

    mount.setAttribute('data-rawr-booking-widget', '');
    var root = el('div', { class: 'rawr-b' });
    mount.appendChild(root);

    function endpoint(path, query) {
      var url = BASE + '/b/' + address + path;
      if (query) url += '?' + query;
      return url;
    }

    function load() {
      state.busy = true;
      render();
      fetch(endpoint('/slots', 'month=' + encodeURIComponent(state.month) + '&tz=' + encodeURIComponent(state.tz)), {
        headers: { accept: 'application/json' }
      })
        .then(function (response) {
          if (!response.ok) throw new Error('slots ' + response.status);
          return response.json();
        })
        .then(function (data) {
          state.data = data;
          state.busy = false;
          render();
        })
        .catch(function () {
          // Nothing partial and nothing invented: the hosted page is a real page
          // that does the same job, so that is what is offered.
          fallbackLink(mount, address, 'Book a meeting on our scheduling page');
        });
    }

    function slotsByDay() {
      var grouped = {};
      var slots = (state.data && state.data.slots) || [];
      for (var i = 0; i < slots.length; i++) {
        var at = new Date(slots[i].startsAt);
        var key = dayKey(at, state.tz);
        (grouped[key] = grouped[key] || []).push(at);
      }
      return grouped;
    }

    function hold(slot) {
      // Best effort. A failed hold costs the courtesy, never the booking.
      fetch(endpoint('/hold'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: slot.toISOString() })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (held) { if (held) state.hold = held.token; })
        .catch(function () {});
    }

    function releaseHold() {
      if (!state.hold) return;
      var token = state.hold;
      state.hold = null;
      fetch(endpoint('/hold', 'token=' + encodeURIComponent(token)), { method: 'DELETE' }).catch(function () {});
    }

    function readInput(input) {
      if (input.type === 'checkbox') return input.checked ? 'true' : '';
      if (input.multiple) {
        var picked = [];
        for (var o = 0; o < input.options.length; o++) if (input.options[o].selected) picked.push(input.options[o].value);
        return picked;
      }
      return input.value;
    }

    function confirm(form) {
      // Read once from the DOM, because a browser autofill never fires an event
      // anyone can hear.
      var fields = form.querySelectorAll('[name]');
      for (var i = 0; i < fields.length; i++) state.answers[fields[i].name] = readInput(fields[i]);

      var body = { slot: state.slot.toISOString(), timezone: state.tz, pagePath: location.pathname };
      if (state.hold) body.hold = state.hold;
      // F4 §3. The widget renders inline, so it is in the same first-party context
      // as the embed and can read the visitor cookie. Sent in the body, never in a
      // URL, and absent entirely when consent was declined and no cookie exists.
      var vid = visitorId();
      if (vid) body.vid = vid;
      for (var key in state.answers) body[key] = state.answers[key];

      state.busy = true;
      state.message = null;
      render();

      fetch(endpoint('/confirm'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (response) {
          return response.json().then(function (payload) { return { status: response.status, payload: payload }; });
        })
        .then(function (result) {
          state.busy = false;
          state.hold = null;
          if (result.status === 409) {
            // The slot went while they were typing. Reload rather than argue.
            state.slot = null;
            state.message = result.payload.error;
            state.bad = true;
            load();
            return;
          }
          if (result.status >= 400) {
            state.message = result.payload.error || 'That could not be booked. Please check the answers.';
            state.bad = true;
            render();
            return;
          }
          if (result.payload.redirectUrl) {
            location.href = result.payload.redirectUrl;
            return;
          }
          renderConfirmed(result.payload);
        })
        .catch(function () {
          state.busy = false;
          state.message = 'The booking could not be sent. Check your connection, or use our scheduling page.';
          state.bad = true;
          render();
        });
    }

    function renderConfirmed(payload) {
      clear(root);
      var note = el('div', { class: 'rawr-b-note', 'data-good': '' });
      note.appendChild(el('p', null, 'You are booked.'));
      note.appendChild(el('p', null,
        new Date(payload.startsAt).toLocaleString(undefined, {
          timeZone: state.tz, weekday: 'long', day: 'numeric', month: 'long',
          hour: '2-digit', minute: '2-digit'
        }) + ' (' + state.tz + ')'
      ));
      if (payload.message) note.appendChild(el('p', null, payload.message));
      if (payload.conferenceUrl) {
        var join = el('p');
        join.appendChild(el('a', { href: payload.conferenceUrl }, 'Joining link'));
        note.appendChild(join);
      }
      var warnings = payload.warnings || [];
      for (var w = 0; w < warnings.length; w++) {
        note.appendChild(el('p', { class: 'rawr-b-hint' }, warnings[w]));
      }
      var manage = el('p');
      manage.appendChild(el('a', { href: payload.rescheduleUrl }, 'Move this meeting'));
      manage.appendChild(document.createTextNode(' · '));
      manage.appendChild(el('a', { href: payload.cancelUrl }, 'Cancel it'));
      note.appendChild(manage);
      root.appendChild(note);
    }

    function render() {
      clear(root);
      var data = state.data;

      var head = el('div', { class: 'rawr-b-head' });
      head.appendChild(el('span', { class: 'rawr-b-title' }, (data && data.name) || 'Book a meeting'));
      if (data) {
        var meta = el('div', { class: 'rawr-b-meta' });
        if (data.organisation) meta.appendChild(el('span', null, data.organisation));
        meta.appendChild(el('span', null, data.durationMinutes + ' minutes'));
        meta.appendChild(el('span', null, 'Times shown in ' + state.tz));
        head.appendChild(meta);
      }
      root.appendChild(head);

      if (state.message) {
        root.appendChild(el('div', { class: 'rawr-b-note', 'data-bad': state.bad ? '' : null, role: 'alert' }, state.message));
      }

      if (!data) {
        root.appendChild(el('p', { class: 'rawr-b-hint' }, 'Loading times…'));
        return;
      }

      if (data.unavailable) {
        root.appendChild(el('div', { class: 'rawr-b-note', 'data-bad': '', role: 'alert' }, data.unavailable));
        return;
      }

      var grouped = slotsByDay();
      var body = el('div', { class: 'rawr-b-body' });
      if (state.day) body.setAttribute('data-two', '');

      // ---- month
      var left = el('div', { class: 'rawr-b-panel' });
      var bar = el('div', { class: 'rawr-b-monthbar' });
      bar.appendChild(button('← Earlier', function () {
        state.month = shiftMonth(state.month, -1); state.day = null; state.slot = null; releaseHold(); load();
      }));
      bar.appendChild(el('span', { class: 'rawr-b-month' }, monthLabel(state.month)));
      bar.appendChild(button('Later →', function () {
        state.month = shiftMonth(state.month, 1); state.day = null; state.slot = null; releaseHold(); load();
      }));
      left.appendChild(bar);

      var grid = el('div', { class: 'rawr-b-grid', role: 'grid' });
      for (var d = 0; d < 7; d++) grid.appendChild(el('div', { class: 'rawr-b-dow', 'aria-hidden': 'true' }, DOW[d]));
      var first = state.month + '-01';
      for (var pad = 1; pad < isoWeekday(first); pad++) grid.appendChild(el('span'));

      // Day zero of the next month is the last day of this one, which is the whole
      // leap-year rule. Counted rather than walked with a Date, because a cursor
      // compared against the visitor's local month renders nothing at all west of
      // Greenwich, where the first of the month starts on the last of the previous.
      var ym = state.month.split('-');
      var days = new Date(Date.UTC(Number(ym[0]), Number(ym[1]), 0)).getUTCDate();
      for (var day = 1; day <= days; day++) {
        var key = state.month + '-' + String(day).padStart(2, '0');
        grid.appendChild(dayCell(key, (grouped[key] || []).length));
      }
      left.appendChild(grid);
      body.appendChild(left);

      // ---- times and form
      if (state.day) {
        var right = el('div', { class: 'rawr-b-panel' });
        right.appendChild(el('h2', null, new Date(state.day + 'T12:00:00Z').toLocaleDateString(undefined, {
          weekday: 'long', day: 'numeric', month: 'long'
        })));

        var times = grouped[state.day] || [];
        if (!times.length) {
          right.appendChild(el('p', { class: 'rawr-b-hint' }, 'Nothing open on this day. Pick another.'));
        } else {
          var list = el('div', { class: 'rawr-b-times' });
          for (var t = 0; t < times.length; t++) list.appendChild(slotButton(times[t]));
          right.appendChild(list);
        }

        if (state.slot) right.appendChild(questionForm(data));
        body.appendChild(right);
      } else if ((data.slots || []).length) {
        body.appendChild(el('p', { class: 'rawr-b-hint' }, 'Pick a day to see the times that are open.'));
      } else {
        body.appendChild(el('div', { class: 'rawr-b-note' }, 'Nothing is open in ' + monthLabel(state.month) + '. Try the next month.'));
      }

      root.appendChild(body);
    }

    function button(label, onClick) {
      var node = el('button', { type: 'button', class: 'rawr-b-slot', style: 'padding:0.25rem 0.5rem' }, label);
      node.addEventListener('click', onClick);
      return node;
    }

    function dayCell(key, count) {
      if (!count) {
        return el('span', { class: 'rawr-b-day', 'data-closed': '', 'aria-label': key + ', nothing open' }, String(Number(key.slice(8))));
      }
      var node = el('button', {
        type: 'button', class: 'rawr-b-day', 'data-open': '',
        'aria-current': key === state.day ? 'date' : null,
        'aria-label': key + ', ' + count + (count === 1 ? ' time open' : ' times open')
      }, String(Number(key.slice(8))));
      node.appendChild(el('span', { class: 'rawr-b-dot', 'aria-hidden': 'true' }));
      node.addEventListener('click', function () {
        state.day = key; state.slot = null; releaseHold(); state.message = null; render();
      });
      return node;
    }

    function slotButton(at) {
      var chosen = state.slot && state.slot.getTime() === at.getTime();
      var node = el('button', {
        type: 'button', class: 'rawr-b-slot', 'aria-current': chosen ? 'true' : null
      }, timeLabel(at, state.tz));
      node.addEventListener('click', function () {
        releaseHold();
        state.slot = at;
        state.message = null;
        hold(at);
        render();
      });
      return node;
    }

    function questionForm(data) {
      var form = el('form', { class: 'rawr-b-form', style: 'margin-block-start:0.75rem' });
      var core = [
        { key: 'name', type: 'text', label: 'Full name', required: true },
        { key: 'email', type: 'email', label: 'Work email', required: true }
      ];
      var fields = core.concat(data.questions || []);

      for (var i = 0; i < fields.length; i++) form.appendChild(fieldFor(fields[i]));

      var submit = el('button', { type: 'submit', class: 'rawr-b-cta' },
        state.busy ? 'Booking…' : 'Confirm ' + data.durationMinutes + ' minutes');
      if (state.busy) submit.setAttribute('disabled', 'disabled');
      form.appendChild(submit);
      form.appendChild(el('p', { class: 'rawr-b-hint' },
        'You will get a calendar invitation with the joining details and a link to move or cancel.'));

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (state.busy) return;
        confirm(form);
      });
      return form;
    }

    function fieldFor(field) {
      var wrap = el('div', { class: 'rawr-b-field' });
      var id = 'rawr-b-' + field.key;
      wrap.appendChild(el('label', { for: id }, field.label + (field.required ? ' *' : '')));

      var input;
      if (field.type === 'long_text') {
        input = el('textarea', { id: id, name: field.key });
      } else if (field.type === 'select' || field.type === 'multi_select') {
        input = el('select', { id: id, name: field.key });
        if (field.type === 'multi_select') input.setAttribute('multiple', 'multiple');
        else input.appendChild(el('option', { value: '' }, 'Choose one…'));
        var options = field.options || [];
        for (var o = 0; o < options.length; o++) {
          input.appendChild(el('option', { value: options[o].value }, options[o].label));
        }
      } else if (field.type === 'boolean') {
        input = el('input', { id: id, name: field.key, type: 'checkbox', value: 'true', style: 'width:auto' });
      } else {
        var types = { email: 'email', phone: 'tel', url: 'url', number: 'number', date: 'date' };
        input = el('input', { id: id, name: field.key, type: types[field.type] || 'text' });
      }
      if (field.required) input.setAttribute('required', 'required');
      if (field.placeholder) input.setAttribute('placeholder', field.placeholder);

      var kept = state.answers[field.key];
      if (kept != null) {
        if (input.type === 'checkbox') input.checked = kept === 'true';
        else if (input.multiple) {
          for (var o = 0; o < input.options.length; o++) {
            input.options[o].selected = kept.indexOf(input.options[o].value) >= 0;
          }
        } else input.value = kept;
      }
      var remember = function () { state.answers[field.key] = readInput(input); };
      input.addEventListener('input', remember);
      input.addEventListener('change', remember);

      wrap.appendChild(input);
      return wrap;
    }

    // A hold nobody confirms should go back as soon as the tab does, rather than
    // sitting on capacity for its full five minutes.
    window.addEventListener('pagehide', releaseHold);

    load();
  }

  // --------------------------------------------------------------------- boot

  function boot() {
    injectStyles();
    var mounts = document.querySelectorAll('[data-rawr-booking]');
    for (var i = 0; i < mounts.length; i++) {
      if (mounts[i].getAttribute('data-rawr-mounted')) continue;
      mounts[i].setAttribute('data-rawr-mounted', '1');
      try { mountWidget(mounts[i]); }
      catch (e) { fallbackLink(mounts[i], mounts[i].getAttribute('data-rawr-booking') || '', 'Book a meeting'); }
    }
  }

  window.rawrBooking = { loaded: true, mount: boot };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`
