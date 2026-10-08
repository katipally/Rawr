import { canWrite, findDuplicates, findJunkCompanies, getRegistry, listDismissedDuplicates, objectOrThrow } from '@rawr/db'
import { EmptyState, PageHeader, Tabs } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { DuplicateList } from './duplicate-list.tsx'
import { JunkCompanies } from './junk-companies.tsx'
import { SetAsideList } from './set-aside-list.tsx'
import { duplicatesPath } from '~/lib/links.ts'
import { isReadOnly } from '~/server/crm.ts'
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
  searchParams: Promise<{ object?: string; view?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const { object: raw, view: rawView } = await searchParams
  const object = raw === 'company' ? 'company' : 'contact'
  const view = rawView === 'set-aside' ? 'set-aside' : 'queue'

  if (!canWrite(contextFrom(session), object)) {
    return (
      <EmptyState
        title="Merging is not something your role does"
        description="Merging two records needs contacts access, which your role does not have. You can read records but not join two of them together."
      />
    )
  }

  const LIMIT = 50
  const pairs =
    view === 'queue' ? await findDuplicates(contextFrom(session), object, { limit: LIMIT }) : []
  const setAside =
    view === 'set-aside' ? await listDismissedDuplicates(contextFrom(session), object, { limit: LIMIT }) : []
  const fields = objectOrThrow(await getRegistry(contextFrom(session)), object)
    .fields.filter((field) => !isReadOnly(field))
    .map((field) => ({ key: field.key, label: field.label, type: field.type }))
  const junk =
    view === 'queue' && object === 'company'
      ? await findJunkCompanies(contextFrom(session), { limit: LIMIT })
      : { rows: [], total: 0 }

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
            <p>
              Reject sets a pair aside and it stays out of the queue. Set aside lists them, and Put
              back returns one to the queue.
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
            href: duplicatesPath(account, 'contact', view === 'set-aside' ? 'set-aside' : undefined),
            current: object === 'contact',
          },
          {
            key: 'company',
            label: 'Companies',
            href: duplicatesPath(account, 'company', view === 'set-aside' ? 'set-aside' : undefined),
            current: object === 'company',
          },
        ]}
      />

      <Tabs
        label="Queue or set aside"
        items={[
          {
            key: 'queue',
            label: 'Queue',
            href: duplicatesPath(account, object),
            current: view === 'queue',
          },
          {
            key: 'set-aside',
            label: 'Set aside',
            href: duplicatesPath(account, object, 'set-aside'),
            current: view === 'set-aside',
          },
        ]}
      />

      {view === 'set-aside' ? (
        <SetAsideList
          account={account}
          object={object}
          limit={LIMIT}
          pairs={setAside.map((pair) => ({
            keep: { ...pair.keep, createdAt: pair.keep.createdAt.toISOString() },
            absorb: { ...pair.absorb, createdAt: pair.absorb.createdAt.toISOString() },
            setAsideAt: pair.setAsideAt.toISOString(),
          }))}
        />
      ) : (
        <DuplicateList
          account={account}
          object={object}
          limit={LIMIT}
          fields={fields}
          pairs={pairs.map((pair) => ({
            ...pair,
            keep: { ...pair.keep, createdAt: pair.keep.createdAt.toISOString() },
            absorb: { ...pair.absorb, createdAt: pair.absorb.createdAt.toISOString() },
          }))}
        />
      )}

      {view === 'queue' && object === 'company' ? (
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
