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
import { toastLifetime, type ToastTone } from './toast-timing.ts'

/** An offer to put back what was just changed. Given as a label and a handler
 *  rather than as an element, so the toast owns its own dismissal: an undo that
 *  leaves its own toast on screen reads as though it did not work. */
export type ToastAction = { label: string; run: () => void | Promise<void> }
type Toast = { id: number; tone: ToastTone; message: string; action?: ToastAction; lifetime: number }

const TONES: Record<ToastTone, string> = {
  success: 'border-success bg-success-subtle',
  error: 'border-error bg-error-subtle',
  info: 'border-line bg-surface-raised',
}

const ToastContext = createContext<((tone: ToastTone, message: string, action?: ToastAction) => void) | null>(null)

export const useToast = () => {
  const show = useContext(ToastContext)
  if (!show) throw new Error('useToast must be used inside <ToastProvider>.')
  return show
}

let nextId = 0

/** Its timer runs only while nobody is reading it: a pointer over the toast or
 *  focus inside it pauses the countdown, and it resumes with the time left. */
const ToastItem = ({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) => {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const left = useRef(toast.lifetime)
  const since = useRef(0)
  const paused = hovered || focused

  useEffect(() => {
    if (paused) return
    since.current = Date.now()
    const timer = setTimeout(() => onDismiss(toast.id), left.current)
    return () => {
      clearTimeout(timer)
      left.current -= Date.now() - since.current
    }
  }, [paused, onDismiss, toast.id])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pause for whoever is reading, not a control; the buttons inside are the controls
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
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
            onDismiss(toast.id)
            void toast.action?.run()
          }}
          className="shrink-0 font-medium text-link underline"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" aria-label="Dismiss" onClick={() => onDismiss(toast.id)} className="text-secondary">
        ✕
      </button>
    </div>
  )
}

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), [])

  const show = useCallback((tone: ToastTone, message: string, action?: ToastAction) => {
    const id = ++nextId
    const lifetime = toastLifetime({ tone, message, hasAction: action !== undefined })
    setToasts((all) => [...all, { id, tone, message, lifetime, ...(action ? { action } : {}) }])
  }, [])

  const value = useMemo(() => show, [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Top and centred, under the header: every page keeps its own actions
          along the bottom and the right, and a toast there covers the very
          button the person just used. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-topbar z-toast flex flex-col items-center gap-2 p-4"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
