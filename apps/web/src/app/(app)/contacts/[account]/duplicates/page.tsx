import { canWrite, findDuplicates, findJunkCompanies } from '@rawr/db'
import { EmptyState, PageHeader, Tabs } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { DuplicateList } from './duplicate-list.tsx'
import { JunkCompanies } from './junk-companies.tsx'
import { duplicatesPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** B11. The queue the merge dialog never had.
 *
 *  Merging two records has worked since B8 and there was no way to find the two.
 *  Every duplicate that accumulates in a CRM got in around the write-time
 *  uniqueness check, not through it: two imports of the same portal, a form fill
 *  under a personal address, a company typed once with its legal suffix and once
 *  without. */
const DuplicatesPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ object?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const { object: raw } = await searchParams
  const object = raw === 'company' ? 'company' : 'contact'

  if (!canWrite(contextFrom(session), object)) {
    return (
      <EmptyState
        title="Merging is not something your role does"
        description="Merging two records needs contacts access, which your role does not have. You can read records but not join two of them together."
      />
    )
  }

  const LIMIT = 50
  const pairs = await findDuplicates(contextFrom(session), object, { limit: LIMIT })
  const junk =
    object === 'company' ? await findJunkCompanies(contextFrom(session), { limit: LIMIT }) : { rows: [], total: 0 }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Duplicates"
        lead="Records that look like the same person or company twice."
        why={
          <>
            <p>
              Nothing here merges on its own. Every pair carries the reason it was proposed, and a
              merge cannot be undone, so the decision stays with a person.
            </p>
            <p>
              The rules are deliberately narrow. A pair is only offered when the evidence is the
              kind that is almost never a coincidence: the same address once dots and plus tags are
              ignored, the same name at the same company, the same phone number, the same domain, or
              the same company name once its legal form is set aside. Two companies with different
              domains are never proposed, because a domain is the thing that tells them apart.
            </p>
          </>
        }
      />

      <Tabs
        label="What to look through"
        items={[
          {
            key: 'contact',
            label: 'Contacts',
            href: duplicatesPath(account, 'contact'),
            current: object === 'contact',
          },
          {
            key: 'company',
            label: 'Companies',
            href: duplicatesPath(account, 'company'),
            current: object === 'company',
          },
        ]}
      />

      <DuplicateList
        account={account}
        object={object}
        limit={LIMIT}
        pairs={pairs.map((pair) => ({
          ...pair,
          keep: { ...pair.keep, createdAt: pair.keep.createdAt.toISOString() },
          absorb: { ...pair.absorb, createdAt: pair.absorb.createdAt.toISOString() },
        }))}
      />

      {object === 'company' ? (
        <JunkCompanies
          account={account}
          limit={LIMIT}
          total={junk.total}
          companies={junk.rows.map((company) => ({ ...company, createdAt: company.createdAt.toISOString() }))}
        />
      ) : null}
    </div>
  )
}

export default DuplicatesPage
