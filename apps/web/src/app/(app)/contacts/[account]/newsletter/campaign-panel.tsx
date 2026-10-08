'use client'

import type { Format } from '~/lib/format.ts'
import { Alert, Button, ConfirmDialog, DataTable, EmptyState, Field, Modal, Select, TextInput, cn, useToast, type Column } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, StatusDot, rowPill, type StatusTone } from '~/components/row-actions.tsx'
import { useUrlParam } from '~/lib/url-params.ts'
import { useQueryClient } from '@tanstack/react-query'

type Template = { id: number; name: string; subject: string | null; isActive: boolean }

type Campaign = {
  id: number
  name: string
  subject: string | null
  status: string
  sentAt: string | null
  listIds: number[]
  stats: {
    sent: number
    delivered: number
    opens: number
    uniqueOpens: number
    clicks: number
    uniqueClicks: number
    bounces: number
    unsubscribes: number
    complaints: number
  } | null
}

export type CampaignPanelProps = {
  segments: { id: string; name: string; memberCount: number }[]
  defaultListId: string
  canWrite: boolean
  hub: string
}

/** Brevo publishes no deep link that opens the composer on a given campaign or
 *  preselects a list: neither developers.brevo.com nor the campaign object (whose
 *  only URL, `shareLink`, is a public share of an already-sent campaign) offers
 *  one, checked Sep 2026. So the hand-off is the app itself plus the list to pick,
 *  which is the one thing somebody landing there has to know. */
const BREVO_APP = 'https://app.brevo.com/'

type Handoff = { name: string; listId: string; scheduled: boolean }

const rate = (fmt: Format, part: number, whole: number): string =>
  whole === 0 ? EMPTY_VALUE : fmt.percent(part / whole, 1)

/** Brevo's campaign statuses in HubSpot's four views and status dots: sent is
 *  green, anything queued or going out is amber, a draft is grey. */
const VIEWS = [
  { key: 'all', label: 'All emails' },
  { key: 'draft', label: 'Drafts' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'sent', label: 'Sent' },
  { key: 'archived', label: 'Archived' },
] as const
type View = (typeof VIEWS)[number]['key']

const viewOf = (status: string): Exclude<View, 'all'> =>
  status === 'sent' ? 'sent' : status === 'draft' ? 'draft' : status === 'archive' ? 'archived' : 'scheduled'

const TONE: Record<Exclude<View, 'all'>, StatusTone> = { sent: 'live', scheduled: 'pending', draft: 'off', archived: 'archived' }

/** B12. Aim a Brevo campaign from here, and read what it did.
 *
 *  Brevo keeps the drag-and-drop designer and the sending reputation, which are
 *  the two hard parts and the reason this row was a buy. What crosses back is the
 *  three decisions that belong next to the data: who it goes to, when, and how it
 *  did. Nothing here composes an email.
 *
 *  Templates and campaigns are fetched on demand rather than server-rendered: both
 *  are calls to Brevo, and a marketing page that will not load because a third
 *  party is slow is worse than one that says it is loading. */
