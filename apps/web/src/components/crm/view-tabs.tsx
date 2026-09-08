'use client'

import { Badge, DropdownMenu, RenamePrompt, cn, useToast } from '@rawr/ui'
import { CalendarDays, ChevronDown, Columns3, MoreHorizontal, Pin, Plus, Table2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useNavigation } from '~/components/navigation.tsx'
import { objectView, type ListParams, type ViewKind } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

const KIND_LABEL: Record<ViewKind, string> = { list: 'Table', board: 'Board', calendar: 'Calendar' }
const KIND_ICON: Record<ViewKind, typeof Table2> = { list: Table2, board: Columns3, calendar: CalendarDays }
const TAB_ICON: Record<ViewTab['kind'], typeof Table2> = { table: Table2, board: Columns3, calendar: CalendarDays }

export type ViewTab = {
  /** Null for the view every account falls back to before one is saved. It has
   *  no row, so it cannot be renamed, pinned or deleted. */
  id: string | null
  slug: string
  name: string
  kind: 'table' | 'board' | 'calendar'
  isShared: boolean
  pinned: boolean
}

export type ViewTabsProps = {
  account: string
  object: string
  views: ViewTab[]
  current: string
  currentKind: ViewKind
  /** Which shapes this object can be looked at in, decided by the page: a board
   *  needs a stage, a calendar needs a date field, and only the registry knows
   *  whether this object has either. */
  kinds: ViewKind[]
  /** Carried onto every tab so switching views keeps the search a person typed. */
  params: ListParams
  canWrite: boolean
}

/** Switching tabs starts the list again, so the page cursor is dropped rather
 *  than carried onto a different result set. */
const withoutCursor = (params: ListParams): ListParams => {
  const next = { ...params }
  delete next.cursor
  return next
}

/** HubSpot's view tabs. The slug is the address, so a tab is a link, not state:
 *  right-click and copy gives someone else exactly this screen.
 *
 *  A pinned view takes a tab; the rest are one menu away, which is what keeps a
 *  account with forty saved views from wrapping the bar onto four lines. */
