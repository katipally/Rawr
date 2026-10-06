'use client'

import { Button, DiscardConfirm, Field, POP_EXIT_MS, SLIDE_EXIT_MS, TextArea, cn, useDismiss, useOverlay, usePresence, useToast } from '@rawr/ui'
import type { ObjectKey } from '@rawr/db'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Building2, Handshake, Pencil, Plus, UserRound, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FilterBuilder, describeCondition, type FilterField, type Group } from '~/components/crm/filter-builder.tsx'
import { useFormat } from '~/components/zone.tsx'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import type { SegmentRow } from './segment-list.tsx'

export const OBJECT_LABEL: Record<ObjectKey, string> = {
  contact: 'Contacts',
  company: 'Companies',
  deal: 'Deals',
}

const NOUN: Record<ObjectKey, [one: string, many: string]> = {
  contact: ['contact', 'contacts'],
  company: ['company', 'companies'],
  deal: ['deal', 'deals'],
}

const OBJECT_ICON: Record<ObjectKey, ReactNode> = {
  contact: <UserRound aria-hidden="true" className="size-4" />,
  company: <Building2 aria-hidden="true" className="size-4" />,
  deal: <Handshake aria-hidden="true" className="size-4" />,
}

const EMPTY: Group[] = [{ conjunction: 'and', conditions: [] }]

const conditionCount = (groups: Group[]) => groups.reduce((sum, group) => sum + group.conditions.length, 0)

/** The dark bar's two pill shapes: outlined on the charcoal, and the white one
 *  that moves forward. */
const darkPill =
  'inline-flex min-h-[2.4375rem] shrink-0 items-center gap-1 rounded-pill border border-nav-line bg-nav px-6 font-semibold text-nav-text transition-all duration-150 ease-out hover:bg-nav-hover disabled:cursor-not-allowed disabled:opacity-60'
const lightPill =
  'inline-flex min-h-[2.4375rem] shrink-0 items-center gap-1 rounded-pill border border-cta bg-surface px-6 font-semibold text-body transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:opacity-60'

const Tile = ({
  name,
  checked,
  onSelect,
  icon,
  title,
  detail,
}: {
  name: string
  checked: boolean
  onSelect: () => void
  icon?: ReactNode
  title: string
  detail?: string
}) => (
  <label
    className={cn(
      'flex min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-hs border px-4 py-3 transition-all duration-150 ease-out has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-line-interactive',
      checked ? 'border-body bg-canvas' : 'border-line-strong bg-surface hover:bg-fill',
    )}
  >
    <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
    {icon}
    <span className="flex min-w-0 flex-col">
      <span className="font-semibold">{title}</span>
      {detail ? <span className="text-small text-secondary">{detail}</span> : null}
    </span>
  </label>
)

/** A segment's rule read out the way HubSpot's segment page shows it: one boxed
 *  group per AND, each condition a grey row, the groups' own and/or between them. */
export const SegmentConditions = ({ fields, filters }: { fields: FilterField[]; filters: Group[] }) => {
  const groups = filters.filter((group) => group.conditions.length > 0)
  return (
    <ol className="flex flex-col gap-2">
      {groups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a group has no identity but its place
        <Fragment key={index}>
          {index > 0 ? <li className="text-center text-small font-bold">AND</li> : null}
          <li className="flex flex-col gap-2 rounded-panel border border-line p-2">
            <span className="px-1 font-semibold">Group {index + 1}</span>
            <ul className="flex flex-col gap-1">
              {group.conditions.map((condition, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: conditions repeat, their place is the key
                <Fragment key={at}>
                  {at > 0 ? <li className="px-2 text-small text-secondary">{group.conjunction}</li> : null}
                  <li className="min-w-0 break-words rounded-panel bg-canvas p-2">{describeCondition(fields, condition)}</li>
                </Fragment>
              ))}
            </ul>
          </li>
        </Fragment>
      ))}
    </ol>
  )
}

export type SegmentBuilderProps = {
  open: boolean
  /** An active segment to change, or null for a new one. */
  segment: SegmentRow | null
  /** A new one starts as a static list. */
  startStatic: boolean
  fieldsByObject: Record<string, FilterField[]>
  onClose: () => void
  onSaved: (id: string) => void
}

