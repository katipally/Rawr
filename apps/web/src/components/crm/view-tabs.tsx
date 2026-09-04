'use client'

import { Badge, DropdownMenu, RenamePrompt, cn, useToast } from '@rawr/ui'
import { ChevronDown, MoreHorizontal, Pin, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { useNavigation } from '~/components/navigation.tsx'
import { objectView, type ListParams } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

export type ViewTab = {
  /** Null for the view every workspace falls back to before one is saved. It has
   *  no row, so it cannot be renamed, pinned or deleted. */
  id: string | null
  slug: string
  name: string
  kind: 'table' | 'board'
  isShared: boolean
  pinned: boolean
}

export type ViewTabsProps = {
  workspace: string
  object: ObjectKey
  views: ViewTab[]
  current: string
  currentKind: 'list' | 'board'
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
 *  workspace with forty saved views from wrapping the bar onto four lines. */
export const ViewTabs = ({
  workspace,
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
  const [busy, setBusy] = useState(false)

  const href = (view: { slug: string }, kind: 'list' | 'board' = currentKind): string =>
    objectView(workspace, object, view.slug, kind, withoutCursor(params))

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

  const menuFor = (view: ViewTab) => [
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
              navigate(objectView(workspace, object, 'all', currentKind, withoutCursor(params)))
            }),
        },
      ],
    },
  ]

  return (
    <div className="flex flex-wrap items-end gap-x-1 gap-y-1 border-b border-divider">
      {tabs.map((view) => {
        const active = view.slug === current
        return (
          <span
            key={view.slug}
            className={cn(
              '-mb-px flex items-center border-b-2',
              active ? 'border-accent' : 'border-transparent',
            )}
          >
            <Link
              href={href(view)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'max-w-56 truncate py-1.5 pl-3 font-medium no-underline',
                active ? 'text-link' : 'text-secondary hover:text-body',
                view.id && canWrite ? 'pr-1' : 'pr-3',
              )}
            >
              {view.name}
              {view.isShared ? null : <span className="ml-1 text-small text-secondary">(mine)</span>}
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
                    className="mr-1 rounded-hs p-1 text-secondary hover:bg-fill-hover hover:text-body disabled:cursor-not-allowed"
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
              className="-mb-px flex items-center gap-1 border-b-2 border-transparent px-3 py-1.5 text-secondary hover:text-body"
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
          className="-mb-px flex items-center gap-1 border-b-2 border-transparent px-2 py-1.5 text-secondary no-underline hover:text-body"
        >
          <Plus aria-hidden="true" className="size-4" />
          Add view
        </Link>
      ) : null}

      {object === 'deal' ? (
        <span className="ml-auto flex gap-1 pb-1">
          {(['list', 'board'] as const).map((kind) => (
            <Link
              key={kind}
              href={href({ slug: current }, kind)}
              aria-current={currentKind === kind ? 'true' : undefined}
              className={cn(
                'rounded-hs border px-2 py-1 no-underline',
                currentKind === kind ? 'border-line-interactive bg-accent-subtle text-link' : 'border-line text-secondary',
              )}
            >
              {kind === 'list' ? 'Table' : 'Board'}
            </Link>
          ))}
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
