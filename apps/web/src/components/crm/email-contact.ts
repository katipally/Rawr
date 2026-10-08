/** A deal has no address of its own. Its Email action writes to the first linked
 *  contact that has one, the same contact the board card's mail button opens. */
export const emailContactOf = (
  groups: { objectKey: string; records: { id: string; email: string | null }[] }[],
): { id: string; email: string } | null => {
  const found = groups.find((group) => group.objectKey === 'contact')?.records.find((record) => record.email)
  return found?.email ? { id: found.id, email: found.email } : null
}
