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

import { BOOKING_COPY, formatterSource } from '~/lib/edge-copy.ts'

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
  var COPY = ${JSON.stringify(BOOKING_COPY)};

  // The same formatters the hosted page and the tests use, inlined from source so
  // there is one implementation rather than a copy that drifts.
  ${formatterSource()}

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
      /** { token, expiresAt } while a slot is held, null otherwise. The expiry is
       *  the server's, not a local guess: a tab that slept through its five
       *  minutes must read as expired the moment it wakes. */
      hold: null,
      holdExpired: false,
      /** What the visitor has typed, kept outside the DOM. Every render rebuilds
       *  the form, and a validation error that empties the answers is a worse
       *  outcome than the error it is reporting. */
      answers: {},
      data: null,
      /** Two different waits, and conflating them showed last month's grid under
       *  this month's name. One is the month being read, the other is the booking
       *  being sent. */
      loadingMonth: false,
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
      state.loadingMonth = true;
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
          state.loadingMonth = false;
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
        .then(function (held) {
          if (!held || !state.slot || state.slot.getTime() !== slot.getTime()) return;
          state.hold = { token: held.token, expiresAt: new Date(held.expiresAt).getTime() };
          state.holdExpired = false;
          tickHold();
        })
        .catch(function () {});
    }

    function releaseHold() {
      if (!state.hold) return;
      var token = state.hold.token;
      state.hold = null;
      state.holdExpired = false;
      fetch(endpoint('/hold', 'token=' + encodeURIComponent(token)), { method: 'DELETE' }).catch(function () {});
    }

    /** The countdown, updated in place rather than by re-rendering: the person is
     *  typing into the form underneath it, and rebuilding the DOM every second
     *  would take their cursor with it. */
    function tickHold() {
      var node = root.querySelector('.rawr-b-hold');
      if (!state.hold) {
        if (node) node.textContent = state.holdExpired ? COPY.holdExpired : '';
        return;
      }
      var left = state.hold.expiresAt - Date.now();
      if (left <= 0) {
        // Expired rather than released: the slot may well still be free, and
        // telling somebody to pick it again is better than silently letting the
        // confirm fail.
        state.hold = null;
        state.holdExpired = true;
        if (node) {
          node.textContent = COPY.holdExpired;
          node.setAttribute('data-bad', '');
        }
        return;
      }
      if (node) node.textContent = bookingHeld(countdown(left));
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

      // Asked before the request rather than inferred from its failure, so a train
      // tunnel reads as a train tunnel instead of as something we broke.
      if (navigator.onLine === false) {
        state.message = COPY.offline;
        state.bad = true;
        render();
        return;
      }

      var body = { slot: state.slot.toISOString(), timezone: state.tz, pagePath: location.pathname };
      if (state.hold) body.hold = state.hold.token;
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
          state.holdExpired = false;
          if (result.status === 409) {
            // The slot went while they were typing. Reload rather than argue, and
            // say so in words that do not read as their mistake. The answers stay
            // in state.answers, so the next slot they pick keeps them.
            state.slot = null;
            state.message = COPY.slotGone;
            state.bad = true;
            load();
            return;
          }
          if (result.status >= 400) {
            state.message = result.payload.error || COPY.failed;
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
          state.message = navigator.onLine === false ? COPY.offline : COPY.failed;
          state.bad = true;
          render();
        });
    }

    function renderConfirmed(payload) {
      clear(root);
      var note = el('div', { class: 'rawr-b-note', 'data-good': '', role: 'status' });
      note.appendChild(el('p', null, COPY.booked));
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
      // Google sends its own invitation to the mailbox they gave us, which is not
      // always the calendar they actually keep. This is the one they can add to
      // whatever they use.
      if (payload.calendarUrl) {
        var add = el('p');
        add.appendChild(el('a', { class: 'rawr-b-add', href: payload.calendarUrl }, COPY.addToCalendar));
        note.appendChild(add);
      }
      var manage = el('p');
      manage.appendChild(el('a', { href: payload.rescheduleUrl }, COPY.reschedule));
      manage.appendChild(document.createTextNode(' · '));
      manage.appendChild(el('a', { href: payload.cancelUrl }, COPY.cancel));
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

      // A month costs a free-busy read per host, so this is a real wait rather than
      // a flicker. A grid the shape of the answer keeps the widget from jumping
      // when it lands, and the message says what is being waited on. Shown while a
      // later month loads too: the old grid under the new month's name is a lie.
      if (!data || state.loadingMonth) {
        root.appendChild(skeleton());
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
      left.appendChild(monthBar());

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
          right.appendChild(el('p', { class: 'rawr-b-hint' }, COPY.nothingOnDay));
        } else {
          var list = el('div', { class: 'rawr-b-times' });
          for (var t = 0; t < times.length; t++) list.appendChild(slotButton(times[t]));
          right.appendChild(list);
        }

        if (state.slot) right.appendChild(questionForm(data));
        body.appendChild(right);
      } else if ((data.slots || []).length) {
        body.appendChild(el('p', { class: 'rawr-b-hint' }, COPY.pickDay));
      } else {
        body.appendChild(emptyMonth(data));
      }

      root.appendChild(body);
      // Every render rebuilds the countdown node empty, so it is filled here
      // rather than a second later on the next tick.
      tickHold();
    }

    /** An empty grid says nothing about whether to click Later once or six times,
     *  so the server answers that question with the month it was already reading.
     *  When there is genuinely nothing ahead, it says so rather than sending
     *  somebody clicking into an empty year. */
    function emptyMonth(data) {
      var note = el('div', { class: 'rawr-b-note' });
      if (!data.nextAvailable) {
        note.appendChild(el('p', null, COPY.nothingAtAll));
        return note;
      }
      var when = new Date(data.nextAvailable);
      note.appendChild(el('p', null, bookingNextAvailable(when.toLocaleDateString(undefined, {
        timeZone: state.tz, weekday: 'long', day: 'numeric', month: 'long'
      }))));
      var jump = button(COPY.jumpToNext, function () {
        var day = dayKey(when, state.tz);
        goToMonth(day.slice(0, 7));
        // The day the times are on, not just the month: one click, not two.
        state.day = day;
      });
      jump.className = 'rawr-b-cta';
      note.appendChild(jump);
      return note;
    }

    function goToMonth(key) {
      state.month = key;
      state.day = null;
      state.slot = null;
      releaseHold();
      load();
    }

    /** Rendered by the skeleton as well as the grid, so the month can be changed
     *  again while one is still loading rather than waiting for a read to finish
     *  before the next click is possible. */
    function monthBar() {
      var bar = el('div', { class: 'rawr-b-monthbar' });
      bar.appendChild(button('← Earlier', function () { goToMonth(shiftMonth(state.month, -1)); }));
      bar.appendChild(el('span', { class: 'rawr-b-month' }, monthLabel(state.month)));
      bar.appendChild(button('Later →', function () { goToMonth(shiftMonth(state.month, 1)); }));
      return bar;
    }

    /** The shape of the answer, drawn while it is being read. Six weeks of cells,
     *  which is the most any month spans, so nothing below it moves when the real
     *  grid arrives. */
    function skeleton() {
      var panel = el('div', { class: 'rawr-b-panel' });
      panel.appendChild(monthBar());
      var grid = el('div', { class: 'rawr-b-grid', 'aria-hidden': 'true' });
      for (var d = 0; d < 7; d++) grid.appendChild(el('div', { class: 'rawr-b-dow' }, DOW[d]));
      for (var i = 0; i < 42; i++) grid.appendChild(el('span', { class: 'rawr-b-skel' }));
      panel.appendChild(grid);
      panel.appendChild(el('p', { class: 'rawr-b-hint', role: 'status' }, COPY.loading));
      return panel;
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
        state.busy ? COPY.booking : 'Confirm ' + data.durationMinutes + ' minutes');
      if (state.busy) {
        submit.setAttribute('disabled', 'disabled');
        submit.setAttribute('aria-busy', 'true');
      }
      form.appendChild(submit);

      // The countdown lives here and is written by tickHold, which finds it by
      // class. Empty until there is something to say, and it is one line either
      // way so nothing moves when the words arrive.
      var held = el('p', { class: 'rawr-b-hold rawr-b-hint', role: 'status' },
        state.holdExpired ? COPY.holdExpired : '');
      if (state.holdExpired) held.setAttribute('data-bad', '');
      form.appendChild(held);

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

    // A phone that slept through the hold wakes with the countdown stale, so it is
    // re-read on the way back rather than waiting for the next tick.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tickHold(); });

    setInterval(tickHold, 1000);

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
