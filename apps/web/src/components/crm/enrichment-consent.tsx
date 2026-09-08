'use client'

import { Button, Modal, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

/** The gate in front of every credit an enricher charges for.
 *
 *  Creating a contact or a company only queues a question. This is where it is
 *  asked: how many records are waiting, what it will cost, yes or no. Approval
 *  covers the batch on screen and nothing that arrives afterwards, so a form
 *  burst tomorrow asks again rather than riding on today's yes.
 *
 *  The prompt opens itself once per browser session, because a bar somebody has
 *  to notice is not consent being asked for. Closing it leaves the batch
 *  waiting: the bar stays, and nothing has been spent either way. */

/** How stale the count may get while somebody works. Long enough not to be a
 *  request per page, short enough that a batch approved in another tab stops
 *  being offered here. */
const REFRESH_MS = 60_000

const ASKED = 'rawr.enrichment.asked'

type Pending = { contacts: number; companies: number; total: number }

const describe = ({ contacts, companies }: Pending): string => {
  const parts = [
    contacts > 0 ? `${contacts} contact${contacts === 1 ? '' : 's'}` : null,
    companies > 0 ? `${companies} compan${companies === 1 ? 'y' : 'ies'}` : null,
  ].filter(Boolean)
  return parts.join(' and ')
}

export const EnrichmentConsent = ({ canWrite }: { canWrite: boolean }) => {
  const router = useRouter()
  const toast = useToast()
  const [pending, setPending] = useState<Pending | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'discard' | null>(null)

  const load = useCallback(() => {
    api.integrations.pendingEnrichment
      .query()
      .then((next) => {
        setPending(next)
        // Asked once per session rather than on every page: a modal that reopens
        // as somebody moves around is a modal they learn to dismiss unread.
        if (next.total > 0 && sessionStorage.getItem(ASKED) !== '1') {
          sessionStorage.setItem(ASKED, '1')
          setOpen(true)
        }
      })
      .catch(() => {
        // A failed poll is not worth a message. The next one is a minute away,
        // and nothing is enriched in the meantime either way.
      })
  }, [])

  useEffect(() => {
    if (!canWrite) return
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [canWrite, load])

  if (!canWrite || !pending || pending.total === 0) return null

  const answer = async (which: 'approve' | 'discard') => {
    setBusy(which)
    try {
      if (which === 'approve') {
        const { approved } = await api.integrations.approveEnrichment.mutate()
        toast('success', `${approved} record${approved === 1 ? '' : 's'} sent to be enriched. They fill in over the next few minutes.`)
      } else {
        const { discarded } = await api.integrations.discardEnrichment.mutate()
        toast('info', `${discarded} request${discarded === 1 ? '' : 's'} dropped. No credits were used.`)
      }
      setPending({ contacts: 0, companies: 0, total: 0 })
      setOpen(false)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-line bg-surface px-4 py-2 shadow-panel">
        <p className="min-w-0 flex-1 text-small">
          <span className="font-medium">{pending.total}</span> record{pending.total === 1 ? '' : 's'} waiting to be
          enriched. Nothing is looked up until you say so.
        </p>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Review
        </Button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Enrich these records?"
        size="sm"
        footer={
          <>
            <Button variant="tertiary" busy={busy === 'discard'} onClick={() => void answer('discard')}>
              Discard
            </Button>
            <Button variant="tertiary" onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button variant="primary" busy={busy === 'approve'} onClick={() => void answer('approve')}>
              Enrich {pending.total}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            {describe(pending)} gained an email address or a domain, which is what an enricher matches on. Enriching
            them looks each one up with the providers you have connected.
          </p>
          <p className="text-secondary">
            Every record can cost one credit per provider, so this is up to {pending.total} credit
            {pending.total === 1 ? '' : 's'} each from Apollo, Lusha and Clay. Only blank fields are filled, and nothing
            you typed yourself is overwritten.
          </p>
          <p className="text-secondary">
            <span className="font-medium">Discard</span> drops the requests and spends nothing. Either way the records
            themselves are untouched, and you can still enrich any one of them from its own page.
          </p>
        </div>
      </Modal>
    </>
  )
}
