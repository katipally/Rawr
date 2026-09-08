import { createImportRun, isObjectKey, type ImportKind } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { importsPath } from '~/lib/links.ts'
import { readSpreadsheet, SpreadsheetError } from '~/server/spreadsheet.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** Everything the picker offers that is not one of the three objects. */
const SHAPE_KINDS = new Set(['activities', 'properties', 'associations', 'lists', 'submissions'])

/** The upload is a form post rather than an RPC call: a 40MB body does not belong
 *  in a JSON envelope, and the browser's own progress is better than one we draw. */
export const POST = async (
  request: NextRequest,
  { params }: { params: Promise<{ account: string }> },
): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) return NextResponse.redirect(new URL('/sign-in', request.nextUrl.origin))

  const { account } = await params
  const back = (error: string) =>
    NextResponse.redirect(
      new URL(`${importsPath(account)}?error=${encodeURIComponent(error)}`, request.nextUrl.origin),
    )

  if (account !== session.accountSlug) return back('That import belongs to another account.')

  const form = await request.formData()
  const file = form.get('file')
  // Five of the six choices are kinds rather than objects. Notes land on the
  // timeline of the contact they name; properties, associations, lists and
  // submissions carry the shape around the records rather than columns on one.
  // Each still records "contact" as its object, because that is what its rows are
  // matched against.
  const what = String(form.get('object') ?? '')
  const kind = SHAPE_KINDS.has(what) ? (what as ImportKind) : ('records' as const)
  const objectKey = kind === 'records' ? what : 'contact'
  const source = String(form.get('source') ?? '') || null

  if (!(file instanceof File) || file.size === 0) return back('Pick a file to import.')
  if (!isObjectKey(objectKey)) return back(`"${what}" is not something Rawr can import into.`)

  const ctx = contextFrom(session)

  try {
    const sheet = await readSpreadsheet(file)

    const run = await createImportRun(ctx, {
      objectKey,
      kind,
      source,
      filename: file.name,
      headers: sheet.headers,
      rows: sheet.rows,
      // Filled from the suggestion the run itself works out, which knows the
      // preset for the export this file came from.
      mapping: {},
    })

    return NextResponse.redirect(new URL(importsPath(account, run.id), request.nextUrl.origin))
  } catch (cause) {
    if (cause instanceof SpreadsheetError) return back(cause.message)
    return back(cause instanceof Error ? cause.message : 'That file could not be read.')
  }
}
