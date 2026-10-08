/** A change this browser has made to one member, shown over the rows it was made
 *  against. `base` is the rows array itself: a refresh replaces that array, so the
 *  overlay stops applying the moment the server has sent its own rows back. */
export type Overlay<Row extends { userId: string }> = { base: readonly Row[]; patch: Partial<Row> }
export type Overlays<Row extends { userId: string }> = Record<string, Overlay<Row>>

/** Rows with each overlay that was made over these exact rows applied. O(rows). */
export const overlaid = <Row extends { userId: string }>(rows: readonly Row[], overlays: Overlays<Row>): Row[] =>
  rows.map((row) => {
    const overlay = overlays[row.userId]
    return overlay && overlay.base === rows ? { ...row, ...overlay.patch } : row
  })

/** A change made over the same rows as an earlier one for that member builds on it,
 *  so two saves in flight both stay on screen until the refresh lands. */
export const stage = <Row extends { userId: string }>(
  overlays: Overlays<Row>,
  rows: readonly Row[],
  userId: string,
  patch: Partial<Row>,
): Overlays<Row> => {
  const earlier = overlays[userId]
  const carried = earlier && earlier.base === rows ? earlier.patch : {}
  return { ...overlays, [userId]: { base: rows, patch: { ...carried, ...patch } } }
}

export const unstage = <Row extends { userId: string }>(overlays: Overlays<Row>, userId: string): Overlays<Row> => {
  const { [userId]: _dropped, ...rest } = overlays
  return rest
}
