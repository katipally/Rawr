import { NextResponse } from 'next/server'
import { env, publicBaseUrl } from '~/lib/env.ts'
import { CONSENT_COOKIE } from '~/server/consent.ts'
import { buildEmbedScript } from '~/server/embed-script.ts'
import { EMBED_STYLES } from '~/lib/embed-styles.ts'

/** GET /embed.js — the one file datasaur.ai loads.
 *
 *  Built per request rather than at build time because it carries the public base
 *  URL and the consent policy version, both of which are environment, not code.
 *  It is small and cached, so building it costs nothing measurable. */

export const GET = (): NextResponse => {
  const script = buildEmbedScript({
    baseUrl: publicBaseUrl,
    policyVersion: env.CONSENT_POLICY_VERSION,
    consentCookie: CONSENT_COOKIE,
    styles: EMBED_STYLES,
  })

  return new NextResponse(script, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Short, because the policy version is baked in and a consent policy change
      // has to reach every visitor within the hour, not whenever a CDN feels like
      // it. Revalidation is a conditional request, not a re-download.
      'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
      'access-control-allow-origin': '*',
    },
  })
}
