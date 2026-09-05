import {
  attributionReport,
  emailReport,
  formsReport,
  pipelineReport,
  sequencesReport,
  websiteReport,
  type AttributionReport,
  type EmailReport,
  type FormsReport,
  type PipelineReport,
  type Range,
  type SequencesReport,
  type WebsiteReport,
  type WorkspaceContext,
} from '@rawr/db'
import { formatCurrency } from '~/components/crm/value.tsx'

/** B11. The catalogue a dashboard is assembled from.
 *
 *  Every card is a figure one of the six reports already computes. That is the
 *  whole design: a dashboard cannot ask the database a question the reports
 *  cannot, so there is no query builder to write, no chart grammar to invent, and
 *  a card can never disagree with the report it came from.
 *
 *  Cards name the report they need rather than fetching one, so a dashboard of
 *  four pipeline cards runs one query and not four. */

export type ReportKey = 'pipeline' | 'forms' | 'sequences' | 'email' | 'website' | 'attribution'

type Reports = {
  pipeline?: PipelineReport
  forms?: FormsReport
  sequences?: SequencesReport
  email?: EmailReport
  website?: WebsiteReport
  attribution?: AttributionReport
}

export type CardData =
  | { kind: 'metric'; value: string; hint: string }
  | { kind: 'table'; columns: string[]; rows: (string | number)[][] }

type CardDef = {
  key: string
  label: string
  /** Which of the six it reads. Also the tab a card links back to. */
  report: ReportKey
  group: string
  render: (reports: Reports) => CardData
}

const sum = <T,>(rows: T[], pick: (row: T) => number): number =>
  rows.reduce((total, row) => total + pick(row), 0)

