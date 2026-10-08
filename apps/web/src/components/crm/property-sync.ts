export type FieldError = { message: string; conflict: boolean }

export type PanelSync = {
  /** The value of the field being edited as the editor last read it. */
  base: unknown
  /** The field whose Reload was clicked, until the read that answers it arrives. */
  reloading: string | null
  errors: Record<string, FieldError>
}

export const reloadRequested = (sync: PanelSync, key: string): PanelSync => ({ ...sync, reloading: key })

/** Only the read a Reload asked for moves the base. Any other read returns the state
 *  it was given, so a save still conflicts on a field that changed unseen. */
export const readArrived = (sync: PanelSync, values: Record<string, unknown>, labels: Record<string, string>): PanelSync => {
  const key = sync.reloading
  if (!key) return sync
  // A relation's stored id is not something a person reads, so its label stands in.
  const shown = key in labels ? labels[key] : values[key]
  const current = typeof shown === 'string' && shown !== '' ? `over "${shown}".` : `over the record's current value.`
  return {
    base: values[key],
    reloading: null,
    errors: {
      ...sync.errors,
      [key]: { message: `Reloaded. Your text is kept. Save to apply it ${current}`, conflict: false },
    },
  }
}
