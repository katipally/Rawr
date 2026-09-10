import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '~/lib/env.ts'

/** Object storage over the S3 protocol, so the host is an endpoint rather than a
 *  rewrite: Supabase, R2, MinIO, S3 and B2 all speak it.
 *
 *  Reads never pass through this app: a link is signed per click and expires, so
 *  the bucket is never public and a forty megabyte PDF is fetched by the browser
 *  from storage directly.
 *
 *  Writes do pass through, because the browser cannot reach storage: this app's
 *  content security policy allows connections to its own origin only, so a PUT
 *  from a page to a bucket on another host never leaves the browser. See
 *  server/uploads.ts. */

export const storageConfigured = Boolean(
  env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET,
)

export const NOT_CONFIGURED =
  'File storage is not connected. Set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET, and create the bucket.'

let opened: S3Client | null = null

/** Path style, because every S3 host but AWS itself addresses buckets that way,
 *  and a virtual-host URL against MinIO or Supabase resolves to nothing. */
const client = (): S3Client => {
  if (!storageConfigured) throw new Error(NOT_CONFIGURED)
  opened ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    // The presigner signs a command with no body, so the SDK would put a CRC32 of
    // zero bytes in the URL and storage would reject the browser's real upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  })
  return opened
}

/** A link that stops working. Short, because a long-lived one is a public file
 *  with extra steps. */
export const signedDownload = async (
  key: string,
  seconds = 120,
  filename?: string,
): Promise<string> =>
  getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      // Saves under the name somebody uploaded rather than the random key segment.
      ...(filename ? { ResponseContentDisposition: contentDisposition(filename) } : {}),
    }),
    { expiresIn: seconds },
  )

/** The bytes, forwarded. Length is given rather than discovered so storage can
 *  refuse a truncated upload instead of keeping one. */
export const putObject = async (key: string, body: Uint8Array, contentType: string): Promise<void> => {
  await client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
    }),
  )
}

export const removeObject = async (key: string): Promise<void> => {
  await client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
}

/** RFC 5987, so a name with a quote, a comma or an accent cannot break out of the
 *  header or arrive mangled. */
const contentDisposition = (filename: string): string =>
  `attachment; filename="${filename.replaceAll(/["\\\r\n]/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
