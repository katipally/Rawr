import { listSubmissions } from '@rawr/db'
import { LinkButton } from '~/components/link-button.tsx'
import { redirect } from 'next/navigation'
import { EmptyState, PageHeader, Tabs } from '@rawr/ui'
import { submissionsPath } from '~/lib/links.ts'
import { contextFrom, readSession, sessionIsReadOnly } from '~/server/session.ts'
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
  params: Promise<{ account: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const { account } = await params
  const query = await searchParams
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const raw = typeof query.state === 'string' ? query.state : undefined
  const state: State = isState(raw) ? raw : 'quarantined'
  const formId = typeof query.form === 'string' ? query.form : undefined

  // "at|id" of the last row on the previous page. One string so the address stays
  // readable, split here rather than parsed anywhere else.
  const [beforeAt, beforeId] = (typeof query.before === 'string' ? query.before : '').split('|')
  const cursor =
    beforeAt && beforeId && !Number.isNaN(Date.parse(beforeAt))
      ? { at: new Date(beforeAt), id: beforeId }
      : undefined

  const PAGE = 50
  // One more than a page, so "is there another page" is known without a count.
  const found = await listSubmissions(contextFrom(session), {
    state,
    limit: PAGE + 1,
    ...(formId ? { formId } : {}),
    ...(cursor ? { cursor } : {}),
  })
  const rows = found.slice(0, PAGE)
  const last = rows.at(-1)
  const olderHref =
    found.length > PAGE && last
      ? submissionsPath(account, {
          state,
          ...(formId ? { form: formId } : {}),
          before: `${last.at.toISOString()}|${last.id}`,
        })
      : null

  const canReview = !sessionIsReadOnly(session)

  return (
    <div className="w-full max-w-6xl">
      <PageHeader
        className="mb-3"
        title="Submissions"
        lead={
          rows.length === 1
            ? '1 submission'
            : `${rows.length}${olderHref ? '+' : ''} submissions`
        }
        why="Nothing the spam engine catches is dropped. A false positive is recovered here rather than lost invisibly, and the state sits in the URL so a held queue is a link somebody can send."
      />

      <Tabs
        className="mb-4"
        label="Submission state"
        items={STATES.map((option) => ({
          key: option.key,
          label: option.label,
          href: submissionsPath(account, { state: option.key, ...(formId ? { form: formId } : {}) }),
          current: option.key === state,
        }))}
      />

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
        <ReviewList account={account} rows={rows} canReview={canReview} state={state} />
      )}

      {olderHref ? (
        <LinkButton href={olderHref} className="mt-3">
          Older submissions
        </LinkButton>
      ) : null}
    </div>
  )
}

export default SubmissionsPage
