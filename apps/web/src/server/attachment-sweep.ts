/** Whether a storage delete failed only because the object is already gone. An
 *  earlier pass may have removed it and failed to clear its row, so a retry finds
 *  nothing to delete, and that is the outcome the sweep wants. */
export const isMissingObject = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const { name, $metadata } = cause as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return name === 'NoSuchKey' || $metadata?.httpStatusCode === 404
}
