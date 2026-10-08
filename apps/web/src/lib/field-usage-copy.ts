/** `shown` is the count already formatted for the viewer's locale; `count` picks the grammar. */
const recordsOf = (count: number, shown: string): string => `${shown} record${count === 1 ? '' : 's'}`

/** What archiving a property tells the admin about the values it leaves in place. */
export const archiveUsageCopy = (count: number, shown: string): string =>
  count === 0
    ? 'No record holds a value for it.'
    : `${recordsOf(count, shown)} ${count === 1 ? 'holds' : 'hold'} a value, and ${count === 1 ? 'that value stays' : 'every one of those values stays'} exactly where it is.`

export const purgeResultCopy = (count: number, shown: string): string =>
  `${recordsOf(count, shown)} had the value stripped.`

/** What archiving a property that something else reads leaves behind. `shown` is the
 *  count already formatted for the viewer's locale, as in the record copy above. */
export const dependantsCopy = (count: number, shown: string): string =>
  `${shown} ${count === 1 ? 'place reads' : 'places read'} this property. Archiving it leaves ${count === 1 ? 'that place' : 'those places'} pointing at nothing.`
