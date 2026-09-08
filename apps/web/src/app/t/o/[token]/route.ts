import { isBot, publicEdgeContext, recordOpen, sendAccountForToken } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { inBackground } from '~/server/background.ts'
import { clientIp, rateLimit } from '~/server/edge.ts'

/** The open pixel.
 *
 *  A 1x1 GIF, always, whatever happened behind it: a broken image in somebody's
 *  mail would tell the recipient they are being tracked, and a slow one would
 *  hold their client open. The recording happens after the response.
 *
 *  Apple Mail Privacy Protection fetches every pixel on the recipient's behalf, so
 *  an open here is weaker evidence than it looks. The user agent is kept for
 *  exactly that reason: it is the only thing that separates the two.
 *
 *  The bot filter is the collector's, which suits this less well than it suits a
 *  page view: it treats a missing user agent as a machine, and a mail client that
 *  sends none would go uncounted. That is the safer way round, because the fetches
 *  with no agent at all are overwhelmingly security scanners opening every link in
 *  every mail, and counting those as opens would make the number meaningless. */

// The smallest transparent GIF there is.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const image = (): NextResponse =>
  new NextResponse(PIXEL as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'image/gif',
      'content-length': String(PIXEL.length),
      // Never cached, or the second open is invisible.
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
    },
  })

export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> => {
  const { token } = await params
  const agent = request.headers.get('user-agent')

  // A crawler following a link out of an archived mail is not an open.
  if (isBot(agent)) return image()
  if (!rateLimit(`open:${clientIp(request) ?? 'unknown'}`, 120, 60).allowed) return image()

  inBackground('sequence open', async () => {
    const accountId = await sendAccountForToken(token)
    if (!accountId) return
    await recordOpen({ ...publicEdgeContext(accountId), actorKind: 'public' }, token, { userAgent: agent })
  })

  return image()
}
