/** Reading a file out of a request without trusting what the request says about
 *  it.
 *
 *  Both upload endpoints take the bytes themselves now. The browser cannot send
 *  them straight to storage: this app's content security policy allows
 *  connections to its own origin and to Turnstile, so a PUT to a bucket on
 *  another host is refused by the browser before it is made, and the failure a
 *  person sees is the word "Failed to fetch". Naming the bucket's host in the
 *  policy instead would put a value that changes per deployment into a header
 *  Next bakes at build time.
 *
 *  So the cost of an upload is one request worker for the length of it, and the
 *  cap is what keeps that bounded. */

/** Content-Length is a claim, so it is only ever used to refuse early. A body
 *  that under-declares is caught while it is being read. */
export const declaredTooLarge = (contentLength: string | null, cap: number): boolean => {
  const bytes = Number(contentLength)
  return Number.isFinite(bytes) && bytes > cap
}

/** The whole body, or null when it is over the cap.
 *
 *  Read in chunks and abandoned the moment the total passes the cap, rather than
 *  buffered first and measured after: a caller who declares one megabyte and
 *  sends a hundred would otherwise be handed a hundred megabytes of this
 *  process's memory before being refused. */
export const readCapped = async (request: Request, cap: number): Promise<Uint8Array | null> => {
  if (declaredTooLarge(request.headers.get('content-length'), cap)) return null

  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}
