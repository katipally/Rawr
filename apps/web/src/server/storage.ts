import { env } from '~/lib/env.ts'

/** Object storage, over Supabase Storage's HTTP API.
 *
 *  No client library: three endpoints are needed and each is one fetch, so a
 *  dependency here would be more surface than the thing it wraps.
 *
 *  Nothing about a file passes through this app. The browser is handed a signed
 *  URL and uploads straight to storage, and reads are signed links that expire.
 *  A forty megabyte PDF never occupies a request worker, and the bucket is never
 *  public — which it would have to be if links did not expire. */

export const storageConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)

/** The one message anybody sees when it is not set up, naming what to set. */
export const NOT_CONFIGURED =
  'File storage is not connected. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and create the bucket named in SUPABASE_STORAGE_BUCKET.'

const base = (): string => `${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1`

/** The service key, which bypasses storage policies. It never leaves the server:
 *  what reaches the browser is a token scoped to one path and one operation. */
const headers = (): Record<string, string> => ({
  authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
})

const call = async (path: string, init: RequestInit): Promise<unknown> => {
  if (!storageConfigured) throw new Error(NOT_CONFIGURED)
  const response = await fetch(`${base()}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.text()
  if (!response.ok) {
    // Storage answers JSON with a message; a proxy in front of it may not, so
    // the raw body is the fallback rather than a generic failure.
    let detail = body.slice(0, 300)
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string }
      detail = parsed.message ?? parsed.error ?? detail
    } catch {
      // Not JSON. The text is what we have.
    }
    throw new Error(`Storage answered ${response.status}: ${detail}`)
  }
  return body ? JSON.parse(body) : null
}

/** A one-shot URL the browser PUTs the file to. Scoped to this exact key, so a
 *  token handed out for one record cannot be used to write over another. */
export const signedUpload = async (key: string): Promise<{ url: string }> => {
  const bucket = env.SUPABASE_STORAGE_BUCKET
  const result = (await call(`/object/upload/sign/${bucket}/${encodeKey(key)}`, {
    method: 'POST',
  })) as { url?: string }
  if (!result?.url) throw new Error('Storage did not return an upload URL.')
  return { url: `${base()}${result.url}` }
}

/** A link that stops working. Short, because it is handed out on a page load and
 *  a long-lived one is a public file with extra steps. */
export const signedDownload = async (
  key: string,
  seconds = 120,
  filename?: string,
): Promise<string> => {
  const bucket = env.SUPABASE_STORAGE_BUCKET
  const result = (await call(`/object/sign/${bucket}/${encodeKey(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: seconds }),
  })) as { signedURL?: string }
  if (!result?.signedURL) throw new Error('Storage did not return a link.')
  const url = new URL(`${base()}${result.signedURL}`)
  // Asks the browser to save it under the name somebody uploaded rather than the
  // random segment in the key.
  if (filename) url.searchParams.set('download', filename)
  return url.toString()
}

export const removeObject = async (key: string): Promise<void> => {
  const bucket = env.SUPABASE_STORAGE_BUCKET
  await call(`/object/${bucket}/${encodeKey(key)}`, { method: 'DELETE' })
}

/** Each segment escaped, the separators left alone: the key is a path, and
 *  encoding its slashes would make it one long filename. */
const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/')