/** HubSpot's segment builder: the whole window, a dark bar with Exit and Next,
 *  the records and the kind first, then the filters beside a live count, then a
 *  review panel that saves and processes in one go.
 *
 *  The kind is chosen on the first screen rather than at the end, because a
 *  static list here holds no conditions: picking Static skips the filters. */
export const SegmentBuilder = ({ open, segment, startStatic, fieldsByObject, onClose, onSaved }: SegmentBuilderProps) => {
  const fmt = useFormat()
  const toast = useToast()
  const queryClient = useQueryClient()
  const layer = useRef<HTMLDivElement>(null)

  const [step, setStep] = useState<'object' | 'filters'>('object')
  const [reviewing, setReviewing] = useState(false)
  const [object, setObject] = useState<ObjectKey>('contact')
  const [isStatic, setIsStatic] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [filters, setFilters] = useState<Group[]>(EMPTY)
  const [editingFilters, setEditingFilters] = useState(false)
  const [preview, setPreview] = useState<{ count: number; sample: { id: string; displayName: string }[] } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [seededName, setSeededName] = useState('')

  const runPreview = async (on: ObjectKey, next: Group[]) => {
    setPreview(null)
    if (conditionCount(next) === 0) return
    setPreviewing(true)
    try {
      setPreview(await queryClient.fetchQuery({ ...trpc.segments.preview.queryOptions({ object: on, filters: next as never }), staleTime: 0 }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setPreviewing(false)
    }
  }

  // Seeded on every open, so a second "Create segment" does not reopen the last
  // draft and an edit opens on the segment's own values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only opening reseeds, not a refreshed copy of the same segment
  useEffect(() => {
    if (!open) return
    const seedName = segment?.name ?? `Unnamed segment ${fmt.dateTime(new Date().toISOString())}`
    setStep(segment ? 'filters' : 'object')
    setReviewing(false)
    setObject(segment?.objectKey ?? 'contact')
    setIsStatic(segment ? false : startStatic)
    setName(seedName)
    setSeededName(seedName)
    setDescription(segment?.description ?? '')
    setFilters(segment && segment.filters.length > 0 ? segment.filters : EMPTY)
    setEditingFilters(false)
    setPreview(null)
    if (segment) void runPreview(segment.objectKey, segment.filters)
  }, [open, segment?.id])

  const count = conditionCount(filters)
  const dirty =
    name !== seededName ||
    description !== (segment?.description ?? '') ||
    JSON.stringify(filters) !== JSON.stringify(segment && segment.filters.length > 0 ? segment.filters : EMPTY)

  const { asking, dismiss, keep, discard } = useDismiss(open, dirty, onClose)
  // Escape on the review panel steps back to the filters rather than leaving.
  const shown = useOverlay(open, () => (reviewing ? setReviewing(false) : dismiss()), layer)
  const { present, closing } = usePresence(shown, POP_EXIT_MS)
  const review = usePresence(shown && reviewing, SLIDE_EXIT_MS)

  if (!present) return null

  const save = async () => {
    setBusy(true)
    try {
      const { id } = isStatic
        ? await api.segments.createList.mutate({ object, name, description: description || null })
        : await api.segments.save.mutate({ id: segment?.id ?? null, object, name, description: description || null, filters: filters as never })
      if (!isStatic) {
        const result = await api.segments.evaluate.mutate({ id })
        toast('success', `Saved. ${fmt.number(result.members)} ${result.members === 1 ? 'record is' : 'records are'} in it.`)
      } else {
        toast('success', 'List created. Add records to it from the bulk bar on any list.')
      }
      void queryClient.invalidateQueries(trpc.segments.pathFilter())
      // Left busy: the page moves to the segment, and a second click in the
      // meantime would save it twice.
      onSaved(id)
    } catch (cause) {
      toast('error', errorMessage(cause))
      setBusy(false)
    }
  }

  const next = () => {
    if (step === 'object' && !isStatic) setStep('filters')
    else setReviewing(true)
  }
  const nextBlocked = step === 'filters' && count === 0

  return createPortal(
    <div
      ref={layer}
      role="dialog"
      aria-modal="true"
      aria-label={segment ? `Edit ${segment.name}` : 'Create segment'}
      inert={closing}
      className={cn(
        'fixed inset-0 z-overlay flex flex-col bg-surface text-body motion-reduce:animate-none',
        closing ? 'animate-fade-out' : 'animate-fade-in',
      )}
    >
      <header
        inert={asking || reviewing}
        className="grid min-h-14 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 bg-nav px-2 text-nav-text"
      >
        <button type="button" onClick={dismiss} className={darkPill}>
          Exit
        </button>
        {step === 'object' ? (
          <h2 className="truncate text-center text-xl font-normal">Choose who you&apos;d like to segment</h2>
        ) : (
          <label className="mx-auto flex max-w-full min-w-0 items-center gap-2">
            <span className="sr-only">Segment name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              size={Math.max(8, Math.min(name.length, 60))}
              className="min-w-0 truncate rounded-hs bg-transparent px-1 text-center text-xl text-nav-text outline-none focus-visible:ring-2 focus-visible:ring-nav-line"
            />
            <Pencil aria-hidden="true" className="size-4 shrink-0" />
          </label>
        )}
        <span className="flex items-center gap-2">
          {step === 'filters' && !segment ? (
            <button type="button" onClick={() => setStep('object')} className={darkPill}>
              Back
            </button>
          ) : null}
          <button type="button" onClick={next} disabled={nextBlocked} title={nextBlocked ? 'Add a filter first' : undefined} className={lightPill}>
            Next
          </button>
        </span>
      </header>

      <div inert={asking || reviewing} className="relative flex min-h-0 flex-1 flex-col">
        {step === 'object' ? (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,35rem)_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col gap-6 overflow-y-auto p-6">
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 font-semibold">Create a segment of...</legend>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-2.5">
                  {(Object.keys(OBJECT_LABEL) as ObjectKey[]).map((key) => (
                    <Tile
                      key={key}
                      name="segment-object"
                      checked={object === key}
                      onSelect={() => {
                        setObject(key)
                        setFilters(EMPTY)
                        setPreview(null)
                      }}
                      icon={OBJECT_ICON[key]}
                      title={OBJECT_LABEL[key]}
                    />
                  ))}
                </div>
              </fieldset>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 font-semibold">Segment type</legend>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-2.5">
                  <Tile name="segment-type" checked={!isStatic} onSelect={() => setIsStatic(false)} title="Active" detail="Keeps itself up to date from its filters." />
                  <Tile name="segment-type" checked={isStatic} onSelect={() => setIsStatic(true)} title="Static" detail="Holds whoever you put in it." />
                </div>
              </fieldset>
            </div>
            <div className="hidden min-h-0 overflow-y-auto bg-canvas p-10 lg:block">
              <div className="flex max-w-3xl flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel">
                <h3 className="text-lg font-normal">Who is in it, and why</h3>
                <p className="text-secondary">
                  An active segment is recomputed on a schedule and whenever you ask. Entering and leaving both land on
                  each record&apos;s timeline, so a contact who left last month still shows why.
                </p>
                <p className="text-secondary">
                  A static list is a snapshot you keep by hand: fill it from the bulk bar on any list of records, or
                  from an imported file.
                </p>
                <p className="text-secondary">A contact segment is also the audience a newsletter is pushed to in Brevo.</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-2 lg:overflow-hidden">
            <section aria-label="Filters" className="flex min-h-0 flex-col gap-4 p-6 lg:overflow-y-auto lg:border-r lg:border-line">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Include</span>
                <span className="inline-flex h-[1.4375rem] items-center rounded-hs border border-tag-object bg-tag-object-subtle px-2 text-small font-semibold">
                  {OBJECT_LABEL[object]}
                </span>
                {segment ? null : (
                  <button type="button" onClick={() => setStep('object')} className="inline-flex items-center gap-1 font-semibold text-link hover:underline">
                    <ArrowLeftRight aria-hidden="true" className="size-3.5" />
                    Change object
                  </button>
                )}
              </p>
              {editingFilters ? (
                <FilterBuilder
                  fields={fieldsByObject[object] ?? []}
                  relativeDates
                  value={filters}
                  onApply={(groups) => {
                    const kept = groups.length > 0 ? groups : EMPTY
                    setFilters(kept)
                    setEditingFilters(false)
                    void runPreview(object, kept)
                  }}
                  onClose={() => setEditingFilters(false)}
                />
              ) : count === 0 ? (
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <p>This segment doesn&apos;t have any filters</p>
                  <Button icon={<Plus aria-hidden="true" className="size-3.5" />} onClick={() => setEditingFilters(true)}>
                    Add filter
                  </Button>
                </div>
              ) : (
                <>
                  <SegmentConditions fields={fieldsByObject[object] ?? []} filters={filters} />
                  <Button className="self-start" icon={<Pencil aria-hidden="true" className="size-3.5" />} onClick={() => setEditingFilters(true)}>
                    Edit filters
                  </Button>
                </>
              )}
            </section>
            <section aria-label="Matching records" aria-live="polite" className="flex min-h-0 flex-col gap-3 border-t border-line p-6 lg:overflow-y-auto lg:border-t-0">
              {count === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
                  <p className="text-lg font-medium">Add filters to start building your segment</p>
                  <p className="text-secondary">Your filtered results will appear here.</p>
                </div>
              ) : previewing || preview === null ? (
                <p className="text-secondary">Counting the records that match…</p>
              ) : (
                <>
                  <p className="flex flex-col">
                    <span className="font-semibold">Estimated segment size</span>
                    <span className="text-xl font-medium">
                      {fmt.number(preview.count)} {NOUN[object][preview.count === 1 ? 0 : 1]}
                    </span>
                  </p>
                  {preview.sample.length > 0 ? (
                    <ul className="flex flex-col divide-y divide-line rounded-panel border border-line">
                      {preview.sample.map((entry) => (
                        <li key={entry.id} className="min-w-0 truncate px-4 py-2" title={entry.displayName}>
                          {entry.displayName}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-secondary">
                      Nothing matches yet. That is allowed: a segment can be built before the records that belong in it exist.
                    </p>
                  )}
                  {preview.count > preview.sample.length ? (
                    <p className="text-small text-secondary">
                      The first {fmt.number(preview.sample.length)} of {fmt.number(preview.count)}.
                    </p>
                  ) : null}
                </>
              )}
            </section>
          </div>
        )}

      </div>
      {review.present ? (
        <>
          <div
            aria-hidden="true"
            onClick={() => setReviewing(false)}
            className={cn('absolute inset-0 bg-scrim motion-reduce:animate-none', review.closing ? 'animate-fade-out' : 'animate-fade-in')}
          />
          <form
            aria-label="Review and save"
            inert={review.closing}
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
            className={cn(
              'absolute inset-y-0 right-0 flex w-[min(var(--spacing-side-panel),100%)] flex-col border-l border-line bg-surface-raised shadow-side motion-reduce:animate-none',
              review.closing ? 'animate-slide-out' : 'animate-slide-in',
            )}
          >
            <header className="flex min-h-17 shrink-0 items-center justify-between gap-3 border-b border-line py-3 pr-6 pl-[clamp(1rem,5vw,2.5rem)]">
              <h2 className="truncate text-xl font-medium">Review and save</h2>
              <button
                type="button"
                onClick={() => setReviewing(false)}
                aria-label="Close"
                className="shrink-0 rounded-hs p-1 text-secondary hover:bg-fill-hover"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-[clamp(1rem,5vw,2.5rem)] py-6">
              <p className="flex flex-col">
                <span className="font-semibold">Estimated segment size</span>
                <span className="text-xl font-medium text-secondary">
                  {isStatic ? 'Starts empty' : preview ? fmt.number(preview.count) : '--'}
                </span>
              </p>
              <Field id="segment-review-name" label="Segment name">
                <input
                  id="segment-review-name"
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  className="h-10 w-full min-w-0 rounded-hs border border-body bg-surface px-4"
                />
              </Field>
              <p className="flex flex-col">
                <span className="font-semibold">Segment type</span>
                <span>{isStatic ? 'Static: holds whoever you put in it.' : 'Active: recomputed from its filters.'}</span>
              </p>
              <Field id="segment-review-description" label="Description" hint="Optional. Why this segment exists.">
                <TextArea
                  id="segment-review-description"
                  value={description}
                  maxLength={500}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </div>
            <footer className="flex shrink-0 flex-wrap gap-2 border-t border-line px-[clamp(1rem,5vw,2.5rem)] py-4">
              <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
                {isStatic ? 'Save segment' : 'Save and process segment'}
              </Button>
              <Button onClick={() => setReviewing(false)}>Back</Button>
            </footer>
          </form>
        </>
      ) : null}
      {asking ? <DiscardConfirm onKeep={keep} onDiscard={discard} /> : null}
    </div>,
    document.body,
  )
}
