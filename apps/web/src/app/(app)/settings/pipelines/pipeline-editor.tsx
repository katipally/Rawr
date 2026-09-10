'use client'

import { Button, Field, IconButton, Modal, RenamePrompt, Select, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { PipelineRow, StageRow } from '@rawr/db'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

export type PipelineEditorProps = {
  pipelines: PipelineRow[]
  canWrite: boolean
  hub: string
}

export const PipelineEditor = ({ pipelines, canWrite, hub }: PipelineEditorProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const [newPipeline, setNewPipeline] = useState('')
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [stageName, setStageName] = useState('')
  const [stageProbability, setStageProbability] = useState('')
  const [editing, setEditing] = useState<StageRow | null>(null)
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

  const moveStage = (pipeline: PipelineRow, index: number, by: number) => {
    const next = [...pipeline.stages]
    const target = index + by
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(target, 0, moved)
    void run(
      () =>
        api.admin.pipelines.reorderStages.mutate({
          pipelineId: pipeline.id,
          orderedIds: next.map((stage) => stage.id),
        }),
      'Order saved.',
    )
  }

  if (!canWrite) {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-hs border border-line bg-fill px-3 py-2 text-secondary">
          You need {hub} access to change this. Pipelines decide what every deal
          in the account means, so only an admin edits them.
        </p>
        {pipelines.map((pipeline) => (
          <ReadOnlyPipeline key={pipeline.id} pipeline={pipeline} />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(() => api.admin.pipelines.create.mutate({ name: newPipeline }), 'Pipeline created.').then(
            (ok) => ok && setNewPipeline(''),
          )
        }}
      >
        <Field id="new-pipeline" label="New pipeline">
          <TextInput
            id="new-pipeline"
            value={newPipeline}
            onChange={(event) => setNewPipeline(event.target.value)}
            placeholder="Enterprise"
          />
        </Field>
        <Button variant="primary" busy={busy} disabled={!newPipeline.trim()}>
          Create pipeline
        </Button>
      </form>

      {pipelines.map((pipeline) => (
        <section key={pipeline.id} className="rounded-panel border border-line bg-surface shadow-panel">
          <header className="flex flex-wrap items-center justify-between gap-2 px-6 pt-6 pb-4">
            <h3 className="flex flex-wrap items-baseline gap-2">
              <span className="text-base font-semibold">{pipeline.name}</span>
              <span className="text-small text-secondary">
                {pipeline.stages.length} stage{pipeline.stages.length === 1 ? '' : 's'} ·{' '}
                {pipeline.dealCount.toLocaleString()} deal{pipeline.dealCount === 1 ? '' : 's'}
              </span>
            </h3>
            <span className="flex flex-wrap gap-2">
              <Button
                variant="tertiary"
                busy={busy}
                onClick={() => setRenaming(pipeline)}
              >
                Rename
              </Button>
              <Button variant="destructive" busy={busy} onClick={() => setDeleting(pipeline)}>
                Delete
              </Button>
            </span>
          </header>

          <ul className="flex flex-col">
            {pipeline.stages.length === 0 ? (
              <li className="px-3 py-3 text-secondary">
                No stages yet. A pipeline with no stages cannot lay out a board, so add the first
                one below.
              </li>
            ) : (
              pipeline.stages.map((stage, index) => (
                <li
                  key={stage.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
                >
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{stage.name}</span>
                    <span className="text-small text-secondary tabular-nums">
                      {stage.probability === null ? 'no probability' : `${stage.probability}%`}
                    </span>
                    {stage.isClosedWon ? <span className="text-small text-success">Closed won</span> : null}
                    {stage.isClosedLost ? <span className="text-small text-error">Closed lost</span> : null}
                    <span className="text-small text-secondary tabular-nums">
                      {stage.dealCount.toLocaleString()} deal{stage.dealCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <IconButton
                      label={`Move ${stage.name} up`}
                      icon={<ACTION_ICONS.moveUp size={16} />}
                      disabled={busy || index === 0}
                      onClick={() => moveStage(pipeline, index, -1)}
                    />
                    <IconButton
                      label={`Move ${stage.name} down`}
                      icon={<ACTION_ICONS.moveDown size={16} />}
                      disabled={busy || index === pipeline.stages.length - 1}
                      onClick={() => moveStage(pipeline, index, 1)}
                    />
                    <IconButton
                      label={`Edit ${stage.name}`}
                      icon={<ACTION_ICONS.edit size={16} />}
                      onClick={() => setEditing(stage)}
                    />
                    <IconButton
                      label={`Delete ${stage.name}`}
                      tone="destructive"
                      icon={<ACTION_ICONS.delete size={16} />}
                      onClick={() => {
                        setRemoving({ stage, pipeline })
                        setDestination('')
                      }}
                    />
                  </span>
                </li>
              ))
            )}
          </ul>

          <div className="border-t border-divider px-3 py-2">
            {addingTo === pipeline.id ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(
                    () =>
                      api.admin.pipelines.createStage.mutate({
                        pipelineId: pipeline.id,
                        name: stageName,
                        probability: stageProbability === '' ? null : Number(stageProbability),
                      }),
                    'Stage added.',
                  ).then((ok) => {
                    if (ok) {
                      setStageName('')
                      setStageProbability('')
                      setAddingTo(null)
                    }
                  })
                }}
              >
                <Field id={`stage-name-${pipeline.id}`} label="Stage name">
                  <TextInput
                    id={`stage-name-${pipeline.id}`}
                    value={stageName}
                    onChange={(event) => setStageName(event.target.value)}
                    autoFocus
                  />
                </Field>
                <Field id={`stage-prob-${pipeline.id}`} label="Probability" hint="0 to 100. Blank means none.">
                  <TextInput
                    id={`stage-prob-${pipeline.id}`}
                    type="number"
                    min={0}
                    max={100}
                    value={stageProbability}
                    onChange={(event) => setStageProbability(event.target.value)}
                  />
                </Field>
                <Button variant="primary" busy={busy} disabled={!stageName.trim()}>
                  Add stage
                </Button>
                <Button variant="tertiary" onClick={() => setAddingTo(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button onClick={() => setAddingTo(pipeline.id)}>Add a stage</Button>
            )}
          </div>
        </section>
      ))}

      <Modal open={editing !== null} title={`Edit ${editing?.name ?? ''}`} onClose={() => setEditing(null)}>
        {editing ? <StageForm stage={editing} busy={busy} onSave={async (values) => {
          const ok = await run(() => api.admin.pipelines.updateStage.mutate({ id: editing.id, ...values }), 'Stage saved.')
          if (ok) setEditing(null)
        }} /> : null}
      </Modal>

      <Modal
        open={removing !== null}
        size="sm"
        title={`Delete ${removing?.stage.name ?? ''}`}
        onClose={() => setRemoving(null)}
      >
        {removing ? (
          <div className="flex flex-col gap-3">
            {removing.stage.dealCount === 0 ? (
              <p>No deals sit in this stage, so nothing has to move.</p>
            ) : (
              <>
                <p>
                  {removing.stage.dealCount.toLocaleString()} deal
                  {removing.stage.dealCount === 1 ? '' : 's'} sit here. Every one of them moves to
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
            <div className="flex flex-wrap gap-2">
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
                    if (result.moved > 0) toast('info', `${result.moved} deals moved.`)
                  }, 'Stage deleted.').then((ok) => ok && setRemoving(null))
                }
              >
                Delete stage
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={deleting !== null}
        size="sm"
        title={`Delete ${deleting?.name ?? ''}`}
        onClose={() => setDeleting(null)}
      >
        {deleting ? (
          <div className="flex flex-col gap-3">
            <p>
              The pipeline and its {deleting.stages.length} stage
              {deleting.stages.length === 1 ? '' : 's'} go. A pipeline with deals in it is refused,
              so nothing is lost either way — but a board somebody had open stops existing.
            </p>
            <div className="flex flex-wrap gap-2">
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
                  ).then((ok) => ok && setDeleting(null))
                }
              >
                Delete pipeline
              </Button>
            </div>
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

const StageForm = ({
  stage,
  busy,
  onSave,
}: {
  stage: StageRow
  busy: boolean
  onSave: (values: { name: string; probability: number | null; isClosedWon: boolean; isClosedLost: boolean }) => void
}) => {
  const [name, setName] = useState(stage.name)
  const [probability, setProbability] = useState(stage.probability === null ? '' : String(stage.probability))
  const [won, setWon] = useState(stage.isClosedWon)
  const [lost, setLost] = useState(stage.isClosedLost)

  return (
    <div className="flex flex-col gap-3">
      <Field id="edit-stage-name" label="Name">
        <TextInput id="edit-stage-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>
      <Field
        id="edit-stage-prob"
        label="Probability"
        hint="Weighted totals use this. Changing it recomputes them on the next board read."
      >
        <TextInput
          id="edit-stage-prob"
          type="number"
          min={0}
          max={100}
          value={probability}
          onChange={(event) => setProbability(event.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={won}
          onChange={(event) => {
            setWon(event.target.checked)
            if (event.target.checked) setLost(false)
          }}
        />
        Closed won
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={lost}
          onChange={(event) => {
            setLost(event.target.checked)
            if (event.target.checked) setWon(false)
          }}
        />
        Closed lost
      </label>
      <div>
        <Button
          variant="primary"
          busy={busy}
          disabled={!name.trim()}
          onClick={() =>
            onSave({
              name,
              probability: probability === '' ? null : Number(probability),
              isClosedWon: won,
              isClosedLost: lost,
            })
          }
        >
          Save stage
        </Button>
      </div>
    </div>
  )
}

const ReadOnlyPipeline = ({ pipeline }: { pipeline: PipelineRow }) => (
  <section className="rounded-panel border border-line bg-surface shadow-panel">
    <header className="px-6 pt-6 pb-4 text-base font-semibold">{pipeline.name}</header>
    <ul className="flex flex-col">
      {pipeline.stages.map((stage) => (
        <li
          key={stage.id}
          className="flex flex-wrap items-baseline gap-x-3 border-b border-divider px-3 py-1.5 last:border-0"
        >
          <span>{stage.name}</span>
          <span className="text-small text-secondary tabular-nums">
            {stage.probability === null ? 'no probability' : `${stage.probability}%`} ·{' '}
            {stage.dealCount.toLocaleString()} deal{stage.dealCount === 1 ? '' : 's'}
          </span>
        </li>
      ))}
    </ul>
  </section>
)
