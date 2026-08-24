'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'

type Tone = 'success' | 'error' | 'info'
type Toast = { id: number; tone: Tone; message: string }

const TONES: Record<Tone, string> = {
  success: 'border-success bg-success-subtle',
  error: 'border-error bg-error-subtle',
  info: 'border-line bg-surface',
}

const ToastContext = createContext<((tone: Tone, message: string) => void) | null>(null)

export const useToast = () => {
  const show = useContext(ToastContext)
  if (!show) throw new Error('useToast must be used inside <ToastProvider>.')
  return show
}

let nextId = 0

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([])

  const show = useCallback((tone: Tone, message: string) => {
    const id = ++nextId
    setToasts((all) => [...all, { id, tone, message }])
    // Errors stay until dismissed: a failure a person did not read is a failure
    // they will hit again.
    if (tone !== 'error') {
      setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 5000)
    }
  }, [])

  const value = useMemo(() => show, [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-panel border px-3 py-2 shadow-panel',
              TONES[toast.tone],
            )}
          >
            <p className="min-w-0 flex-1 break-words">{toast.message}</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((t) => t.id !== toast.id))}
              className="text-secondary"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
