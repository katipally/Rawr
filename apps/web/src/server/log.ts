/** One JSON object per line on stdout. The host collects the container's stdout,
 *  so a line here is a line in the log search, and no logging service is needed.
 *
 *  `describe` keeps what is needed to find the fault (name, message, SQLSTATE or
 *  errno, stack) and follows the cause chain a few links, which is where a driver
 *  error sits under the wrapper that was thrown. */

type Described = { name: string; message: string; code?: string; stack?: string; cause?: Described }

const MAX_CAUSES = 3

export const describe = (error: unknown, depth = 0): Described => {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) }
  const code = (error as { code?: unknown }).code
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' && { code }),
    ...(error.stack && { stack: error.stack }),
    ...(error.cause !== undefined && depth < MAX_CAUSES && { cause: describe(error.cause, depth + 1) }),
  }
}

export const logError = (fields: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ level: 'error', time: new Date().toISOString(), ...fields })}\n`)
}
