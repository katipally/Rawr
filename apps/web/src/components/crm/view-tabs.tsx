'use client'

import { Badge, Button, DropdownMenu, Modal, RenamePrompt, cn, useToast } from '@rawr/ui'
import { CalendarDays, ChevronDown, Columns3, GripVertical, MoreHorizontal, Pin, Plus, Table2, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useNavigation } from '~/components/navigation.tsx'
import { objectView, tabParams, type ListParams, type ViewKind } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

const TAB_ICON: Record<ViewTab['kind'], typeof Table2> = { table: Table2, board: Columns3, calendar: CalendarDays }

/** The view every link falls back to. dal/views.ts refuses to unpin it, so its tab has no close and no unpin. */
const DEFAULT_TAB = 'all'

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
  params: ListParams
  canWrite: boolean
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
  params,
  canWrite,
}: ViewTabsProps) => {
  const router = useRouter()
  const { navigate } = useNavigation()
  const toast = useToast()
  const [renaming, setRenaming] = useState<ViewTab | null>(null)
  const [deleting, setDeleting] = useState<ViewTab | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)

  const href = (view: { slug: string }, kind: ViewKind = currentKind): string =>
    objectView(account, object, view.slug, kind, tabParams(params))

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
    moveTo(view, order.indexOf(view.id ?? '') + by)
  }

  /** The grip's drop: the dragged tab takes the place of the one it lands on. */
  const moveTo = (view: ViewTab, to: number) => {
    const order = tabs.map((tab) => tab.id).filter((id): id is string => !!id)
    const at = order.indexOf(view.id ?? '')
    if (at < 0 || to < 0 || to >= order.length || to === at) return
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
        ...(view.slug === DEFAULT_TAB
          ? []
          : [
              {
                key: 'pin',
                label: view.pinned ? 'Unpin from the tab bar' : 'Pin as a tab',
                icon: <Pin aria-hidden="true" className="size-4" />,
                onSelect: () =>
                  void run(view.pinned ? 'Unpinned.' : 'Pinned.', () =>
                    api.crm.views.pin.mutate({ id: view.id!, pinned: !view.pinned }),
                  ),
              },
            ]),
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
          // Asked rather than done: a shared view is somebody else's screen too,
          // and a menu item one row below Rename is a menu item that gets hit.
          onSelect: () => setDeleting(view),
        },
      ],
    },
    ]
  }

  /** Closing a tab unpins it; the view itself stays one menu away. The open tab
   *  always shows, so closing it also moves to the tab beside it. */
  const close = (view: ViewTab) =>
    void run('Closed. The view is still under All views.', async () => {
      await api.crm.views.pin.mutate({ id: view.id!, pinned: false })
      const next = tabs.find((tab) => tab.slug !== view.slug)
      navigate(href({ slug: next?.slug ?? 'all' }))
    })

  /** Shown while the pointer is over the tab or focus is inside it, and always on
   *  a device with no hover to show it with. */
  const onHover = 'hidden group-hover/tab:grid group-focus-within/tab:grid aria-expanded:grid [@media(hover:none)]:grid'

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line pb-1">
      {tabs.map((view) => {
        const active = view.slug === current
        const Icon = TAB_ICON[view.kind]
        const movable = Boolean(view.id && canWrite && view.pinned)
        return (
          // A drop target for the grip. Dragging is the pointer shortcut; Move left
          // and Move right in the tab's menu are the way a keyboard does the same.
          // biome-ignore lint/a11y/noStaticElementInteractions: see above
          <span
            key={view.slug}
            draggable={movable}
            onDragStart={(event) => {
              setDragging(view.slug)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              if (dragging && movable) event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              const moved = tabs.find((tab) => tab.slug === dragging)
              setDragging(null)
              if (moved && movable) moveTo(moved, tabs.filter((tab) => tab.id).indexOf(view))
            }}
            className={cn(
              'group/tab flex h-pill max-w-full items-center rounded-hs transition-all duration-150 ease-out',
              active ? 'bg-fill-hover text-body' : 'bg-surface text-secondary hover:bg-fill-hover hover:text-body',
              dragging === view.slug && 'opacity-60',
            )}
          >
            <Link
              href={href(view)}
              aria-current={active ? 'page' : undefined}
              className="flex min-w-0 items-center gap-2 px-3 py-px font-normal text-current no-underline"
            >
              <Icon aria-hidden="true" className={cn('size-4 shrink-0', movable && 'group-hover/tab:hidden')} />
              {movable ? <GripVertical aria-hidden="true" className="hidden size-4 shrink-0 cursor-grab group-hover/tab:block" /> : null}
              <span className="truncate">{view.name}</span>
              {view.isShared ? null : <span className="text-small text-secondary">(mine)</span>}
            </Link>
            {active && movable && view.slug !== DEFAULT_TAB ? (
              <button
                type="button"
                disabled={busy}
                aria-label={`Close the ${view.name} tab`}
                onClick={() => close(view)}
                className={cn('-ml-2 mr-1 size-6 shrink-0 place-items-center rounded-pill hover:bg-fill disabled:cursor-not-allowed', onHover)}
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}
            {view.id && canWrite ? (
              <DropdownMenu
                label={`Actions for ${view.name}`}
                groups={menuFor(view)}
                trigger={(props) => (
                  <button
                    {...props}
                    type="button"
                    disabled={busy}
                    className={cn('-ml-2 mr-1 size-6 shrink-0 place-items-center rounded-pill text-secondary hover:bg-fill hover:text-body disabled:cursor-not-allowed', onHover)}
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

      <Modal
        open={deleting !== null}
        size="sm"
        title="Delete this view?"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() => {
                const view = deleting
                if (!view?.id) return
                void run('View deleted.', async () => {
                  await api.crm.views.remove.mutate({ id: view.id! })
                  setDeleting(null)
                  // The records are still there; only the arrangement went. Land
                  // on the tab every link falls back to rather than on a dead one.
                  navigate(objectView(account, object, 'all', currentKind, tabParams(params)))
                })
              }}
            >
              Delete view
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            {/* The name in full and selectable rather than only in the title,
                which truncates: a view named at length is still a view somebody
                has to be able to recognise before they agree to lose it. */}
            <span className="font-medium break-words select-all">{deleting?.name}</span> goes for
            good. The records stay; only this arrangement of them is deleted.
          </p>
          {deleting?.isShared ? (
            <p className="text-secondary">
              It is shared, so it disappears for everybody in this account, not just for you.
            </p>
          ) : null}
        </div>
      </Modal>

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
