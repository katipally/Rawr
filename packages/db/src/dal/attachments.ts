import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm'
import { randomToken } from '../internal/crypto.ts'
import { attachment, attachmentUpload } from '../schema/records.ts'
import type { AccountContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import type { EntityType } from './activity.ts'
import { mutate, withAccount } from './index.ts'

/** Files on records. The rows only: where the bytes go is the app's business,
 *  because it is the half that talks to a storage service over HTTP and this
 *  package talks to Postgres.
 *
 *  The order matters and is the reason these are two calls rather than one. A
 *  row is written only after the bytes are known to have landed, so a failed
 *  upload leaves nothing on the record. The opposite order leaves a filename
 *  somebody can click and nothing behind it. */

export type AttachmentRow = {
  id: string
  entityType: EntityType
  entityId: string
  storageKey: string
  filename: string
  bytes: number
  mime: string
  uploadedBy: string | null
  at: Date
}

/** Bigger than this is not a document somebody is filing against a deal, and
 *  every storage service bills for what it holds. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** A filename is user text that becomes part of a path and a Content-Disposition
 *  header. Slashes would climb out of the account's prefix, and control
 *  characters would split the header, so neither survives. The name shown on the
 *  record is the original; this is only what goes in the key. */
const slug = (filename: string): string =>
  filename
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'file'

/** Where the bytes go.
 *
 *  The account is the first segment, so one tenant's files are never under
 *  another's prefix even if a bucket is ever shared or a policy misconfigured —
 *  belt and braces beside the row level security on the row.
 *
 *  A random segment before the name, so two people uploading contract.pdf to the
 *  same deal get two files rather than one overwriting the other, and so a key
 *  cannot be guessed from a record id somebody already knows. */
export const storageKeyFor = (
  ctx: AccountContext,
  input: { entityType: EntityType; entityId: string; filename: string },
): string => `${ctx.accountId}/${input.entityType}/${input.entityId}/${randomToken(9)}/${slug(input.filename)}`

/** Long enough for a 25 MB file on a slow line, short enough that a key nobody
 *  filed stops being writable the same hour. */
const UPLOAD_WINDOW_MS = 60 * 60 * 1000

/** Names where the bytes will go, and records that this person may send them
 *  there. Everything refusable is refused here, before a byte moves.
 *
 *  Expired rows are swept on the way in, so the table stays the size of one
 *  hour's uploads without a job to clear it. */
export const beginAttachment = async (
  ctx: AccountContext,
  input: { entityType: EntityType; entityId: string; filename: string; bytes: number },
): Promise<{ storageKey: string }> => {
  assertCanAttach(ctx, input.bytes)
  if (!ctx.actorId) throw new Error('Sign in to attach a file.')
  const userId = ctx.actorId
  const storageKey = storageKeyFor(ctx, input)
  await withAccount(ctx, async (tx) => {
    await tx.delete(attachmentUpload).where(lt(attachmentUpload.expiresAt, new Date()))
    await tx.insert(attachmentUpload).values({
      accountId: ctx.accountId,
      userId,
      storageKey,
      bytes: input.bytes,
      expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS),
    })
  })
  return { storageKey }
}

/** The size this person was cleared to send to this key, or null when the key
 *  was never begun by them, has expired, or has already been filed. */
export const beganUploadBytes = async (ctx: AccountContext, storageKey: string): Promise<number | null> => {
  const userId = ctx.actorId
  if (!userId) return null
  return withAccount(ctx, async (tx) => {
    const [row] = await tx
      .select({ bytes: attachmentUpload.bytes })
      .from(attachmentUpload)
      .where(
        and(
          eq(attachmentUpload.storageKey, storageKey),
          eq(attachmentUpload.userId, userId),
          gt(attachmentUpload.expiresAt, new Date()),
        ),
      )
      .limit(1)
    return row?.bytes ?? null
  })
}

export const listAttachments = async (
  ctx: AccountContext,
  input: { entityType: EntityType; entityId: string },
): Promise<AttachmentRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(attachment)
      .where(and(eq(attachment.entityType, input.entityType), eq(attachment.entityId, input.entityId)))
      .orderBy(desc(attachment.at))
    return rows.map((row) => ({
      id: row.id,
      entityType: row.entityType as EntityType,
      entityId: row.entityId,
      storageKey: row.storageKey,
      filename: row.filename,
      bytes: Number(row.bytes),
      mime: row.mime,
      uploadedBy: row.uploadedBy,
      at: row.at,
    }))
  })

/** Refuses before anything is uploaded, so a person is told the file is too big
 *  while they are still looking at the dialog rather than after the wait. */
export const assertCanAttach = (ctx: AccountContext, bytes: number): void => {
  assertCanWrite(ctx, 'attachment')
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('That file is empty.')
  if (bytes > MAX_ATTACHMENT_BYTES) {
    // One decimal, and rounded up. Rounding to whole megabytes made a file one
    // byte over the limit report "that file is 25 MB, the limit is 25 MB".
    const mb = Math.ceil((bytes / 1024 / 1024) * 10) / 10
    throw new Error(
      `That file is ${mb} MB. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB — link to it instead.`,
    )
  }
}

/** A file for a message written by hand. Filed under the sender, so the key says
 *  whose upload it is, and the send can refuse anybody else's. */
