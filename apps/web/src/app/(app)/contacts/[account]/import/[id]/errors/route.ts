import { importErrorCsv, readImportRun } from '@rawr/db'
import { NextResponse } from 'next/server'
import { contextFrom, readSession } from '~/server/session.ts'

/** Every refused row, with every original column, so the person fixes them in the
 *  same spreadsheet and uploads just those. Streamed, however many there are. A8. */
export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ account: string; id: string }> },
): Promise<Response> => {
  const session = await readSession()
  if (!session) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const { account, id } = await params
  if (account !== session.accountSlug) {
    return NextResponse.json({ error: 'That import belongs to another account.' }, { status: 403 })
  }

  const ctx = contextFrom(session)
  const run = await readImportRun(ctx, id)
  if (!run) return NextResponse.json({ error: 'That import does not exist.' }, { status: 404 })
  if (run.errored === 0) {
    return NextResponse.json({ error: 'Every row in that import was accepted.' }, { status: 404 })
  }

  const rows = importErrorCsv(ctx, id)
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await rows.next()
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
    async cancel() {
      await rows.return(undefined as never)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${run.filename.replace(/\.[^.]+$/, '')}-errors.csv"`,
      'cache-control': 'no-store',
    },
  })
}
