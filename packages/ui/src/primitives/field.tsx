import { cloneElement, isValidElement, type ComponentProps, type ReactNode } from 'react'
import { cn } from '../cn.ts'

/** No outline-none here. The border going teal is HubSpot's focus look and it is
 *  kept, but it was the only affordance: these were the one family of controls in
 *  the app with no focus ring, while every button, link and resize handle takes
 *  the 2px accent outline from globals.css. Both, and the ring is the one that
 *  carries at a glance. */
const control =
  'w-full min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5 text-body ' +
  'transition-colors duration-150 placeholder:text-secondary ' +
  'focus:border-line-interactive focus:bg-surface ' +
  'disabled:cursor-not-allowed disabled:bg-disabled disabled:text-secondary ' +
  'aria-[invalid=true]:border-error'

export type FieldProps = {
  id: string
  label: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactNode
}

type Described = { 'aria-describedby'?: string | undefined; 'aria-invalid'?: boolean | undefined }

/** The hint and the error are the caller's control's, not this box's, so they have
 *  to be handed down: a message rendered beside an input that points at nothing is
 *  read to nobody. The caller keeps whatever it set itself. */
const describe = (children: ReactNode, noteId: string | undefined, invalid: boolean): ReactNode =>
  noteId && isValidElement<Described>(children)
    ? cloneElement(children, {
        'aria-describedby': children.props['aria-describedby'] ?? noteId,
        ...(invalid ? { 'aria-invalid': children.props['aria-invalid'] ?? true } : {}),
      })
    : children

export const Field = ({ id, label, hint, error, required, children }: FieldProps) => (
  <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="font-medium">
      {label}
      {required ? <span className="text-error"> *</span> : null}
    </label>
    {describe(children, error ? `${id}-error` : hint ? `${id}-hint` : undefined, error !== undefined)}
    {error ? (
      <p id={`${id}-error`} role="alert" className="text-error">
        {error}
      </p>
    ) : hint ? (
      <p id={`${id}-hint`} className="text-secondary">
        {hint}
      </p>
    ) : null}
  </div>
)

export const TextInput = ({ className, ...rest }: ComponentProps<'input'>) => (
  <input {...rest} className={cn(control, 'min-h-9', className)} />
)

export const TextArea = ({ className, ...rest }: ComponentProps<'textarea'>) => (
  <textarea {...rest} className={cn(control, 'min-h-20 resize-y', className)} />
)

// pr-8 reserves the strip the native chevron is painted over; the shared control
// padding is sized for a text input, so a long option ran under the arrow.
export const Select = ({ className, ...rest }: ComponentProps<'select'>) => (
  <select {...rest} className={cn(control, 'min-h-9 pr-8', className)} />
)
