/** The keys with the one at `index` moved `by` places. The same array comes back
 *  when that runs off either end, so a caller can tell that nothing moved. O(keys). */
export const moveKey = (keys: string[], index: number, by: number): string[] => {
  const to = index + by
  if (to < 0 || to >= keys.length) return keys
  const next = [...keys]
  const [moved] = next.splice(index, 1)
  next.splice(to, 0, moved!)
  return next
}
