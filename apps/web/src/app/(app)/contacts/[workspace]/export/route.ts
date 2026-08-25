import { exportCsv, isObjectKey, parseFilters, parseSorts } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { contextFrom, readSession } from '~/server/session.ts'

/** Streamed, not buffered: a 50,000-row export never holds 50,000 rows in memory,
 *  and the browser starts saving as soon as the first page is ready. A8. */
export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ workspace: string }> },
): Promise<Response> => {
  const session = await readSession()
  if (!session) return NextResponse.json({ error: 'Sign in to export.' }, { status: 401 })

  const { workspace } = await params
  if (workspace !== session.workspaceSlug) {
    return NextResponse.json({ error: 'That export belongs to another workspace.' }, { status: 403 })
  }

  const search = request.nextUrl.searchParams
  const object = search.get('object') ?? ''
  if (!isObjectKey(object)) {
    return NextResponse.json({ error: `"${object}" is not an object.` }, { status: 400 })
  }

  const columns = (search.get('columns') ?? '').split(',').filter(Boolean)
  const sortParam = search.get('sort')
  const sorts = sortParam
    ? parseSorts([
        sortParam.startsWith('-')
          ? { key: sortParam.slice(1), direction: 'desc' }
          : { key: sortParam, direction: 'asc' },
      ])
    : []

  let filters: ReturnType<typeof parseFilters> = []
  try {
    filters = parseFilters(JSON.parse(search.get('filters') ?? '[]'))
  } catch {
    // A hand-edited filter string in a URL is not a reason to refuse the export.
    filters = []
  }

  const ctx = contextFrom(session)
  const encoder = new TextEncoder()

  let rows
  try {
    rows = exportCsv(ctx, { objectKey: object, columns, filters, sorts, search: search.get('q') ?? '' })
    // Pull the header eagerly so a bad column set fails as a real message rather
    // than as a truncated download.
    var first = await rows.next()
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 400 },
    )
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first && !first.done) {
        controller.enqueue(encoder.encode(first.value))
        first = undefined as never
        return
      }
      const next = await rows.next()
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
  })

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${object}-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
