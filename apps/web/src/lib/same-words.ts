/** Whether somebody typed back the name they were shown.
 *
 *  A delete that asks for the record's name has to compare what is on screen, not
 *  what is in the column. A name carrying a tab renders as a space, so a person
 *  copying what they can see is refused by an exact comparison and the record
 *  becomes undeletable through the UI. Runs of whitespace are one space on both
 *  sides, which is what the browser drew.
 *
 *  Case still matters: this is the confirmation for an irreversible act, and
 *  reading the name is the point of asking. */
export const sameWords = (typed: string, shown: string): boolean =>
  typed.replace(/\s+/g, ' ').trim() === shown.replace(/\s+/g, ' ').trim()
