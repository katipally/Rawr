import { errorCsv, readImportRun } from '@rawr/db'
import { NextResponse } from 'next/server'
import { contextFrom, readSession } from '~/server/session.ts'

/** The failed rows, with every original column, so the person fixes them in the
 *  same spreadsheet and uploads just those. A8. */
export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ workspace: string; id: string }> },
): Promise<Response> => {
  const session = await readSession()
  if (!session) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const { workspace, id } = await params
  if (workspace !== session.workspaceSlug) {
    return NextResponse.json({ error: 'That import belongs to another workspace.' }, { status: 403 })
  }

  const run = await readImportRun(contextFrom(session), id)
  if (!run) return NextResponse.json({ error: 'That import does not exist.' }, { status: 404 })
  if (run.errors.length === 0) {
    return NextResponse.json({ error: 'Every row in that import was accepted.' }, { status: 404 })
  }

  return new Response(errorCsv(run.errors), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${run.filename.replace(/\.[^.]+$/, '')}-errors.csv"`,
      'cache-control': 'no-store',
    },
  })
}
