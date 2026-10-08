import { createHash } from 'node:crypto'

/** The wire rules a client can see from outside: which protocol versions answer,
 *  which key a retried write is recognised by, and how a tool's data is put into
 *  its text. Kept free of the tool catalogue so these rules can be tested alone. */

export const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const
export const LATEST = SUPPORTED[0]

/** The version the client asked for if we speak it, otherwise the newest we speak.
 *  A client that cannot speak that one is the one that disconnects, as the spec intends. */
export const negotiate = (asked: unknown): string =>
  typeof asked === 'string' && (SUPPORTED as readonly string[]).includes(asked) ? asked : LATEST

/** The client may send its own key; a client that does not gets one derived from
 *  who is calling, what, and with which arguments, so identical writes in the same
 *  minute collapse. The minute bound is the point: "add the same note twice" is a
 *  thing a person can legitimately mean an hour apart, which is why the ledger
 *  expires. */
export const idempotencyKey = (
  params: Record<string, unknown>,
  args: Record<string, unknown>,
  tokenId: string,
  tool: string,
  now: number,
): string => {
  const meta = params._meta as Record<string, unknown> | undefined
  const given = params.idempotencyKey ?? meta?.['io.modelcontextprotocol/idempotencyKey'] ?? args.idempotency_key
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, 200)
  const minute = Math.floor(now / 60_000)
  return createHash('sha256').update(JSON.stringify([tokenId, tool, canonicalJson(args), minute])).digest('hex')
}

/** Keys sorted at every depth, so the same arguments in another order are the same call. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)))
      : entry,
  )

const TEXT_DATA_LIMIT = 4000

/** The sentence first, then the data compact, so a model that reads only the text
 *  still has the fields. Cut at a fixed length so one large list cannot fill a context. */
export const withData = (text: string, data: unknown): string => {
  if (data === undefined) return text
  const json = JSON.stringify(data)
  return json.length <= TEXT_DATA_LIMIT
    ? `${text}\n${json}`
    : `${text}\n${json.slice(0, TEXT_DATA_LIMIT)}\n(truncated, see structuredContent)`
}

