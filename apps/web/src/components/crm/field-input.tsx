'use client'

import { Select, TextArea, TextInput } from '@rawr/ui'
import type { FieldType, ObjectKey } from '@rawr/db'
import { useState } from 'react'
import { RecordPicker, type PickedRecord } from './record-picker.tsx'
import { RichTextInput } from './rich-text-input.tsx'

export type Choice = { id: string; label: string; pipelineId?: string }

/** A deal stage belongs to one pipeline, so the stage list is cut to the
 *  pipeline the form holds. Every other field is itself. */
export const scoped = (field: EditableField, values: Record<string, unknown>): EditableField => {
  if (field.key !== 'stage_id' || !field.choices) return field
  const pipelineId = typeof values.pipeline_id === 'string' ? values.pipeline_id : null
  return pipelineId ? { ...field, choices: field.choices.filter((choice) => choice.pipelineId === pipelineId) } : field
}

/** The first stage of a pipeline, which is where a deal starts in it. */
export const firstStageOf = (fields: EditableField[], pipelineId: unknown): string | null =>
  fields.find((field) => field.key === 'stage_id')?.choices?.find((choice) => choice.pipelineId === pipelineId)?.id ?? null

export type EditableField = {
  key: string
  label: string
  type: FieldType
  isRequired: boolean
  helpText: string | null
  options: string[]
  /** Relation and user fields with a short, bounded list are picked from it. */
  choices?: Choice[]
  /** Relations whose target is too large for a list: searched, not enumerated. */
  pickObject?: ObjectKey
  readOnly?: boolean
}

const numericTypes = new Set(['number', 'currency', 'percent', 'rating'])

export type FieldInputProps = {
  field: EditableField
  value: unknown
  onChange: (value: unknown) => void
  id: string
  autoFocus?: boolean
  /** What the current value is called, so a searched relation shows a name rather
   *  than the uuid it stores. */
  valueLabel?: string | null | undefined
}

/** Only the id is stored, so on the next render there is nothing left to say what
 *  was chosen and the picker falls back to showing a uuid. The caller supplies a
 *  label when it has one, from the record being edited; a create form has none,
 *  because the record does not exist yet. So the name of whatever was just picked
 *  is remembered here, which is the only place that sees it. */
const RelationField = ({
  id,
  pickObject,
  label: fieldLabel,
  allowClear,
  value,
  onChange,
  valueLabel,
}: {
  id: string
  pickObject: ObjectKey
  label: string
  allowClear: boolean
  value: unknown
  onChange: (value: unknown) => void
  valueLabel?: string | null | undefined
}) => {
  const [picked, setPicked] = useState<PickedRecord | null>(null)
  const current = typeof value === 'string' && value !== '' ? value : null
  const label = valueLabel || (picked?.id === current ? picked.label : null) || current

  return (
    <RecordPicker
      id={id}
      object={pickObject}
      label={fieldLabel}
      allowClear={allowClear}
      value={current ? { id: current, label: label ?? current } : null}
      onChange={(next) => {
        setPicked(next)
        onChange(next?.id ?? null)
      }}
    />
  )
}

/** One editor per field type, chosen from the registry. Adding a type means adding
 *  a branch here and nowhere else on the write side. */
export const FieldInput = ({ field, value, onChange, id, autoFocus, valueLabel }: FieldInputProps) => {
  const common = { id, 'aria-label': field.label, autoFocus }

  if (field.pickObject) {
    return (
      <RelationField
        id={id}
        pickObject={field.pickObject}
        label={field.label}
        allowClear={!field.isRequired}
        value={value}
        onChange={onChange}
        valueLabel={valueLabel}
      />
    )
  }

  if (field.choices) {
    return (
      <Select {...common} value={String(value ?? '')} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Not set</option>
        {field.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </Select>
    )
  }

  switch (field.type) {
    case 'rich_text':
      return (
        <RichTextInput
          id={id}
          label={field.label}
          value={String(value ?? '')}
          onChange={onChange}
          {...(autoFocus ? { autoFocus } : {})}
        />
      )

    case 'long_text':
    case 'address':
      return <TextArea {...common} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />

    case 'boolean':
      return (
        <Select
          {...common}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'true')}
        >
          <option value="">Not set</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      )

    case 'select':
      return (
        <Select {...common} value={String(value ?? '')} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">Not set</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      )

    case 'multi_select': {
      const selected = new Set(Array.isArray(value) ? value.map(String) : [])
      return (
        // role="group" with an accessible name is exposed correctly and is what
        // this is. <fieldset>, the rule's suggestion, wants a <legend> and its own
        // reset inside this flex row for no gain a screen reader can hear.
        // biome-ignore lint/a11y/useSemanticElements: see above
        <div role="group" aria-label={field.label} className="flex flex-wrap gap-x-3 gap-y-1">
          {field.options.map((option) => (
            <label key={option} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={selected.has(option)}
                onChange={(event) => {
                  const next = new Set(selected)
                  if (event.target.checked) next.add(option)
                  else next.delete(option)
                  onChange([...next])
                }}
              />
              {option}
            </label>
          ))}
        </div>
      )
    }

    case 'date':
      return (
        <TextInput
          {...common}
          type="date"
          value={typeof value === 'string' ? value.slice(0, 10) : ''}
          onChange={(event) => onChange(event.target.value || null)}
        />
      )

    case 'datetime':
      return (
        <TextInput
          {...common}
          type="datetime-local"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          onChange={(event) => onChange(event.target.value || null)}
        />
      )

    case 'json':
      return (
        <TextArea
          {...common}
          readOnly
          value={value === null || value === undefined ? '' : JSON.stringify(value, null, 2)}
          onChange={() => undefined}
        />
      )

    default:
      return (
        <TextInput
          {...common}
          type={
            numericTypes.has(field.type)
              ? 'number'
              : field.type === 'email'
                ? 'email'
                : field.type === 'phone'
                  ? 'tel'
                  : 'text'
          }
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}
