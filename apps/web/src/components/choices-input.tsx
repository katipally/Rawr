'use client'

import { TextArea } from '@rawr/ui'
import { useState } from 'react'
import { type Choice, choicesText, parseChoices } from '~/lib/choices.ts'

/** Holds the raw text, since parsing drops a trailing space or a fresh blank line
 *  and a box that re-renders from the parsed list could never be typed into. */
export const ChoicesInput = ({
  id,
  choices,
  disabled,
  onChange,
}: {
  id: string
  choices: Choice[] | undefined
  disabled: boolean
  onChange: (choices: Choice[]) => void
}) => {
  const [text, setText] = useState(() => choicesText(choices))
  return (
    <TextArea
      id={id}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value)
        onChange(parseChoices(event.target.value))
      }}
    />
  )
}
