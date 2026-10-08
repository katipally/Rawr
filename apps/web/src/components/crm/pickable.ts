/** A deactivated member is offered only while a record already points at them, so
 *  the picker still shows who the value is instead of a blank select. */
export const pickable = <T extends { id: string; deactivated?: boolean }>(choices: T[], current: unknown): T[] =>
  choices.filter((choice) => !choice.deactivated || choice.id === current)

/** The empty choice of a select. A required field cannot be saved empty, so its
 *  empty choice is a disabled prompt rather than an option that would be refused. */
export const emptyOption = (required: boolean): { label: string; disabled: boolean } => ({
  label: required ? 'Pick one' : 'Not set',
  disabled: required,
})
