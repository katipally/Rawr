'use client'

import { Alert, Button, EmptyState, Field, Modal, Select, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

type Template = { id: number; name: string; subject: string | null; isActive: boolean }

type Campaign = {
  id: number
  name: string
  subject: string | null
  status: string
  sentAt: string | null
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
  segments: { id: string; name: string }[]
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

const rate = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`

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
  const router = useRouter()
  const toast = useToast()

  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [handoff, setHandoff] = useState<Handoff | null>(null)

  const [segmentId, setSegmentId] = useState(segments[0]?.id ?? '')
  const [listId, setListId] = useState(defaultListId)
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [senderName, setSenderName] = useState('')
  const [senderEmail, setSenderEmail] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [rows, gallery] = await Promise.all([
        api.integrations.brevoCampaigns.query(),
        api.integrations.brevoTemplates.query(),
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
      await load()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

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
            , go to Campaigns and pick {handoff.name}. Its recipients are already list {handoff.listId};
            changing that there sends to somebody else.
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-2xl border-collapse text-left">
            <thead>
              <tr className="border-b border-divider text-small text-secondary">
                <th className="py-1.5 pr-3 font-medium">Campaign</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 text-right font-medium">Delivered</th>
                <th className="py-1.5 pr-3 text-right font-medium">Opened</th>
                <th className="py-1.5 pr-3 text-right font-medium">Clicked</th>
                <th className="py-1.5 pr-3 text-right font-medium">Bounced</th>
                <th className="py-1.5 pr-3 text-right font-medium">Opted out</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id} className="border-b border-divider last:border-0">
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{campaign.name}</span>
                    {campaign.subject ? (
                      <span className="block text-small text-secondary">{campaign.subject}</span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 text-secondary">{campaign.status}</td>
                  {/* A campaign Brevo has nothing to say about yet reads as a dash,
                      not as zero: "nobody opened it" and "it has not gone out" are
                      different facts. */}
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {campaign.stats ? campaign.stats.delivered.toLocaleString() : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {campaign.stats ? rate(campaign.stats.uniqueOpens, campaign.stats.delivered) : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {campaign.stats ? rate(campaign.stats.uniqueClicks, campaign.stats.delivered) : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {campaign.stats ? campaign.stats.bounces.toLocaleString() : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {campaign.stats ? campaign.stats.unsubscribes.toLocaleString() : '—'}
                  </td>
                  <td className="py-1.5 text-right">
                    {campaign.status === 'draft' ? (
                      <Button variant="tertiary" busy={busy} onClick={() => void send(campaign)}>
                        Send now
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={composing}
        onClose={() => setComposing(false)}
        title="Aim a campaign"
        footer={
          <div className="flex gap-2">
            <Button
              variant="primary"
              busy={busy}
              disabled={!segmentId || !listId || !name.trim() || !subject.trim() || !senderEmail || !templateId}
              onClick={() => void schedule()}
            >
              {scheduledAt ? 'Push and schedule' : 'Push and create the draft'}
            </Button>
            <Button onClick={() => setComposing(false)}>Cancel</Button>
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
                  {segment.name}
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
