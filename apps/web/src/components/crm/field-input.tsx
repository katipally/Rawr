'use client'

import { Select, TextArea, TextInput } from '@rawr/ui'
import type { FieldType, ObjectKey } from '@rawr/db'
import { RecordPicker } from './record-picker.tsx'

export type Choice = { id: string; label: string }

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

/** One editor per field type, chosen from the registry. Adding a type means adding
 *  a branch here and nowhere else on the write side. */
export const FieldInput = ({ field, value, onChange, id, autoFocus, valueLabel }: FieldInputProps) => {
  const common = { id, 'aria-label': field.label, autoFocus }

  if (field.pickObject) {
    const current = typeof value === 'string' && value !== '' ? value : null
    return (
      <RecordPicker
        id={id}
        object={field.pickObject}
        label={field.label}
        allowClear={!field.isRequired}
        value={current ? { id: current, label: valueLabel || current } : null}
        onChange={(next) => onChange(next?.id ?? null)}
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
