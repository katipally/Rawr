import type { ImportKind } from '@rawr/db'

/** What each of the five shape files is for, in the picker's own words. The
 *  columns beside them are read off the shapes themselves. */
export const SHAPE_LABEL: Record<Exclude<ImportKind, 'records'>, { label: string; what: string }> = {
  activities: {
    label: 'Notes and logged emails',
    what: 'Timeline entries against records that already exist. Nothing here creates a contact.',
  },
  properties: {
    label: 'Property definitions',
    what: 'The fields records go into. Import this first: a column cannot arrive before the field it fills.',
  },
  associations: {
    label: 'Deal contacts and companies',
    what: 'Who is on which deal. A record export carries a contact’s company and nothing else.',
  },
  lists: {
    label: 'List memberships',
    what: 'One row per person per list. Each list arrives as a snapshot of the people the file names.',
  },
  submissions: {
    label: 'Form submissions',
    what: 'Submission history, so the forms report is not empty and a timeline does not start at the cutover.',
  },
}
