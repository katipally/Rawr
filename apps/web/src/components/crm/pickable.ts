/** A deactivated member is offered only while a record already points at them, so
 *  the picker still shows who the value is instead of a blank select. */
export const pickable = <T extends { id: string; deactivated?: boolean }>(choices: T[], current: unknown): T[] =>
  choices.filter((choice) => !choice.deactivated || choice.id === current)
