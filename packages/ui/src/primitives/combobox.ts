/** Which options a typed query keeps, and in what order. Pure so the ranking is
 *  testable and identical everywhere a combobox appears. */

export type Rankable = { label: string; hint?: string | undefined; keywords?: string[] | undefined }

const norm = (value: string): string => value.trim().toLowerCase()

/** Prefix beats word-start beats anywhere; a hit on the label beats one on a
 *  hint. Within a tier the caller's order is kept, so a list already sorted by
 *  recency stays that way. Returns -1 for no match.
 *  O(options x fields) per keystroke, which is what a list of a few hundred
 *  wants; anything larger passes a server-side onSearch instead. */
export const rank = (option: Rankable, query: string): number => {
  const q = norm(query)
  if (q === '') return 0

  const fields: [string, number][] = [
    [norm(option.label), 0],
    ...(option.keywords ?? []).map((word): [string, number] => [norm(word), 1]),
    [norm(option.hint ?? ''), 2],
  ]

  let best = -1
  for (const [text, penalty] of fields) {
    if (text === '') continue
    const at = text.indexOf(q)
    if (at < 0) continue
    // 0 starts the field, 1 starts a word inside it, 2 is anywhere.
    const kind = at === 0 ? 0 : /[\s@._/-]/.test(text[at - 1] ?? '') ? 1 : 2
    const score = kind + penalty * 3
    if (best < 0 || score < best) best = score
  }
  return best
}

export const filterOptions = <T extends Rankable>(options: T[], query: string): T[] =>
  options
    .map((option, index) => ({ option, index, score: rank(option, query) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((row) => row.option)
