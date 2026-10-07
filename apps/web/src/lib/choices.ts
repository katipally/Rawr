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
