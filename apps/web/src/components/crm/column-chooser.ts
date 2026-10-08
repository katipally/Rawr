/** A person's first and last name are two stored fields that the table shows as
 *  one Name column. The chooser lists them the same way: one row, keyed by
 *  first_name, that adds and removes both. */
const NAME_PARTS = ['first_name', 'last_name']

/** The rows the chooser shows for a set of columns. A last name that rides with a
 *  first name is not a row of its own. */
export const chooserRows = (keys: string[]): string[] =>
  keys.filter((key) => key !== 'last_name' || !keys.includes('first_name'))

/** The columns a set of chooser rows stands for. Naming the Name row means both parts. */
export const withNameParts = (keys: string[]): string[] => [
  ...new Set(keys.flatMap((key) => (key === 'first_name' ? NAME_PARTS : [key]))),
]
