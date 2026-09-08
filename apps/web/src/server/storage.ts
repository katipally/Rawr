import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '~/lib/env.ts'

/** Object storage over the S3 protocol, so the host is an endpoint rather than a
 *  rewrite: Supabase, R2, MinIO, S3 and B2 all speak it.
 *
 *  Nothing about a file passes through this app. The browser is handed a signed
 *  URL and uploads straight to storage, and reads are links that expire, so a
 *  forty megabyte PDF never occupies a request worker and the bucket is never
 *  public. */

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

/** A one-shot URL the browser PUTs to, scoped to this exact key, so a token for
 *  one record cannot write over another. Content type is left unsigned so the
 *  browser may send its own; storage keeps whatever arrives. */
export const signedUpload = async (key: string): Promise<{ url: string }> => {
  const url = await getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { expiresIn: 300 },
  )
  return { url }
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

export const removeObject = async (key: string): Promise<void> => {
  await client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
}

/** RFC 5987, so a name with a quote, a comma or an accent cannot break out of the
 *  header or arrive mangled. */
const contentDisposition = (filename: string): string =>
  `attachment; filename="${filename.replaceAll(/["\\\r\n]/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
