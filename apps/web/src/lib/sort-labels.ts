const DATES = new Set(['date', 'datetime'])
const NUMBERS = new Set(['number', 'currency', 'percent', 'rating'])

/** Words for the two directions of a sort on a property of this type. "A to Z"
 *  is the order a text column reads in; a date's ascending is "Oldest first". */
export const sortWords = (type: string): { asc: string; desc: string } =>
  DATES.has(type)
    ? { asc: 'Oldest first', desc: 'Most recent' }
    : NUMBERS.has(type)
      ? { asc: 'Low to high', desc: 'High to low' }
      : { asc: 'A to Z', desc: 'Z to A' }

/** The first direction a property is sorted in when no sort is set yet: text
 *  starts A to Z, a date or a number starts at the newest or the largest. */
export const firstDirection = (type: string): 'asc' | 'desc' => (DATES.has(type) || NUMBERS.has(type) ? 'desc' : 'asc')
