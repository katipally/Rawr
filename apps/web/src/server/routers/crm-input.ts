import { z } from 'zod'

/** Any object in the account, including one an admin invented. The registry is
 *  what decides whether it exists — this only proves the string is shaped like a
 *  key, because it reaches SQL as an alias and appears in a URL. */
export const anyObject = z.string().regex(/^[a-z][a-z0-9_]{1,58}$/, 'That is not an object.')

/** Values arrive as whatever a form produced. The registry decides what each one
 *  has to be, so there is nothing to validate here beyond the shape and the size. */
export const recordValues = z.record(z.string().max(64), z.unknown())

/** Either stamp is optional on its own. The editor sends the value each edited
 *  field held when it was read, and a caller that has only the record's version
 *  sends that instead. A write is refused as stale when either one is sent and no longer holds. */
export const recordUpdateInput = z.object({
  object: anyObject,
  id: z.uuid(),
  values: recordValues,
  expectedUpdatedAt: z.coerce.date({ error: 'That is not a date.' }).optional(),
  /** Checked per field instead of the record stamp, so a change to another field is fine. */
  expectedValues: recordValues.optional(),
})
