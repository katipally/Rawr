import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from '../cn.ts'

const control =
  'w-full min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5 text-body outline-none ' +
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

export const Field = ({ id, label, hint, error, required, children }: FieldProps) => (
  <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="font-medium">
      {label}
      {required ? <span className="text-error"> *</span> : null}
    </label>
    {children}
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

export const TextInput = ({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...rest} className={cn(control, 'min-h-9', className)} />
)

export const TextArea = ({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...rest} className={cn(control, 'min-h-20 resize-y', className)} />
)

export const Select = ({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...rest} className={cn(control, 'min-h-9', className)} />
)
