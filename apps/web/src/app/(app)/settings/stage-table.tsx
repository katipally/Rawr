'use client'

import { TextInput, cn } from '@rawr/ui'
import { GripVertical, Plus } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { SaveBar } from '~/components/save-bar.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'

/** A stage as it is being edited: `id` is null until a new one has been saved,
 *  and `key` is what the row is drawn under either way. */
export type StageDraft<Extra> = Extra & { key: string; id: string | null; name: string; usedBy: number }

export type StageColumn<Extra> = {
  header: string
  render: (stage: StageDraft<Extra>, set: (patch: Partial<Extra>) => void, canWrite: boolean) => ReactNode
}

const th = 'h-11 border-b border-line-strong bg-surface px-6 pt-2 pb-1 text-left font-normal text-secondary'
const td = 'border-b border-line px-6 py-4 font-light'

/** HubSpot's stage table under a pipeline and the lifecycle: a name per row typed
 *  in place, a grip to drag the row by, how many records sit in it, and Delete on
 *  the hovered row. Nothing is written until the save bar's Save, which sends what
 *  changed; Cancel puts the saved stages back. Remount it with the saved stages as
 *  its key so a refresh after a save starts it clean. */
export const StageTable = <Extra,>({
  caption,
  stages,
  blank,
  columns,
  usedHeader,
  canWrite,
  busy,
  onSave,
  onDelete,
}: {
  caption: string
  stages: (Extra & { id: string; name: string; usedBy: number })[]
  /** What a newly added row starts with beyond its name. */
  blank: Extra
  columns: StageColumn<Extra>[]
  usedHeader: string
  canWrite: boolean
  busy: boolean
  /** Resolves true when every change was written, so the draft can be dropped. */
  onSave: (draft: StageDraft<Extra>[], saved: typeof stages) => Promise<boolean>
  onDelete: (stage: (typeof stages)[number]) => void
}) => {
  const fmt = useFormat()
  const form = useId()
  const seed = (): StageDraft<Extra>[] => stages.map((stage) => ({ ...stage, key: stage.id }))
  const [draft, setDraft] = useState(seed)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const savedById = new Map(stages.map((stage) => [stage.id, stage]))
  const changedRow = (row: StageDraft<Extra>) => {
    if (!row.id) return true
    const saved = savedById.get(row.id)
    return !saved || JSON.stringify({ ...saved, key: row.key }) !== JSON.stringify(row)
  }
  const reordered = draft.filter((row) => row.id).some((row, index) => row.id !== stages[index]?.id)
  const changes = draft.filter(changedRow).length + (reordered ? 1 : 0)

  const set = (key: string, patch: Partial<StageDraft<Extra>>) =>
    setDraft((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= draft.length) return
    setDraft((rows) => {
      const next = [...rows]
      const [moved] = next.splice(from, 1)
      if (moved) next.splice(to, 0, moved)
      return next
    })
  }

  return (
    <form
      id={form}
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.some((row) => !row.name.trim())) return
        void onSave(draft, stages)
      }}
      className="min-w-0 overflow-x-auto"
    >
      <table className="w-full min-w-[40rem] border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {canWrite ? <th className={cn(th, 'w-8 px-0')}><span className="sr-only">Order</span></th> : null}
            <th className={th}>Stage name</th>
            {columns.map((column) => (
              <th key={column.header} className={th}>{column.header}</th>
            ))}
            <th className={cn(th, 'text-right')}>{usedHeader}</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((row, index) => (
            <tr
              key={row.key}
              onDragOver={(event) => {
                if (dragging === null) return
                event.preventDefault()
                setOver(index)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null) move(dragging, index)
                setDragging(null)
                setOver(null)
              }}
              className={cn(
                'transition-colors duration-150 ease-out hover:bg-fill',
                dragging === index && 'opacity-50',
                over === index && dragging !== null && dragging !== index && 'shadow-[inset_0_2px_0_var(--color-link)]',
              )}
            >
              {canWrite ? (
                <td className={cn(td, 'px-0 text-center')}>
                  <button
                    type="button"
                    draggable
                    aria-label={`Move ${row.name || 'new stage'}: drag, or use the arrow keys`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      setDragging(index)
                    }}
                    onDragEnd={() => {
                      setDragging(null)
                      setOver(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      move(index, index + (event.key === 'ArrowUp' ? -1 : 1))
                    }}
                    className="grid size-6 cursor-grab place-items-center rounded-hs text-secondary hover:bg-fill-hover active:cursor-grabbing"
                  >
                    <GripVertical aria-hidden="true" className="size-4" />
                  </button>
                </td>
              ) : null}
              <td className={cn(td, 'min-w-48')}>
                {canWrite ? (
                  <TextInput
                    aria-label="Stage name"
                    value={row.name}
                    required
                    autoFocus={!row.id && index === draft.length - 1}
                    onChange={(event) => set(row.key, { name: event.target.value } as Partial<StageDraft<Extra>>)}
                    className="h-control min-h-0 w-full"
                  />
                ) : (
                  <span className="break-words">{row.name}</span>
                )}
              </td>
              {columns.map((column) => (
                <td key={column.header} className={td}>
                  {column.render(row, (patch) => set(row.key, patch as Partial<StageDraft<Extra>>), canWrite)}
                </td>
              ))}
              <td className={cn(td, 'text-right')}>
                <span className="flex items-center justify-end gap-3">
                  {canWrite ? (
                    <RowActions>
                      <button
                        type="button"
                        className={rowPill}
                        disabled={busy || (row.id !== null && changes > 0)}
                        title={row.id !== null && changes > 0 ? 'Save or cancel your changes first' : undefined}
                        onClick={() => {
                          const saved = row.id ? savedById.get(row.id) : null
                          if (saved) onDelete(saved)
                          else setDraft((rows) => rows.filter((other) => other.key !== row.key))
                        }}
                      >
                        Delete
                      </button>
                    </RowActions>
                  ) : null}
                  <span className="tabular-nums">{fmt.number(row.usedBy)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft.length === 0 ? <p className="px-6 py-4 text-secondary">No stages yet.</p> : null}
      {canWrite ? (
        <button
          type="button"
          onClick={() => setDraft((rows) => [...rows, { ...blank, key: `new-${rows.length}-${Date.now()}`, id: null, name: '', usedBy: 0 }])}
          className="mt-3 ml-6 inline-flex items-center gap-1 font-semibold text-link hover:underline"
        >
          <Plus aria-hidden="true" className="size-4" />
          Add stage
        </button>
      ) : null}
      <SaveBar form={form} changes={changes} busy={busy} onCancel={() => setDraft(seed())} />
    </form>
  )
}