export const CampaignPanel = ({ segments, defaultListId, canWrite, hub }: CampaignPanelProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()

  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [sending, setSending] = useState<Campaign | null>(null)

  const [segmentId, setSegmentId] = useState(segments[0]?.id ?? '')
  const [listId, setListId] = useState(defaultListId)
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [senderName, setSenderName] = useState('')
  const [senderEmail, setSenderEmail] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [viewParam, setView] = useUrlParam('status')
  const view: View = VIEWS.some((entry) => entry.key === viewParam) ? (viewParam as View) : 'all'
  const shown = (campaigns ?? []).filter((campaign) => view === 'all' || viewOf(campaign.status) === view)
  const { page, pager } = usePagedRows(shown, 'campaigns')

  /** The first thing still missing, named, so a primary button that will not
   *  press says why instead of looking broken. */
  const missing =
    !segmentId ? 'an audience'
    : !listId ? 'a Brevo list'
    : !name.trim() ? 'a campaign name'
    : !subject.trim() ? 'a subject line'
    : !templateId ? 'a design'
    : !senderEmail ? 'a from address'
    : null

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [rows, gallery] = await Promise.all([
        queryClient.fetchQuery({ ...trpc.integrations.brevoCampaigns.queryOptions(), staleTime: 0 }),
        queryClient.fetchQuery({ ...trpc.integrations.brevoTemplates.queryOptions(), staleTime: 0 }),
      ])
      setCampaigns(rows as Campaign[])
      setTemplates(gallery as Template[])
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const schedule = async () => {
    setBusy(true)
    try {
      const outcome = await api.integrations.scheduleCampaign.mutate({
        segmentId,
        listId: Number(listId),
        name,
        subject,
        senderName,
        senderEmail,
        templateId: Number(templateId),
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      })
      toast(
        'success',
        `${outcome.pushed} pushed to list ${listId}, ${outcome.skipped} left out. ${
          scheduledAt ? 'The campaign is scheduled.' : 'The campaign is a draft in Brevo.'
        }`,
      )
      setHandoff({ name, listId, scheduled: scheduledAt !== '' })
      setComposing(false)
      await load()
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const send = async (campaign: Campaign) => {
    setBusy(true)
    try {
      await api.integrations.sendCampaign.mutate({ campaignId: campaign.id })
      toast('success', `${campaign.name} is going out.`)
      setSending(null)
      await load()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  // A campaign Brevo has nothing to say about yet reads as --, not as zero:
  // "nobody opened it" and "it has not gone out" are different facts.
  const stat = (campaign: Campaign, value: (stats: NonNullable<Campaign['stats']>) => string) =>
    campaign.stats ? value(campaign.stats) : EMPTY_VALUE

  const columns: Column<Campaign>[] = [
    {
      key: 'name',
      header: 'Email name',
      width: 380,
      render: (campaign) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 font-semibold" title={campaign.status}>
              <StatusDot tone={TONE[viewOf(campaign.status)]}>{campaign.name}</StatusDot>
            </span>
            {campaign.subject ? <span className="truncate pl-[1.125rem] text-small text-secondary">{campaign.subject}</span> : null}
          </span>
          {campaign.status === 'draft' ? (
            <RowActions>
              <button type="button" className={rowPill} disabled={busy} onClick={() => setSending(campaign)}>
                Send now
              </button>
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'delivered', header: 'Delivered', width: 120, align: 'right', render: (campaign) => stat(campaign, (stats) => fmt.number(stats.delivered)) },
    { key: 'opens', header: 'Open rate', width: 120, align: 'right', render: (campaign) => stat(campaign, (stats) => rate(fmt, stats.uniqueOpens, stats.delivered)) },
    { key: 'clicks', header: 'Click rate', width: 120, align: 'right', render: (campaign) => stat(campaign, (stats) => rate(fmt, stats.uniqueClicks, stats.delivered)) },
    { key: 'bounces', header: 'Bounced', width: 110, align: 'right', render: (campaign) => stat(campaign, (stats) => fmt.number(stats.bounces)) },
    { key: 'unsubscribes', header: 'Opted out', width: 110, align: 'right', render: (campaign) => stat(campaign, (stats) => fmt.number(stats.unsubscribes)) },
    { key: 'sent', header: 'Sent', width: 180, render: (campaign) => (campaign.sentAt ? fmt.dateTime(campaign.sentAt) : EMPTY_VALUE) },
  ]

  if (!canWrite) {
    return (
      <p className="text-secondary">
        You need {hub} access to aim a newsletter.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            setComposing(true)
            if (campaigns === null) void load()
          }}
          disabled={segments.length === 0}
        >
          Aim a campaign
        </Button>
        <Button busy={loading} onClick={() => void load()}>
          {campaigns === null ? 'Load campaigns from Brevo' : 'Refresh'}
        </Button>
      </div>

      {segments.length === 0 ? (
        <p className="text-secondary">There are no contact segments yet, and a segment is the audience.</p>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}

      {handoff ? (
        <Alert tone="info">
          <span className="break-words">
            {handoff.name} is {handoff.scheduled ? 'scheduled' : 'a draft'} in Brevo, aimed at list{' '}
            {handoff.listId}.{' '}
            <a href={BREVO_APP} target="_blank" rel="noreferrer noopener">
              Open Brevo
            </a>
            , go to Campaigns and pick {handoff.name}. Its recipients are already list {handoff.listId}.
            Changing that there sends to somebody else.
          </span>
        </Alert>
      ) : null}

      {campaigns === null ? (
        <p className="text-secondary">
          Campaigns and their numbers come from Brevo when you ask, not on every page load.
        </p>
      ) : campaigns.length === 0 ? (
        <EmptyState title="Brevo has no campaigns yet" />
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div role="tablist" aria-label="Campaign status" className="scroll-fade-x flex min-w-0 overflow-x-auto rounded-t-hs border-b border-line">
            {VIEWS.map((entry) => {
              const count = entry.key === 'all' ? campaigns.length : campaigns.filter((campaign) => viewOf(campaign.status) === entry.key).length
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={view === entry.key}
                  onClick={() => setView(entry.key === 'all' ? null : entry.key)}
                  className={cn(
                    'flex min-h-10 shrink-0 items-center gap-2 border-r border-line px-4 text-body last:border-r-0',
                    view === entry.key ? 'bg-surface font-medium' : 'bg-fill font-normal hover:bg-fill-hover',
                  )}
                >
                  {entry.key === 'all' ? entry.label : <StatusDot tone={TONE[entry.key]}>{entry.label}</StatusDot>}
                  <span className="text-small text-secondary">{fmt.number(count)}</span>
                </button>
              )
            })}
          </div>
          <DataTable
            columns={columns}
            rows={page}
            rowKey={(campaign) => String(campaign.id)}
            caption="Brevo campaigns"
            storageKey="newsletter.campaigns"
            empty={<EmptyState title="No campaigns here" description="None of Brevo's campaigns are in this state." />}
          />
          {pager}
        </div>
      )}

      <ConfirmDialog
        open={sending !== null}
        title={`Send ${sending?.name ?? 'this campaign'} now?`}
        confirm="Send now"
        busy={busy}
        onCancel={() => setSending(null)}
        onConfirm={() => sending && void send(sending)}
      >
        <p className="break-words">
          {sending?.name} goes to everybody on{' '}
          {sending && sending.listIds.length > 0
            ? `Brevo ${sending.listIds.length === 1 ? 'list' : 'lists'} ${sending.listIds.join(', ')}`
            : 'its Brevo recipient lists'}{' '}
          straight away. A sent campaign cannot be called back.
        </p>
      </ConfirmDialog>

      <Modal
        open={composing}
        onClose={() => setComposing(false)}
        title="Aim a campaign"
        onSubmit={() => void schedule()}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {missing ? <p className="text-small text-secondary">Still needs {missing}.</p> : null}
            <Button variant="tertiary" onClick={() => setComposing(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={missing !== null}>
              {scheduledAt ? 'Push and schedule' : 'Push and create the draft'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="campaign-segment" label="Audience">
            <Select
              id="campaign-segment"
              value={segmentId}
              onChange={(event) => setSegmentId(event.target.value)}
            >
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {`${segment.name} (${fmt.number(segment.memberCount)} ${segment.memberCount === 1 ? 'person' : 'people'})`}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="campaign-list"
            label="Brevo list"
            hint="The list the audience is pushed into, and the list the campaign is aimed at."
          >
            <TextInput
              id="campaign-list"
              inputMode="numeric"
              value={listId}
              onChange={(event) => setListId(event.target.value)}
            />
          </Field>

          <Field id="campaign-name" label="Campaign name" hint="What it is called in Brevo.">
            <TextInput id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          <Field id="campaign-subject" label="Subject line">
            <TextInput
              id="campaign-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </Field>

          <Field id="campaign-template" label="Design">
            <Select
              id="campaign-template"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              <option value="">
                {templates.length === 0 ? 'Load campaigns first to fetch the gallery' : 'Pick one'}
              </option>
              {templates.map((template) => (
                <option key={template.id} value={String(template.id)}>
                  {template.name} (#{template.id})
                </option>
              ))}
            </Select>
          </Field>

          <Field id="campaign-sender-name" label="From name">
            <TextInput
              id="campaign-sender-name"
              value={senderName}
              onChange={(event) => setSenderName(event.target.value)}
            />
          </Field>

          <Field id="campaign-sender-email" label="From address">
            <TextInput
              id="campaign-sender-email"
              type="email"
              value={senderEmail}
              onChange={(event) => setSenderEmail(event.target.value)}
            />
          </Field>

          <Field
            id="campaign-when"
            label="Send at"
            hint="Leave empty to create it as a draft and send it yourself."
          >
            <TextInput
              id="campaign-when"
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
          </Field>

          <Alert tone="info">
            The audience is pushed first and the campaign is aimed at the list afterwards, in that
            order: a campaign created first would go to whoever was on the list before this push,
            which is the previous send&apos;s audience. Anybody who has opted out is left out
            whatever Brevo thinks.
          </Alert>
        </div>
      </Modal>
    </div>
  )
}