const percent = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`

const count = (value: number): string => value.toLocaleString()

/** The same formatting the reports overview uses, so a card and the report it
 *  came from never show the same figure two different ways. Amounts are summed
 *  across currencies without conversion upstream, exactly as the pipeline report
 *  does it, and this inherits that. */
const money = (value: number): string => formatCurrency(value)

/** Longest table a card shows. A card is a glance; the report behind it is the
 *  place to read all forty rows, and every card links there. */
const TOP = 8

const CARDS: CardDef[] = [
  {
    key: 'deals_created',
    label: 'Deals created',
    report: 'pipeline',
    group: 'Pipeline',
    render: ({ pipeline }) => {
      const weeks = pipeline?.weeks ?? []
      return {
        kind: 'metric',
        value: count(sum(weeks, (week) => week.created)),
        hint: `${count(sum(weeks, (week) => week.won))} won, ${count(sum(weeks, (week) => week.lost))} lost`,
      }
    },
  },
  {
    key: 'deals_won_amount',
    label: 'Won',
    report: 'pipeline',
    group: 'Pipeline',
    render: ({ pipeline }) => {
      const weeks = pipeline?.weeks ?? []
      const won = sum(weeks, (week) => week.won)
      return {
        kind: 'metric',
        value: money(sum(weeks, (week) => week.wonAmount)),
        hint: `across ${count(won)} deal${won === 1 ? '' : 's'}, unconverted`,
      }
    },
  },
  {
    key: 'pipeline_funnel',
    label: 'Where the open deals sit',
    report: 'pipeline',
    group: 'Pipeline',
    render: ({ pipeline }) => {
      const funnel = pipeline?.funnel ?? []
      // Stage names repeat across pipelines, so the pipeline is prefixed once
      // there is more than one. With a single pipeline it is only noise.
      const many = new Set(funnel.map((row) => row.pipelineId)).size > 1
      return {
        kind: 'table',
        columns: ['Stage', 'Deals', 'Amount'],
        rows: funnel
          .slice(0, TOP)
          .map((row) => [many ? `${row.pipeline} · ${row.stage}` : row.stage, row.deals, money(row.amount)]),
      }
    },
  },
  {
    key: 'pipeline_owners',
    label: 'Deals by owner',
    report: 'pipeline',
    group: 'Pipeline',
    render: ({ pipeline }) => ({
      kind: 'table',
      columns: ['Owner', 'Open', 'Won'],
      rows: (pipeline?.owners ?? []).slice(0, TOP).map((row) => [row.owner, row.open, row.won]),
    }),
  },

  {
    key: 'form_fills',
    label: 'Form fills',
    report: 'forms',
    group: 'Forms',
    render: ({ forms }) => {
      const days = forms?.days ?? []
      const held = sum(days, (day) => day.held)
      return {
        kind: 'metric',
        value: count(sum(days, (day) => day.clean + day.held)),
        hint: held === 0 ? 'none held for review' : `${count(held)} held for review`,
      }
    },
  },
  {
    key: 'form_conversion',
    label: 'Form conversion',
    report: 'forms',
    group: 'Forms',
    render: ({ forms }) => ({
      kind: 'table',
      columns: ['Form', 'Seen', 'Filled', 'Rate'],
      rows: (forms?.forms ?? [])
        .slice(0, TOP)
        .map((row) => [row.form, row.views, row.submissions, percent(row.submissions, row.views)]),
    }),
  },
  {
    key: 'form_output',
    label: 'What forms produced',
    report: 'forms',
    group: 'Forms',
    render: ({ forms }) => ({
      kind: 'table',
      columns: ['Form', 'Contacts', 'Deals'],
      rows: (forms?.forms ?? []).slice(0, TOP).map((row) => [row.form, row.contacts, row.deals]),
    }),
  },

  {
    key: 'sequence_sent',
    label: 'Sequence emails sent',
    report: 'sequences',
    group: 'Sequences',
    render: ({ sequences }) => {
      const rows = sequences?.sequences ?? []
      const sent = sum(rows, (row) => row.sent)
      return {
        kind: 'metric',
        value: count(sent),
        hint: `${percent(sum(rows, (row) => row.replied), sent)} replied`,
      }
    },
  },
  {
    key: 'sequence_bounce',
    label: 'Sequence bounces',
    report: 'sequences',
    group: 'Sequences',
    render: ({ sequences }) => {
      const rows = sequences?.sequences ?? []
      const sent = sum(rows, (row) => row.sent)
      const bounced = sum(rows, (row) => row.bounced)
      return { kind: 'metric', value: count(bounced), hint: `${percent(bounced, sent)} of what went out` }
    },
  },
  {
    key: 'sequence_breakdown',
    label: 'Sequence by sequence',
    report: 'sequences',
    group: 'Sequences',
    render: ({ sequences }) => ({
      kind: 'table',
      columns: ['Sequence', 'Sent', 'Opened', 'Replied'],
      rows: (sequences?.sequences ?? [])
        .slice(0, TOP)
        .map((row) => [row.sequence, row.sent, row.opened, row.replied]),
    }),
  },

  {
    key: 'mail_volume',
    label: 'Mail through connected inboxes',
    report: 'email',
    group: 'Email',
    render: ({ email }) => {
      const rows = email?.mailboxes ?? []
      const out = sum(rows, (row) => row.sent)
      const back = sum(rows, (row) => row.received)
      return { kind: 'metric', value: count(out + back), hint: `${count(out)} out, ${count(back)} in` }
    },
  },
  {
    key: 'reply_lag',
    label: 'How long people wait',
    report: 'email',
    group: 'Email',
    render: ({ email }) => ({
      kind: 'table',
      columns: ['Mailbox', 'Median hours', 'Replies'],
      rows: (email?.replyLag ?? [])
        .slice(0, TOP)
        .map((row) => [row.mailbox, row.medianHours === null ? '—' : row.medianHours, row.replies]),
    }),
  },

  {
    key: 'site_sessions',
    label: 'Site visits',
    report: 'website',
    group: 'Website',
    render: ({ website }) => {
      const share = website?.identifiedShare ?? { sessions: 0, identified: 0 }
      return {
        kind: 'metric',
        value: count(share.sessions),
        hint: `${percent(share.identified, share.sessions)} by somebody Rawr can name`,
      }
    },
  },
  {
    key: 'traffic_channels',
    label: 'Where traffic came from',
    report: 'website',
    group: 'Website',
    render: ({ website }) => ({
      kind: 'table',
      columns: ['Channel', 'Sessions', 'Named'],
      rows: (website?.channels ?? [])
        .slice(0, TOP)
        .map((row) => [row.channel, row.sessions, row.identified]),
    }),
  },
  {
    key: 'top_pages',
    label: 'Most read pages',
    report: 'website',
    group: 'Website',
    render: ({ website }) => ({
      kind: 'table',
      columns: ['Path', 'Views', 'Visitors'],
      rows: (website?.pages ?? []).slice(0, TOP).map((row) => [row.path, row.views, row.visitors]),
    }),
  },

  {
    key: 'first_touch',
    label: 'First touch',
    report: 'attribution',
    group: 'Attribution',
    render: ({ attribution }) => ({
      kind: 'table',
      columns: ['Channel', 'Contacts', 'Deals', 'Won'],
      rows: (attribution?.first ?? [])
        .slice(0, TOP)
        .map((row) => [row.channel, row.contacts, row.deals, money(row.wonAmount)]),
    }),
  },
  {
    key: 'last_touch',
    label: 'Last touch',
    report: 'attribution',
    group: 'Attribution',
    render: ({ attribution }) => ({
      kind: 'table',
      columns: ['Channel', 'Contacts', 'Deals', 'Won'],
      rows: (attribution?.last ?? [])
        .slice(0, TOP)
        .map((row) => [row.channel, row.contacts, row.deals, money(row.wonAmount)]),
    }),
  },
]

const BY_KEY = new Map(CARDS.map((card) => [card.key, card]))

export type CardChoice = { key: string; label: string; group: string; report: ReportKey }

/** What the picker offers, in catalogue order so the groups stay together. */
export const cardCatalogue = (): CardChoice[] =>
  CARDS.map(({ key, label, group, report }) => ({ key, label, group, report }))

export type RenderedCard = CardChoice & { data: CardData }

/** Draw the cards a dashboard names, over one range.
 *
 *  Only the reports the chosen cards actually need are run, and each is run once
 *  however many cards read it. A key that is no longer in the catalogue is
 *  dropped rather than throwing, so retiring a card cannot break a saved
 *  dashboard somebody opens every morning. */
export const renderCards = async (
  ctx: WorkspaceContext,
  keys: string[],
  range: Range,
): Promise<RenderedCard[]> => {
  const chosen = keys.flatMap((key) => {
    const card = BY_KEY.get(key)
    return card ? [card] : []
  })
  if (chosen.length === 0) return []

  const needed = [...new Set(chosen.map((card) => card.report))]
  const readers: Record<ReportKey, (ctx: WorkspaceContext, range: Range) => Promise<unknown>> = {
    pipeline: pipelineReport,
    forms: formsReport,
    sequences: sequencesReport,
    email: emailReport,
    website: websiteReport,
    attribution: attributionReport,
  }

  const fetched = await Promise.all(needed.map((key) => readers[key](ctx, range)))
  const reports = Object.fromEntries(needed.map((key, index) => [key, fetched[index]])) as Reports

  return chosen.map((card) => ({
    key: card.key,
    label: card.label,
    group: card.group,
    report: card.report,
    data: card.render(reports),
  }))
}
