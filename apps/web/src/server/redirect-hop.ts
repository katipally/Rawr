import { webAddress } from '@rawr/db/forms'

/** Sending a browser to another origin after it posted a form.
 *
 *  The app's CSP says form-action 'self', and Chrome applies that to the redirect
 *  chain of a form post, so a 303 to another origin is refused and the person is
 *  left looking at the page they pressed the button on. A 200 page that then
 *  navigates by meta refresh is not a form submission, and no CSP directive
 *  governs it (navigate-to was removed from the spec and never shipped). The
 *  visible link is for a browser or a person that will not wait. */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** The address in its serialized form when it is an absolute http or https one.
 *  Anything else (javascript:, data:, a relative path) is not a hop: a link to it
 *  would run in this origin or go nowhere. */
export const hopHref = (target: string | URL): string | null => webAddress(String(target))

export const hopPage = (href: string): string => {
  const safe = escapeHtml(href)
  const host = escapeHtml(new URL(href).host)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>Returning to ${host}</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 20vh auto; padding: 0 1rem; overflow-wrap: anywhere">
<p>Returning to <strong>${host}</strong>.</p>
<p>If nothing happens, <a href="${safe}">continue</a>.</p>
</body>
</html>`
}

/** `Cache-Control: no-store` because the address can carry an authorization code. */
export const hopResponse = (target: string | URL): Response => {
  const href = hopHref(target)
  if (!href) throw new Error('Only an http or https address can be followed.')
  return new Response(hopPage(href), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}
