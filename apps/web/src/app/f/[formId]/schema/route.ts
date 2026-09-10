import { publicFormById } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { themeCss } from '~/lib/embed-themes.ts'
import { CORS_HEADERS, rateLimit, clientIp } from '~/server/edge.ts'

/** GET /f/:formId/schema — what the embed needs to paint the form.
 *
 *  Returns the questions and nothing else. No submissions, no counts, no
 *  account name, no settings a visitor has no business seeing: the success
 *  message is the only one, because the browser has to render it. */

export const OPTIONS = (): NextResponse =>
  new NextResponse(null, { status: 204, headers: { ...CORS_HEADERS, 'access-control-allow-methods': 'GET, OPTIONS' } })

export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ formId: string }> },
): Promise<NextResponse> => {
  const { formId } = await params

  // Cheap, but still limited: an unauthenticated read loop against the database
  // is worth shedding even when the answer is small.
  const limit = rateLimit(`schema:${clientIp(request) ?? 'unknown'}`, 60, 60)
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Too many requests.' }, {
      status: 429,
      headers: { ...CORS_HEADERS, 'retry-after': String(limit.retryAfterSeconds) },
    })
  }

  const form = await publicFormById(formId)
  if (!form || !form.isActive) {
    return NextResponse.json({ error: 'That form is not available.' }, { status: 404, headers: CORS_HEADERS })
  }

  return NextResponse.json(
    {
      name: form.name,
      fields: form.fields,
      // Conditional logic on the properties the answers become. The submit path
      // re-runs these, so this is only so a visitor is not asked a question the
      // rule would have discarded the answer to.
      rules: form.rules,
      settings: {
        submitLabel: form.settings.submitLabel,
        steps: form.settings.steps ?? null,
      },
      // Resolved here rather than shipped as a preset name, so the embed carries
      // no table of looks and a preset the marketer has changed since renders as
      // what they actually chose.
      theme: themeCss(form.settings.theme),
    },
    {
      headers: {
        ...CORS_HEADERS,
        // A form definition changes rarely and a stale one for a minute is
        // harmless: the server revalidates every answer regardless of what the
        // browser was told to render.
        'cache-control': 'public, max-age=60, stale-while-revalidate=600',
      },
    },
  )
}
