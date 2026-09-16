import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
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

/** A file too big for one request, sent in parts.
 *
 *  An import's file is uploaded this way for two reasons that the attachment path
 *  does not have: it can be hundreds of megabytes, which is more than one request
 *  worker should hold in memory, and the browser tab may be closed half way
 *  through, which a numbered part can resume from and a single PUT cannot. */

export const beginMultipart = async (key: string, contentType: string): Promise<string> => {
  const started = await client().send(
    new CreateMultipartUploadCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }),
  )
  if (!started.UploadId) throw new Error('Storage did not start the upload.')
  return started.UploadId
}

/** One part, by number. The tag storage answers with is what
 *  `completeMultipart` hands back to it, and storage refuses an assembly whose
 *  tags do not match what it holds. */
export const uploadPart = async (
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<string> => {
  const done = await client().send(
    new UploadPartCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.byteLength,
    }),
  )
  if (!done.ETag) throw new Error('Storage did not acknowledge that part.')
  return done.ETag
}

export const completeMultipart = async (
  key: string,
  uploadId: string,
  parts: { n: number; etag: string }[],
): Promise<void> => {
  await client().send(
    new CompleteMultipartUploadCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        // Storage requires them ascending, and the caller holds them in whatever
        // order they were acknowledged.
        Parts: [...parts]
          .sort((a, b) => a.n - b.n)
          .map((part) => ({ PartNumber: part.n, ETag: part.etag })),
      },
    }),
  )
}

/** Abandons the parts. Without this a stopped upload leaves them billed and
 *  invisible: an incomplete multipart upload is not an object, so it does not
 *  show in a listing and is never cleaned up on its own. */
export const abortMultipart = async (key: string, uploadId: string): Promise<void> => {
  await client().send(new AbortMultipartUploadCommand({ Bucket: env.S3_BUCKET, Key: key, UploadId: uploadId }))
}

/** The object as a stream, so a file is read in the memory of one chunk however
 *  big it is. */
export const objectStream = async (key: string): Promise<ReadableStream<Uint8Array>> => {
  const got = await client().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
  const body = got.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined
  if (!body?.transformToWebStream) throw new Error('Storage returned nothing for that file.')
  return body.transformToWebStream()
}
