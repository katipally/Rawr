'use client'

import { TextInput, cn } from '@rawr/ui'
import { Search } from 'lucide-react'

export type PropertySearchProps = {
  value: string
  onChange: (value: string) => void
  className?: string
}

/** The box above a long list of properties. Enter is swallowed because it sits
 *  inside forms: a search is not a request to submit what is around it. */
export const PropertySearch = ({ value, onChange, className }: PropertySearchProps) => (
  <label className={cn('relative block', className)}>
    <span className="sr-only">Search all properties</span>
    <TextInput
      type="search"
      value={value}
      placeholder="Search properties"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault()
      }}
      className="pr-9"
    />
    <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2" />
  </label>
)
