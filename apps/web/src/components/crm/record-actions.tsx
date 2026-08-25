'use client'

import { Button, Modal, Select, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { objectView } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { Value } from './value.tsx'
import type { EditableField } from './field-input.tsx'

export type MergeCandidate = { id: string; label: string }

export type RecordActionsProps = {
  workspace: string
  object: ObjectKey
  objectLabel: string
  recordId: string
  displayName: string
  fields: EditableField[]
  values: Record<string, unknown>
  labels: Record<string, string>
  candidates: MergeCandidate[]
  canWrite: boolean
}

export const RecordActions = ({
  workspace,
  object,
  objectLabel,
  recordId,
  displayName,
  fields,
  values,
  labels,
  candidates,
  canWrite,
}: RecordActionsProps) => {
  const router = useRouter()
  const toast = useToast()
  const [showMerge, setShowMerge] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [absorbedId, setAbsorbedId] = useState('')
  const [absorbed, setAbsorbed] = useState<{ values: Record<string, unknown>; labels: Record<string, string> } | null>(null)
  const [picks, setPicks] = useState<Record<string, 'survivor' | 'absorbed'>>({})
  const [busy, setBusy] = useState(false)

  const loadOther = async (id: string) => {
    setAbsorbedId(id)
    setAbsorbed(null)
    setPicks({})
    if (!id) return
    try {
      const record = await api.crm.records.get.query({ object, id })
      if (record) setAbsorbed({ values: record.values, labels: record.labels })
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const merge = async () => {
    setBusy(true)
    try {
      const result = await api.crm.records.merge.mutate({ object, survivorId: recordId, absorbedId, picks })
      toast('success', `Merged. ${result.activitiesMoved} timeline entries moved onto this record.`)
      setShowMerge(false)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.crm.records.remove.mutate({ object, id: recordId })
      toast('success', `${objectLabel} deleted. Its history is kept on the records it touched.`)
      router.push(objectView(workspace, object, 'all'))
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  // Only fields where the two records actually differ are worth choosing between.
  const differing = absorbed
    ? fields.filter((field) => String(values[field.key] ?? '') !== String(absorbed.values[field.key] ?? ''))
    : []

  if (!canWrite) return null

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setShowMerge(true)}>Merge</Button>
      <Button variant="destructive" onClick={() => setShowDelete(true)}>
        Delete
      </Button>

      <Modal open={showMerge} title={`Merge into ${displayName}`} onClose={() => setShowMerge(false)}>
        <div className="flex flex-col gap-3">
          <p className="rounded-hs border border-warning bg-warning-subtle px-3 py-2">
            Merging cannot be undone. Everything on the other record moves here: its timeline, its
            links, its subscriptions and its tasks. The other record is then deleted.
          </p>

          <Select
            aria-label={`Which ${objectLabel.toLowerCase()} to merge in`}
            value={absorbedId}
            onChange={(event) => void loadOther(event.target.value)}
          >
            <option value="">Pick the record to merge in</option>
            {candidates
              .filter((candidate) => candidate.id !== recordId)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
          </Select>

          {absorbed ? (
            differing.length === 0 ? (
              <p className="text-secondary">
                The two records hold the same values, so there is nothing to choose between. Merging
                still moves the timeline and the links.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="font-medium">Pick which value wins</p>
                {differing.map((field) => {
                  const chosen = picks[field.key] ?? 'survivor'
                  return (
                    <fieldset key={field.key} className="rounded-hs border border-divider p-2">
                      <legend className="px-1 text-secondary">{field.label}</legend>
                      {(['survivor', 'absorbed'] as const).map((side) => (
                        <label key={side} className="flex items-start gap-2 py-0.5">
                          <input
                            type="radio"
                            name={`pick-${field.key}`}
                            checked={chosen === side}
                            onChange={() => setPicks((current) => ({ ...current, [field.key]: side }))}
                          />
                          <span className="min-w-0">
                            <Value
                              type={field.type}
                              value={side === 'survivor' ? values[field.key] : absorbed.values[field.key]}
                              label={side === 'survivor' ? labels[field.key] : absorbed.labels[field.key]}
                              placeholder="Empty"
                            />
                            <span className="ml-2 text-small text-secondary">
                              {side === 'survivor' ? 'this record' : 'the other one'}
                            </span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )
                })}
              </div>
            )
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy} disabled={absorbedId === ''} onClick={() => void merge()}>
              Merge, permanently
            </Button>
            <Button variant="tertiary" onClick={() => setShowMerge(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={showDelete} title={`Delete ${displayName}`} onClose={() => setShowDelete(false)}>
        <div className="flex flex-col gap-3">
          <p>
            The record is hidden everywhere immediately. Its timeline entries stay on the records
            they also touched, reading as a deleted {objectLabel.toLowerCase()}, so history is not
            rewritten.
          </p>
          <p className="text-secondary">Type the name to confirm.</p>
          <TextInput
            aria-label={`Type ${displayName} to confirm`}
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              busy={busy}
              disabled={confirmText.trim() !== displayName}
              onClick={() => void remove()}
            >
              Delete {objectLabel.toLowerCase()}
            </Button>
            <Button variant="tertiary" onClick={() => setShowDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
