export type RailTarget = { key: string; hasCompanyLink: boolean }

/** What a record created from a record's rail starts with, per object key. The
 *  page's company is the company itself on a company page, and otherwise the
 *  record's own company when that company is still live. */
export const railInitial = (
  targets: RailTarget[],
  company: string | null,
): Record<string, Record<string, unknown>> =>
  company
    ? Object.fromEntries(targets.filter((target) => target.hasCompanyLink).map((target) => [target.key, { company_id: company }]))
    : {}
