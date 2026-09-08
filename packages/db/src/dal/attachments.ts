import { and, desc, eq } from 'drizzle-orm'
import { randomToken } from '../internal/crypto.ts'
import { attachment } from '../schema/records.ts'
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
    .replace(/[^\w.\-]+/g, '-')
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
