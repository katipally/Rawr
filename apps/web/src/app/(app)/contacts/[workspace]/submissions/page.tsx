import { listSubmissions } from '@rawr/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { EmptyState } from '@rawr/ui'
import { submissionsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReviewList } from './review-list.tsx'

/** The review queue. Nothing the spam engine catches is dropped, so this is where
 *  a false positive is recovered and a real prospect is not lost invisibly.
 *
 *  The state is in the URL, so "here are the 3 held submissions" is a link
 *  somebody can paste into Slack. */

const STATES = [
  { key: 'quarantined', label: 'Held for review' },
  { key: 'clean', label: 'Accepted' },
  { key: 'released', label: 'Released' },
  { key: 'confirmed_spam', label: 'Spam' },
] as const

type State = (typeof STATES)[number]['key']

const isState = (value: string | undefined): value is State =>
  STATES.some((s) => s.key === value)

const SubmissionsPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const { workspace } = await params
  const query = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const raw = typeof query.state === 'string' ? query.state : undefined
  const state: State = isState(raw) ? raw : 'quarantined'
  const formId = typeof query.form === 'string' ? query.form : undefined

  const rows = await listSubmissions(contextFrom(session), {
    state,
    ...(formId ? { formId } : {}),
  })

  const canReview = session.role !== 'viewer'

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-medium">Submissions</h1>
        <span className="text-sm text-secondary">
          {rows.length === 1 ? '1 submission' : `${rows.length} submissions`}
        </span>
      </header>

      <nav aria-label="Submission state" className="mb-4 flex flex-wrap gap-1 border-b border-divider">
        {STATES.map((option) => (
          <Link
            key={option.key}
            href={submissionsPath(workspace, { state: option.key, ...(formId ? { form: formId } : {}) })}
            aria-current={option.key === state ? 'page' : undefined}
            className={
              option.key === state
                ? '-mb-px border-b-2 border-accent px-3 py-2 text-sm font-medium text-link'
                : '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-secondary'
            }
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          title={state === 'quarantined' ? 'Nothing is waiting' : 'Nothing here'}
          description={
            state === 'quarantined'
              ? 'Submissions that score as possible spam are held here instead of being dropped.'
              : 'No submissions are in this state.'
          }
        />
      ) : (
        <ReviewList workspace={workspace} rows={rows} canReview={canReview} state={state} />
      )}
    </div>
  )
}

export default SubmissionsPage
