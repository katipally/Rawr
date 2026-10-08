'use client'

import { Button, cn, Popover } from '@rawr/ui'
import { Check, ChevronDown } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useRef, useState } from 'react'
import { todayIn } from '~/lib/format.ts'
import { rangeLabel } from '~/lib/range-label.ts'
import { useFormat, useZone } from '~/components/zone.tsx'

/** The range every report reads, kept in the URL so a report somebody found worth
 *  looking at is a link they can send. Drawn as HubSpot's date quick filter: one
 *  ghost button naming the range, and a panel of presets and a custom range. */

const PRESETS = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
  { key: '365', label: 'Last 12 months', days: 365 },
] as const

const iso = (date: Date): string => date.toISOString().slice(0, 10)

const startOf = (to: string, days: number): string => {
  const start = new Date(`${to}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return iso(start)
}

/** A preset's name, or the two days, for the tag a dashboard card carries. */
export const useRangeLabel = (from: string, to: string): string => {
  const fmt = useFormat()
  return PRESETS.find((entry) => startOf(to, entry.days) === from)?.label ?? rangeLabel(from, to, fmt.today(), fmt)
}

const item =
  'flex h-10 w-full items-center gap-2 px-5 text-left font-normal text-body transition-all duration-150 ease-out hover:bg-fill focus-visible:bg-fill outline-none'

export const RangePicker = ({ from, to }: { from: string; to: string }) => {
  const router = useRouter()
  const zone = useZone()
  const pathname = usePathname()
  const search = useSearchParams()
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ from, to })
  const label = useRangeLabel(from, to)
  const preset = PRESETS.find((entry) => startOf(to, entry.days) === from)

  const go = (next: { from: string; to: string }) => {
    const params = new URLSearchParams(search.toString())
    params.set('from', next.from)
    params.set('to', next.to)
    setOpen(false)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setDraft({ from, to })
          setOpen(!open)
        }}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-pill p-3 font-semibold text-body transition-all duration-150 ease-out hover:bg-fill"
      >
        <span className="shrink-0 font-light">Date range:</span>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={button} align="start" label="Date range" className="w-[min(18rem,calc(100vw-2rem))] py-2">
        <ul>
          {PRESETS.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                className={item}
                onClick={() => {
                  // The last day of the range is the reader's own today, not the
                  // container's, so "Last 7 days" ends on the day they are looking at.
                  const end = todayIn(zone)
                  go({ from: startOf(end, entry.days), to: end })
                }}
              >
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <Check aria-hidden="true" className={cn('size-4 shrink-0', preset?.key !== entry.key && 'invisible')} />
              </button>
            </li>
          ))}
        </ul>

        <form
          className="mt-2 flex flex-col gap-2 border-t border-line px-5 pt-3 pb-1"
          onSubmit={(event) => {
            event.preventDefault()
            go(draft)
          }}
        >
          <p className="font-semibold">Custom range</p>
          <div className="flex min-w-0 flex-col gap-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-small text-secondary">From</span>
              <input
                type="date"
                value={draft.from}
                max={draft.to}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                className="w-full min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-small text-secondary">To</span>
              <input
                type="date"
                value={draft.to}
                min={draft.from}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                className="w-full min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5"
              />
            </label>
          </div>
          <Button type="submit" variant="primary" disabled={!draft.from || !draft.to || (draft.from === from && draft.to === to)} className="self-start">
            Apply
          </Button>
        </form>
      </Popover>
    </>
  )
}
