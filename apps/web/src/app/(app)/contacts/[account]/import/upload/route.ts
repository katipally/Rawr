import { createImportRun, isObjectKey, type ImportKind } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { importsPath } from '~/lib/links.ts'
import { MAX_BYTES, readSpreadsheet, SpreadsheetError } from '~/server/spreadsheet.ts'
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
  if (!session) return NextResponse.redirect(new URL('/sign-in', env.AUTH_URL), 303)

  const { account } = await params
  // 303 on every path out of here, against the public origin.
  //
  // Two things go wrong otherwise, and they hide each other. Next defaults a
  // redirect to 307, which keeps the method, so the browser re-posts the upload to
  // a page that only answers GET. And `request.nextUrl.origin` inside a container
  // is the address the server bound to, so the Location read
  // `https://0.0.0.0:10000/...` and the navigation died on a host that does not
  // exist. Either one alone leaves the person staring at the form they just sent.
  const back = (error: string) =>
    NextResponse.redirect(
      new URL(`${importsPath(account)}?error=${encodeURIComponent(error)}`, env.AUTH_URL),
      303,
    )

  if (account !== session.accountSlug) return back('That import belongs to another account.')

  // Before the body is read, not after: parsing a 200MB multipart body to find
  // out it is too big is the work the cap exists to avoid, and the browser has
  // already spent the upload either way. Content-Length is the client's claim,
  // so the row and byte caps inside the parser still stand behind it.
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return back(
      `That upload is ${(declared / 1024 / 1024).toFixed(1)}MB and the limit is ${MAX_BYTES / 1024 / 1024}MB. Split it and import the parts.`,
    )
  }

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

    return NextResponse.redirect(new URL(importsPath(account, run.id), env.AUTH_URL), 303)
  } catch (cause) {
    if (cause instanceof SpreadsheetError) return back(cause.message)
    return back(cause instanceof Error ? cause.message : 'That file could not be read.')
  }
}
