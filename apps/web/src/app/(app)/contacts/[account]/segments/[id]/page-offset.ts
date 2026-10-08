/** The first row of the last page that still has rows, so a page emptied by
 *  removals steps back onto the one before it. */
export const lastPageStart = (total: number, perPage: number) => Math.max(0, Math.floor((total - 1) / perPage) * perPage)
