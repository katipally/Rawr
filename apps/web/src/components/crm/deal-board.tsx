'use client'

import { Avatar, Badge, DropdownMenu, EmptyState, Modal, Spinner, cn, useToast } from '@rawr/ui'
import { CalendarPlus, ChevronDown, CircleCheck, Mail, MoreHorizontal, StickyNote } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { shortName } from '~/components/crm/value.tsx'
import { useNavigation } from '~/components/navigation.tsx'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import type { Group } from './filter-builder.tsx'
import { ScoreRing } from './score-ring.tsx'
import { TaskForm } from './task-form.tsx'
import { formatCurrency, formatDate, isPast } from './value.tsx'
import { useZone } from '~/components/zone.tsx'

export type BoardCard = {
  id: string
  displayName: string
  amount: string | null
  currency: string
  closeDate: string | null
  ownerName: string | null
  companyName: string | null
  nextStep: string | null
  nextStepDate: string | null
  daysInStage: number
  daysSinceActivity: number | null
  score: number | null
  nextTask: { title: string; dueDate: string | null } | null
  contacts: string[]
  contactCount: number
  emailContactId: string | null
}

/** How many faces fit on a card before the rest become a number. Three is what
 *  HubSpot shows and what stays legible at the card's narrowest. */
const AVATARS_SHOWN = 3

/** What the inline scheduler needs before it can show the real task form: the
 *  people a task can be assigned to and the queues it can go in. Fetched once,
 *  the first time somebody opens it, because a board that nobody schedules from
 *  should not pay for two lists on every render. */
type TaskLookups = { assignees: { id: string; label: string }[]; queues: { id: string; name: string }[] }

/** When a card starts reading as stuck. Thirty days is a sales month: shorter
 *  and every board is amber, longer and nobody notices in time. Not configurable
 *  until somebody asks, because a setting with one right answer is a setting. */
const STALE_DAYS = 30

export type BoardColumn = {
  key: string
  name: string
  probability: number | null
  count: number
  totals: { currency: string; total: string; weighted: string }[]
  cards: BoardCard[]
  hasMore: boolean
}

/** Our own type, so a file or a link dragged onto the board is ignored rather than
 *  read as a deal id. */
const DRAG_TYPE = 'application/x-rawr-deal'

/** What the board on screen was read with, so "Show more" asks for the next page
 *  of the same deals rather than of an unfiltered board. */
export type BoardQuery = {
  pipelineId: string | null
  filters: Group[]
  search: string
  groupBy: string
}

export type DealBoardProps = {
  account: string
  columns: BoardColumn[]
  query: BoardQuery
  /** Which field a column stands for. A drop writes that field, so a board grouped
   *  by deal type moves the deal's type rather than its stage. */
  groupByKey: string
  canWrite: boolean
}

export type PipelineOption = { id: string; label: string; href: string }

/** HubSpot's pipeline switcher: one pill naming the pipeline on screen, the rest
 *  one click away. */
export const PipelinePicker = ({ pipelines, currentId }: { pipelines: PipelineOption[]; currentId: string }) => (
  <DropdownMenu
    label="Pipeline"
    groups={[
      {
        key: 'pipelines',
        items: pipelines.map((pipeline) => ({ key: pipeline.id, label: pipeline.label, href: pipeline.href, checked: pipeline.id === currentId })),
      },
    ]}
    trigger={(props) => (
      <button
        {...props}
        type="button"
        className="inline-flex h-control items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 text-small font-light hover:bg-fill"
      >
        {pipelines.find((pipeline) => pipeline.id === currentId)?.label ?? 'Pipeline'}
        <ChevronDown aria-hidden="true" className="size-3" />
      </button>
    )}
  />
)

