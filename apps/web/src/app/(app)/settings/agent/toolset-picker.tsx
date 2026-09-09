'use client'

import { Button, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

export type CatalogueTool = { name: string; title: string; writes: boolean }
export type CatalogueGroup = {
  key: string
  label: string
  description: string
  isDefault: boolean
  tools: CatalogueTool[]
}

/** Past this a client starts dropping tools it was given, usually without saying
 *  which. The number is the common cap rather than a rule of ours. */
const CROWDED = 100

/** What an agent can reach, and the address that gives it exactly that.
 *
 *  The page used to say "every screen in Rawr has a tool behind it" and then list
 *  none of them, which is a claim nobody could check. This is the list, built from
 *  the live catalogue on every render, so a procedure added to a router appears
 *  here the day it exists.
 *
 *  Ticking a group changes the address, not the person's access: what a token may
 *  do is their role, and a tool left out still runs if something calls it by name. */
export const ToolsetPicker = ({
  endpoint,
  groups,
}: {
  endpoint: string
  groups: CatalogueGroup[]
}) => {
  const toast = useToast()
  const [chosen, setChosen] = useState<string[]>(groups.filter((g) => g.isDefault).map((g) => g.key))
  const [expanded, setExpanded] = useState<string | null>(null)

  const on = (group: CatalogueGroup) => group.key === 'core' || chosen.includes(group.key)
  const toggle = (key: string) =>
    setChosen((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]))

  const selected = groups.filter(on)
  const total = selected.reduce((sum, group) => sum + group.tools.length, 0)

  const defaults = groups.filter((group) => group.isDefault).map((group) => group.key)
  const address =
    selected.length === groups.length
      ? `${endpoint}?toolsets=all`
      : [...defaults].sort().join() === [...selected.map((g) => g.key)].sort().join()
        ? endpoint
        : `${endpoint}?toolsets=${selected.map((group) => group.key).join(',')}`

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast('success', `${what} copied.`)
    } catch {
      toast('error', 'Your browser would not let this page use the clipboard. Select it and copy by hand.')
    }
  }

  return (
    <div className="rounded-panel border border-line p-4">
      <h2 className="font-medium">What an agent can reach</h2>
      <p className="text-secondary">
        Every screen in Rawr has a tool behind it, which is more tools than most clients accept. A connection
        lists the CRM by default and turns the rest on from the address below. A group left off is hidden, not
        forbidden: your role is what decides what any of them may do.
      </p>

      <ul className="mt-4 flex flex-col">
        {groups.map((group) => {
          const open = expanded === group.key
          return (
            <li key={group.key} className="border-b border-divider py-2 last:border-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on(group)}
                    disabled={group.key === 'core'}
                    onChange={() => toggle(group.key)}
                  />
                  <span className="font-medium">{group.label}</span>
                </label>
                <span className="text-small text-secondary">
                  {group.tools.length} {group.tools.length === 1 ? 'tool' : 'tools'}
                </span>
                {group.key === 'core' ? (
                  <span className="text-small text-secondary">
                    always on, because every other tool takes ids and these are what find them
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : group.key)}
                  aria-expanded={open}
                  className="ml-auto flex items-center gap-1 text-small text-secondary"
                >
                  {open ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
                  {open ? 'Hide' : 'Show'} tools
                </button>
              </div>
              <p className="text-small text-secondary">{group.description}</p>
              {open ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {group.tools.map((tool) => (
                    <li key={tool.name} className="flex flex-wrap items-baseline gap-x-3">
                      <code className="text-small break-all">{tool.name}</code>
                      <span className="text-small text-secondary">{tool.writes ? 'writes' : 'reads'}</span>
                      <span className="text-small text-secondary">{tool.title}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="mt-4 border-t border-line pt-4">
        <p className="font-medium">
          {total} {total === 1 ? 'tool' : 'tools'} selected
          {total > CROWDED ? ' — more than most clients accept, so some may be dropped' : ''}
        </p>
        <code className="mt-2 block overflow-x-auto rounded-hs bg-fill p-3 text-small break-all">{address}</code>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => void copy(address, 'Address')}>Copy the address</Button>
          <Button
            variant="secondary"
            onClick={() =>
              void copy(
                JSON.stringify({ mcpServers: { rawr: { type: 'http', url: address } } }, null, 2),
                'Config',
              )
            }
          >
            Copy as JSON config
          </Button>
        </div>
        <p className="mt-2 text-small text-secondary">
          If a client refuses this address because the resource does not match, give it {endpoint} on its own.
          That always works and lists the default groups.
        </p>
      </div>
    </div>
  )
}
