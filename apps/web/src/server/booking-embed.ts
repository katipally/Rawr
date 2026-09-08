/** The browser half of F2 §7, served as one file from /booking.js.
 *
 *  No framework, no bundler, no dependencies. It runs inside Webflow's page, so
 *  every byte and every global belongs to somebody else's budget. Everything is
 *  inside one IIFE and the only global is window.rawrBooking.
 *
 *  It renders the hosted booking page in a frame rather than rebuilding the widget
 *  here. That is the whole point: there is one booking widget, and a fix to it
 *  reaches the embed on the next page load instead of waiting for a second
 *  implementation to be updated to match. The frame reports its height outwards and
 *  this sets it, so the embed still grows and shrinks with the widget inside it.
 *
 *  Two failure rules, in order of how often they bite: the script not loading at all
 *  leaves the <noscript> link to the hosted page, and a frame that never reports a
 *  height keeps the sensible default it was given.
 *
 *  Written as a template string rather than a .js file so the endpoint paths are
 *  shared with the server that defines them; a rename becomes a compile error
 *  instead of a silently broken embed. */

export type BookingEmbedConfig = {
  baseUrl: string
}

export const buildBookingEmbed = (config: BookingEmbedConfig): string =>
  `/* Rawr booking embed. */
(function () {
  'use strict';
  if (window.rawrBooking && window.rawrBooking.loaded) return;

  var BASE = ${JSON.stringify(config.baseUrl)};
  var frames = [];

  function zone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  function fallbackLink(mount, address) {
    var link = document.createElement('a');
    link.href = BASE + '/b/' + address;
    link.textContent = 'Book a meeting';
    link.rel = 'noopener';
    mount.appendChild(link);
  }

  function mountOne(mount) {
    var address = (mount.getAttribute('data-rawr-booking') || '').replace(/^\\/+|\\/+$/g, '');
    if (!address) return;

    var url = BASE + '/b/' + address + '?embed=1';
    var tz = mount.getAttribute('data-rawr-tz') || zone();
    if (tz) url += '&tz=' + encodeURIComponent(tz);

    var frame = document.createElement('iframe');
    frame.src = url;
    frame.title = mount.getAttribute('data-rawr-title') || 'Book a meeting';
    frame.loading = 'lazy';
    frame.style.width = '100%';
    frame.style.border = '0';
    frame.style.display = 'block';
    // Tall enough for the widget's usual first paint, so the page does not jump
    // once the real height arrives.
    frame.style.height = '620px';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('allow', 'clipboard-write');

    frame.onerror = function () {
      mount.removeChild(frame);
      fallbackLink(mount, address);
    };

    mount.appendChild(frame);
    frames.push(frame);
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== 'rawr-booking' || data.type !== 'height') return;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source && data.height > 0) {
        frames[i].style.height = Math.ceil(data.height) + 'px';
      }
    }
  });

  function mountAll() {
    var mounts = document.querySelectorAll('[data-rawr-booking]');
    for (var i = 0; i < mounts.length; i++) {
      if (mounts[i].getAttribute('data-rawr-mounted')) continue;
      mounts[i].setAttribute('data-rawr-mounted', '1');
      try { mountOne(mounts[i]); }
      catch (e) { fallbackLink(mounts[i], mounts[i].getAttribute('data-rawr-booking') || ''); }
    }
  }

  window.rawrBooking = { loaded: true, mount: mountAll };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }
})();
`