export const DealBoard = ({ account, columns, query, groupByKey, canWrite }: DealBoardProps) => {
  const zone = useZone()
  const router = useRouter()
  const { navigate } = useNavigation()
  const toast = useToast()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  /** Pages fetched after the first, per column. Cleared whenever the board is
   *  reread, because a card that moved would otherwise be on two columns. */
  const [pages, setPages] = useState<Record<string, { cards: BoardCard[]; hasMore: boolean }>>({})
  const [loadingMore, setLoadingMore] = useState<string | null>(null)
  /** The card whose next activity is being scheduled, and the two lists the real
   *  task form needs. Null until somebody asks for one. */
  const [scheduling, setScheduling] = useState<BoardCard | null>(null)
  const [lookups, setLookups] = useState<TaskLookups | null>(null)

  useEffect(() => {
    if (!scheduling || lookups) return
    let live = true
    Promise.all([api.crm.lookups.query(), api.crm.tasks.queues.list.query()])
      .then(([crm, queues]) => {
        if (!live) return
        setLookups({
          assignees: crm.users.map((user) => ({ id: user.id, label: user.name || user.email })),
          queues: queues.map((queue) => ({ id: queue.id, name: queue.name })),
        })
      })
      .catch((cause) => {
        if (live) toast('error', errorMessage(cause))
      })
    return () => {
      live = false
    }
  }, [scheduling, lookups, toast])

  const shownCards = (column: BoardColumn): BoardCard[] => {
    const page = pages[column.key]
    return page ? [...column.cards, ...page.cards] : column.cards
  }
  const stillMore = (column: BoardColumn): boolean => pages[column.key]?.hasMore ?? column.hasMore

  const showMore = async (column: BoardColumn) => {
    setLoadingMore(column.key)
    const loaded = pages[column.key]?.cards ?? []
    try {
      const page = await api.crm.board.more.query({
        pipelineId: query.pipelineId,
        filters: query.filters as never,
        search: query.search,
        groupBy: query.groupBy,
        groupKey: column.key,
        offset: column.cards.length + loaded.length,
      })
      setPages((current) => ({
        ...current,
        [column.key]: { cards: [...loaded, ...page.cards], hasMore: page.hasMore },
      }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setLoadingMore(null)
    }
  }

  const move = async (dealId: string, columnKey: string) => {
    setMoving(dealId)
    try {
      await api.crm.board.moveCard.mutate({ dealId, field: groupByKey, value: columnKey })
      toast(
        'success',
        groupByKey === 'stage_id'
          ? 'Stage changed. The move is on the deal timeline.'
          : 'Moved. The change is in the audit log.',
      )
      setPages({})
      router.refresh()
    } catch (cause) {
      // The card snaps back because the server never accepted the move.
      toast('error', errorMessage(cause))
    } finally {
      setMoving(null)
      setDragging(null)
      setOver(null)
    }
  }

  /** Everything a person does to a card without opening it: move it, log against
   *  it, or start a task on it. The last three are links into the record page's
   *  own quick actions, so there is one composer and one task form. */
  const menuFor = (card: BoardCard, columnKey: string) => [
    {
      key: 'open',
      items: [
        { key: 'open', label: 'Open deal', href: recordPath(account, 'deal', card.id) },
        {
          key: 'note',
          label: 'Add a note',
          onSelect: () =>
            navigate(recordPath(account, 'deal', card.id, { tab: 'activities', log: 'note' })),
        },
        {
          key: 'task',
          label: 'Create a task',
          onSelect: () =>
            navigate(recordPath(account, 'deal', card.id, { tab: 'activities', task: 'new' })),
        },
      ],
    },
    {
      key: 'move',
      label: `Move to`,
      items: columns
        .filter((column) => column.key !== columnKey)
        .map((column) => ({
          key: column.key,
          label: column.name,
          onSelect: () => void move(card.id, column.key),
        })),
    },
  ]

  if (columns.length === 0) {
    return (
      <EmptyState
        title="This board has no columns"
        description={
          groupByKey === 'stage_id'
            ? 'This pipeline has no stages. An admin adds them in Settings, under Pipelines.'
            : 'The field this board groups by has no values to lay out. An admin adds them in Settings, under Properties.'
        }
      />
    )
  }

  return (
    <>
    {/* The board scrolls inside its own box; the page never scrolls sideways. */}
    <div className="flex min-h-0 w-full flex-1 overflow-x-auto pb-2">
      {/* Stretch, not start: a column that sizes to its own cards leaves an empty
          stage as a header-high drop target, which is the one stage somebody most
          often drags into. Equal heights also stop the board reading as ragged. */}
      <div className="flex min-h-0 min-w-max flex-1 items-stretch gap-3">
        {columns.map((column) => (
          // A drop target. Dragging is the pointer shortcut, not the only way: the
          // same stage change is on the record page and in bulk edit, both
          // ordinary keyboard-reachable controls. No ARIA role describes a drop
          // zone, so there is nothing truer to put here.
          // biome-ignore lint/a11y/noStaticElementInteractions: see above
          <section
            key={column.key}
            onDragOver={(event) => {
              if (!canWrite) return
              event.preventDefault()
              setOver(column.key)
            }}
            onDragLeave={() => setOver((current) => (current === column.key ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              if (!canWrite) return
              // The id travels in the drag itself rather than in React state, so a
              // drop cannot be lost to a render that has not flushed yet.
              const dealId = event.dataTransfer.getData(DRAG_TYPE) || dragging
              if (dealId) void move(dealId, column.key)
            }}
            className={cn(
              // One comfortable reading width, whatever the column count. Growing
              // to fill made a three-column board stretch each card to 470px.
              'flex w-[min(17.5rem,85vw)] shrink-0 flex-col rounded-panel bg-canvas',
              over === column.key && 'bg-accent-subtle',
            )}
          >
            <header className="flex items-baseline gap-1 px-2 pt-4 pb-3 text-small font-semibold">
              <span className="min-w-0 truncate" title={column.name}>
                {column.name}
              </span>
              <span className="shrink-0 tabular-nums">{column.count}</span>
            </header>

            {/* The card list scrolls, the board does not. Height follows the
                viewport rather than a fixed pixel count so a short laptop screen
                and a tall monitor both show whole cards. */}
            <ol className="flex min-h-0 max-h-[min(65svh,50rem)] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 @[60rem]:max-h-none">
              {shownCards(column).length === 0 ? (
                <li className="px-1 py-2 text-secondary">
                  Nothing {groupByKey === 'stage_id' ? 'in this stage' : 'here'} yet.
                </li>
              ) : (
                shownCards(column).map((card) => (
                  <li key={card.id}>
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: the drag
                        source for the drop target above, and the same reasoning
                        applies. The card's own link is what a keyboard uses. */}
                    <div
                      draggable={canWrite}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(DRAG_TYPE, card.id)
                        event.dataTransfer.effectAllowed = 'move'
                        setDragging(card.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      aria-busy={moving === card.id || undefined}
                      className={cn(
                        'group rounded-panel border border-line bg-surface p-3 text-small shadow-panel',
                        canWrite && 'cursor-grab active:cursor-grabbing',
                        moving === card.id && 'opacity-60',
                        dragging === card.id && 'opacity-40',
                      )}
                    >
                      <div className="flex items-start gap-1">
                        <Link
                          href={recordPath(account, 'deal', card.id)}
                          title={card.displayName}
                          className="line-clamp-2 min-w-0 flex-1 break-words text-body"
                        >
                          {card.displayName}
                        </Link>
                        {canWrite ? (
                          // Shown on hover and whenever it holds focus, so the
                          // keyboard reaches what the pointer does.
                          <DropdownMenu
                            label={`Actions for ${shortName(card.displayName)}`}
                            groups={menuFor(card, column.key)}
                            trigger={(props) => (
                              <button
                                {...props}
                                type="button"
                                className="shrink-0 rounded-hs p-0.5 text-secondary opacity-0 hover:bg-fill-hover hover:text-body focus-visible:opacity-100 group-hover:opacity-100"
                              >
                                <MoreHorizontal aria-hidden="true" className="size-4" />
                                <span className="sr-only">Actions for {shortName(card.displayName)}</span>
                              </button>
                            )}
                          />
                        ) : null}
                      </div>
                      <p className="mt-2 tabular-nums">Amount: {card.amount === null ? '—' : formatCurrency(card.amount, card.currency)}</p>
                      <p className="flex flex-wrap items-baseline gap-x-1 tabular-nums">
                        Close date:
                        {card.closeDate === null ? (
                          <span>--</span>
                        ) : isPast(card.closeDate) ? (
                          <Badge tone="error">{formatDate(card.closeDate, zone)}</Badge>
                        ) : (
                          <span>{formatDate(card.closeDate, zone)}</span>
                        )}
                      </p>
                      {card.ownerName ? <p className="truncate">Deal owner: {card.ownerName}</p> : null}
                      {/* Under the amount block, where HubSpot puts its own. The
                          ring is sized in em, so it follows the card's text
                          rather than a pixel count. */}
                      <p className="mt-1 flex items-center gap-1.5">
                        <ScoreRing score={card.score} />
                        <span className="text-secondary">Deal score</span>
                      </p>
                      {card.companyName ? (
                        <p className="mt-2 flex items-center gap-1.5 truncate border-t border-line pt-2 text-body" title={card.companyName}>
                          <Avatar name={card.companyName} size="sm" />
                          <span className="truncate">{card.companyName}</span>
                        </p>
                      ) : null}
                      {card.contactCount > 0 ? (
                        // Three faces and a count. Forty contacts is a number, not
                        // forty avatars wrapping down the card.
                        <p className="mt-2 flex flex-wrap items-center gap-1" title={card.contacts.join(', ')}>
                          {card.contacts.slice(0, AVATARS_SHOWN).map((name) => (
                            <Avatar key={name} name={name} size="sm" />
                          ))}
                          {card.contactCount > AVATARS_SHOWN ? (
                            <span className="text-secondary tabular-nums">+{card.contactCount - AVATARS_SHOWN}</span>
                          ) : null}
                        </p>
                      ) : null}
                      {canWrite ? (
                        // The next open task, or an offer to make one. Either way
                        // it opens the same task form the record page uses, filed
                        // against this deal, without leaving the board.
                        <button
                          type="button"
                          onClick={() => setScheduling(card)}
                          className={cn(
                            'mt-2 flex w-full items-center gap-1.5 rounded-pill border border-line-strong px-2 py-1 text-left hover:bg-fill',
                            isPast(card.nextTask?.dueDate) && 'border-error text-error',
                          )}
                        >
                          <CalendarPlus aria-hidden="true" className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {card.nextTask
                              ? `${card.nextTask.dueDate ? `${formatDate(card.nextTask.dueDate, zone)}: ` : ''}${card.nextTask.title}`
                              : 'Schedule next activity'}
                          </span>
                        </button>
                      ) : null}
                      {card.nextStep ? (
                        <p className="mt-1 break-words text-small text-secondary">
                          <span className={cn(isPast(card.nextStepDate) && 'font-medium text-error')}>
                            {card.nextStepDate ? `${formatDate(card.nextStepDate, zone)}: ` : ''}
                          </span>
                          {card.nextStep}
                        </p>
                      ) : null}
                      {/* How long it has sat here, and how long since anything
                          happened. Both derived from the timeline, and both the
                          first thing anybody looks for on a board: a deal is
                          rarely in trouble because of its amount. */}
                      <p className="mt-1 flex flex-wrap gap-x-2 text-small text-secondary tabular-nums">
                        <span className={cn(card.daysInStage >= STALE_DAYS && 'text-warning')}>
                          {card.daysInStage === 0 ? 'Moved here today' : `${card.daysInStage}d in stage`}
                        </span>
                        <span>
                          {card.daysSinceActivity === null
                            ? 'Nothing logged yet'
                            : card.daysSinceActivity === 0
                              ? 'Active today'
                              : `${card.daysSinceActivity}d quiet`}
                        </span>
                      </p>
                      {canWrite ? (
                        // The record page's quick actions, on the card. Each is a
                        // link into the address that opens the panel already on
                        // that page, so there is still one composer and one note
                        // editor. Shown on hover and whenever one holds focus, so
                        // the keyboard reaches what the pointer does.
                        <div className="mt-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          {[
                            {
                              key: 'note',
                              label: 'Add a note',
                              icon: StickyNote,
                              href: recordPath(account, 'deal', card.id, { tab: 'activities', log: 'note' }),
                            },
                            {
                              key: 'task',
                              label: 'Create a task',
                              icon: CircleCheck,
                              href: recordPath(account, 'deal', card.id, { tab: 'activities', task: 'new' }),
                            },
                            {
                              key: 'email',
                              // A deal has no address of its own, so the composer
                              // opens on the first contact linked to it that has
                              // one. With none, the button says why rather than
                              // going nowhere.
                              label: card.emailContactId ? 'Email a contact on this deal' : 'No contact on this deal has an email address',
                              icon: Mail,
                              href: card.emailContactId
                                ? recordPath(account, 'contact', card.emailContactId, { tab: 'activities', compose: '1' })
                                : null,
                            },
                          ].map((action) =>
                            action.href ? (
                              <Link
                                key={action.key}
                                href={action.href}
                                title={action.label}
                                className="grid size-7 place-items-center rounded-pill border border-line-strong text-body hover:bg-fill"
                              >
                                <action.icon aria-hidden="true" className="size-3.5" />
                                <span className="sr-only">{action.label}</span>
                              </Link>
                            ) : (
                              <span
                                key={action.key}
                                title={action.label}
                                aria-disabled="true"
                                className="grid size-7 place-items-center rounded-pill border border-line text-secondary opacity-60"
                              >
                                <action.icon aria-hidden="true" className="size-3.5" />
                                <span className="sr-only">{action.label}</span>
                              </span>
                            ),
                          )}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))
              )}

              {stillMore(column) ? (
                <li className="flex flex-col items-start gap-1 px-1 py-1 text-small text-secondary">
                  <span className="tabular-nums">
                    Showing {shownCards(column).length} of {column.count}.
                  </span>
                  <button
                    type="button"
                    onClick={() => void showMore(column)}
                    disabled={loadingMore === column.key}
                    className="rounded-pill border border-line-strong bg-surface px-3 py-1 font-light text-body hover:bg-fill disabled:opacity-60"
                  >
                    {loadingMore === column.key ? 'Loading' : 'Show more'}
                  </button>
                </li>
              ) : null}
            </ol>

            {/* The money sits at the foot of the column, under the cards it adds
                up, rather than in the header where it reads as a title. */}
            <footer className="mt-auto border-t border-line px-2 py-1 text-small">
              {column.totals.length === 0 ? (
                <p>
                  <span className="font-semibold">{formatCurrency(0, 'USD')}</span> | Total amount
                </p>
              ) : (
                column.totals.map((total) => (
                  <div key={total.currency} className="tabular-nums">
                    <p>
                      <span className="font-semibold">{formatCurrency(total.total, total.currency)}</span> | Total amount
                    </p>
                    {column.probability !== null ? (
                      <p>
                        <span className="font-semibold">
                          {formatCurrency(total.weighted, total.currency)} ({column.probability}%)
                        </span>{' '}
                        | Weighted amount
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </footer>
          </section>
        ))}
      </div>
    </div>

    {/* The record page's own task form, on the board, filed against the card it
        was opened from. One form, so a task scheduled here carries the type, the
        priority, the queue and the reminder a task scheduled anywhere else does. */}
    <Modal
      open={scheduling !== null}
      onClose={() => setScheduling(null)}
      title={scheduling ? `Next activity on ${shortName(scheduling.displayName)}` : 'Next activity'}
      size="sm"
    >
      {scheduling && lookups ? (
        <TaskForm
          autoFocus
          account={account}
          assignees={lookups.assignees}
          queues={lookups.queues}
          entity={{ entityType: 'deal', entityId: scheduling.id }}
          onCreated={() => {
            setScheduling(null)
            setPages({})
            router.refresh()
          }}
        />
      ) : (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      )}
    </Modal>
    </>
  )
}
