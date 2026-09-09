'use client'

import { Alert, Button, DropdownMenu, Modal, TextInput, useToast } from '@rawr/ui'
import { ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { shortName } from '~/components/crm/value.tsx'
import { useNavigation } from '~/components/navigation.tsx'
import { ComposeDialog } from './compose-dialog.tsx'
import { EnrollDialog } from './enroll-dialog.tsx'
import { useEffect, useState } from 'react'
import { objectView } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { Value } from './value.tsx'
import { RecordPicker, type PickedRecord } from './record-picker.tsx'
import type { EditableField } from './field-input.tsx'
import { useZone } from '~/components/zone.tsx'

export type RecordActionsProps = {
  account: string
  object: string
  objectLabel: string
  recordId: string
  displayName: string
  fields: EditableField[]
  values: Record<string, unknown>
  labels: Record<string, string>
  canWrite: boolean
  /** The quick-action row asking for the compose dialog, from the address. The
   *  dialog is here, next to the address it sends to. */
  startCompose?: boolean | undefined
}

/** The three that can be merged. Written out rather than imported from
 *  '@rawr/db': a runtime value from the barrel pulls the Postgres driver into
 *  the client bundle, which is what the form builder's note next door is about. */
const MERGEABLE = new Set(['contact', 'company', 'deal'])

export const RecordActions = ({
  account,
  object,
  objectLabel,
  recordId,
  displayName,
  fields,
  values,
  labels,
  canWrite,
  startCompose,
}: RecordActionsProps) => {
  const zone = useZone()
  const router = useRouter()
  const { navigate } = useNavigation()
  const toast = useToast()
  const [showMerge, setShowMerge] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showEnroll, setShowEnroll] = useState(false)
  const [showCompose, setShowCompose] = useState(false)
  useEffect(() => {
    if (startCompose) setShowCompose(true)
  }, [startCompose])
  const [confirmText, setConfirmText] = useState('')
  const [other, setOther] = useState<PickedRecord | null>(null)
  const absorbedId = other?.id ?? ''
  const [absorbed, setAbsorbed] = useState<{ values: Record<string, unknown>; labels: Record<string, string> } | null>(null)
  const [picks, setPicks] = useState<Record<string, 'survivor' | 'absorbed'>>({})
  const [busy, setBusy] = useState(false)

  const loadOther = async (picked: PickedRecord | null) => {
    setOther(picked)
    setAbsorbed(null)
    setPicks({})
    if (!picked) return
    try {
      const record = await api.crm.records.get.query({ object, id: picked.id })
      if (record) setAbsorbed({ values: record.values, labels: record.labels })
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const merge = async () => {
    setBusy(true)
    try {
      // Every differing field is sent, defaults included. Sending only what was
      // clicked would let a default that nobody looked at go unrecorded, and the
      // useful default is the one that fills a blank.
      const decided = Object.fromEntries(
        differing.map((field) => [field.key, picks[field.key] ?? defaultSide(field.key)]),
      )
      if (!MERGEABLE.has(object)) throw new Error('Only contacts, companies and deals can be merged.')
      const result = await api.crm.records.merge.mutate({
        object: object as 'contact' | 'company' | 'deal',
        survivorId: recordId,
        absorbedId,
        picks: decided,
      })
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
      navigate(objectView(account, object, 'all'))
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

  /** This record wins by default, except where it holds nothing. Losing the only
   *  phone number on the file because the survivor's was blank is not a merge,
   *  it is a deletion nobody asked for. */
  const isBlank = (value: unknown): boolean =>
    value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

  const defaultSide = (key: string): 'survivor' | 'absorbed' =>
    absorbed && isBlank(values[key]) && !isBlank(absorbed.values[key]) ? 'absorbed' : 'survivor'

  if (!canWrite) return null

  return (
    <>
      <DropdownMenu
        label="Actions"
        groups={[
          {
            key: 'actions',
            items: [
              // Only a contact can be written to or enrolled: both send to a person.
              ...(object === 'contact' && typeof values.email === 'string' && values.email
                ? [{ key: 'email', label: 'Email', onSelect: () => setShowCompose(true) }]
                : []),
              ...(object === 'contact' ? [{ key: 'enroll', label: 'Enroll in sequence', onSelect: () => setShowEnroll(true) }] : []),
              // Merging moves activities, associations and browsing history, and a
              // custom object has none of them. Offered only where it can work.
              ...(MERGEABLE.has(object) ? [{ key: 'merge', label: 'Merge', onSelect: () => setShowMerge(true) }] : []),
            ],
          },
          { key: 'danger', items: [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => setShowDelete(true) }] },
        ]}
        trigger={(props) => (
          <button {...props} type="button" className="flex h-10 items-center gap-1 rounded-pill pr-3 pl-3 font-semibold hover:bg-fill">
            Actions
            <ChevronDown aria-hidden="true" className="size-3" />
          </button>
        )}
      />

      {showCompose && typeof values.email === 'string' ? (
        <ComposeDialog
          to={values.email}
          contactId={recordId}
          onClose={() => setShowCompose(false)}
          onSent={() => router.refresh()}
        />
      ) : null}

      {showEnroll ? (
        <EnrollDialog
          contactIds={[recordId]}
          contactLabel={displayName}
          onClose={() => setShowEnroll(false)}
          onEnrolled={() => router.refresh()}
        />
      ) : null}

      <Modal open={showMerge} title={`Merge into ${shortName(displayName)}`} onClose={() => setShowMerge(false)}>
        <div className="flex flex-col gap-3">
          <Alert tone="warning">
            Merging cannot be undone. Everything on the other record moves here: its timeline, its
            links, its subscriptions and its tasks. The other record is then deleted.
          </Alert>

          {/* Searched rather than listed: a duplicate is almost never among the
              most recently created records, which is all a capped list could offer. */}
          <RecordPicker
            object={MERGEABLE.has(object) ? (object as 'contact' | 'company' | 'deal') : 'contact'}
            label={`Which ${objectLabel.toLowerCase()} to merge in`}
            placeholder={`Search for the ${objectLabel.toLowerCase()} to merge in`}
            excludeId={recordId}
            value={other}
            onChange={(picked) => void loadOther(picked)}
          />

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
                  const chosen = picks[field.key] ?? defaultSide(field.key)
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
                            <Value zone={zone}
                              type={field.type}
                              value={side === 'survivor' ? values[field.key] : absorbed.values[field.key]}
                              label={side === 'survivor' ? labels[field.key] : absorbed.labels[field.key]}
                              placeholder="Empty"
                              oneLine
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

      <Modal open={showDelete} size="sm" title={`Delete ${shortName(displayName)}`} onClose={() => setShowDelete(false)}>
        <div className="flex flex-col gap-3">
          <p>
            The record is hidden everywhere immediately. Its timeline entries stay on the records
            they also touched, reading as a deleted {objectLabel.toLowerCase()}, so history is not
            rewritten.
          </p>
          <p className="text-secondary">Type the name to confirm:</p>
          {/* The name is shown here, in full and selectable, rather than only in
              the dialog's title. The title is truncated, and a record whose name
              runs to hundreds of characters was one nobody could ever type back
              and therefore one nobody could delete. */}
          <p className="max-h-24 overflow-y-auto rounded-hs border border-divider bg-fill px-2 py-1 font-medium break-words select-all">
            {displayName}
          </p>
          <TextInput
            aria-label={`Type ${shortName(displayName)} to confirm`}
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
    </>
  )
}
