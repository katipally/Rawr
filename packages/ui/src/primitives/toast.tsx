'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '../cn.ts'

type Tone = 'success' | 'error' | 'info'

/** An offer to put back what was just changed. Given as a label and a handler
 *  rather than as an element, so the toast owns its own dismissal: an undo that
 *  leaves its own toast on screen reads as though it did not work. */
export type ToastAction = { label: string; run: () => void | Promise<void> }
type Toast = { id: number; tone: Tone; message: string; action?: ToastAction }

const TONES: Record<Tone, string> = {
  success: 'border-success bg-success-subtle',
  error: 'border-error bg-error-subtle',
  info: 'border-line bg-surface-raised',
}

const ToastContext = createContext<((tone: Tone, message: string, action?: ToastAction) => void) | null>(null)

export const useToast = () => {
  const show = useContext(ToastContext)
  if (!show) throw new Error('useToast must be used inside <ToastProvider>.')
  return show
}

let nextId = 0

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const show = useCallback((tone: Tone, message: string, action?: ToastAction) => {
    const id = ++nextId
    setToasts((all) => [...all, { id, tone, message, ...(action ? { action } : {}) }])
    // Errors stay until dismissed: a failure a person did not read is a failure
    // they will hit again. So does anything offering an undo, because five
    // seconds is not long enough to notice a mistake and reach the button.
    if (tone !== 'error' && !action) {
      timers.current.push(setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 5000))
    }
  }, [])

  const value = useMemo(() => show, [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-toast flex flex-col items-center gap-2 p-4 sm:items-end"
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
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  setToasts((all) => all.filter((t) => t.id !== toast.id))
                  void toast.action?.run()
                }}
                className="shrink-0 font-medium text-link underline"
              >
                {toast.action.label}
              </button>
            ) : null}
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
