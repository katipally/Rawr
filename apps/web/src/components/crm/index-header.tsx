'use client'

import { Button, DropdownMenu, IconButton } from '@rawr/ui'
import { ChevronDown, MoreVertical } from 'lucide-react'
import type { ReactNode } from 'react'

export type IndexObject = { key: string; label: string; href: string }

export type IndexHeaderProps = {
  /** The object on screen. */
  title: string
  /** Every object a person can switch to from the caret beside the title. */
  objects: IndexObject[]
  currentObject: string
  /** The "Add" menu: create, import. Empty for a role that cannot write. */
  add: { label: string; href: string }[]
  addLabel: string
  /** The overflow menu at the right of the title row. */
  more: { key: string; label: string; href: string }[]
  /** Anything else that sits between the overflow and the Add button. */
  children?: ReactNode
}

/** HubSpot's index-page header: the object name with a caret that switches
 *  object, and at the right an overflow menu and the "Add" button. */
export const IndexHeader = ({ title, objects, currentObject, add, addLabel, more, children }: IndexHeaderProps) => (
  <div className="flex flex-wrap items-center justify-between gap-2">
    <DropdownMenu
      label="Switch object"
      align="start"
      groups={[
        {
          key: 'objects',
          items: objects.map((object) => ({
            key: object.key,
            label: object.label,
            href: object.href,
            checked: object.key === currentObject,
          })),
        },
      ]}
      trigger={(props) => (
        <button {...props} type="button" className="flex min-w-0 items-center gap-1 rounded-hs text-2xl font-normal hover:bg-fill">
          <h1 className="min-w-0 truncate">{title}</h1>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        </button>
      )}
    />
    <div className="flex shrink-0 items-center gap-2">
      {more.length > 0 ? (
        <DropdownMenu
          label="More"
          groups={[{ key: 'more', items: more }]}
          trigger={(props) => (
            <IconButton {...props} label="More" icon={<MoreVertical className="size-4" />} className="border border-line-strong text-body" />
          )}
        />
      ) : null}
      {children}
      {add.length > 0 ? (
        <DropdownMenu
          label={addLabel}
          groups={[{ key: 'add', items: add.map((item) => ({ key: item.href, label: item.label, href: item.href })) }]}
          trigger={(props) => (
            <Button {...props} variant="primary" className="whitespace-nowrap">
              <span className="flex items-center gap-1">
                {addLabel}
                <ChevronDown aria-hidden="true" className="size-3" />
              </span>
            </Button>
          )}
        />
      ) : null}
    </div>
  </div>
)
