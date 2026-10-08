'use client'

import { Button, DataTable, DropdownMenu, EmptyState, Field, Modal, RenamePrompt, Select, useToast, type Column } from '@rawr/ui'
import { ChevronDown, ChevronLeft, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { PipelineRow, StageRow } from '@rawr/db'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { useFormat } from '~/components/zone.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'
import { StageTable, type StageDraft } from '../stage-table.tsx'

export type PipelineEditorProps = {
  pipelines: PipelineRow[]
  canWrite: boolean
  hub: string
}

type Extra = { probability: number | null; isClosedWon: boolean; isClosedLost: boolean }

/** 0 and 100 are left out: Lost (0%) and Won (100%) already cover them. */
const PROBABILITIES = [10, 20, 30, 40, 50, 60, 70, 80, 90]

/** HubSpot's one probability control: a percentage, or Won or Lost, which close
 *  the deal at 100% and 0%. */
const probabilityValue = (stage: Extra) =>
  stage.isClosedWon ? 'won' : stage.isClosedLost ? 'lost' : stage.probability === null ? '' : String(stage.probability)

const fromProbability = (value: string): Extra =>
  value === 'won'
    ? { probability: 100, isClosedWon: true, isClosedLost: false }
    : value === 'lost'
      ? { probability: 0, isClosedWon: false, isClosedLost: true }
      : { probability: value === '' ? null : Number(value), isClosedWon: false, isClosedLost: false }

const searchBox =
  'h-[2.5rem] w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 font-light placeholder:text-muted'

export const PipelineEditor = ({ pipelines, canWrite, hub }: PipelineEditorProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [pipelineId, setPipelineId] = useUrlParam('pipeline')
  const open = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null
  const [query, setQuery] = useState('')

  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<{ stage: StageRow; pipeline: PipelineRow } | null>(null)
  const [renaming, setRenaming] = useState<PipelineRow | null>(null)
  const [deleting, setDeleting] = useState<PipelineRow | null>(null)
  const [destination, setDestination] = useState('')

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      router.refresh()
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** New stages first, so the order written at the end can name them; then the
   *  edited ones; then the order, once, when it changed or something was added.
   *  One request per changed stage, so O(changed) round trips. */
  const saveStages = (pipeline: PipelineRow, draft: StageDraft<Extra>[], saved: StageRow[]) =>
    run(async () => {
      const ids: string[] = []
      for (const row of draft) {
        const values = { name: row.name.trim(), probability: row.probability, isClosedWon: row.isClosedWon, isClosedLost: row.isClosedLost }
        if (!row.id) {
          ids.push((await api.admin.pipelines.createStage.mutate({ pipelineId: pipeline.id, ...values })).id)
          continue
        }
        ids.push(row.id)
        const before = saved.find((stage) => stage.id === row.id)
        if (
          before &&
          (before.name !== values.name || before.probability !== values.probability || before.isClosedWon !== values.isClosedWon || before.isClosedLost !== values.isClosedLost)
        ) {
          await api.admin.pipelines.updateStage.mutate({ id: row.id, ...values })
        }
      }
      if (ids.some((id, index) => id !== saved[index]?.id) || ids.length !== saved.length) {
        await api.admin.pipelines.reorderStages.mutate({ pipelineId: pipeline.id, orderedIds: ids })
      }
    }, 'Pipeline saved.')

  const needle = query.trim().toLowerCase()
  const shown = needle ? pipelines.filter((pipeline) => pipeline.name.toLowerCase().includes(needle)) : pipelines

  const columns: Column<PipelineRow>[] = [
    {
      key: 'name',
      header: 'Pipeline',
      width: 360,
      render: (pipeline) => (
        <button type="button" title={pipeline.name} onClick={() => setPipelineId(pipeline.id)} className="block max-w-full truncate text-left font-semibold text-link hover:underline">
          {pipeline.name}
        </button>
      ),
    },
    { key: 'stages', header: 'Number of stages', width: 180, align: 'right', render: (pipeline) => <span className="font-light tabular-nums">{fmt.number(pipeline.stages.length)}</span> },
    { key: 'deals', header: 'Deals', width: 160, align: 'right', render: (pipeline) => <span className="font-light tabular-nums">{fmt.number(pipeline.dealCount)}</span> },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!canWrite ? (
        <p className="text-secondary">You need {hub} access to change this. Pipelines decide what every deal in the account means, so only an admin edits them.</p>
      ) : null}

      {open ? (
        <>
          <button type="button" onClick={() => setPipelineId(null)} className="inline-flex items-center gap-1 self-start font-semibold text-link hover:underline">
            <ChevronLeft aria-hidden="true" className="size-4" />
            Back to Pipelines
          </button>
          <h2 className="text-xl font-medium break-words">Manage {open.name}</h2>
          <section className="flex min-w-0 flex-col gap-4 rounded-panel border border-line px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Select aria-label="Pipeline" value={open.id} onChange={(event) => setPipelineId(event.target.value)} className="w-64 max-w-full">
                {pipelines.map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>
                    {pipeline.name}
                  </option>
                ))}
              </Select>
              {canWrite ? (
                <DropdownMenu
                  label={`Actions for ${open.name}`}
                  trigger={(props) => (
                    <Button {...props}>
                      Actions <ChevronDown aria-hidden="true" className="inline size-3 align-middle" />
                    </Button>
                  )}
                  groups={[
                    {
                      key: 'pipeline',
                      items: [
                        { key: 'rename', label: 'Rename pipeline', onSelect: () => setRenaming(open) },
                        { key: 'delete', label: 'Delete pipeline', destructive: true, onSelect: () => setDeleting(open) },
                      ],
                    },
                  ]}
                />
              ) : null}
            </div>
            <p className="text-small text-secondary">
              {fmt.number(open.dealCount)} deal{open.dealCount === 1 ? '' : 's'} in this pipeline. Drag a stage by its grip to reorder it; weighted totals use each stage's probability.
            </p>
            <StageTable<Extra>
              key={JSON.stringify(open.stages)}
              caption={`${open.name} stages`}
              stages={open.stages.map((stage) => ({ id: stage.id, name: stage.name, usedBy: stage.dealCount, probability: stage.probability, isClosedWon: stage.isClosedWon, isClosedLost: stage.isClosedLost }))}
              blank={{ probability: null, isClosedWon: false, isClosedLost: false }}
              usedHeader="Used in"
              canWrite={canWrite}
              busy={busy}
              columns={[
                {
                  header: 'Probability',
                  render: (stage, set, editable) => {
                    const value = probabilityValue(stage)
                    const label = (option: string) =>
                      option === 'won' ? 'Won (100%)' : option === 'lost' ? 'Lost (0%)' : option === '' ? EMPTY_VALUE : `${option}%`
                    if (!editable) return <span className="tabular-nums">{label(value)}</span>
                    const options = ['', ...PROBABILITIES.map(String), 'won', 'lost']
                    return (
                      <Select aria-label={`Probability of ${stage.name || 'the new stage'}`} value={value} onChange={(event) => set(fromProbability(event.target.value))} className="h-control min-h-0 w-36">
                        {(options.includes(value) ? options : [...options, value]).map((option) => (
                          <option key={option} value={option}>
                            {label(option)}
                          </option>
                        ))}
                      </Select>
                    )
                  },
                },
              ]}
              onSave={(draft, saved) =>
                saveStages(open, draft, open.stages.filter((stage) => saved.some((row) => row.id === stage.id)))
              }
              onDelete={(stage) => {
                const row = open.stages.find((candidate) => candidate.id === stage.id)
                if (!row) return
                setRemoving({ stage: row, pipeline: open })
                setDestination('')
              }}
            />
          </section>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="relative w-full min-w-0 @lg:w-[16rem]">
              <span className="sr-only">Search pipelines</span>
              <input type="search" value={query} placeholder="Search pipelines" onChange={(event) => setQuery(event.target.value)} className={searchBox} />
              <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
            </label>
            <span className="flex flex-wrap items-center gap-3">
              <span className="text-secondary tabular-nums">
                {fmt.number(pipelines.length)} deal pipeline{pipelines.length === 1 ? '' : 's'}
              </span>
              {canWrite ? <Button onClick={() => setCreating(true)}>Create pipeline</Button> : null}
            </span>
          </div>
          {shown.length === 0 ? (
            <EmptyState
              title={pipelines.length === 0 ? 'No pipelines yet' : 'No pipeline matches'}
              description={pipelines.length === 0 ? 'A pipeline is the stages a deal moves through. Create one to lay out a board.' : 'Try another name.'}
            />
          ) : (
            <DataTable columns={columns} rows={shown} rowKey={(pipeline) => pipeline.id} caption="Deal pipelines" storageKey="settings.pipelines" />
          )}
        </>
      )}

      <RenamePrompt
        value={creating ? '' : null}
        title="Create pipeline"
        label="Pipeline name"
        confirmLabel="Create"
        busy={busy}
        onCancel={() => setCreating(false)}
        onRename={(name) => {
          void run(async () => {
            const created = await api.admin.pipelines.create.mutate({ name })
            setPipelineId(created.id)
          }, 'Pipeline created.').then((ok) => ok && setCreating(false))
        }}
      />
      <Modal
        open={removing !== null}
        size="sm"
        title={`Delete ${removing?.stage.name ?? ''}`}
        onClose={() => setRemoving(null)}
        footer={
          removing ? (
            <>
              <Button variant="tertiary" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                busy={busy}
                disabled={removing.stage.dealCount > 0 && destination === ''}
                onClick={() =>
                  void run(async () => {
                    const result = await api.admin.pipelines.removeStage.mutate({
                      id: removing.stage.id,
                      destinationStageId: destination || null,
                    })
                    if (result.moved > 0) toast('info', `${result.moved} deal${result.moved === 1 ? '' : 's'} moved.`)
                  }, 'Stage deleted.').then((ok) => ok && setRemoving(null))
                }
              >
                Delete stage
              </Button>
            </>
          ) : null
        }
      >
        {removing ? (
          <div className="flex flex-col gap-3">
            {removing.stage.dealCount === 0 ? (
              <p>No deals sit in this stage, so nothing has to move. Deals already deleted from it go to the first other stage on this pipeline, so Restore still finds them.</p>
            ) : (
              <>
                <p>
                  {fmt.number(removing.stage.dealCount)} deal
                  {removing.stage.dealCount === 1 ? '' : 's'} {removing.stage.dealCount === 1 ? 'sits' : 'sit'} here. Every one of them moves to
                  the stage you pick, and each move is written to its timeline as a stage change,
                  so nobody opens a deal later and finds its history rewritten.
                </p>
                <Field id="stage-destination" label="Move them to">
                  <Select
                    id="stage-destination"
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                  >
                    <option value="">Pick a stage</option>
                    {removing.pipeline.stages
                      .filter((stage) => stage.id !== removing.stage.id)
                      .map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={deleting !== null}
        size="sm"
        title={`Delete ${deleting?.name ?? ''}`}
        onClose={() => setDeleting(null)}
        footer={
          deleting ? (
            <>
              <Button variant="tertiary" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                busy={busy}
                onClick={() =>
                  void run(
                    () => api.admin.pipelines.remove.mutate({ id: deleting.id }),
                    'Pipeline deleted.',
                  ).then((ok) => {
                    if (!ok) return
                    setDeleting(null)
                    setPipelineId(null)
                  })
                }
              >
                Delete pipeline
              </Button>
            </>
          ) : null
        }
      >
        {deleting ? (
          <div className="flex flex-col gap-3">
            <p>
              The pipeline and its {deleting.stages.length} stage
              {deleting.stages.length === 1 ? '' : 's'} go. A pipeline with deals in it is refused,
              so nothing is lost either way, but a board somebody had open stops existing. Deals already deleted from it move to the first stage of the first other pipeline, so Restore still finds them.
            </p>
          </div>
        ) : null}
      </Modal>

      <RenamePrompt
        value={renaming?.name ?? null}
        title={`Rename ${renaming?.name ?? ''}`}
        label="Pipeline name"
        busy={busy}
        onCancel={() => setRenaming(null)}
        onRename={(name) => {
          if (!renaming) return
          void run(
            () => api.admin.pipelines.rename.mutate({ id: renaming.id, name }),
            'Renamed.',
          ).then((ok) => ok && setRenaming(null))
        }}
      />
    </div>
  )
}
