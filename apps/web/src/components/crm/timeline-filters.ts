/** The people a timeline filter names, read from the `who` parameter. Ids that are
 *  not on this record's timeline are dropped, so a pasted link cannot filter to nobody. */
export const authorsFromParam = (param: string | null, peopleIds: string[]): string[] =>
  (param ?? '').split(',').filter((id) => peopleIds.includes(id))

/** The address with the type and person filters set to these values. Empty values
 *  are removed rather than written, so a cleared filter leaves no trace in the link. */
export const withFilters = (search: string, types: string[], authors: string[]): string => {
  const next = new URLSearchParams(search)
  if (types.length === 0) next.delete('type')
  else next.set('type', types.join(','))
  if (authors.length === 0) next.delete('who')
  else next.set('who', authors.join(','))
  return next.toString()
}

export const assignedChipLabel = (authors: string[], labelOf: (id: string) => string | undefined, count: (n: number) => string): string => {
  if (authors.length === 1) return `Assigned to ${labelOf(authors[0] ?? '') ?? ''}`
  if (authors.length > 1) return `Assigned to (${count(authors.length)})`
  return 'Assigned to'
}

export const searchEmptyHint = (hasOlder: boolean): string =>
  hasOlder ? 'Only what is loaded is searched. Load older entries to search further back.' : 'Nothing on this record matches that search.'