export const beginMailAttachment = async (
  ctx: AccountContext,
  input: { filename: string; bytes: number },
): Promise<{ storageKey: string }> => {
  if (!ctx.actorId) throw new Error('Sign in to attach a file.')
  return beginAttachment(ctx, { ...input, entityType: 'mail', entityId: ctx.actorId })
}

/** The sizes of the uploads a message is sent with, read from the rows and not
 *  from the request. Refuses a key this person did not begin, one that has
 *  expired, and one listed twice. */
export type MailFile = { storageKey: string; filename: string; mime: string }

export const claimMailAttachments = async (
  ctx: AccountContext,
  files: MailFile[],
): Promise<(MailFile & { bytes: number })[]> => {
  const userId = ctx.actorId
  if (!userId) throw new Error('Sign in to attach a file.')
  const keys = files.map((file) => file.storageKey)
  if (keys.some((key) => !key.startsWith(`${ctx.accountId}/`))) {
    throw new Error('That file does not belong to this account.')
  }
  if (new Set(keys).size !== keys.length) throw new Error('The same file is attached twice.')
  if (keys.length === 0) return []

  const rows = await withAccount(ctx, (tx) =>
    tx
      .select({ storageKey: attachmentUpload.storageKey, bytes: attachmentUpload.bytes })
      .from(attachmentUpload)
      .where(
        and(
          inArray(attachmentUpload.storageKey, keys),
          eq(attachmentUpload.userId, userId),
          gt(attachmentUpload.expiresAt, new Date()),
        ),
      ),
  )
  const sizes = new Map(rows.map((row) => [row.storageKey, Number(row.bytes)]))
  return files.map((file) => {
    const bytes = sizes.get(file.storageKey)
    if (bytes === undefined) {
      throw new Error(`${file.filename} was not uploaded, or its upload has expired. Remove it and attach it again.`)
    }
    return { ...file, bytes }
  })
}

/** Once a message has gone, or a file is taken off the composer, its upload is spent
 *  and the key cannot be sent again. Returns how many of this person's uploads it was,
 *  so a caller can tell whether there were any bytes to remove. */
export const finishMailAttachments = async (ctx: AccountContext, keys: string[]): Promise<number> => {
  const userId = ctx.actorId
  if (!userId || keys.length === 0) return 0
  const gone = await withAccount(ctx, (tx) =>
    tx
      .delete(attachmentUpload)
      .where(and(inArray(attachmentUpload.storageKey, keys), eq(attachmentUpload.userId, userId)))
      .returning({ storageKey: attachmentUpload.storageKey }),
  )
  return gone.length
}

/** Written after the bytes have landed, never before. */
export const recordAttachment = async (
  ctx: AccountContext,
  input: {
    entityType: EntityType
    entityId: string
    storageKey: string
    filename: string
    bytes: number
    mime: string
  },
): Promise<{ id: string }> =>
  mutate(ctx, 'attachment', async (tx) => {
    assertCanAttach(ctx, input.bytes)
    const [created] = await tx
      .insert(attachment)
      .values({
        accountId: ctx.accountId,
        entityType: input.entityType,
        entityId: input.entityId,
        storageKey: input.storageKey,
        filename: input.filename.slice(0, 255),
        bytes: input.bytes,
        mime: input.mime.slice(0, 120),
        uploadedBy: ctx.actorId,
      })
      .returning({ id: attachment.id })
    if (!created) throw new Error('The file could not be recorded.')
    await tx.delete(attachmentUpload).where(eq(attachmentUpload.storageKey, input.storageKey))
    return {
      result: { id: created.id },
      audit: {
        entity: 'attachment',
        entityId: created.id,
        action: 'create',
        before: null,
        after: { filename: input.filename, bytes: input.bytes, on: `${input.entityType}/${input.entityId}` },
      },
    }
  })

/** Returns the key so the caller can delete the bytes too. The row goes first:
 *  a row pointing at nothing is a broken link on a record, and bytes with no row
 *  are invisible and cost pennies. Of the two ways to fail, this is the better. */
export const removeAttachment = async (ctx: AccountContext, id: string): Promise<{ storageKey: string }> =>
  mutate(ctx, 'attachment', async (tx) => {
    const [before] = await tx.select().from(attachment).where(eq(attachment.id, id)).limit(1)
    if (!before) throw new Error('That file is already gone.')
    await tx.delete(attachment).where(eq(attachment.id, id))
    return {
      result: { storageKey: before.storageKey },
      audit: { entity: 'attachment', entityId: id, action: 'delete', before: { filename: before.filename }, after: null },
    }
  })

/** One row, for the read path: a signed link is issued for a key, and the key has
 *  to be shown to belong to this account before one is. */
export const readAttachment = async (ctx: AccountContext, id: string): Promise<AttachmentRow | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.select().from(attachment).where(eq(attachment.id, id)).limit(1)
    return row
      ? {
          id: row.id,
          entityType: row.entityType as EntityType,
          entityId: row.entityId,
          storageKey: row.storageKey,
          filename: row.filename,
          bytes: Number(row.bytes),
          mime: row.mime,
          uploadedBy: row.uploadedBy,
          at: row.at,
        }
      : null
  })
