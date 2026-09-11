import type { FieldType } from './types.ts'

/** A column with no field to go into, and the property that would be made for it.
 *  A HubSpot contact export carries three hundred and seventy-two columns; asking
 *  somebody to create the sixty-eight this account has never seen, one modal at a
 *  time, before they can import anything, is the reason nobody finishes a
 *  migration. The mapper proposes them and the run makes them. */
export type NewProperty = {
  create: true
  key: string
  label: string
  type: FieldType
  options?: string[] | undefined
}

/** How long one choice may be, and how many a field may hold. The admin screens
 *  and the importer read the same two numbers, so a file cannot propose a field
 *  that the settings screen would refuse to save. */
export const MAX_OPTION_LENGTH = 120
export const MAX_CHOICES = 200

export const isNewProperty =(target: unknown): target is NewProperty =>
  typeof target === 'object' && target !== null && (target as NewProperty).create === true

/** csv header -> field key, a property to create for it, or null for a column the
 *  person chose to ignore. */
export type Mapping = Record<string, string | NewProperty | null>
