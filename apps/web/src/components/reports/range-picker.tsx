'use client'

import { Button, Select } from '@rawr/ui'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'

/** The range every report reads, kept in the URL so a report somebody found worth
 *  looking at is a link they can send. */

const PRESETS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '365', label: 'Last 12 months', days: 365 },
] as const

const iso = (date: Date): string => date.toISOString().slice(0, 10)

export const RangePicker = ({ from, to }: { from: string; to: string }) => {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const [draft, setDraft] = useState({ from, to })

  const go = (next: { from: string; to: string }) => {
    const params = new URLSearchParams(search.toString())
    params.set('from', next.from)
    params.set('to', next.to)
    router.push(`${pathname}?${params.toString()}`)
  }

  const preset = PRESETS.find((entry) => {
    const start = new Date(`${to}T00:00:00Z`)
    start.setUTCDate(start.getUTCDate() - (entry.days - 1))
    return iso(start) === from
  })

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-small text-secondary">Range</span>
        <Select
          value={preset?.key ?? 'custom'}
          onChange={(event) => {
            const chosen = PRESETS.find((entry) => entry.key === event.target.value)
            if (!chosen) return
            const end = new Date()
            const start = new Date(end)
            start.setUTCDate(start.getUTCDate() - (chosen.days - 1))
            const next = { from: iso(start), to: iso(end) }
            setDraft(next)
            go(next)
          }}
        >
          {PRESETS.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
          {preset ? null : <option value="custom">A range you picked</option>}
        </Select>
      </label>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-small text-secondary">From</span>
        <input
          type="date"
          value={draft.from}
          max={draft.to}
          onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          className="min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5"
        />
      </label>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-small text-secondary">To</span>
        <input
          type="date"
          value={draft.to}
          min={draft.from}
          onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          className="min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5"
        />
      </label>

      <Button
        disabled={draft.from === from && draft.to === to}
        onClick={() => go(draft)}
      >
        Apply
      </Button>
    </div>
  )
}
