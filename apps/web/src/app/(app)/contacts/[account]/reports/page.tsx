import {
  attributionReport,
  emailReport,
  formsReport,
  pipelineReport,
  sequencesReport,
  websiteReport,
} from '@rawr/db'
import { Card } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatCurrency } from '~/components/crm/value.tsx'
import { reportsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { ReportsHeader } from './header.tsx'
import { rangeFrom } from './range.ts'

/** The headline from each of the six, with a link into the one somebody wants.
 *
 *  Six queries rather than one combined view: each report is already a single
 *  grouped scan, and a union of six shapes would be harder to read than six calls
 *  that each answer one question. They run together rather than in turn. */

const percent = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`

const Tile = ({
  href,
  label,
  value,
  hint,
}: {
  href: string
  label: string
  value: string
  hint: string
}) => (
  <Link
    href={href}
    className="flex min-w-0 flex-col gap-1 rounded-panel border border-line p-3 no-underline hover:border-line-interactive"
  >
    <span className="text-small text-secondary">{label}</span>
    <span className="text-lg font-medium tabular-nums">{value}</span>
    <span className="text-small text-secondary">{hint}</span>
  </Link>
)

const ReportsOverview = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ from?: string; to?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const search = await searchParams
  const range = rangeFrom(search)
  const ctx = contextFrom(session)
  const link = (tab: string) => reportsPath(account, { tab, from: range.fromDay, to: range.toDay })

  const [pipeline, forms, sequences, email, website, attribution] = await Promise.all([
    pipelineReport(ctx, range),
    formsReport(ctx, range),
    sequencesReport(ctx, range),
    emailReport(ctx, range),
    websiteReport(ctx, range),
    attributionReport(ctx, range),
  ])

  const created = pipeline.weeks.reduce((total, week) => total + week.created, 0)
  const won = pipeline.weeks.reduce((total, week) => total + week.won, 0)
  const wonAmount = pipeline.weeks.reduce((total, week) => total + week.wonAmount, 0)
  const submissions = forms.days.reduce((total, day) => total + day.clean + day.held, 0)
  const held = forms.days.reduce((total, day) => total + day.held, 0)
  const sent = sequences.sequences.reduce((total, row) => total + row.sent, 0)
  const replied = sequences.sequences.reduce((total, row) => total + row.replied, 0)
  const outbound = email.mailboxes.reduce((total, row) => total + row.sent, 0)
  const inbound = email.mailboxes.reduce((total, row) => total + row.received, 0)
  const topFirst = attribution.first.find((row) => row.channel !== 'Not attributed')

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ReportsHeader account={account} current="" from={range.fromDay} to={range.toDay} />

      <Card title="The headline from each report">
        <div className="grid gap-3 @2xl:grid-cols-2 @4xl:grid-cols-3">
          <Tile
            href={link('pipeline')}
            label="Deals created"
            value={String(created)}
            hint={`${won} won, ${formatCurrency(wonAmount)}`}
          />
          <Tile
            href={link('forms')}
            label="Form fills"
            value={String(submissions)}
            hint={held === 0 ? 'None held for review' : `${held} held for review`}
          />
          <Tile
            href={link('sequences')}
            label="Sequence emails sent"
            value={String(sent)}
            hint={`${percent(replied, sent)} replied`}
          />
          <Tile
            href={link('email')}
            label="Mail through connected inboxes"
            value={String(outbound + inbound)}
            hint={`${outbound} out, ${inbound} in`}
          />
          <Tile
            href={link('website')}
            label="Site visits"
            value={String(website.identifiedShare.sessions)}
            hint={`${percent(website.identifiedShare.identified, website.identifiedShare.sessions)} of them by somebody Rawr can name`}
          />
          <Tile
            href={link('attribution')}
            label="Biggest first touch"
            value={topFirst?.channel ?? '—'}
            hint={topFirst ? `${topFirst.contacts} contacts, ${formatCurrency(topFirst.wonAmount)} won` : 'Nothing attributed in this range'}
          />
        </div>
      </Card>
    </div>
  )
}

export default ReportsOverview
