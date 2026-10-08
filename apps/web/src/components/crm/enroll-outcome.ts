import type { EnrollOutcome } from '@rawr/db'

export type RefusedRow = Extract<EnrollOutcome, { enrolled: false }>

/** The headline and the refused rows for the outcome view. */
export const summarizeEnrollment = (outcomes: EnrollOutcome[]) => {
  const refused: RefusedRow[] = outcomes.filter((row): row is RefusedRow => !row.enrolled)
  const enrolled = outcomes.length - refused.length
  const headline =
    refused.length === 0
      ? `${enrolled} enrolled.`
      : enrolled === 0
        ? `Nobody was enrolled. ${refused.length === 1 ? '1 was' : `${refused.length} were`} not.`
        : `${enrolled} enrolled, ${refused.length} not.`
  return { enrolled, refused, headline }
}