export const ViewTabs = ({
  account,
  object,
  views,
  current,
  currentKind,
  kinds,
  params,
  canWrite,
}: ViewTabsProps) => {
  const router = useRouter()
  const { navigate } = useNavigation()
  const toast = useToast()
  const [renaming, setRenaming] = useState<ViewTab | null>(null)
  const [busy, setBusy] = useState(false)

  const href = (view: { slug: string }, kind: ViewKind = currentKind): string =>
    objectView(account, object, view.slug, kind, withoutCursor(params))

  // The open tab always shows, even when it is not pinned, so a link into an
  // unpinned view does not land on a bar that has no tab for where you are.
  const currentHref = href({ slug: current })
  const tabs = views.filter((view) => view.pinned || view.slug === current)
  const unpinned = views.filter((view) => !view.pinned && view.slug !== current)

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      toast('success', what)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Tab order is the `position` column, and nothing has ever written it, so
   *  every bar is in creation order for ever. Move left and move right rather
   *  than dragging: the same affordance properties and form fields already use,
   *  and one a keyboard can reach. */
  const moveBy = (view: ViewTab, by: number) => {
    const order = tabs.map((tab) => tab.id).filter((id): id is string => !!id)
    const at = order.indexOf(view.id ?? '')
    const to = at + by
    if (at < 0 || to < 0 || to >= order.length) return
    const next = [...order]
    const [moved] = next.splice(at, 1)
    if (moved) next.splice(to, 0, moved)
    void run('Moved.', () => api.crm.views.reorder.mutate({ object, ids: next }))
  }

  const menuFor = (view: ViewTab) => {
    const at = tabs.findIndex((tab) => tab.id === view.id)
    return [
    {
      key: 'view',
      items: [
        { key: 'rename', label: 'Rename', onSelect: () => setRenaming(view) },
        {
          key: 'duplicate',
          label: 'Duplicate',
          onSelect: () =>
            void run('Copied. The copy is yours until you share it.', async () => {
              const copy = await api.crm.views.duplicate.mutate({ id: view.id! })
              navigate(href(copy))
            }),
        },
        {
          key: 'pin',
          label: view.pinned ? 'Unpin from the tab bar' : 'Pin as a tab',
          icon: <Pin aria-hidden="true" className="size-4" />,
          onSelect: () =>
            void run(view.pinned ? 'Unpinned.' : 'Pinned.', () =>
              api.crm.views.pin.mutate({ id: view.id!, pinned: !view.pinned }),
            ),
        },
        ...(view.pinned && at > 0
          ? [{ key: 'left', label: 'Move left', onSelect: () => moveBy(view, -1) }]
          : []),
        ...(view.pinned && at >= 0 && at < tabs.length - 1
          ? [{ key: 'right', label: 'Move right', onSelect: () => moveBy(view, 1) }]
          : []),
      ],
    },
    {
      key: 'danger',
      items: [
        {
          key: 'delete',
          label: 'Delete view',
          destructive: true,
          onSelect: () =>
            void run('View deleted.', async () => {
              await api.crm.views.remove.mutate({ id: view.id! })
              // The records are still there; only the arrangement went. Land on
              // the tab every link falls back to rather than on a dead address.
              navigate(objectView(account, object, 'all', currentKind, withoutCursor(params)))
            }),
        },
      ],
    },
    ]
  }

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line pb-1">
      {tabs.map((view) => {
        const active = view.slug === current
        const Icon = TAB_ICON[view.kind]
        return (
          <span
            key={view.slug}
            className={cn(
              'flex min-h-control items-center rounded-hs',
              active ? 'bg-fill-hover text-body' : 'text-secondary hover:bg-fill hover:text-body',
            )}
          >
            <Link
              href={href(view)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex max-w-56 items-center gap-2 truncate py-1 pl-3 font-normal text-current no-underline',
                view.id && canWrite ? 'pr-1' : 'pr-3',
              )}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{view.name}</span>
              {view.isShared ? null : <span className="text-small text-secondary">(mine)</span>}
            </Link>
            {view.id && canWrite ? (
              <DropdownMenu
                label={`Actions for ${view.name}`}
                groups={menuFor(view)}
                trigger={(props) => (
                  <button
                    {...props}
                    type="button"
                    disabled={busy}
                    className="mr-1 rounded-pill p-1 text-secondary hover:bg-fill-hover hover:text-body disabled:cursor-not-allowed"
                  >
                    <MoreHorizontal aria-hidden="true" className="size-4" />
                    <span className="sr-only">Actions for {view.name}</span>
                  </button>
                )}
              />
            ) : null}
          </span>
        )
      })}

      {unpinned.length > 0 ? (
        <DropdownMenu
          label="All views"
          align="start"
          groups={[
            {
              key: 'views',
              label: 'Not pinned',
              items: unpinned.map((view) => ({
                key: view.slug,
                label: view.name,
                href: href(view),
                hint: view.isShared ? undefined : 'mine',
              })),
            },
          ]}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              className="flex min-h-control items-center gap-1 rounded-hs px-3 py-1 text-secondary hover:bg-fill hover:text-body"
            >
              All views
              <Badge tone="neutral">{unpinned.length}</Badge>
              <ChevronDown aria-hidden="true" className="size-4" />
            </button>
          )}
        />
      ) : null}

      {canWrite ? (
        <Link
          href={`${currentHref}${currentHref.includes('?') ? '&' : '?'}view=new`}
          aria-label="Add view"
          title="Add view"
          className="grid size-8 place-items-center rounded-pill text-body no-underline hover:bg-fill"
        >
          <Plus aria-hidden="true" className="size-4" />
        </Link>
      ) : null}

      {kinds.length > 1 ? (
        <span className="ml-auto flex h-control items-center gap-0.5 rounded-pill border border-line px-0.5">
          {kinds.map((kind) => {
            const Icon = KIND_ICON[kind]
            return (
              <Link
                key={kind}
                href={href({ slug: current }, kind)}
                aria-current={currentKind === kind ? 'true' : undefined}
                aria-label={KIND_LABEL[kind]}
                title={KIND_LABEL[kind]}
                className={cn(
                  'grid size-7 place-items-center rounded-pill text-body no-underline',
                  currentKind === kind ? 'border border-line-strong bg-surface' : 'hover:bg-fill',
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
              </Link>
            )
          })}
        </span>
      ) : null}

      <RenamePrompt
        value={renaming?.name ?? null}
        label="View name"
        title="Rename this view"
        busy={busy}
        onCancel={() => setRenaming(null)}
        onRename={(name) => {
          const view = renaming
          if (!view?.id) return
          void run('Renamed.', async () => {
            await api.crm.views.rename.mutate({ id: view.id!, name })
            setRenaming(null)
          })
        }}
      />
    </div>
  )
}
