/** "1 app", "2 apps". `none` replaces the number when nothing is left, for a
 *  sentence where "0 apps you can connect" reads worse than a plain statement. */
export const countPhrase = (count: number, one: string, many: string, none?: string): string => {
  if (count === 0 && none !== undefined) return none
  return `${count} ${count === 1 ? one : many}`
}

/** The enrichment result as one line. With counts, the counts come first and every
 *  failed provider is named after them, so one outage is never hidden by another
 *  provider's fills. With no counts, `detail` already holds each provider's sentence,
 *  failures included. */
export const enrichmentLine = (detail: string, filled: number, held: number, failed: string[]): string => {
  if (filled === 0 && held === 0) return detail
  const parts: string[] = []
  if (filled > 0) parts.push(`Filled ${countPhrase(filled, 'blank field', 'blank fields')}.`)
  if (held > 0) parts.push(`${countPhrase(held, 'suggestion', 'suggestions')} held for review below.`)
  for (const provider of failed) parts.push(`${provider} could not be reached.`)
  return parts.join(' ')
}
