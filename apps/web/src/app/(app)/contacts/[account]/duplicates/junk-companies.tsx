'use client'

import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { formatDate } from '~/components/crm/value.tsx'
import { recordPath } from '~/lib/links.ts'
import { useZone } from '~/components/zone.tsx'

export type JunkCompany = { id: string; name: string; createdAt: string; contactCount: number }

export type JunkCompaniesProps = {
  account: string
  companies: JunkCompany[]
  /** What the server asked for, so a full page reads as "the first n" rather
   *  than "all of them", the same promise the pairs above make. */
  limit: number
}

/** B11 follow-up. A HubSpot export sometimes carries a contact's employer as the
 *  numeric id of a company that has since been merged or deleted in HubSpot, not
 *  its name, and the importer used to take that id and create a company literally
 *  named after it. The importer no longer does that, but the ones it already made
 *  are still here, so this lists them for a person to judge one at a time. Nothing
 *  here deletes anything. */
export const JunkCompanies = ({ account, companies, limit }: JunkCompaniesProps) => {
  const zone = useZone()
  const capped = companies.length >= limit

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-medium">Companies named after a HubSpot id</h2>
        <p className="text-secondary">
          Each of these is a company whose name is only digits, the id of a HubSpot company that
          was merged or deleted by the time this contact was exported. Open one to see who is
          attached, and delete it yourself if it turns out to hold nobody real.
        </p>
      </div>

      {companies.length === 0 ? (
        <EmptyState title="None of these here" description="Every company in this account has a real name." />
      ) : (
        <>
          <p className="text-secondary tabular-nums">
            {companies.length} compan{companies.length === 1 ? 'y' : 'ies'}
            {capped ? `, the first ${limit} found` : ''}
          </p>
          <ul className="flex flex-col gap-2">
            {companies.map((company) => (
              <li
                key={company.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-panel border border-line bg-surface p-3"
              >
                <Link href={recordPath(account, 'company', company.id)} className="min-w-0 truncate font-medium">
                  {company.name}
                </Link>
                <span className="text-small text-secondary">created {formatDate(company.createdAt, zone)}</span>
                <span className="text-small text-secondary">
                  &middot; {company.contactCount} contact{company.contactCount === 1 ? '' : 's'} attached
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
