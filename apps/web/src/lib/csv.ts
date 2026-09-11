/** RFC 4180, fed a chunk at a time, so a file of any size is read in the memory
 *  of one chunk and one row. Quoted fields, doubled quotes inside them and line
 *  breaks inside quotes are the whole specification; each of them can be split
 *  across two chunks, which is what the carried state is for. Owned rather than
 *  a dependency: one fewer supply chain to audit. O(characters). */
export const csvReader = (delimiter = ',') => {
  let row: string[] = []
  let field = ''
  let quoted = false
  /** A quote inside a quoted field, waiting on the next character to say whether
   *  it closes the field or is the first half of a doubled quote. */
  let quoteSeen = false
  /** A carriage return ended the last row; a line feed straight after it is the
   *  same line ending, not an empty row. */
  let afterReturn = false
  let started = false

  const push = (text: string): string[][] => {
    const rows: string[][] = []
    // A byte order mark from Excel would otherwise become part of the first header.
    const input = !started && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    if (input.length > 0) started = true

    for (const char of input) {
      if (afterReturn) {
        afterReturn = false
        if (char === '\n') continue
      }
      if (quoted) {
        if (!quoteSeen) {
          if (char === '"') quoteSeen = true
          else field += char
          continue
        }
        quoteSeen = false
        if (char === '"') {
          field += '"'
          continue
        }
        quoted = false
      }
      if (char === '"') {
        quoted = true
      } else if (char === delimiter) {
        row.push(field)
        field = ''
      } else if (char === '\n' || char === '\r') {
        row.push(field)
        rows.push(row)
        row = []
        field = ''
        afterReturn = char === '\r'
      } else {
        field += char
      }
    }
    return rows
  }

  /** The last row, when the file does not end on a line break. */
  const end = (): string[][] => {
    const last = field !== '' || row.length > 0 ? [[...row, field]] : []
    row = []
    field = ''
    quoted = false
    quoteSeen = false
    return last
  }

  return { push, end }
}

/** What separates the columns, read off the first line: a comma, or the semicolon
 *  a European Excel writes, or a tab. Counted outside quotes, so a header like
 *  "Street, number" does not vote. */
export const sniffDelimiter = (firstChunk: string): string => {
  const counts = new Map([
    [',', 0],
    [';', 0],
    ['\t', 0],
  ])
  let quoted = false
  for (const char of firstChunk) {
    if (char === '"') quoted = !quoted
    else if (!quoted && (char === '\n' || char === '\r')) break
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1)
  }
  let best = ','
  for (const [candidate, count] of counts) if (count > counts.get(best)!) best = candidate
  return best
}
