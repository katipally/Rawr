export type Choice = { value: string; label: string }

/** One choice per line; blank lines are not choices. Run on every edit, so it must
 *  never be what the textarea displays: trimming there eats a typed space or Enter. */
export const parseChoices = (text: string): Choice[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({ value: label, label }))

export const choicesText = (choices: Choice[] | undefined): string => (choices ?? []).map((choice) => choice.label).join('\n')

/** The rows a multi-line paste becomes, with the text either side of the selection
 *  kept on the first and last rows. Null for a paste with no line break, which the
 *  input should take as it always has. */
export const pasteRows = (value: string, start: number, end: number, pasted: string): [string, ...string[]] | null => {
  const [head, ...tail] = pasted.includes('\n') ? parseChoices(pasted).map((choice) => choice.value) : []
  if (head === undefined) return null
  const before = value.slice(0, start)
  const after = value.slice(end)
  if (tail.length === 0) return [before + head + after]
  return [before + head, ...tail.slice(0, -1), tail[tail.length - 1] + after]
}
