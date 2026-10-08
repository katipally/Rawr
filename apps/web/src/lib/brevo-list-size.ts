export type BrevoListSize = { subscribers: number; blacklisted: number }

/** One line under the list id field. `count` is the locale number formatter, so
 *  the thousands separator follows the viewer's format. */
export const brevoListLine = (
  listId: string,
  size: BrevoListSize,
  count: (value: number) => string,
): string =>
  `Brevo list ${listId} has ${count(size.subscribers)} ${size.subscribers === 1 ? 'contact' : 'contacts'}, ${count(size.blacklisted)} blocked in Brevo.`
