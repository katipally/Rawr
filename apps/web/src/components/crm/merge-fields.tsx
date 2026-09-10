'use client'

import { MERGE_FIELD_KEYS, type MergeFieldKey } from '@rawr/db/sequence-rules'
import { Button } from '@rawr/ui'

const LABELS: Record<MergeFieldKey, string> = {
  first_name: 'First name, or “there”',
  last_name: 'Last name',
  full_name: 'Full name',
  company: 'Company',
  email: 'Their email',
  sender_email: 'Your email',
  sequence: 'Sequence name',
}

/** A first name is the field most often missing, and the one whose absence reads
 *  worst, so the button inserts it with its fallback already written. */
const tokenFor = (key: MergeFieldKey): string =>
  key === 'first_name' ? '{{first_name|there}}' : `{{${key}}}`

/** The merge fields a template may use, offered rather than remembered. The list
 *  is the one the save enforces, so nothing here can be typed and then refused. */
export const MergeFieldPicker = ({ onInsert }: { onInsert: (token: string) => void }) => (
  <div className="flex flex-wrap gap-1">
    {MERGE_FIELD_KEYS.map((key) => (
      <Button key={key} variant="tertiary" onClick={() => onInsert(tokenFor(key))}>
        {LABELS[key]}
      </Button>
    ))}
  </div>
)
